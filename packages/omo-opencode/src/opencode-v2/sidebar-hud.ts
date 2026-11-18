import { viewKey } from "../features/tui-sidebar/compute-view"
import { POLL_INTERVAL_MS } from "../features/tui-sidebar/constants"
import { materialize } from "../features/tui-sidebar/materialize"
import type { SolidRuntime } from "../features/tui-sidebar/materialize"
import { isSidebarEnabled, readView } from "../features/tui-sidebar/read-view"
import { buildViewNodes } from "../features/tui-sidebar/render-view"
import type { ThemeLike } from "../features/tui-sidebar/render-view"
import type { SidebarView } from "../features/tui-sidebar/state-types"
import { log } from "../shared/logger"
import { adaptV2Theme } from "./theme-adapter"

/**
 * The slice of the V2 TUI context this HUD needs. Declared structurally so tests
 * can drive it without constructing a host context.
 */
export type SidebarSlotHost = {
  readonly theme: ThemeLike
  readonly ui: {
    readonly slot: (claim: {
      readonly append: "sidebar.content"
      readonly render: () => unknown
    }) => () => void
  }
}

export type SidebarHudOptions = {
  readonly directory: string
  readonly host: SidebarSlotHost
  readonly solid: SolidRuntime<unknown>
  readonly isEnabled?: (directory: string) => Promise<boolean>
  readonly readView?: (directory: string) => Promise<SidebarView>
  readonly intervalMs?: number
  readonly onPollError?: (error: Error) => void
}

export type SidebarHud = {
  readonly dispose: () => void
}

type Timer = ReturnType<typeof setTimeout>

/**
 * V2 calls a slot's `render` once and keeps the returned node tree, so a changed
 * view cannot be pushed through the same claim. Re-claiming runs the registry's
 * subscription, which is the host's own re-render path.
 */
export async function startSidebarHud({
  directory,
  host,
  solid,
  isEnabled = isSidebarEnabled,
  readView: read = readView,
  intervalMs = POLL_INTERVAL_MS,
  onPollError = () => undefined,
}: SidebarHudOptions): Promise<SidebarHud | null> {
  if (!(await isEnabled(directory))) {
    log("[v2-bridge:sidebar] skipped, disabled by config", { directory })
    return null
  }

  let current = await read(directory)
  let currentKey = viewKey(current)
  let disposed = false
  let inFlight = false
  let timer: Timer | null = null
  let release: (() => void) | null = null

  const claim = (view: SidebarView): (() => void) =>
    host.ui.slot({
      append: "sidebar.content",
      render: () => {
        try {
          const node = materialize(buildViewNodes(view, adaptV2Theme(host.theme)), solid)
          log("[v2-bridge:sidebar] rendered", { view: view.kind })
          return node
        } catch (error) {
          log("[v2-bridge:sidebar] render threw", {
            view: view.kind,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            stack: error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 6).join(" | ") : undefined,
          })
          throw error
        }
      },
    })

  release = claim(current)
  log("[v2-bridge:sidebar] claimed sidebar.content", { directory, view: current.kind })

  const dispose = (): void => {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    release?.()
    release = null
  }

  const schedule = (): void => {
    if (disposed) return
    timer = setTimeout(tick, intervalMs)
  }

  const tick = async (): Promise<void> => {
    timer = null
    if (disposed || inFlight) {
      schedule()
      return
    }
    inFlight = true
    try {
      const next = await read(directory)
      const nextKey = viewKey(next)
      if (nextKey !== currentKey && !disposed) {
        current = next
        currentKey = nextKey
        release?.()
        release = claim(current)
        log("[v2-bridge:sidebar] re-claimed sidebar.content", { view: current.kind })
      }
    } catch (error) {
      onPollError(error instanceof Error ? error : new Error(String(error)))
    } finally {
      inFlight = false
      schedule()
    }
  }

  schedule()

  return { dispose }
}
