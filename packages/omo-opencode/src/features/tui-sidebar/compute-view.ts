import { assertNever } from "./state-types"
import type {
  AgentRow,
  AgentsState,
  ConfigState,
  JobBoardState,
  LoopLive,
  LoopState,
  RosterState,
  SidebarView,
} from "./state-types"

export type ComputeViewSections = {
  readonly config: ConfigState
  readonly roster: RosterState
  readonly agents: AgentsState
  readonly jobs: JobBoardState
  readonly loop: LoopState
}

export function computeView(sections: ComputeViewSections): SidebarView {
  if (isActive(sections)) {
    return {
      kind: "active",
      loop: sections.loop,
      agents: sections.agents,
      jobs: sections.jobs,
      configBanner: sections.config.kind === "invalid" ? { kind: "invalid" } : { kind: "none" },
    }
  }

  if (sections.config.kind === "invalid") {
    return { kind: "broken", messages: sections.config.messages }
  }

  return { kind: "idle", roster: sections.roster }
}

/**
 * Folds agent rows from the live TUI context into an already computed view. On V2 the mirror
 * reports no agents at all (the bridge's `session.status()` is empty), so without this a
 * session with no ULW loop and no jobs would sit on the idle roster and never show agents.
 */
export function applyLiveAgents(view: SidebarView, rows: readonly AgentRow[]): SidebarView {
  const agents: AgentsState = rows.length === 0 ? { kind: "none" } : { kind: "list", agents: rows }
  if (view.kind === "active") return { ...view, agents }
  if (rows.length === 0) return view
  return {
    kind: "active",
    loop: { kind: "none" },
    agents,
    jobs: { kind: "none" },
    configBanner: view.kind === "broken" ? { kind: "invalid" } : { kind: "none" },
  }
}

export function viewKey(view: SidebarView): string {
  switch (view.kind) {
    case "active":
      return stableKey([
        "active",
        loopKeyParts(view.loop),
        agentsKeyParts(view.agents),
        jobsKeyParts(view.jobs),
        ["configBanner", view.configBanner.kind],
      ])
    case "broken":
      return stableKey(["broken", [...view.messages]])
    case "idle":
      return stableKey(["idle", rosterKeyParts(view.roster)])
    default:
      return assertNever(view)
  }
}

function isActive(sections: ComputeViewSections): boolean {
  return sections.agents.kind === "list" || sections.jobs.kind === "list" || sections.loop.kind === "live"
}

function stableKey(parts: readonly unknown[]): string {
  return JSON.stringify(parts)
}

function rosterKeyParts(roster: RosterState): readonly unknown[] {
  switch (roster.kind) {
    case "empty":
      return ["roster", "empty"]
    case "rows":
      return ["roster", "rows", roster.rows.map((row) => [row.label, row.model])]
    default:
      return assertNever(roster)
  }
}

function agentsKeyParts(agents: AgentsState): readonly unknown[] {
  switch (agents.kind) {
    case "none":
      return ["agents", "none"]
    case "list":
      // activeSince is excluded on purpose: the glyph reads it, the animation timer owns the
      // repaint, and keying on it would re-claim the slot on every frame.
      return [
        "agents",
        "list",
        agents.agents.map((agent) => [
          agent.name,
          agent.status,
          agent.model ?? "",
          agent.variant ?? "",
          agent.color ?? "",
          agent.title ?? "",
          agent.sessionID ?? "",
          agent.outcome ?? "",
          agent.activeSince === undefined ? "" : "ran",
        ]),
      ]
    default:
      return assertNever(agents)
  }
}

function jobsKeyParts(jobs: JobBoardState): readonly unknown[] {
  switch (jobs.kind) {
    case "none":
      return ["jobs", "none"]
    case "list":
      return ["jobs", "list", jobs.jobs.map((job) => [job.title, job.status, job.toolCalls, job.lastTool])]
    default:
      return assertNever(jobs)
  }
}

function loopKeyParts(loop: LoopState): readonly unknown[] {
  switch (loop.kind) {
    case "none":
      return ["loop", "none"]
    case "live":
      return ["loop", "live", liveLoopKeyParts(loop)]
    default:
      return assertNever(loop)
  }
}

function liveLoopKeyParts(loop: LoopLive): readonly unknown[] {
  return [loop.goalsDone, loop.goalsTotal, loop.pass, loop.fail, loop.pending, loop.blocked, loop.activeGoal]
}
