import { describe, expect, test } from "bun:test"

import { MAX_AGENTS } from "../features/tui-sidebar/constants"
import { readAgentRows, type AgentDataSource, type AgentSessionInfo } from "./agent-source"

function source(input: {
  sessions: readonly AgentSessionInfo[]
  statuses?: Readonly<Record<string, "idle" | "running">>
  family?: readonly string[]
  agents?: readonly { id: string; name?: string; color?: string }[] | undefined
}): AgentDataSource {
  return {
    session: {
      list: () => input.sessions,
      status: (id) => input.statuses?.[id] ?? "idle",
      family: () => input.family ?? [],
    },
    location: {
      agent: {
        list: () => input.agents,
      },
    },
  }
}

describe("readAgentRows", () => {
  describe("#given a running and an idle session", () => {
    test("#then the running one sorts first and carries the running status", () => {
      // given
      const data = source({
        sessions: [
          { id: "s1", agent: "oracle", title: "idle work" },
          { id: "s2", agent: "explore", title: "live work" },
        ],
        statuses: { s2: "running" },
      })

      // when
      const rows = readAgentRows({ data })

      // then
      expect(rows.map((row) => row.name)).toEqual(["explore", "oracle"])
      expect(rows[0]?.status).toBe("running")
      expect(rows[1]?.status).toBe("idle")
    })
  })

  describe("#given agent metadata from the location collection", () => {
    test("#then the display name and colour come from it", () => {
      // given
      const data = source({
        sessions: [{ id: "s1", agent: "oracle" }],
        agents: [{ id: "oracle", name: "Oracle", color: "info" }],
      })

      // when
      const rows = readAgentRows({ data })

      // then
      expect(rows[0]?.name).toBe("Oracle")
      expect(rows[0]?.color).toBe("info")
    })
  })

  describe("#given the agent collection returns undefined", () => {
    test("#then the row degrades to the agent id instead of throwing", () => {
      // given
      const data = source({ sessions: [{ id: "s1", agent: "oracle" }], agents: undefined })

      // when
      const rows = readAgentRows({ data })

      // then
      expect(rows[0]?.name).toBe("oracle")
      expect(rows[0]?.color).toBeUndefined()
    })
  })

  describe("#given a model with a variant", () => {
    test("#then both are carried through", () => {
      // given
      const data = source({
        sessions: [{ id: "s1", agent: "hephaestus", model: { id: "gpt-5", variant: "high" } }],
      })

      // when
      const rows = readAgentRows({ data })

      // then
      expect(rows[0]?.model).toBe("gpt-5")
      expect(rows[0]?.variant).toBe("high")
    })
  })

  describe("#given a failed outcome", () => {
    test("#then the row reports the error status, which colours it red", () => {
      // given
      const data = source({ sessions: [{ id: "s1", agent: "oracle", outcome: "failed" }] })

      // when
      const rows = readAgentRows({ data })

      // then
      expect(rows[0]?.status).toBe("error")
      expect(rows[0]?.outcome).toBe("failed")
    })
  })

  describe("#given a session family", () => {
    test("#then only that family is listed", () => {
      // given
      const data = source({
        sessions: [{ id: "root" }, { id: "child" }, { id: "stranger" }],
        family: ["root", "child"],
      })

      // when
      const rows = readAgentRows({ data, sessionID: "root" })

      // then
      expect(rows.map((row) => row.sessionID)).toEqual(["child", "root"])
    })
  })

  describe("#given more sessions than the cap", () => {
    test("#then only MAX_AGENTS rows survive", () => {
      // given
      const sessions = Array.from({ length: MAX_AGENTS + 4 }, (_, index) => ({ id: `s${index}` }))

      // when
      const rows = readAgentRows({ data: source({ sessions }) })

      // then
      expect(rows).toHaveLength(MAX_AGENTS)
    })
  })

  describe("#given a session with no title", () => {
    test("#then the row has no title so the renderer falls back to the status word", () => {
      // given
      const data = source({ sessions: [{ id: "s1", agent: "oracle" }] })

      // when
      const rows = readAgentRows({ data })

      // then
      expect(rows[0]?.title).toBeUndefined()
      expect(rows[0]?.sessionID).toBe("s1")
    })
  })
})
