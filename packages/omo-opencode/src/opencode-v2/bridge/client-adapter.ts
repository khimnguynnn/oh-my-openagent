import type { Context } from "@opencode/plugin/promise/plugin"
import { log } from "../../shared/logger"

function resolveSessionID(args: any): any {
  return args?.path?.id ?? args?.id
}

/**
 * V2 `session.prompt` takes a single input object and returns as soon as the message is enqueued.
 * V1 callers pass the OpenAPI-client shape (`{ path: { id }, body: { parts | prompt } }`).
 */
function dispatchPrompt(v2Context: Context, args: any): Promise<unknown> {
  const prompt = args?.body?.prompt ?? args?.prompt ?? args?.body
  const text =
    typeof prompt === "string"
      ? prompt
      : typeof prompt?.text === "string"
        ? prompt.text
        : extractTextFromParts(args?.body?.parts ?? prompt?.parts)
  return v2Context.session.prompt({
    sessionID: resolveSessionID(args),
    text,
    ...(prompt?.delivery ? { delivery: prompt.delivery } : {}),
  } as any)
}

function extractTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .map((part) => (typeof part === "string" ? part : typeof (part as any)?.text === "string" ? (part as any).text : ""))
    .filter(Boolean)
    .join("\n")
}

/**
 * Creates a compatibility shim for the V1 OpencodeClient using OpenCode V2's Context domains.
 * This allows OMO's existing managers and tools to communicate with the host without changes.
 */
export function createV1ClientFromV2Context(v2Context: Context): any {
  return {
    session: {
      create: async (args: any) => {
        log("[v2-bridge:client] session.create", args)
        const body = args?.body ?? args ?? {}
        const created = await v2Context.session.create(body)
        return { data: created }
      },
      get: async (args: any) => {
        const id = args?.path?.id ?? args?.id ?? args
        const session = await v2Context.session.get(id)
        return { data: session }
      },
      messages: async (args: any) => {
        const id = args?.path?.id ?? args?.id ?? args
        try {
          const msgs = await v2Context.session.context(id)
          return { data: Array.isArray(msgs) ? msgs : (msgs as any)?.messages ?? [] }
        } catch {
          return { data: [] }
        }
      },
      status: async () => {
        return { data: {} }
      },
      todo: async () => {
        return { data: [] }
      },
      abort: async (args: any) => {
        const id = args?.path?.id ?? args?.id ?? args
        await v2Context.session.interrupt(id)
        return { data: { success: true } }
      },
      prompt: async (args: any) => {
        const result = await dispatchPrompt(v2Context, args)
        await v2Context.session.wait({ sessionID: resolveSessionID(args) })
        return { data: result }
      },
      promptAsync: async (args: any) => {
        const result = await dispatchPrompt(v2Context, args)
        return { data: result }
      },
      children: async () => {
        return { data: [] }
      },
    },
    app: {
      agents: async () => {
        try {
          const listed = (await v2Context.agent.list()) as any
          const agents = Array.isArray(listed) ? listed : (listed?.data ?? [])
          return { data: agents }
        } catch {
          return { data: [] }
        }
      },
    },
    config: {
      get: async () => {
        return { data: {} }
      },
    },
    tui: {
      showToast: async (input: any) => {
        log("[v2-bridge:client] tui.showToast", input)
      },
    },
  }
}
