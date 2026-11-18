import {
  ACTIVITY_FRAMES,
  AGENT_COLOR_TOKENS,
  AGENT_MODEL_MAX,
  AGENT_ROW_CHROME,
  LABEL_MAX,
  SECTION_CHROME,
  SESSION_ID_MAX,
  SIDEBAR_WIDTH_FALLBACK,
  STATUS_DOT_GLYPH,
  STATUS_HISTORY_GLYPH,
  STATUS_STOPPED_GLYPH,
} from "./constants"
import { box, text } from "./element-helpers"
import type { ViewNode } from "./element-helpers"
import { groupAgents, groupBusy, leadSession } from "./group-agents"
import type { AgentGroup } from "./group-agents"
import { assertNever } from "./state-types"
import type {
  AgentRow,
  AgentsState,
  ConfigBanner,
  JobBoardState,
  LoopState,
  RosterState,
  SidebarView,
} from "./state-types"

const LABEL_MIN = 6
const GROUP_REF_PREFIX = "group:"
const AGENT_REF_PREFIX = "agent:"

export type ThemeLike = {
  readonly error?: unknown
  readonly text?: unknown
  readonly textMuted?: unknown
  readonly warning?: unknown
  readonly success?: unknown
  readonly info?: unknown
  readonly accent?: unknown
  readonly borderSubtle?: unknown
}

export type ViewNodeOptions = {
  /** Click handler for a session row. Absent leaves rows unclickable rather than a dead click. */
  readonly onSelectAgent?: (sessionID: string) => void
  /** Click handler for a group row, which folds that agent's sessions open or shut. */
  readonly onToggleAgent?: (name: string) => void
  /** Agent names whose sessions are currently shown. */
  readonly expandedAgents?: readonly string[]
  /** Measured column width of the sidebar box, so detail text fits instead of wrapping. */
  readonly width?: number
}

export function buildViewNodes(
  view: SidebarView,
  theme: ThemeLike,
  options: ViewNodeOptions = {},
): ViewNode[] {
  switch (view.kind) {
    case "active":
      return [
        box({ flexDirection: "column", gap: 1 }, [
          ...configBannerNodes(view.configBanner, theme),
          ...loopNodes(view.loop, theme),
          ...agentNodes(view.agents, theme, options),
          ...jobNodes(view.jobs, theme),
        ]),
      ]
    case "broken":
      return brokenNodes(view.messages, theme)
    case "idle":
      return idleNodes(view.roster, theme)
    default:
      return assertNever(view)
  }
}

export function describeView(view: SidebarView): string {
  return linesForView(view).join("\n")
}

function linesForView(view: SidebarView): string[] {
  switch (view.kind) {
    case "active":
      return [
        ...configBannerLines(view.configBanner),
        ...loopLines(view.loop),
        ...agentLines(view.agents),
        ...jobLines(view.jobs),
      ]
    case "broken":
      return ["config invalid - run doctor", ...view.messages]
    case "idle":
      return rosterLines(view.roster)
    default:
      return assertNever(view)
  }
}

function configBannerNodes(banner: ConfigBanner, theme: ThemeLike): ViewNode[] {
  switch (banner.kind) {
    case "none":
      return []
    case "invalid":
      return [text({ fg: theme.warning }, "config invalid - run doctor")]
    default:
      return assertNever(banner)
  }
}

function configBannerLines(banner: ConfigBanner): string[] {
  switch (banner.kind) {
    case "none":
      return []
    case "invalid":
      return ["config invalid - run doctor"]
    default:
      return assertNever(banner)
  }
}

function loopNodes(loop: LoopState, theme: ThemeLike): ViewNode[] {
  switch (loop.kind) {
    case "none":
      return []
    case "live":
      return [
        section("ULW", theme, [
          text({ fg: theme.text }, `goals ${loop.goalsDone}/${loop.goalsTotal}`),
          text({ fg: theme.success }, `pass ${loop.pass}`),
          text({ fg: theme.error }, `fail ${loop.fail}`),
          text({ fg: theme.textMuted }, `pending ${loop.pending} blocked ${loop.blocked}`),
          text({ fg: theme.accent }, `active ${truncate(activeGoalLabel(loop.activeGoal))}`),
        ]),
      ]
    default:
      return assertNever(loop)
  }
}

