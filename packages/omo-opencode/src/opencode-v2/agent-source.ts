import { MAX_AGENTS } from "../features/tui-sidebar/constants"
import type { AgentOutcome, AgentRow, AgentStatus } from "../features/tui-sidebar/state-types"

/**
 * The slice of the V2 TUI data context this adapter reads. Declared structurally so the source
 * needs no host context in tests and no `@opencode/plugin` import in this module.
 */
export type AgentDataSource = {
  readonly session: {
    readonly list: () => readonly AgentSessionInfo[]
    readonly status: (sessionID: string) => "idle" | "running"
    readonly family: (sessionID: string) => readonly string[]
  }
  readonly location: {
    readonly agent: {
      readonly list: () => readonly AgentInfoLike[] | undefined
    }
  }
}

export type AgentSessionInfo = {
  readonly id: string
  readonly parentID?: string
  readonly agent?: string
  readonly model?: { readonly id: string; readonly variant?: string }
  readonly title?: string
  readonly outcome?: AgentOutcome
  readonly time?: { readonly busy?: number; readonly created?: number }
}

export type AgentInfoLike = {
  readonly id: string
  readonly name?: string
  readonly color?: string
}

export type ReadAgentRowsInput = {
  readonly data: AgentDataSource
  /** Restrict rows to this session's family. Omitted means every session the context lists. */
  readonly sessionID?: string
}

/**
 * Agent rows come from the TUI context, not from the mirror snapshot: on V2 the bridge's
 * `session.status()` returns an empty object, so the mirror's `activeAgents` is always empty.
 */
export function readAgentRows(input: ReadAgentRowsInput): readonly AgentRow[] {
  const { data, sessionID } = input
  const agentsByID = agentIndex(data.location.agent.list())
  const family = sessionID === undefined ? undefined : new Set(data.session.family(sessionID))
  const rows: AgentRow[] = []
  for (const session of data.session.list()) {
    if (family !== undefined && !family.has(session.id)) continue
    rows.push(toAgentRow(session, data.session.status(session.id), agentsByID))
  }
  return capAgents(rows)
}

function agentIndex(agents: readonly AgentInfoLike[] | undefined): ReadonlyMap<string, AgentInfoLike> {
  const index = new Map<string, AgentInfoLike>()
  for (const agent of agents ?? []) index.set(agent.id, agent)
  return index
}

function toAgentRow(
  session: AgentSessionInfo,
  status: "idle" | "running",
  agentsByID: ReadonlyMap<string, AgentInfoLike>,
): AgentRow {
  const agentID = session.agent
  const info = agentID === undefined ? undefined : agentsByID.get(agentID)
  const name = info?.name ?? agentID ?? session.title ?? session.id
  const color = info?.color
  const model = session.model
  const busy = session.time?.busy
  return {
    name,
    status: statusOf(status, session.outcome),
    ...(model === undefined ? {} : { model: model.id }),
    ...(model?.variant === undefined ? {} : { variant: model.variant }),
    ...(color === undefined ? {} : { color }),
    ...(session.title === undefined ? {} : { title: session.title }),
    sessionID: session.id,
    ...(busy === undefined ? {} : { activeSince: busy }),
    ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
  }
}

function statusOf(status: "idle" | "running", outcome: AgentOutcome | undefined): AgentStatus {
  if (status === "running") return "running"
  return outcome === "failed" ? "error" : "idle"
}

/** Active rows first so the agents the user is waiting on never fall below the fold. */
function capAgents(rows: readonly AgentRow[]): readonly AgentRow[] {
  const ordered = [...rows].sort((left, right) => {
    const byActivity = activityRank(left.status) - activityRank(right.status)
    return byActivity === 0 ? left.name.localeCompare(right.name) : byActivity
  })
  return ordered.slice(0, MAX_AGENTS)
}

function activityRank(status: AgentStatus): number {
  if (status === "running" || status === "busy") return 0
  if (status === "retry") return 1
  if (status === "error") return 2
  return 3
}
