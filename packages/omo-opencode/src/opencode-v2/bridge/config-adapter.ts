import type { Context } from "@opencode/plugin/promise/plugin"
import { getAgentConfigKey, getAgentDisplayName } from "../../shared/agent-display-names"
import { validateAgentOrder } from "../../shared/agent-ordering"
import { log } from "../../shared/logger"
import {
  createV2PermissionProjector,
  dedupePermissionRules,
  toolFlagsToV2PermissionRules,
  toV2PermissionRules,
} from "./permission-adapter"
import { resolveProviderForBareModel, type V2ModelInfoLike } from "./provider-adapter"

export interface V1ConfigResult {
  agent?: Record<string, any>
  default_agent?: string
  command?: Record<string, any>
  provider?: Record<string, any>
  tools?: Record<string, boolean>
  permission?: Record<string, unknown>
  formatter?: unknown
}

/**
 * Parses a model string into the `{ providerID, id }` reference V2 stores on an agent.
 *
 * The split mirrors V2's own `Model.Ref.parse`, which cuts at the first `/`, rather than OMO's
 * config-level parser, which also strips reasoning suffixes. A model id reaching this point is
 * already resolved, so stripping a suffix such as `-thinking` here would rename the model.
 *
 * A string with no provider cannot be parsed on its own. `resolveBareProvider` is given the chance
 * to answer from the live catalog; when it cannot, the result is undefined so the caller can skip
 * the model rather than route to a fabricated provider.
 */
export function parseModelString(
  modelStr: string,
  variant?: string,
  resolveBareProvider?: (modelID: string) => string | undefined,
):
  | {
      providerID: string
      id: string
      variant?: string
    }
  | undefined {
  const slashIdx = modelStr.indexOf("/")
  if (slashIdx !== -1) {
    return {
      providerID: modelStr.slice(0, slashIdx),
      id: modelStr.slice(slashIdx + 1),
      ...(variant ? { variant } : {}),
    }
  }

  const resolvedProvider = resolveBareProvider?.(modelStr)
  if (!resolvedProvider) return undefined

  return {
    providerID: resolvedProvider,
    id: modelStr,
    ...(variant ? { variant } : {}),
  }
}

/**
 * Expands an OMO V1 command template into the prompt text V2 delivers to the session.
 *
 * V1 OpenCode substituted these placeholders itself. V2 hands the plugin a bare
 * `CommandInvocation`, so the bridge owns the substitution.
 */
export function expandCommandTemplate(
  template: string,
  context: { args: string; sessionID: string; timestamp?: string },
): string {
  return template
    .replaceAll("$ARGUMENTS", context.args)
    .replaceAll("$SESSION_ID", context.sessionID)
    .replaceAll("$TIMESTAMP", context.timestamp ?? new Date().toISOString())
}

/**
 * Returns the agent ids in the order they should be registered with V2, canonical core agents
 * first.
 *
 * On V2 this is the only ordering lever that exists. `Agent.Info` has no `order` field (its schema
 * strips unknown keys), `Agent.list` does not sort, and `editor.update` on an unseen id does
 * `agents.set(id, agent)`, so a Map's insertion order is what the picker renders. Writing the core
 * agents first therefore makes them occupy consecutive leading slots, and the active agent is
 * hoisted to index 0 by the host.
 *
 * The canonical key sequence comes from `validateAgentOrder`, which is also what enforces the
 * documented rule that no second ordering constant may exist.
 */
function orderAgentIds(agentIds: readonly string[], agentOrder: readonly string[] | undefined): string[] {
  const canonical = validateAgentOrder(agentOrder).order
  const present = new Set(agentIds)
  const ordered = canonical.filter((configKey) => present.has(configKey))
  const orderedSet = new Set(ordered)
  const rest = agentIds.filter((id) => !orderedSet.has(id)).sort((a, b) => a.localeCompare(b))
  return [...ordered, ...rest]
}

/**
 * Binds OMO V1 config results to OpenCode V2 domains (agent, command, provider).
 */
