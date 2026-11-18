import type { Context } from "@opencode/plugin/promise/plugin"
import { log } from "../../shared/logger"

function isPlainRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDisabled(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { enabled?: unknown }).enabled === false
}

export interface V2McpAdapterOptions {
  v2Context: Context
  directory: string
  mcps: Record<string, unknown>
}

/**
 * Projects OMO's merged MCP map into OpenCode V2.
 *
 * The map is `config.mcp` as written by `applyMcpConfig`, which has already merged the four tiers
 * (built-in, Claude Code `.mcp.json`, the user's own config, plugin components) and applied both
 * `disabled_mcps` and the user's `enabled: false` markers. Resolving MCPs here as well would create a
 * second source of truth that silently disagrees with the first: the V1 pipeline's answer is the only
 * one the host would have seen on V1.
 */
export async function bindMcpToV2(options: V2McpAdapterOptions): Promise<Array<() => Promise<void>>> {
  const { v2Context, directory, mcps } = options
  const disposers: Array<() => Promise<void>> = []

  try {
    let reported = false
    const registration = await v2Context.mcp.transform((editor) => {
      const registered: string[] = []
      for (const [name, config] of Object.entries(mcps)) {
        if (!config || typeof config !== "object") continue

        // `applyMcpConfig` deletes the names in `disabled_mcps` but leaves the user's `enabled: false`
        // entries in place, so a projection that only inspected `type` would register a server the
        // user explicitly turned off.
        if (isDisabled(config)) continue

        // If the server is already registered in OpenCode config, do not overwrite
        if (editor.get(name) !== undefined) {
          continue
        }

        // V2 validates each server config against a strict schema: an explicit `undefined` for an
        // optional object field is a hard SchemaError, and a throw here makes OpenCode disable the
        // whole plugin ("disabled plugin after transform failure"). Omit absent fields entirely.
        const mcpType = (config as { type?: unknown }).type
        if (mcpType === "remote" && (config as { url?: unknown }).url) {
          const headers = (config as { headers?: Record<string, string> }).headers
          editor.set(name, {
            type: "remote",
            url: String((config as { url: string }).url),
            ...(isPlainRecord(headers) ? { headers } : {}),
            oauth: false,
          } as any)
        } else if (mcpType === "local" && Array.isArray((config as { command?: unknown }).command)) {
          const environment = (config as { environment?: Record<string, string> }).environment
          editor.set(name, {
            type: "local",
            command: (config as { command: string[] }).command,
            cwd: (config as { cwd?: string }).cwd ?? directory,
            ...(isPlainRecord(environment) ? { environment } : {}),
          } as any)
        } else {
          continue
        }

        registered.push(name)
      }

      // V2 registers the callback and runs it later, once per registry recompute, so a log emitted
      // right after `transform` resolves reports an empty list for a projection that succeeded. Only
      // the first pass can describe what this binder actually did.
      if (!reported) {
        reported = true
        log("[v2-bridge:mcp] projected OMO MCP servers into OpenCode V2", {
          candidates: Object.keys(mcps).length,
          registered,
        })
      }
    })

    disposers.push(() => registration.dispose())
  } catch (err) {
    log("[v2-bridge:mcp] failed to bind MCP servers:", { error: String(err) })
  }

  return disposers
}
