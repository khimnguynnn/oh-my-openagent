import type { Context } from "@opencode/plugin/promise/plugin"
import { getAgentConfigKey, getAgentDisplayName } from "../../shared/agent-display-names"
import { log } from "../../shared/logger"

export interface V1ConfigResult {
  agent?: Record<string, any>
  default_agent?: string
  command?: Record<string, any>
  provider?: Record<string, any>
}

/**
 * Parses a model string into providerID and model id.
 * e.g. "kiro-proxy/claude-opus-5.5-thinking" -> { providerID: "kiro-proxy", id: "claude-opus-5.5-thinking" }
 * e.g. "claude-sonnet-4-5" -> { providerID: "anthropic", id: "claude-sonnet-4-5" }
 */
export function parseModelString(modelStr: string, variant?: string): {
  providerID: string
  id: string
  variant?: string
} {
  const slashIdx = modelStr.indexOf("/")
  if (slashIdx !== -1) {
    return {
      providerID: modelStr.slice(0, slashIdx),
      id: modelStr.slice(slashIdx + 1),
      ...(variant ? { variant } : {}),
    }
  }
  return {
    providerID: "anthropic",
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
 * Binds OMO V1 config results to OpenCode V2 domains (agent, command, provider).
 */
export async function bindConfigToV2(args: {
  v2Context: Context
  v1Config: V1ConfigResult
  rawPluginConfig?: any
}): Promise<Array<() => Promise<void>>> {
  const { v2Context, v1Config, rawPluginConfig } = args
  const disposers: Array<() => Promise<void>> = []

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

        for (const [id, agentConfig] of Object.entries(agentMap)) {
          if (!agentConfig) continue

          try {
            editor.update(id, (agent) => {
              // 1. Name
              const displayName = agentConfig.name ?? getAgentDisplayName(id)
              if (displayName && !agent.name) {
                agent.name = displayName
              }

              // 2. Model & Reasoning / Variant
              if (agentConfig.model && typeof agentConfig.model === "string") {
                const variant = agentConfig.variant ?? agentConfig.reasoning
                agent.model = parseModelString(agentConfig.model, variant) as any
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
                  try {
                    await v2Context.session.switchAgent({ sessionID: inv.sessionID, agent: cmd.agent })
                  } catch (err) {
                    log("[v2-bridge:command] failed to switch agent for command:", {
                      name,
                      agent: cmd.agent,
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
