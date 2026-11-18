import {
  ACTIVITY_FRAMES,
  AGENT_COLOR_TOKENS,
  AGENT_MODEL_MAX,
  LABEL_MAX,
  STATUS_DOT_GLYPH,
  STATUS_HISTORY_GLYPH,
  STATUS_STOPPED_GLYPH,
} from "./constants"
import { box, text } from "./element-helpers"
import type { ViewNode } from "./element-helpers"
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
  /** Click handler for an agent row. Absent leaves rows unclickable rather than a dead click. */
  readonly onSelectAgent?: (sessionID: string) => void
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
    case "list":
      return [section("Agents", theme, agents.agents.map((agent) => agentRowNode(agent, theme, options)))]
    default:
      return assertNever(agents)
  }
}

function agentRowNode(agent: AgentRow, theme: ThemeLike, options: ViewNodeOptions): ViewNode {
  const props: Record<string, unknown> = { fg: agentColor(agent, theme) }
  const sessionID = agent.sessionID
  if (sessionID !== undefined && options.onSelectAgent !== undefined) {
    const select = options.onSelectAgent
    props.onMouseDown = () => select(sessionID)
  }
  const ref = sessionID === undefined ? {} : { ref: `agent:${sessionID}` }
  return text(props, agentLine(agent, agentGlyph(agent)), ref)
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

export function agentGlyph(agent: AgentRow, frameIndex = 0): string {
  if (isAgentActive(agent.status)) return ACTIVITY_FRAMES[frameIndex % ACTIVITY_FRAMES.length] ?? ACTIVITY_FRAMES[0]!
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
      return ["Agents", ...agents.agents.map((agent) => `${agent.name} ${agent.status}`)]
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
  return value.length <= LABEL_MAX ? value : `${value.slice(0, LABEL_MAX - 3)}...`
}

function activeGoalLabel(activeGoal: string | null): string {
  return activeGoal ?? "private"
}