function loopLines(loop: LoopState): string[] {
  switch (loop.kind) {
    case "none":
      return []
    case "live":
      return [
        "ULW",
        `goals ${loop.goalsDone}/${loop.goalsTotal}`,
        `pass ${loop.pass}`,
        `fail ${loop.fail}`,
        `pending ${loop.pending} blocked ${loop.blocked}`,
        `active ${activeGoalLabel(loop.activeGoal)}`,
      ]
    default:
      return assertNever(loop)
  }
}

function agentNodes(agents: AgentsState, theme: ThemeLike, options: ViewNodeOptions): ViewNode[] {
  switch (agents.kind) {
    case "none":
      return []
    case "list": {
      if (agents.agents.length === 0) return []
      const groups = groupAgents(agents.agents)
      const nodes: ViewNode[] = []
      for (const group of groups) {
        nodes.push(agentGroupNode(group, theme, options))
        if (!isExpanded(group.name, options)) continue
        for (const session of group.sessions) nodes.push(agentSessionNode(session, theme, options))
      }
      return [section("Agents", theme, nodes)]
    }
    default:
      return assertNever(agents)
  }
}

function isExpanded(name: string, options: ViewNodeOptions): boolean {
  const expanded = options.expandedAgents
  return expanded !== undefined && expanded.includes(name)
}

function agentGroupNode(group: AgentGroup, theme: ThemeLike, options: ViewNodeOptions): ViewNode {
  const lead = leadSession(group)
  const glyph = lead === undefined ? STATUS_DOT_GLYPH : agentGlyph(lead, 0, groupBusy(group))
  const props: Record<string, unknown> = { fg: lead === undefined ? theme.text : agentColor(lead, theme) }
  const toggle = options.onToggleAgent
  if (toggle !== undefined && group.sessions.length > 1) {
    props.onMouseDown = () => toggle(group.name)
  }
  const ref = { ref: `${GROUP_REF_PREFIX}${group.name}` }
  return text(props, agentGroupLine(group, glyph, detailWidth(options)), ref)
}

function agentSessionNode(session: AgentRow, theme: ThemeLike, options: ViewNodeOptions): ViewNode {
  const props: Record<string, unknown> = { fg: theme.textMuted }
  const sessionID = session.sessionID
  if (sessionID !== undefined && options.onSelectAgent !== undefined) {
    const select = options.onSelectAgent
    props.onMouseDown = () => select(sessionID)
  }
  const ref = sessionID === undefined ? {} : { ref: `${AGENT_REF_PREFIX}${sessionID}` }
  return text(props, agentSessionLine(session, detailWidth(options)), ref)
}

function detailWidth(options: ViewNodeOptions): number {
  const measured = options.width ?? SIDEBAR_WIDTH_FALLBACK
  return Math.max(LABEL_MIN, measured - SECTION_CHROME)
}

export function agentGroupLine(group: AgentGroup, glyph: string, width: number): string {
  const count = group.sessions.length > 1 ? ` ·${group.sessions.length}` : ""
  const name = truncateTo(group.name, Math.max(LABEL_MIN, width - AGENT_ROW_CHROME - count.length))
  return `${glyph} ${name}${count}`
}

export function agentSessionLine(session: AgentRow, width: number): string {
  const id = session.sessionID === undefined ? "" : truncateTo(shortSessionID(session.sessionID), SESSION_ID_MAX)
  const titleBudget = Math.max(LABEL_MIN, width - AGENT_ROW_CHROME - id.length)
  const detail = session.title === undefined ? session.status : session.title
  const label = id === "" ? `  ${truncateTo(detail, titleBudget)}` : `  ${id} ${truncateTo(detail, titleBudget)}`
  return label
}

function shortSessionID(sessionID: string): string {
  return sessionID.startsWith("ses_") ? sessionID.slice(4) : sessionID
}

export function agentLine(agent: AgentRow, glyph: string): string {
  const name = truncate(agent.name)
  const detail = agent.title === undefined ? agent.status : truncate(agent.title)
  const model = agent.model === undefined ? "" : modelLabel(agent.model, agent.variant)
  return model === "" ? `${glyph} ${name} ${detail}` : `${glyph} ${name} ${model} ${detail}`
}