export async function bindConfigToV2(args: {
  v2Context: Context
  v1Config: V1ConfigResult
  rawPluginConfig?: any
  providerModels?: readonly V2ModelInfoLike[]
}): Promise<Array<() => Promise<void>>> {
  const { v2Context, v1Config, rawPluginConfig, providerModels } = args
  const disposers: Array<() => Promise<void>> = []

  const globalPermissionRules = dedupePermissionRules([
    ...toolFlagsToV2PermissionRules(v1Config.tools),
    ...toV2PermissionRules(v1Config.permission),
  ])
  const permissionProjector = createV2PermissionProjector({ globalRules: globalPermissionRules })

  const resolveBareProvider = (modelID: string): string | undefined =>
    providerModels ? resolveProviderForBareModel(modelID, providerModels) : undefined

  if (globalPermissionRules.length > 0) {
    log("[v2-bridge:config] projecting global tool permissions onto the V2 ruleset:", {
      ruleCount: globalPermissionRules.length,
    })
  }

  // 1. Agent Domain Transform
  if (v2Context.agent && typeof v2Context.agent.transform === "function") {
    try {
      // The host invokes this callback lazily, on every agent-list recompute, and does not await
      // it. It must stay synchronous and idempotent.
      const agentRegistration = await v2Context.agent.transform((editor) => {
        // Set default agent if configured
        const rawDefault = rawPluginConfig?.default_agent ?? v1Config.default_agent
        if (rawDefault && typeof rawDefault === "string") {
          const canonicalDefault = getAgentConfigKey(rawDefault) || rawDefault
          try {
            editor.default(canonicalDefault)
            log("[v2-bridge:config] set default agent:", { agent: canonicalDefault })
          } catch (err) {
            log("[v2-bridge:config] failed to set default agent:", { error: String(err) })
          }
        }

        // Merge V1 resolved agent config with raw pluginConfig overrides,
        // normalizing all keys to canonical lowercase IDs (e.g. "sisyphus", "hephaestus")
        const agentMap: Record<string, any> = {}

        // 1. Ingest V1 resolved agents
        if (v1Config.agent) {
          for (const [key, config] of Object.entries(v1Config.agent)) {
            const canonicalKey = getAgentConfigKey(key) || key.toLowerCase()
            agentMap[canonicalKey] = {
              ...agentMap[canonicalKey],
              ...config,
            }
          }
        }

        // 2. Ingest rawPluginConfig.agents (from .omo/omo.jsonc - global + project)
        if (rawPluginConfig?.agents && typeof rawPluginConfig.agents === "object") {
          for (const [key, config] of Object.entries(rawPluginConfig.agents as Record<string, any>)) {
            const canonicalKey = getAgentConfigKey(key) || key.toLowerCase()
            agentMap[canonicalKey] = {
              ...agentMap[canonicalKey],
              ...config,
            }
          }
        }

        const agentOrder = orderAgentIds(Object.keys(agentMap), rawPluginConfig?.agent_order)
        if (agentOrder.length > 0) {
          log("[v2-bridge:config] registering agents in canonical order:", { order: agentOrder })
        }

        for (const id of agentOrder) {
          const agentConfig = agentMap[id]
          if (!agentConfig) continue

          try {
            editor.update(id, (agent) => {
              // 1. Name
              // V2 pre-fills `name` with the id, so a guard on `!agent.name` would discard every
              // display name and the picker renders raw lowercase ids. V2 keys on `id` everywhere,
              // so `name` is display-only and safe to overwrite. An explicit config name wins, and
              // a key with no display-name entry is left alone so host built-ins such as `build`
              // keep the capitalized name V2 gave them.
              const explicitName = typeof agentConfig.name === "string" ? agentConfig.name : undefined
              const knownDisplayName = getAgentDisplayName(id)
              const displayName = explicitName ?? (knownDisplayName !== id ? knownDisplayName : undefined)
              if (displayName) {
                // `Agent.Name` is a branded identifier type, so a plain string needs this assertion;
                // it is scoped to the field's own type rather than widened to `any`.
                agent.name = displayName as typeof agent.name
              }

              // 2. Model & Reasoning / Variant
              if (agentConfig.model && typeof agentConfig.model === "string") {
                const variant = agentConfig.variant ?? agentConfig.reasoning
                const parsedModel = parseModelString(agentConfig.model, variant, resolveBareProvider)
                if (parsedModel) {
                  agent.model = parsedModel as any
                } else {
                  // A bare id no live provider claims cannot be routed: skipping leaves the host's
                  // resolved model, where a fabricated provider would never serve the request.
                  log("[v2-bridge:config] skipping unresolvable bare model id:", {
                    id,
                    model: agentConfig.model,
                  })
                }
              } else if (agentConfig.model && typeof agentConfig.model === "object") {
                agent.model = agentConfig.model
              }

              // 3. System prompt
              const prompt = agentConfig.prompt ?? agentConfig.system
              if (prompt && typeof prompt === "string") {
                agent.system = prompt
              }

              // 4. Mode (primary | subagent | all)
              if (agentConfig.mode) {
                agent.mode = agentConfig.mode
              }

              // 5. Description
              if (agentConfig.description && typeof agentConfig.description === "string") {
                agent.description = agentConfig.description
              }

              // 6. Tool permissions
              // V2 resolves permissions from an ordered rule list on the agent, not from V1's
              // name-to-effect map, so phase 4 is invisible to V2 without this projection.
              const ruleCount = permissionProjector.project(id, agent, agentConfig.permission)
              if (ruleCount > 0) {
                log("[v2-bridge:config] projected tool permissions onto agent:", {
                  id,
                  ruleCount,
                })
              }
            })
            log("[v2-bridge:config] updated agent from OMO config:", {
              id,
              model: agentConfig.model,
              mode: agentConfig.mode,
            })
          } catch (err) {
            log("[v2-bridge:config] failed to update agent in V2:", { id, error: String(err) })
          }
        }
      })
      disposers.push(() => agentRegistration.dispose())
    } catch (err) {
      log("[v2-bridge:config] failed to transform agents:", { error: String(err) })
    }
  }

  // 2. Command Domain Transform
  if (v2Context.command && typeof v2Context.command.transform === "function" && v1Config.command) {
    try {
      const commandRegistration = await v2Context.command.transform((editor) => {
        for (const [name, cmd] of Object.entries(v1Config.command as Record<string, any>)) {
          if (!cmd || typeof cmd !== "object") continue
          try {
            editor.add({
              name,
              description: cmd.description ?? "",
              execute: async (inv) => {
                const sessionID = String(inv.sessionID)
                const template = typeof cmd.template === "string" ? cmd.template : ""
                const text = expandCommandTemplate(template, {
                  args: String(inv.prompt?.text ?? ""),
                  sessionID,
                })
                if (!text.trim()) {
                  log("[v2-bridge:command] command has no template, nothing to dispatch:", { name })
                  return
                }
                if (typeof cmd.agent === "string" && cmd.agent) {
                  const canonicalAgent = getAgentConfigKey(cmd.agent) || cmd.agent
                  try {
                    await v2Context.session.switchAgent({ sessionID: inv.sessionID, agent: canonicalAgent })
                  } catch (err) {
                    log("[v2-bridge:command] failed to switch agent for command:", {
                      name,
                      agent: canonicalAgent,
                      error: String(err),
                    })
                  }
                }
                await v2Context.session.prompt({ sessionID: inv.sessionID, text, delivery: inv.delivery })
                log("[v2-bridge:command] dispatched command template:", { name, sessionID })
              },
            })
          } catch (err) {
            log("[v2-bridge:config] failed to register command:", { name, error: String(err) })
          }
        }
      })
      disposers.push(() => commandRegistration.dispose())
    } catch (err) {
      log("[v2-bridge:config] failed to transform commands:", { error: String(err) })
    }
  }

  return disposers
}
