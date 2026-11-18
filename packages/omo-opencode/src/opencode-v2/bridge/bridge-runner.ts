import type { Context } from "@opencode/plugin/promise/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import { createPluginModule } from "../../testing/create-plugin-module"
import { loadPluginConfig } from "../../plugin-config"
import { log } from "../../shared/logger"
import { createV1ClientFromV2Context } from "./client-adapter"
import { bindToolsToV2 } from "./tool-adapter"
import { bindSessionHooksToV2 } from "./session-adapter"
import { bindMcpToV2 } from "./mcp-adapter"
import { bindConfigToV2 } from "./config-adapter"
import { bindRuntimeSkillsToV2 } from "./skill-adapter"
import { readV2ProviderCatalog, summarizeV1ProviderConfig, toV1ProviderConfig, type V2ModelInfoLike } from "./provider-adapter"

export type BridgeCleanup = () => Promise<void>

/**
 * V2 gives plugins no shell runner (`ctx.shell` carries only `hook`), so the V1 `$` helper has
 * no implementation here. Callers already fall back to `child_process.execFile` when `$` is not
 * callable, which a no-op function would defeat: it would be accepted as a runner and then fail
 * with `undefined is not an object (evaluating 'command.nothrow')`.
 */
const SHELL_UNAVAILABLE = undefined as unknown as PluginInput["$"]

/**
 * V2 exposes typed domains and never tells a plugin the HTTP server URL, so there is nothing to
 * advertise here. A guessed URL is worse than none: session listing builds an SDK client from it,
 * the host binds an arbitrary port so the connection is refused, that error is classified as
 * "unavailable", and the reader silently degrades to OpenCode's legacy JSON storage, which V2
 * never writes. That is why every session list came back empty. Leaving it undefined routes those
 * reads through the V1 client shim instead. The tmux manager keeps its own
 * `localhost:${OPENCODE_PORT ?? 4096}` fallback, and the live-server route reports itself
 * unavailable, which is the truth.
 */
const SERVER_URL_UNAVAILABLE = undefined as unknown as PluginInput["serverUrl"]

/**
 * Boots the full OMO runtime and binds it into OpenCode V2.
 */