function modelLabel(model: string, variant: string | undefined): string {
  const label = variant === undefined || variant === "" ? model : `${model}:${variant}`
  return label.length <= AGENT_MODEL_MAX ? label : `${label.slice(0, AGENT_MODEL_MAX - 3)}...`
}

export function agentGlyph(agent: AgentRow, frameIndex = 0, busy = isAgentActive(agent.status)): string {
  if (busy) return ACTIVITY_FRAMES[frameIndex % ACTIVITY_FRAMES.length] ?? ACTIVITY_FRAMES[0]!
  if (agent.outcome !== undefined) return STATUS_STOPPED_GLYPH
  return agent.activeSince === undefined ? STATUS_DOT_GLYPH : STATUS_HISTORY_GLYPH
}

export function isAgentActive(status: AgentRow["status"]): boolean {
  return status === "busy" || status === "running" || status === "retry"
}

function agentColor(agent: AgentRow, theme: ThemeLike): unknown {
  if (agent.status === "error") return theme.error
  if (agent.status === "retry") return theme.warning
  const named = agent.color
  if (named !== undefined && (AGENT_COLOR_TOKENS as readonly string[]).includes(named)) {
    const themed = theme[named as keyof ThemeLike]
    if (themed !== undefined) return themed
  }
  return theme.text
}

function agentLines(agents: AgentsState): string[] {
  switch (agents.kind) {
    case "none":
      return []
    case "list":
      return [
        "Agents",
        ...groupAgents(agents.agents).map((group) =>
          agentGroupLine(group, agentGlyph(leadSession(group), 0, groupBusy(group)), LABEL_MAX),
        ),
      ]
    default:
      return assertNever(agents)
  }
}

function jobNodes(jobs: JobBoardState, theme: ThemeLike): ViewNode[] {
  switch (jobs.kind) {
    case "none":
      return []
    case "list":
      return [
        section(
          "Jobs",
          theme,
          jobs.jobs.map((job) =>
            text(
              { fg: theme.text },
              `${truncate(job.title)} ${job.status} ${job.toolCalls ?? 0} ${job.lastTool ?? "none"}`,
            ),
          ),
        ),
      ]
    default:
      return assertNever(jobs)
  }
}

function jobLines(jobs: JobBoardState): string[] {
  switch (jobs.kind) {
    case "none":
      return []
    case "list":
      return jobs.jobs.flatMap((job) => [
        "Jobs",
        `${job.title} ${job.status} calls ${job.toolCalls ?? 0} last ${job.lastTool ?? "none"}`,
      ])
    default:
      return assertNever(jobs)
  }
}

function brokenNodes(messages: readonly string[], theme: ThemeLike): ViewNode[] {
  return [
    section("Config", theme, [
      text({ fg: theme.error }, "config invalid - run doctor"),
      ...messages.map((message) => text({ fg: theme.textMuted }, truncate(message))),
    ]),
  ]
}

function idleNodes(roster: RosterState, theme: ThemeLike): ViewNode[] {
  return [
    section(
      "Models",
      theme,
      rosterLines(roster).map((line) => text({ fg: theme.text }, line)),
    ),
  ]
}

function rosterLines(roster: RosterState): string[] {
  switch (roster.kind) {
    case "empty":
      return ["No configured models"]
    case "rows":
      return roster.rows.map((row) => `${row.label} ${row.model}`)
    default:
      return assertNever(roster)
  }
}

function section(title: string, theme: ThemeLike, children: readonly ViewNode[]): ViewNode {
  return box({ borderStyle: "single", borderColor: theme.borderSubtle, flexDirection: "column", padding: 1 }, [
    text({ fg: theme.info }, title),
    ...children,
  ])
}

function truncate(value: string): string {
  return truncateTo(value, LABEL_MAX)
}

function truncateTo(value: string, max: number): string {
  if (max <= 3) return value.slice(0, Math.max(0, max))
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}

function activeGoalLabel(activeGoal: string | null): string {
  return activeGoal ?? "private"
}
