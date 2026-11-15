import type { Context } from "@opencode/plugin/promise/plugin"
import { log } from "../../shared/logger"

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
        // V2 session.context retrieves current messages/context
        try {
          const ctx = await v2Context.session.context(id)
          return { data: ctx?.messages ?? [] }
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
        const id = args?.path?.id ?? args?.id
        const prompt = args?.body?.prompt ?? args?.prompt
        const result = await v2Context.session.prompt(id, prompt)
        return { data: result }
      },
      promptAsync: async (args: any) => {
        const id = args?.path?.id ?? args?.id
        const prompt = args?.body?.prompt ?? args?.prompt
        const result = await v2Context.session.prompt(id, prompt)
        return { data: result }
      },
      children: async () => {
        return { data: [] }
      },
    },
    app: {
      agents: async () => {
        try {
          const agents = await v2Context.agent.list()
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
