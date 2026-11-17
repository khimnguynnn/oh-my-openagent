import type { Context } from "@opencode/plugin/promise/plugin"
import { log } from "../../shared/logger"

function resolveSessionID(args: any): any {
  return args?.path?.id ?? args?.id
}

/**
 * V2 session calls take an options object keyed `sessionID`. Passing the bare id string
 * (the V1 shape) fails validation with `SchemaError: Expected object`, and passing `{ id }`
 * fails with `Missing key at ["sessionID"]`.
 */
function sessionRef(args: any): { sessionID: any } {
  return { sessionID: args?.path?.id ?? args?.id ?? args }
}

/**
 * V2 session records nest the working directory under `location`, while V1 consumers read a flat
 * `directory`. Session listing filters on that field, so without this an unflattened record is
 * dropped by every directory filter and the caller sees an empty list.
 */
function normalizeSession(session: any): any {
  if (!session || typeof session !== "object") return session
  const directory = session.directory ?? session.location?.directory
  return directory === undefined ? session : { ...session, directory }
}

/** V2 list endpoints answer `{ data, cursor }` where V1 callers expect the rows. */
function unwrapList(result: any): any[] {
  const rows = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : []
  return rows.map(normalizeSession)
}

/**
 * `ctx.session.list` exists at runtime (it is in the live domain's own key list and answers
 * `{ data, cursor }`) but the published `SessionDomain` type omits it, so the type has to be
 * widened here rather than cast at every call site.
 */
type SessionListDomain = Context["session"] & {
  list: (input?: { parentID?: string; [key: string]: unknown }) => Promise<unknown>
}

function sessionListDomain(v2Context: Context): SessionListDomain {
  return v2Context.session as SessionListDomain
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
        return { data: normalizeSession(created) }
      },
      get: async (args: any) => {
        const session = await v2Context.session.get(sessionRef(args))
        return { data: normalizeSession(session) }
      },
      list: async (args: any) => {
        const listed = await sessionListDomain(v2Context).list(args?.query ?? args ?? {})
        return { data: unwrapList(listed) }
      },
      messages: async (args: any) => {
        try {
          const msgs = await v2Context.session.context(sessionRef(args))
          return { data: Array.isArray(msgs) ? msgs : ((msgs as any)?.messages ?? []) }
        } catch (error) {
          log("[v2-bridge:client] session.messages failed", { error: String(error) })
          return { data: [] }
        }
      },
      // V2 has no session status or todo API, so these stay empty rather than guessing a shape.
      status: async () => {
        return { data: {} }
      },
      todo: async () => {
        return { data: [] }
      },
      abort: async (args: any) => {
        await v2Context.session.interrupt(sessionRef(args))
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
      children: async (args: any) => {
        const listed = await sessionListDomain(v2Context).list({ parentID: sessionRef(args).sessionID })
        return { data: unwrapList(listed) }
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
