import type { Context } from "@opencode/plugin/promise/plugin"
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
      const agentRegistration = await v2Context.agent.transform(async (editor) => {
        const existingList = editor.list()
        const existingMap = new Map(existingList.map((a) => [a.id, a]))

        // Set default agent if configured
        if (v1Config.default_agent && typeof v1Config.default_agent === "string") {
          try {
            editor.default(v1Config.default_agent)
            log("[v2-bridge:config] set default agent:", { agent: v1Config.default_agent })
          } catch (err) {
            log("[v2-bridge:config] failed to set default agent:", { error: String(err) })
          }
        }

        // Merge V1 resolved agent config with raw pluginConfig overrides
        const agentMap: Record<string, any> = {
          ...(v1Config.agent ?? {}),
        }
        if (rawPluginConfig?.agents && typeof rawPluginConfig.agents === "object") {
          for (const [id, agentOverrides] of Object.entries(rawPluginConfig.agents as Record<string, any>)) {
            if (agentOverrides && typeof agentOverrides === "object") {
              agentMap[id] = {
                ...agentMap[id],
                ...agentOverrides,
              }
            }
          }
        }

        for (const [id, agentConfig] of Object.entries(agentMap)) {
          if (!agentConfig || !existingMap.has(id)) continue

          try {
            editor.update(id, (agent) => {
              // 1. Model & Reasoning / Variant
              if (agentConfig.model && typeof agentConfig.model === "string") {
                const variant = agentConfig.variant ?? agentConfig.reasoning
                agent.model = parseModelString(agentConfig.model, variant) as any
              } else if (agentConfig.model && typeof agentConfig.model === "object") {
                agent.model = agentConfig.model
              }

              // 2. System prompt
              if (agentConfig.prompt && typeof agentConfig.prompt === "string") {
                agent.system = agentConfig.prompt
              }

              // 3. Mode (primary | subagent | all)
              if (agentConfig.mode) {
                agent.mode = agentConfig.mode
              }

              // 4. Description
              if (agentConfig.description) {
                agent.description = agentConfig.description
              }
            })
            log("[v2-bridge:config] updated agent from OMO config:", {
              id,
              model: agentConfig.model,
              mode: agentConfig.mode,
            })
          } catch (err) {
            log("[v2-bridge:config] failed to update agent:", { id, error: String(err) })
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
                log("[v2-bridge:command] executed command:", { name, sessionID: inv.sessionID })
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
