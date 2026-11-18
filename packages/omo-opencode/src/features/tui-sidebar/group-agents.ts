import { MAX_AGENTS } from "./constants"
import type { AgentRow } from "./state-types"

/**
 * Sessions of one agent collapsed to a single sidebar row. Clicking the row reveals the
 * sessions, which is what makes a run of same-named subagents readable at sidebar width.
 */
export type AgentGroup = {
  readonly name: string
  readonly sessions: readonly AgentRow[]
}

const STATUS_RANK: Record<AgentRow["status"], number> = {
  running: 0,
  busy: 1,
  retry: 2,
  error: 3,
  idle: 4,
}

function rowRank(row: AgentRow): number {
  return STATUS_RANK[row.status]
}

function sessionKey(row: AgentRow): string {
  return row.sessionID ?? row.title ?? ""
}

/**
 * Groups rows by agent name, keeping the busiest session first inside a group and the
 * busiest group first overall. The cap counts groups, not sessions, so a burst of one
 * agent can no longer push every other agent out of the sidebar.
 */
export function groupAgents(rows: readonly AgentRow[]): AgentGroup[] {
  const buckets = new Map<string, AgentRow[]>()
  for (const row of rows) {
    const bucket = buckets.get(row.name)
    if (bucket === undefined) buckets.set(row.name, [row])
    else bucket.push(row)
  }

  const groups: AgentGroup[] = []
  for (const [name, sessions] of buckets) {
    const ordered = [...sessions].sort((left, right) => {
      const byStatus = rowRank(left) - rowRank(right)
      return byStatus !== 0 ? byStatus : sessionKey(left).localeCompare(sessionKey(right))
    })
    groups.push({ name, sessions: ordered })
  }

  groups.sort((left, right) => {
    const byStatus = groupRank(left) - groupRank(right)
    return byStatus !== 0 ? byStatus : left.name.localeCompare(right.name)
  })

  return groups.slice(0, MAX_AGENTS)
}

function groupRank(group: AgentGroup): number {
  return rowRank(leadSession(group))
}

export function leadSession(group: AgentGroup): AgentRow {
  return group.sessions[0]!
}

/** True while any session of the agent still runs, so the group row spins. */
export function groupBusy(group: AgentGroup): boolean {
  return group.sessions.some(
    (session) => session.status === "busy" || session.status === "running" || session.status === "retry",
  )
}
