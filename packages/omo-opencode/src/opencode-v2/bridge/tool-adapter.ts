import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin"
import { z } from "zod"
import { log } from "../../shared/logger"

export type V1ToolMap = Record<string, ToolDefinition>

export interface V1ToolHooks {
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: Record<string, unknown> },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID?: string; args?: Record<string, unknown> },
    output: { title: string; output: string; metadata: Record<string, unknown> } | undefined,
  ) => Promise<void>
}

/**
 * Normalizes input schema for OpenCode V2.
 * Supports StandardSchemaV1 (Zod), JSON schema, raw Zod field mappings, or defaults to an empty object schema.
 */
function normalizeInputSchema(rawSchema: unknown): any {
  if (rawSchema && typeof rawSchema === "object") {
    // If it's already a StandardSchemaV1 or Effect Schema or JSON schema with properties
    if ("~standard" in rawSchema || "type" in rawSchema || "_def" in rawSchema) {
      return rawSchema
    }
    // If it's a map of field schemas (e.g. { name: z.string(), ... } from OMO V1 tools)
    const values = Object.values(rawSchema)
    if (values.length > 0 && values.every((v) => v && typeof v === "object" && ("_def" in v || "~standard" in v))) {
      return z.object(rawSchema as Record<string, z.ZodTypeAny>)
    }
  }
  return {
    type: "object",
    properties: {},
  }
}

/**
 * Binds OMO V1 tools and tool execution hooks to OpenCode V2.
 */
export async function bindToolsToV2(args: {
  v2Context: Context
  v1Tools: V1ToolMap
  v1Hooks: V1ToolHooks
}): Promise<Array<() => Promise<void>>> {
  const { v2Context, v1Tools, v1Hooks } = args
  const disposers: Array<() => Promise<void>> = []

  // 1. Register tools in V2 tool domain via transform
  const toolTransformRegistration = await v2Context.tool.transform((editor) => {
    for (const [name, definition] of Object.entries(v1Tools)) {
      try {
        editor.add({
          name,
          description: definition.description ?? "",
          input: normalizeInputSchema(definition.args),
          execute: async (input: unknown, toolCtx) => {
            const v1ToolContext = {
              sessionID: String(toolCtx.sessionID),
              messageID: String(toolCtx.messageID),
              agent: String(toolCtx.agent),
              directory: String(v2Context.location.directory),
              worktree: String(v2Context.location.directory),
              abort: () => {},
              metadata: () => {},
              ask: async () => {},
              signal: toolCtx.signal,
            }
            try {
              const result = await definition.execute(input as Record<string, unknown>, v1ToolContext as any)
              if (typeof result === "string") {
                return { content: result }
              }
              if (result && typeof result === "object") {
                if ("content" in result || "output" in result) {
                  return result as any
                }
                return { content: JSON.stringify(result) }
              }
              return { content: result ? String(result) : "" }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              log(`[v2-bridge:tool] execution error in ${name}:`, { error: message })
              throw error
            }
          },
        })
      } catch (err) {
        log(`[v2-bridge:tool] failed to register tool ${name}:`, { error: String(err) })
      }
    }
  })
  disposers.push(() => toolTransformRegistration.dispose())

  // 2. Register tool.execute.before hook
  if (v1Hooks["tool.execute.before"]) {
    const beforeHandler = v1Hooks["tool.execute.before"]
    const beforeRegistration = await v2Context.tool.hook("execute.before", async (event) => {
      const v1Input = {
        tool: event.tool,
        sessionID: String(event.sessionID),
        callID: String(event.id),
      }
      const v1Output = {
        args: (event.input as Record<string, unknown>) ?? {},
      }
      await beforeHandler(v1Input, v1Output)
      event.input = v1Output.args
    })
    disposers.push(() => beforeRegistration.dispose())
  }

  // 3. Register tool.execute.after hook
  if (v1Hooks["tool.execute.after"]) {
    const afterHandler = v1Hooks["tool.execute.after"]
    const afterRegistration = await v2Context.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return

      const v1Input = {
        tool: event.tool,
        sessionID: String(event.sessionID),
        callID: String(event.id),
        args: (event.input as Record<string, unknown>) ?? {},
      }
      const rawContent = event.result.content
      const initialOutput =
        typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(event.result.output ?? rawContent ?? "")

      const v1Output = {
        title: "",
        output: initialOutput,
        metadata: ((event.result.metadata as Record<string, unknown>) ?? {}) as Record<string, unknown>,
      }

      await afterHandler(v1Input, v1Output)

      // Apply modifications back to V2 event result
      event.result = {
        ...event.result,
        content: v1Output.output,
        metadata: v1Output.metadata,
      }
    })
    disposers.push(() => afterRegistration.dispose())
  }

  return disposers
}
