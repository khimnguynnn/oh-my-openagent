import { describe, expect, it } from "bun:test"

import { computeView } from "./compute-view"
import { ACTIVITY_FRAMES, STATUS_DOT_GLYPH, STATUS_HISTORY_GLYPH, STATUS_STOPPED_GLYPH } from "./constants"
import { agentGlyph, agentLine, buildViewNodes, describeView, isAgentActive } from "./render-view"
import type { ComputeViewSections } from "./compute-view"
import type { AgentRow, SidebarView } from "./state-types"

const theme = {
  accent: "accent",
  borderSubtle: "border",
  error: "error",
  info: "info",
  success: "success",
  text: "text",
  textMuted: "muted",
  warning: "warning",
}

const activeSections: ComputeViewSections = {
  config: { kind: "invalid", messages: ["agents.sisyphus.model: expected string"] },
  roster: { kind: "empty" },
  agents: { kind: "list", agents: [{ name: "fixer", status: "busy" }] },
  jobs: { kind: "list", jobs: [{ title: "explore repo", status: "running", toolCalls: 3, lastTool: "grep" }] },
  loop: {
    kind: "live",
    goalsDone: 0,
    goalsTotal: 1,
    pass: 1,
    fail: 1,
    pending: 0,
    blocked: 0,
    activeGoal: "g1",
  },
}

describe("tui sidebar renderView", () => {
  it("#given active view #when building nodes #then it renders ULW agents jobs and invalid banner in order", () => {
    // given
    const view = computeView(activeSections)

    // when
    const description = describeView(view)
    const nodes = buildViewNodes(view, theme)

    // then
    expect(description).toContain("config invalid")
    expect(description.indexOf("ULW")).toBeLessThan(description.indexOf("Agents"))
    expect(description.indexOf("Agents")).toBeLessThan(description.indexOf("Jobs"))
    expect(description).toContain("0/1")
    expect(description).toContain("pass 1")
    expect(description).toContain("fail 1")
    expect(description).toContain("fixer")
    expect(description).toContain("explore repo")
    expect(nodes[0]?.kind).toBe("box")
  })

  it("#given a redacted active goal #when describing #then it reports the active goal as private", () => {
    // given
    const view = computeView({
      ...activeSections,
      loop: { ...activeSections.loop, activeGoal: null },
    })

    // when
    const description = describeView(view)

    // then
    expect(description).toContain("active private")
    expect(description).not.toContain("active none")
  })

  it("#given broken view #when describing #then it includes config invalid and run doctor", () => {
    // given
    const view = computeView({
      config: { kind: "invalid", messages: ["agents.sisyphus.model: expected string"] },
      roster: { kind: "empty" },
      agents: { kind: "none" },
      jobs: { kind: "none" },
      loop: { kind: "none" },
    })

    // when
    const description = describeView(view)

    // then
    expect(view.kind).toBe("broken")
    expect(description).toContain("config invalid")
    expect(description).toContain("run doctor")
    expect(description).toContain("agents.sisyphus.model")
  })

  it("#given idle roster #when rendering #then it lists configured model rows", () => {
    // given
    const view: SidebarView = {
      kind: "idle",
      roster: { kind: "rows", rows: [{ label: "sisyphus", model: "gpt-5.5" }] },
    }

    // when
    const description = describeView(view)
    const nodes = buildViewNodes(view, theme)

    // then
    expect(description).toContain("sisyphus")
    expect(description).toContain("gpt-5.5")
    expect(nodes[0]?.kind).toBe("box")
  })
})

