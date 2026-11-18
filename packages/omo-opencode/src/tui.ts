import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

import { registerBtwSideTui } from "./features/btw-side"
import { registerNativeEditionNudgeTui } from "./features/native-edition-nudge"
import { viewKey } from "./features/tui-sidebar/compute-view"
import { POLL_INTERVAL_MS } from "./features/tui-sidebar/constants"
import { materialize } from "./features/tui-sidebar/materialize"
import { loadPluginValidation, readView } from "./features/tui-sidebar/read-view"
import { buildViewNodes } from "./features/tui-sidebar/render-view"
import { opencodeV2Tui } from "./opencode-v2/tui-entry"
import { log } from "./shared/logger"
import { trackLoadedPluginSandbox } from "./hooks/auto-update-checker/checker/sandbox-refresh"

export { materialize } from "./features/tui-sidebar/materialize"
export { readView } from "./features/tui-sidebar/read-view"

type SidebarSlotRegistration<Node> = {
  readonly order: number
  readonly slots: {
    readonly sidebar_content: () => Node | (() => Node)
  }
}

type RegisterSidebarContentSlotInput<Node> = {
  readonly registerSlot: (registration: SidebarSlotRegistration<Node>) => void
  readonly requestRender: () => void
  readonly renderSidebar: () => Node
}

export function registerSidebarContentSlot<Node>({
  registerSlot,
  requestRender,
  renderSidebar,
}: RegisterSidebarContentSlotInput<Node>): void {
  registerSlot({
    order: 900,
    slots: {
      sidebar_content: () => renderSidebar,
    },
  })
  requestRender()
}

export function handleTuiPollError(
  error: unknown,
  reportPollError: (error: Error) => void = (pollError) => log("[tui-sidebar] polling failed", { error: pollError }),
): void {
  if (error instanceof Error) {
    reportPollError(error)
    return
  }
  throw error
}

const module: TuiPluginModule = {
  id: "oh-my-openagent:tui",
  tui: async (api) => {
    // The TUI plugin runs on OpenCode's main thread, the only thread that
    // emits `exit`; it applies a sandbox refresh the server plugin requested.
    trackLoadedPluginSandbox()

    const solid = await import("@opentui/solid").catch(() => null)
    if (!solid) {
      return
    }

    try {
      await registerBtwSideTui(api, solid)
    } catch (error) {
      log("[btw-side] TUI registration failed", { error })
    }

    try {
      registerNativeEditionNudgeTui(api as never)
    } catch (error) {
      log("[native-edition-nudge] TUI registration failed", { error })
    }

    const directory = api.state.path.directory
    if ((await loadPluginValidation(directory)).config.tui?.sidebar?.enabled === false) {
      return
    }

    let currentView = await readView(directory)
    let currentKey = viewKey(currentView)
    let disposed = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null

    registerSidebarContentSlot({
      registerSlot: (registration) => {
        api.slots.register(registration)
      },
      requestRender: () => {
        api.renderer.requestRender()
      },
      renderSidebar: () => materialize(buildViewNodes(currentView, api.theme.current), solid),
    })

    const schedule = (): void => {
      timer = setTimeout(tick, POLL_INTERVAL_MS)
    }

    const tick = async (): Promise<void> => {
      if (disposed || inFlight) {
        if (!disposed) schedule()
        return
      }
      inFlight = true
      try {
        const nextView = await readView(directory)
        const nextKey = viewKey(nextView)
        if (nextKey !== currentKey) {
          currentView = nextView
          currentKey = nextKey
          api.renderer.requestRender()
        }
      } catch (error) {
        handleTuiPollError(error)
      } finally {
        inFlight = false
        if (!disposed) schedule()
      }
    }

    schedule()
    api.lifecycle.onDispose(() => {
      disposed = true
      if (timer) clearTimeout(timer)
    })
  },
}

export default { ...module, setup: opencodeV2Tui.setup }
