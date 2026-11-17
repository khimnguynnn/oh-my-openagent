import { describe, expect, it } from "bun:test"
import {
  createV2PermissionProjector,
  dedupePermissionRules,
  toolFlagsToV2PermissionRules,
  toV2PermissionRules,
  type V2PermissionRule,
} from "../permission-adapter"

const V2_DEFAULT_RULES: V2PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
]

function effectsFor(rules: readonly V2PermissionRule[], action: string): V2PermissionRule[] {
  return rules.filter((rule) => rule.action === action)
}

function lastEffect(rules: readonly V2PermissionRule[], action: string, resource = "*"): string | undefined {
  const match = rules.findLast((rule) => rule.action === action && rule.resource === resource)
  return match?.effect
}

describe("toV2PermissionRules", () => {
  describe("#given a string effect for a tool name", () => {
    it("#when translating #then emits one wildcard-resource rule", () => {
      // given
      const permission = { look_at: "deny" }

      // when
      const rules = toV2PermissionRules(permission)

      // then
      expect(rules).toEqual([{ action: "look_at", resource: "*", effect: "deny" }])
    })
  })

  describe("#given a nested pattern map", () => {
    it("#when translating #then emits one rule per pattern with the pattern as resource", () => {
      // given
      const permission = { bash: { "git push": "deny", "npm *": "ask" } }

      // when
      const rules = toV2PermissionRules(permission)

      // then
      expect(rules).toContainEqual({ action: "bash", resource: "git push", effect: "deny" })
      expect(rules).toContainEqual({ action: "bash", resource: "npm *", effect: "ask" })
    })

    it("#when the pattern map contains a wildcard key #then it is emitted once as the wildcard rule", () => {
      // given
      const permission = { edit: { "*": "deny" } }

      // when
      const rules = toV2PermissionRules(permission)

      // then
      expect(rules).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
    })

    it("#when a V1-only tool name aliases onto a V2 action #then both the name and the alias are emitted", () => {
      // given
      const permission = { write: { "*": "deny" } }

      // when
      const rules = toV2PermissionRules(permission)

      // then
      expect(rules).toEqual([
        { action: "write", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "deny" },
      ])
    })
  })

  describe("#given a tool whose V2 action name differs from the V1 name", () => {
    it("#when the tool is task #then both task and subagent are governed", () => {
      // given
      const permission = { task: "allow" }

      // when
      const rules = toV2PermissionRules(permission)

      // then
      expect(lastEffect(rules, "task")).toBe("allow")
      expect(lastEffect(rules, "subagent")).toBe("allow")
    })

    it("#when the tool is bash #then both bash and shell are governed", () => {
      // given
      const permission = { bash: "deny" }

      // when
      const rules = toV2PermissionRules(permission)

      // then
      expect(lastEffect(rules, "bash")).toBe("deny")
      expect(lastEffect(rules, "shell")).toBe("deny")
    })

    it("#when the tool already matches its V2 action name #then no duplicate alias rule is emitted", () => {
      // given
      const permission = { shell: "deny" }

      // when
      const rules = toV2PermissionRules(permission)

      // then
      expect(rules).toEqual([{ action: "shell", resource: "*", effect: "deny" }])
    })
  })

  describe("#given values that are not a permission effect", () => {
    it("#when translating #then invalid effects and non-object inputs are dropped", () => {
      // given
      const permission = { edit: "sometimes", task: 42, look_at: "deny" }

      // when
      const rules = toV2PermissionRules(permission)

      // then
      expect(rules).toEqual([{ action: "look_at", resource: "*", effect: "deny" }])
    })

    it("#when the input is not an object #then nothing is emitted", () => {
      expect(toV2PermissionRules(undefined)).toEqual([])
      expect(toV2PermissionRules("deny")).toEqual([])
      expect(toV2PermissionRules([])).toEqual([])
    })
  })
})

describe("toolFlagsToV2PermissionRules", () => {
  describe("#given a global tools map", () => {
    it("#when translating #then disabled tools become wildcard deny rules and enabled tools become allow", () => {
      // given
      const tools = { "grep_app_*": false, "task_*": false, teammate: false, todowrite: true }

      // when
      const rules = toolFlagsToV2PermissionRules(tools)

      // then
      expect(rules).toContainEqual({ action: "grep_app_*", resource: "*", effect: "deny" })
      expect(rules).toContainEqual({ action: "task_*", resource: "*", effect: "deny" })
      expect(rules).toContainEqual({ action: "teammate", resource: "*", effect: "deny" })
      expect(rules).toContainEqual({ action: "todowrite", resource: "*", effect: "allow" })
    })

    it("#when a flag is not a boolean #then it is skipped", () => {
      // given
      const tools = { grep_app_any: false, broken: "yes" }

      // when
      const rules = toolFlagsToV2PermissionRules(tools)

      // then
      expect(rules).toEqual([{ action: "grep_app_any", resource: "*", effect: "deny" }])
    })
  })
})

