import { applyLiveAgents, viewKey } from "../features/tui-sidebar/compute-view"
import { ACTIVITY_FRAME_MS, POLL_INTERVAL_MS } from "../features/tui-sidebar/constants"
import { materializeTree } from "../features/tui-sidebar/materialize"
import type { SolidRuntime } from "../features/tui-sidebar/materialize"
import { isSidebarEnabled, readView } from "../features/tui-sidebar/read-view"
import { agentGlyph, agentLine, buildViewNodes, isAgentActive } from "../features/tui-sidebar/render-view"
import type { ThemeLike } from "../features/tui-sidebar/render-view"
import type { AgentRow, SidebarView } from "../features/tui-sidebar/state-types"
import { log } from "../shared/logger"
import { adaptV2Theme } from "./theme-adapter"

/**
 * The slice of the V2 TUI context this HUD needs. Declared structurally so tests
 * can drive it without constructing a host context.
 */
/** What V2 passes to a `sidebar.content` render. The slot only paints inside a session. */
export type SidebarSlotInput = { readonly sessionID?: string }

export type SidebarSlotHost = {
  readonly theme: ThemeLike
  readonly ui: {
    readonly slot: (claim: {
      readonly append: "sidebar.content"
      readonly render: (input?: SidebarSlotInput) => unknown
    }) => () => void
  }
  /** Present on the real host; absent in tests that do not animate. */
  readonly renderer?: { readonly requestRender: () => void }
}

export type SidebarHudOptions = {
  readonly directory: string
  readonly host: SidebarSlotHost
  readonly solid: SolidRuntime<unknown>
  readonly isEnabled?: (directory: string) => Promise<boolean>
  readonly readView?: (directory: string) => Promise<SidebarView>
  /**
   * Agent rows from the live TUI context. On V2 the mirror cannot supply them: the bridge's
   * `session.status()` returns an empty object, so the snapshot's `activeAgents` is always empty.
   */
  readonly readAgents?: (sessionID?: string) => readonly AgentRow[]
  readonly onSelectAgent?: (sessionID: string) => void
  readonly intervalMs?: number
  readonly frameMs?: number
  readonly onPollError?: (error: Error) => void
}

export type SidebarHud = {
  readonly dispose: () => void
}

type Timer = ReturnType<typeof setTimeout>

const AGENT_REF_PREFIX = "agent:"

/**
 * V2 calls a slot's `render` once and keeps the returned node tree, so a changed
 * view cannot be pushed through the same claim. Re-claiming runs the registry's
 * subscription, which is the host's own re-render path. The spinner is the exception:
 * it mutates the mounted text node and asks the renderer to repaint, so an animation
 * frame never costs a re-claim.
 */
export async function startSidebarHud({
  directory,
  host,
  solid,
  isEnabled = isSidebarEnabled,
  readView: read = readView,
  readAgents,
  onSelectAgent,
  intervalMs = POLL_INTERVAL_MS,
  frameMs = ACTIVITY_FRAME_MS,
  onPollError = () => undefined,
}: SidebarHudOptions): Promise<SidebarHud | null> {
  if (!(await isEnabled(directory))) {
    log("[v2-bridge:sidebar] skipped, disabled by config", { directory })
    return null
  }

  let current = withLiveAgents(await read(directory), readAgents)
  let currentKey = viewKey(current)
  let disposed = false
  let inFlight = false
  let timer: Timer | null = null
  let frameTimer: Timer | null = null
  let release: (() => void) | null = null
  let frames = 0
  let mounted: ReadonlyMap<string, unknown> = new Map()

  const claim = (view: SidebarView): (() => void) =>
    host.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        try {
          const tree = materializeTree(
            buildViewNodes(viewForRender(view, readAgents, input?.sessionID), adaptV2Theme(host.theme), selectOptions(onSelectAgent)),
            solid,
          )
          mounted = tree.refs
          log("[v2-bridge:sidebar] rendered", { view: view.kind })
          return tree.root
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

  const activeRows = (view: SidebarView): readonly AgentRow[] =>
    view.kind === "active" && view.agents.kind === "list" ? view.agents.agents : []

  const animate = (): void => {
    frameTimer = null
    if (disposed) return
    const rows = activeRows(current).filter((row) => isAgentActive(row.status) && row.sessionID !== undefined)
    if (rows.length > 0 && host.renderer !== undefined) {
      frames += 1
      for (const row of rows) {
        const node = mounted.get(`${AGENT_REF_PREFIX}${row.sessionID}`)
        if (node === undefined) continue
        solid.setProp(node, "content", agentLine(row, agentGlyph(row, frames)))
      }
      host.renderer.requestRender()
    }
    if (rows.length > 0) frameTimer = setTimeout(animate, frameMs)
  }

  const scheduleFrames = (): void => {
    if (disposed || frameTimer !== null) return
    if (!activeRows(current).some((row) => isAgentActive(row.status))) return
    frameTimer = setTimeout(animate, frameMs)
  }

  const dispose = (): void => {
    disposed = true
    if (timer !== null) clearTimeout(timer)
    if (frameTimer !== null) clearTimeout(frameTimer)
    timer = null
    frameTimer = null
    mounted = new Map()
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
      const next = withLiveAgents(await read(directory), readAgents)
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
      scheduleFrames()
    }
  }

  schedule()
  scheduleFrames()

  return { dispose }
}

/**
 * The render input is the only place the hosting session is known, so the agent scope is
 * resolved there. Without it the section would list every session in the directory.
 */
function viewForRender(
  view: SidebarView,
  readAgents: ((sessionID?: string) => readonly AgentRow[]) | undefined,
  sessionID: string | undefined,
): SidebarView {
  return withLiveAgents(view, readAgents, sessionID)
}

function selectOptions(onSelectAgent: ((sessionID: string) => void) | undefined) {
  return onSelectAgent === undefined ? {} : { onSelectAgent }
}

/**
 * The context owns agents on V2 because the mirror cannot see them. Jobs and the loop keep
 * coming from the mirror, which still works for both.
 */
function withLiveAgents(
  view: SidebarView,
  readAgents: ((sessionID?: string) => readonly AgentRow[]) | undefined,
  sessionID?: string,
): SidebarView {
  if (readAgents === undefined) return view
  let rows: readonly AgentRow[]
  try {
    rows = readAgents(sessionID)
  } catch (error) {
    log("[v2-bridge:sidebar] agent source threw", {
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    })
    return view
  }
  return applyLiveAgents(view, rows)
}
