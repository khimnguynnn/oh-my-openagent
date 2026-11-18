import { describe, expect, test } from "bun:test"
import { groupAgents, groupBusy, leadSession } from "./group-agents"
import type { AgentRow } from "./state-types"

const running = (name: string, sessionID: string, title?: string): AgentRow => ({
  name,
  status: "running",
  sessionID,
  ...(title === undefined ? {} : { title }),
})

const idle = (name: string, sessionID: string): AgentRow => ({ name, status: "idle", sessionID })

describe("groupAgents", () => {
  describe("#given a single session", () => {
    test("#then it yields one group holding that session", () => {
      expect(groupAgents([running("explore", "ses_a")])).toEqual([
        { name: "explore", sessions: [running("explore", "ses_a")] },
      ])
    })
  })

  describe("#given four sessions of the same agent", () => {
    test("#then they collapse into one group of four", () => {
      const groups = groupAgents([
        running("explore", "ses_a"),
        running("explore", "ses_b"),
        running("explore", "ses_c"),
        running("explore", "ses_d"),
      ])
      expect(groups).toHaveLength(1)
      expect(groups[0]?.sessions).toHaveLength(4)
    })
  })

  describe("#given mixed agents and statuses", () => {
    test("#then the busiest group comes first", () => {
      const groups = groupAgents([idle("oracle", "ses_a"), running("explore", "ses_b")])
      expect(groups.map((group) => group.name)).toEqual(["explore", "oracle"])
    })

    test("#then sessions inside a group put the busiest first", () => {
      const groups = groupAgents([idle("explore", "ses_z"), running("explore", "ses_a")])
      expect(groups[0]?.sessions.map((session) => session.sessionID)).toEqual(["ses_a", "ses_z"])
    })
  })

  describe("#given an empty input", () => {
    test("#then there are no groups", () => {
      expect(groupAgents([])).toEqual([])
    })
  })
})

describe("leadSession", () => {
  test("returns the first session of the group", () => {
    const groups = groupAgents([idle("explore", "ses_z"), running("explore", "ses_a")])
    const group = groups[0]
    if (group === undefined) throw new Error("expected a group")
    expect(leadSession(group).sessionID).toBe("ses_a")
  })
})

describe("groupBusy", () => {
  test("is true when any session still runs", () => {
    const groups = groupAgents([idle("explore", "ses_a"), running("explore", "ses_b")])
    const group = groups[0]
    if (group === undefined) throw new Error("expected a group")
    expect(groupBusy(group)).toBe(true)
  })

  test("is false when every session is idle", () => {
    const groups = groupAgents([idle("explore", "ses_a")])
    const group = groups[0]
    if (group === undefined) throw new Error("expected a group")
    expect(groupBusy(group)).toBe(false)
  })
})