export async function setupOpenCodeV2Bridge(v2Context: Context): Promise<BridgeCleanup> {
  const directory = String(v2Context.location.directory)
  log("[v2-bridge] initializing OMO compatibility bridge for OpenCode V2", {
    directory,
  })

  // 1. Create V1-compatible client shim wrapping V2 domains
  const v1Client = createV1ClientFromV2Context(v2Context)

  // 2. Synthesize PluginInput for OMO's staged serverPlugin
  const pluginInput: PluginInput = {
    client: v1Client,
    project: { id: "opencode-v2-project" } as any,
    directory,
    worktree: directory,
    experimental_workspace: {
      register: () => {},
    },
    serverUrl: SERVER_URL_UNAVAILABLE,
    $: SHELL_UNAVAILABLE,
  }

  // 3. Initialize OMO plugin module
  const pluginModule = createPluginModule()
  const v1Hooks = (await pluginModule.server(pluginInput)) as any

  log("[v2-bridge] OMO V1 runtime initialized successfully. Registering V2 adapters...", {
    toolCount: Object.keys(v1Hooks.tool ?? {}).length,
  })

  const allDisposers: Array<() => Promise<void>> = []

  // 4. Execute V1 Config Pipeline and bind to V2 (agent, command, provider)
  const v1Config: Record<string, unknown> = {}
  const rawPluginConfig = loadPluginConfig(directory, {})
  let providerModels: readonly V2ModelInfoLike[] | undefined
  if (typeof v1Hooks.config === "function") {
    try {
      // Phase 1 reads `config.provider` to build the context-limit cache, the image-capable model
      // set, and the Anthropic 1M flag. Nothing else in the pipeline writes it, so on V2 this seed
      // is the only input phase 1 ever sees.
      const catalog = await readV2ProviderCatalog(v2Context)
      if (catalog) {
        const seededProviderConfig = toV1ProviderConfig(catalog)
        v1Config.provider = seededProviderConfig
        providerModels = catalog.models
        log(
          "[v2-bridge:provider] seeded V1 provider config from the V2 catalog",
          summarizeV1ProviderConfig(seededProviderConfig),
        )
      }

      log("[v2-bridge] executing OMO V1 config pipeline for directory", { directory })
      await v1Hooks.config(v1Config)

      const configDisposers = await bindConfigToV2({
        v2Context,
        v1Config,
        rawPluginConfig,
        providerModels,
      })
      allDisposers.push(...configDisposers)
    } catch (err) {
      log("[v2-bridge:config] error during config pipeline execution:", { error: String(err) })
    }
  }

  // 4b. Register OMO's code-only skills (security-research / security-review).
  // V1 exposed them by starting an HTTP source server and appending its URL to `config.skills.urls`,
  // but V2 has no `config` domain and the bridge never reads `skills`, so that handoff is dead here.
  // V2 has a real `skill.add`, so the entries are registered directly instead.
  try {
    const skillDisposers = await bindRuntimeSkillsToV2({
      v2Context,
      pluginConfig: rawPluginConfig,
      log,
    })
    allDisposers.push(...skillDisposers)
  } catch (err) {
    log("[v2-bridge:skill] failed to register runtime security skills:", { error: String(err) })
  }

  // 5. Bind Tools and Tool Hooks
  if (v1Hooks.tool) {
    const toolDisposers = await bindToolsToV2({
      v2Context,
      v1Tools: v1Hooks.tool,
      v1Hooks,
    })
    allDisposers.push(...toolDisposers)
  }

  // 6. Bind Session Lifecycle Hooks
  const sessionDisposers = await bindSessionHooksToV2({
    v2Context,
    v1Hooks,
  })
  allDisposers.push(...sessionDisposers)

  // 7. Bind MCP Servers
  if (v2Context.mcp) {
    const mcpDisposers = await bindMcpToV2({
      v2Context,
      directory,
    })
    allDisposers.push(...mcpDisposers)
  }

  // 8. Bind Event Subscription with proper V1 EventInput adaptation
  if (typeof v1Hooks.event === "function") {
    try {
      const abortController = new AbortController()
      const eventSubscription = v2Context.event.subscribe({ signal: abortController.signal })

      // Consume async iterable event stream in background
      void (async () => {
        try {
          for await (const rawEvent of eventSubscription) {
            if (abortController.signal.aborted) break
            const data = (rawEvent as any).data ?? {}
            const v1Event = {
              type: rawEvent.type,
              properties: {
                ...(typeof data === "object" ? data : {}),
                sessionID: data?.sessionID ?? data?.id ?? (rawEvent as any).sessionID,
                session: data?.session ?? data,
                ...((rawEvent as any).metadata ?? {}),
              },
            }
            await v1Hooks.event({ event: v1Event })
          }
        } catch (err) {
          if (!abortController.signal.aborted) {
            log("[v2-bridge:event] event stream error:", { error: String(err) })
          }
        }
      })()

      allDisposers.push(async () => {
        abortController.abort()
      })
    } catch (err) {
      log("[v2-bridge:event] failed to subscribe to V2 event stream:", { error: String(err) })
    }
  }

  log("[v2-bridge] OpenCode V2 bridge fully wired and active")

  // Return cleanup function
  return async () => {
    log("[v2-bridge] disposing OMO V2 bridge registrations...")
    for (const dispose of allDisposers) {
      try {
        await dispose()
      } catch (err) {
        log("[v2-bridge] disposer error:", { error: String(err) })
      }
    }
    if (typeof v1Hooks.dispose === "function") {
      try {
        await v1Hooks.dispose()
      } catch (err) {
        log("[v2-bridge] v1Hooks dispose error:", { error: String(err) })
      }
    }
    log("[v2-bridge] OMO V2 bridge disposed")
  }
}