describe("tui sidebar agent rows", () => {
  const running: AgentRow = { name: "oracle", status: "running", sessionID: "s-1" }

  it("#given a running agent #when asking for a glyph #then it steps through the spinner frames", () => {
    // given
    const frames = [0, 1, 2, ACTIVITY_FRAMES.length]

    // when
    const glyphs = frames.map((frame) => agentGlyph(running, frame))

    // then
    expect(glyphs[0]).toBe(ACTIVITY_FRAMES[0])
    expect(glyphs[1]).toBe(ACTIVITY_FRAMES[1])
    expect(glyphs[2]).toBe(ACTIVITY_FRAMES[2])
    expect(glyphs[3]).toBe(ACTIVITY_FRAMES[0])
  })

  it("#given rows that are not running #when asking for a glyph #then the glyph names their terminal state", () => {
    // given
    const idle: AgentRow = { name: "oracle", status: "idle" }
    const ran: AgentRow = { name: "oracle", status: "idle", activeSince: 1_700_000_000_000 }
    const failed: AgentRow = { name: "oracle", status: "error", outcome: "failed" }

    // when
    const glyphs = [agentGlyph(idle), agentGlyph(ran), agentGlyph(failed)]

    // then
    expect(glyphs).toEqual([STATUS_DOT_GLYPH, STATUS_HISTORY_GLYPH, STATUS_STOPPED_GLYPH])
  })

  it("#given each active status #when checking #then only busy running and retry count as active", () => {
    // given
    const statuses = ["busy", "running", "retry", "idle", "error"] as const

    // when
    const active = statuses.map((status) => isAgentActive(status))

    // then
    expect(active).toEqual([true, true, true, false, false])
  })

  it("#given an agent with a model and a title #when building its line #then both columns appear after the glyph", () => {
    // given
    const row: AgentRow = { name: "oracle", status: "running", model: "gpt-5", title: "audit bridge" }

    // when
    const line = agentLine(row, "*")

    // then
    expect(line).toBe("* oracle gpt-5 audit bridge")
  })

  it("#given an agent with no model #when building its line #then the model column is omitted rather than left blank", () => {
    // given
    const row: AgentRow = { name: "oracle", status: "idle" }

    // when
    const line = agentLine(row, "*")

    // then
    expect(line).toBe("* oracle idle")
    expect(line).not.toContain("  ")
  })

  it("#given a model variant and an over-long model id #when building its line #then the pair is truncated to the column budget", () => {
    // given
    const row: AgentRow = {
      name: "oracle",
      status: "running",
      model: "a-very-long-model-identifier",
      variant: "max",
    }

    // when
    const line = agentLine(row, "*")
    const modelColumn = line.split(" ")[2] ?? ""

    // then
    expect(modelColumn.length).toBeLessThanOrEqual(16)
    expect(modelColumn.endsWith("...")).toBe(true)
  })

  it("#given a single-session agent and a click target #when building nodes #then the group row carries no handler", () => {
    // given
    const selected: string[] = []
    const view = computeView({ ...activeSections, agents: { kind: "list", agents: [running] } })

    // when
    const nodes = buildViewNodes(view, theme, { onSelectAgent: (id) => selected.push(id) })
    const row = firstTextWithRef(nodes, "group:oracle")

    // then
    expect(row).toBeDefined()
    expect(row?.props.onMouseDown).toBeUndefined()
  })

  it("#given an expanded group #when building nodes #then its session row carries a ref and navigates on click", () => {
    // given
    const selected: string[] = []
    const rows: AgentRow[] = [
      { name: "oracle", status: "running", sessionID: "s-1", title: "first" },
      { name: "oracle", status: "idle", sessionID: "s-2", title: "second" },
    ]
    const view = computeView({ ...activeSections, agents: { kind: "list", agents: rows } })

    // when
    const nodes = buildViewNodes(view, theme, {
      onSelectAgent: (id) => selected.push(id),
      expandedAgents: ["oracle"],
    })
    const row = firstTextWithRef(nodes, "agent:s-1")

    // then
    expect(row).toBeDefined()
    expect(row?.text).toContain("s-1")
    expect(typeof row?.props.onMouseDown).toBe("function")
    ;(row?.props.onMouseDown as () => void)()
    expect(selected).toEqual(["s-1"])
  })

  it("#given a collapsed group #when building nodes #then its session rows are hidden", () => {
    // given
    const rows: AgentRow[] = [
      { name: "oracle", status: "running", sessionID: "s-1" },
      { name: "oracle", status: "idle", sessionID: "s-2" },
    ]
    const view = computeView({ ...activeSections, agents: { kind: "list", agents: rows } })

    // when
    const nodes = buildViewNodes(view, theme, { onSelectAgent: () => undefined })

    // then
    expect(firstTextWithRef(nodes, "agent:s-1")).toBeUndefined()
    expect(firstTextWithRef(nodes, "group:oracle")).toBeDefined()
  })

  it("#given multiple sessions of one agent #when building nodes #then one row shows the count", () => {
    // given
    const rows: AgentRow[] = [
      { name: "explore", status: "running", sessionID: "s-1" },
      { name: "explore", status: "running", sessionID: "s-2" },
      { name: "explore", status: "idle", sessionID: "s-3" },
      { name: "explore", status: "idle", sessionID: "s-4" },
    ]
    const view = computeView({ ...activeSections, agents: { kind: "list", agents: rows } })

    // when
    const nodes = buildViewNodes(view, theme)
    const row = firstTextWithRef(nodes, "group:explore")

    // then
    expect(row?.text).toContain("explore ·4")
  })

  it("#given a measured width #when building nodes #then the row fits that width", () => {
    // given
    const rows: AgentRow[] = [
      { name: "a-very-long-agent-name-that-would-wrap", status: "running", sessionID: "s-1" },
    ]
    const view = computeView({ ...activeSections, agents: { kind: "list", agents: rows } })

    // when
    const narrow = firstTextWithRef(buildViewNodes(view, theme, { width: 24 }), "group:a-very-long-agent-name-that-would-wrap")
    const wide = firstTextWithRef(buildViewNodes(view, theme, { width: 80 }), "group:a-very-long-agent-name-that-would-wrap")

    // then
    expect(narrow?.text?.length).toBeLessThan(wide?.text?.length ?? 0)
    expect(narrow?.text).toContain("...")
  })

  it("#given an agent naming a theme token #when building nodes #then that token colours the row", () => {
    // given
    const coloured: AgentRow = { name: "oracle", status: "idle", color: "accent" }
    const unknown: AgentRow = { name: "oracle", status: "idle", color: "not-a-token" }
    const errored: AgentRow = { name: "oracle", status: "error" }

    // when
    const accentFg = firstTextContaining(agentNodesOf([coloured]), "oracle")
    const fallbackFg = firstTextContaining(agentNodesOf([unknown]), "oracle")
    const errorFg = firstTextContaining(agentNodesOf([errored]), "oracle")

    // then
    expect(accentFg?.props.fg).toBe(theme.accent)
    expect(fallbackFg?.props.fg).toBe(theme.text)
    expect(errorFg?.props.fg).toBe(theme.error)
  })
})

function firstTextWithRef(nodes: readonly ViewNode[], ref: string): ViewNode | undefined {
  for (const node of nodes) {
    if (node.kind === "text" && node.ref === ref) return node
    const hit = firstTextWithRef(node.children ?? [], ref)
    if (hit !== undefined) return hit
  }
  return undefined
}

function agentNodesOf(agents: readonly AgentRow[]): readonly ViewNode[] {
  return buildViewNodes(computeView({ ...activeSections, agents: { kind: "list", agents } }), theme)
}

function firstTextContaining(nodes: readonly ViewNode[], value: string): ViewNode | undefined {
  for (const node of nodes) {
    if (node.kind === "text" && node.text?.includes(value) === true) return node
    const hit = firstTextContaining(node.children ?? [], value)
    if (hit !== undefined) return hit
  }
  return undefined
}
