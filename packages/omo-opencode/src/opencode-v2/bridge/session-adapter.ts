import type { Context } from "@opencode/plugin/promise/plugin"
import { log } from "../../shared/logger"

export interface V1SessionHooks {
  "chat.message"?: (
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
    output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string; [k: string]: unknown }> },
  ) => Promise<void>
  "chat.params"?: (
    input: {
      sessionID?: string
      agent?: string | { name?: string }
      model?: { providerID?: unknown; modelID?: unknown; id?: unknown }
      message?: { variant?: string }
    },
    output: { options?: Record<string, unknown> },
  ) => Promise<void>
  "chat.headers"?: (
    input: { sessionID?: string; agent?: string; model?: unknown },
    output: { headers?: Record<string, string> },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; agent?: string; model?: unknown },
    output: { system: string[] },
  ) => Promise<void>
  "experimental.chat.messages.transform"?: (
    input: { sessionID?: string; agent?: string; model?: unknown },
    output: { messages: unknown[] },
  ) => Promise<void>
  "experimental.session.compacting"?: (input: { sessionID: string }) => Promise<void>
}

/**
 * Binds OpenCode V2 session lifecycle hooks to OMO V1 hook handlers.
 */
export async function bindSessionHooksToV2(args: {
  v2Context: Context
  v1Hooks: V1SessionHooks
}): Promise<Array<() => Promise<void>>> {
  const { v2Context, v1Hooks } = args
  const disposers: Array<() => Promise<void>> = []

  // 1. Hook: prompt (equivalent to chat.message)
  if (v1Hooks["chat.message"]) {
    const chatMessageHandler = v1Hooks["chat.message"]
    const promptRegistration = await v2Context.session.hook("prompt", async (promptEvent) => {
      try {
        const sessionID = String(promptEvent.sessionID)
        const promptRaw = promptEvent.prompt
        const promptText = typeof promptRaw === "string" ? promptRaw : JSON.stringify(promptRaw)

        const v1Input = {
          sessionID,
        }
        const v1Output = {
          message: (promptEvent.metadata ?? {}) as Record<string, unknown>,
          parts: [{ type: "text", text: promptText }],
        }

        await chatMessageHandler(v1Input, v1Output)

        // If message text was transformed by keyword detector or aliases
        const modifiedText = v1Output.parts.find((p) => p.type === "text")?.text
        if (modifiedText !== undefined && modifiedText !== promptText) {
          promptEvent.prompt = modifiedText as any
        }
        promptEvent.metadata = v1Output.message
      } catch (err) {
        log("[v2-bridge:session] prompt hook error:", { error: String(err) })
      }
    })
    disposers.push(() => promptRegistration.dispose())
  }

  // 2. Hook: context (runs before each LLM turn: system, messages, and model options)
  const hasContextTransforms =
    v1Hooks["experimental.chat.system.transform"] ||
    v1Hooks["experimental.chat.messages.transform"] ||
    v1Hooks["chat.params"]

  if (hasContextTransforms) {
    const contextRegistration = await v2Context.session.hook("context", async (sessionCtx) => {
      const sessionID = String(sessionCtx.sessionID)
      const agent = String(sessionCtx.agent)
      const model = sessionCtx.model

      const hookInput = {
        sessionID,
        agent,
        model,
      }

      // A. System prompt transform
      if (v1Hooks["experimental.chat.system.transform"]) {
        try {
          const currentSystemStrings: string[] = []
          for (const part of sessionCtx.system) {
            if (typeof part === "string") {
              currentSystemStrings.push(part)
            } else if (part && typeof part === "object" && "text" in part) {
              currentSystemStrings.push(String((part as any).text))
            }
          }

          const systemOutput = { system: currentSystemStrings }
          await v1Hooks["experimental.chat.system.transform"](hookInput, systemOutput)

          if (systemOutput.system.length > 0) {
            sessionCtx.system = systemOutput.system as any
          }
        } catch (err) {
          log("[v2-bridge:session] system transform error:", { error: String(err) })
        }
      }

      // B. Messages transform (thinking block validation, rule injection, etc.)
      if (v1Hooks["experimental.chat.messages.transform"]) {
        try {
          const messagesOutput = { messages: [...sessionCtx.messages] }
          await v1Hooks["experimental.chat.messages.transform"](hookInput, messagesOutput)
          sessionCtx.messages = messagesOutput.messages as any
        } catch (err) {
          log("[v2-bridge:session] messages transform error:", { error: String(err) })
        }
      }

      // C. Generation options / params
      if (v1Hooks["chat.params"]) {
        try {
          const paramsOutput: { options?: Record<string, unknown> } = {
            options: { ...sessionCtx.options },
          }
          await v1Hooks["chat.params"](hookInput, paramsOutput)
          if (paramsOutput.options) {
            Object.assign(sessionCtx.options, paramsOutput.options)
          }
        } catch (err) {
          log("[v2-bridge:session] chat params error:", { error: String(err) })
        }
      }
    })
    disposers.push(() => contextRegistration.dispose())
  }

  // 3. Hook: model.request (equivalent to chat.headers)
  if (v1Hooks["chat.headers"]) {
    const headersHandler = v1Hooks["chat.headers"]
    const modelReqRegistration = await v2Context.session.hook("model.request", async (req) => {
      try {
        const headersOutput = { headers: { ...req.headers } }
        await headersHandler(
          {
            sessionID: String(req.sessionID),
            agent: String(req.agent),
            model: req.model,
          },
          headersOutput,
        )
        if (headersOutput.headers) {
          Object.assign(req.headers, headersOutput.headers)
        }
      } catch (err) {
        log("[v2-bridge:session] model.request headers error:", { error: String(err) })
      }
    })
    disposers.push(() => modelReqRegistration.dispose())
  }

  // 4. Hook: compaction
  if (v1Hooks["experimental.session.compacting"]) {
    const compactingHandler = v1Hooks["experimental.session.compacting"]
    const compactionRegistration = await v2Context.session.hook("compaction", async (compaction) => {
      try {
        await compactingHandler({ sessionID: String(compaction.sessionID) })
      } catch (err) {
        log("[v2-bridge:session] compaction hook error:", { error: String(err) })
      }
    })
    disposers.push(() => compactionRegistration.dispose())
  }

  return disposers
}
