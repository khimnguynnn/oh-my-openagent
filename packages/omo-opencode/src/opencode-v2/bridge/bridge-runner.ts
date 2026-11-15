import type { Context } from "@opencode/plugin/promise/plugin"
import type { PluginInput } from "@opencode-ai/plugin"
import { createPluginModule } from "../../testing/create-plugin-module"
import { log } from "../../shared/logger"
import { createV1ClientFromV2Context } from "./client-adapter"
import { bindToolsToV2 } from "./tool-adapter"
import { bindSessionHooksToV2 } from "./session-adapter"

export type BridgeCleanup = () => Promise<void>

/**
 * Boots the full OMO runtime and binds it into OpenCode V2.
 */
export async function setupOpenCodeV2Bridge(v2Context: Context): Promise<BridgeCleanup> {
  log("[v2-bridge] initializing OMO compatibility bridge for OpenCode V2", {
    directory: v2Context.location.directory,
  })

  // 1. Create V1-compatible client shim wrapping V2 domains
  const v1Client = createV1ClientFromV2Context(v2Context)

  // 2. Synthesize PluginInput for OMO's staged serverPlugin
  const pluginInput: PluginInput = {
    client: v1Client,
    project: { id: "opencode-v2-project" } as any,
    directory: String(v2Context.location.directory),
    worktree: String(v2Context.location.directory),
    experimental_workspace: {
      register: () => {},
    },
    serverUrl: new URL("http://localhost:4096"),
    $: (() => {}) as any,
  }

  // 3. Initialize OMO plugin module
  const pluginModule = createPluginModule()
  const v1Hooks = (await pluginModule.server(pluginInput)) as any

  log("[v2-bridge] OMO V1 runtime initialized successfully. Registering V2 adapters...", {
    toolCount: Object.keys(v1Hooks.tool ?? {}).length,
  })

  const allDisposers: Array<() => Promise<void>> = []

  // 4. Bind Tools and Tool Hooks
  if (v1Hooks.tool) {
    const toolDisposers = await bindToolsToV2({
      v2Context,
      v1Tools: v1Hooks.tool,
      v1Hooks,
    })
    allDisposers.push(...toolDisposers)
  }

  // 5. Bind Session Lifecycle Hooks
  const sessionDisposers = await bindSessionHooksToV2({
    v2Context,
    v1Hooks,
  })
  allDisposers.push(...sessionDisposers)

  // 6. Bind Event Subscription
  if (typeof v1Hooks.event === "function") {
    try {
      const abortController = new AbortController()
      const eventSubscription = v2Context.event.subscribe({ signal: abortController.signal })

      // Consume async iterable event stream in background
      void (async () => {
        try {
          for await (const event of eventSubscription) {
            if (abortController.signal.aborted) break
            await v1Hooks.event(event)
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