describe("dedupePermissionRules", () => {
  describe("#given repeated identical rules", () => {
    it("#when deduping #then the first occurrence is kept in order", () => {
      // given
      const rules: V2PermissionRule[] = [
        { action: "task", resource: "*", effect: "deny" },
        { action: "task", resource: "*", effect: "allow" },
        { action: "task", resource: "*", effect: "deny" },
      ]

      // when
      const deduped = dedupePermissionRules(rules)

      // then
      expect(deduped).toEqual([
        { action: "task", resource: "*", effect: "deny" },
        { action: "task", resource: "*", effect: "allow" },
      ])
    })
  })
})

describe("createV2PermissionProjector", () => {
  describe("#given global rules and per-agent grants", () => {
    it("#when projecting #then the agent overrides win over the global deny", () => {
      // given
      const projector = createV2PermissionProjector({
        globalRules: toolFlagsToV2PermissionRules({ "task_*": false, "grep_app_*": false }),
      })
      const agent = { permissions: [...V2_DEFAULT_RULES] }

      // when
      projector.project("sisyphus", agent, { task: "allow", "task_*": "allow", call_omo_agent: "deny" })

      // then
      expect(lastEffect(agent.permissions, "task")).toBe("allow")
      expect(lastEffect(agent.permissions, "subagent")).toBe("allow")
      expect(lastEffect(agent.permissions, "call_omo_agent")).toBe("deny")
      expect(lastEffect(agent.permissions, "task_*")).toBe("allow")
    })

    it("#when an agent grants nothing for a globally denied tool #then the global deny stands", () => {
      // given
      const projector = createV2PermissionProjector({
        globalRules: toolFlagsToV2PermissionRules({ "task_*": false, "grep_app_*": false }),
      })
      const agent = { permissions: [...V2_DEFAULT_RULES] }

      // when
      projector.project("explore", agent, { task: "deny" })

      // then
      expect(lastEffect(agent.permissions, "task_*")).toBe("deny")
      expect(lastEffect(agent.permissions, "grep_app_*")).toBe("deny")
    })

    it("#when projecting #then the V2 default rules stay ahead of the projected rules", () => {
      // given
      const projector = createV2PermissionProjector({ globalRules: toV2PermissionRules({ webfetch: "deny" }) })
      const agent = { permissions: [...V2_DEFAULT_RULES] }

      // when
      projector.project("build", agent, undefined)

      // then
      expect(agent.permissions.slice(0, V2_DEFAULT_RULES.length)).toEqual(V2_DEFAULT_RULES)
      expect(lastEffect(agent.permissions, "read", "*.env")).toBe("ask")
      expect(lastEffect(agent.permissions, "webfetch")).toBe("deny")
    })

    it("#when the same agent is projected repeatedly #then the ruleset does not grow", () => {
      // given
      const projector = createV2PermissionProjector({
        globalRules: toolFlagsToV2PermissionRules({ "grep_app_*": false }),
      })
      const agent = { permissions: [...V2_DEFAULT_RULES] }
      const permission = { "grep_app_*": "allow", task: "allow" }

      // when
      const first = projector.project("librarian", agent, permission)
      const firstSnapshot = [...agent.permissions]
      const second = projector.project("librarian", agent, permission)
      const third = projector.project("librarian", agent, permission)

      // then
      expect(second).toBe(first)
      expect(third).toBe(first)
      expect(agent.permissions).toEqual(firstSnapshot)
    })

    it("#when two agents are projected #then each keeps its own base ruleset", () => {
      // given
      const projector = createV2PermissionProjector({ globalRules: [] })
      const librarian = { permissions: [...V2_DEFAULT_RULES] }
      const oracle = { permissions: [...V2_DEFAULT_RULES] }

      // when
      projector.project("librarian", librarian, { "grep_app_*": "allow" })
      projector.project("oracle", oracle, { task: "deny" })

      // then
      expect(effectsFor(librarian.permissions, "grep_app_*")).toEqual([
        { action: "grep_app_*", resource: "*", effect: "allow" },
      ])
      expect(effectsFor(oracle.permissions, "grep_app_*")).toEqual([])
      expect(lastEffect(oracle.permissions, "task")).toBe("deny")
    })

    it("#when an agent has no base ruleset #then the projection still produces valid rules", () => {
      // given
      const projector = createV2PermissionProjector({ globalRules: toV2PermissionRules({ webfetch: "allow" }) })
      const agent: { permissions?: V2PermissionRule[] } = {}

      // when
      projector.project("custom", agent, { task: "deny" })

      // then
      expect(agent.permissions).toEqual([
        { action: "webfetch", resource: "*", effect: "allow" },
        { action: "task", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" },
      ])
    })
  })
})
