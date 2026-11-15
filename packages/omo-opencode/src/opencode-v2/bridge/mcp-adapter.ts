import type { Context } from "@opencode/plugin/promise/plugin"
import { createBuiltinMcps } from "../../mcp"
import { loadMcpConfigs } from "../../features/claude-code-mcp-loader"
import { log } from "../../shared/logger"

export interface V2McpAdapterOptions {
  v2Context: Context
  directory: string
  disabledMcps?: string[]
}

/**
 * Binds OMO built-in MCP servers and Claude Code .mcp.json servers into OpenCode V2.
 */
export async function bindMcpToV2(options: V2McpAdapterOptions): Promise<Array<() => Promise<void>>> {
  const { v2Context, directory, disabledMcps = [] } = options
  const disposers: Array<() => Promise<void>> = []

  try {
    // 1. Resolve built-in MCP configurations
    const builtinMcps = createBuiltinMcps(disabledMcps, undefined, { cwd: directory })

    // 2. Resolve optional Claude Code .mcp.json configurations
    let claudeMcps: Record<string, unknown> = {}
    try {
      const loaded = await loadMcpConfigs(disabledMcps)
      claudeMcps = (loaded.servers ?? {}) as Record<string, unknown>
    } catch {
      // Claude Code config optional
    }

    const allMcps: Record<string, unknown> = {
      ...builtinMcps,
      ...claudeMcps,
    }

    // 3. Register via v2Context.mcp.transform
    const registration = await v2Context.mcp.transform((editor) => {
      for (const [name, config] of Object.entries(allMcps)) {
        if (!config || typeof config !== "object") continue

        // If the server is already registered in OpenCode config, do not overwrite
        if (editor.get(name) !== undefined) {
          continue
        }

        const mcpType = (config as { type?: unknown }).type
        if (mcpType === "remote" && (config as { url?: unknown }).url) {
          editor.set(name, {
            type: "remote",
            url: String((config as { url: string }).url),
            headers: (config as { headers?: Record<string, string> }).headers,
            oauth: false,
          } as any)
        } else if (mcpType === "local" && Array.isArray((config as { command?: unknown }).command)) {
          editor.set(name, {
            type: "local",
            command: (config as { command: string[] }).command,
            cwd: (config as { cwd?: string }).cwd ?? directory,
            environment: (config as { environment?: Record<string, string> }).environment,
          } as any)
        }
      }
    })

    disposers.push(() => registration.dispose())
    log("[v2-bridge:mcp] registered OMO MCP servers in OpenCode V2", {
      count: Object.keys(allMcps).length,
    })
  } catch (err) {
    log("[v2-bridge:mcp] failed to bind MCP servers:", { error: String(err) })
  }

  return disposers
}
