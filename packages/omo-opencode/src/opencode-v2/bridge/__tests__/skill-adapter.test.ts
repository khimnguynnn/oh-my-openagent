import { describe, expect, it } from "bun:test"
import { bindRuntimeSkillsToV2, stripFrontmatter, toV2SkillInfo } from "../skill-adapter"

const FRONTMATTER_MARKDOWN = [
  "---",
  "name: security-research",
  'description: "Team Mode security research skill."',
  "---",
  "",
  "# Security Research",
  "",
  "Body line.",
].join("\n")

function createMockSkillContext(options: { existing?: string[] } = {}) {
  const existing = new Set(options.existing ?? [])
  const stored = new Map<string, Record<string, unknown>>()
  for (const id of existing) {
    stored.set(id, { id, name: id, description: "pre-existing", path: `skill://${id}/SKILL.md`, content: "# Existing" })
  }

  const editor = {
    list: () => [...stored.values()],
    get: (id: string) => stored.get(id),
    add: (skill: Record<string, unknown>) => {
      stored.set(String(skill.id), skill)
    },
    update: () => {},
    remove: (id: string) => {
      stored.delete(id)
    },
  }

  const transformCalls: Array<(editor: typeof editor) => void> = []
  const context = {
    skill: {
      transform: async (callback: (editor: typeof editor) => void) => {
        transformCalls.push(callback)
        callback(editor)
        return { dispose: async () => {} }
      },
    },
  }

  return { context, editor, stored, transformCalls, rerun: () => transformCalls.forEach((cb) => cb(editor)) }
}

const silentLog = () => {}

describe("stripFrontmatter", () => {
  describe("#given markdown carrying a leading frontmatter block", () => {
    it("#when stripping #then only the body remains", () => {
      // given
      const markdown = FRONTMATTER_MARKDOWN

      // when
      const body = stripFrontmatter(markdown)

      // then
      expect(body).toBe("# Security Research\n\nBody line.")
      expect(body.startsWith("---")).toBe(false)
    })
  })

  describe("#given markdown with no frontmatter block", () => {
    it("#when stripping #then the text is returned unchanged", () => {
      // given
      const markdown = "# Heading\n\nNo frontmatter here."

      // when
      const body = stripFrontmatter(markdown)

      // then
      expect(body).toBe(markdown)
    })
  })

  describe("#given a frontmatter opener with no closer", () => {
    it("#when stripping #then the text is returned unchanged rather than truncated", () => {
      // given
      const markdown = "---\nname: broken"

      // when
      const body = stripFrontmatter(markdown)

      // then
      expect(body).toBe(markdown)
    })
  })
})

describe("toV2SkillInfo", () => {
  describe("#given an emitted runtime skill entry", () => {
    it("#when mapping #then it produces the host record shape with a skill:// path", () => {
      // given
      const entry = {
        name: "security-research",
        description: "Team Mode security research skill.",
        markdown: FRONTMATTER_MARKDOWN,
      }

      // when
      const info = toV2SkillInfo(entry)

      // then
      expect(info.id).toBe("security-research")
      expect(info.name).toBe("security-research")
      expect(info.description).toBe("Team Mode security research skill.")
      expect(info.path).toBe("skill://security-research/SKILL.md")
      expect(info.content).toBe("# Security Research\n\nBody line.")
    })
  })
})

describe("bindRuntimeSkillsToV2", () => {
  describe("#given both security skills are enabled", () => {
    it("#when binding #then both are registered with body-only content", async () => {
      // given
      const { context, stored } = createMockSkillContext()

      // when
      const disposers = await bindRuntimeSkillsToV2({
        v2Context: context as never,
        pluginConfig: {},
        log: silentLog,
      })

      // then
      expect(disposers.length).toBe(1)
      expect([...stored.keys()].sort()).toEqual(["security-research", "security-review"])
      expect(String((stored.get("security-research") as { content: unknown }).content)).toContain(
        "# Security Research",
      )
      expect(String((stored.get("security-research") as { content: unknown }).content).startsWith("---")).toBe(false)
    })
  })

  describe("#given security-research is disabled", () => {
    it("#when binding #then only security-review is registered", async () => {
      // given
      const { context, stored } = createMockSkillContext()

      // when
      await bindRuntimeSkillsToV2({
        v2Context: context as never,
        pluginConfig: { disabled_skills: ["security-research"] },
        log: silentLog,
      })

      // then
      expect([...stored.keys()]).toEqual(["security-review"])
    })
  })

  describe("#given both security skills are disabled", () => {
    it("#when binding #then nothing is registered and no transform runs", async () => {
      // given
      const { context, stored, transformCalls } = createMockSkillContext()

      // when
      const disposers = await bindRuntimeSkillsToV2({
        v2Context: context as never,
        pluginConfig: { disabled_skills: ["security-research", "security-review"] },
        log: silentLog,
      })

      // then
      expect(disposers).toEqual([])
      expect(stored.size).toBe(0)
      expect(transformCalls.length).toBe(0)
    })
  })

  describe("#given the transform re-runs on a later skill-list recompute", () => {
    it("#when re-running #then the registered set does not grow", async () => {
      // given
      const { context, stored, rerun } = createMockSkillContext()
      await bindRuntimeSkillsToV2({ v2Context: context as never, pluginConfig: {}, log: silentLog })
      const firstKeys = [...stored.keys()].sort()

      // when
      rerun()
      rerun()

      // then
      expect([...stored.keys()].sort()).toEqual(firstKeys)
      expect(stored.size).toBe(2)
    })

    it("#when binding #then the log reports what was added, not the state of a later pass", async () => {
      // given
      const { context, rerun } = createMockSkillContext()
      const logged: Array<unknown> = []
      const captureLog = (_message: string, data?: unknown) => {
        logged.push(data)
      }

      // when
      await bindRuntimeSkillsToV2({ v2Context: context as never, pluginConfig: {}, log: captureLog })

      // then
      expect(logged).toHaveLength(1)
      expect((logged[0] as { registered: string[] }).registered).toEqual(["security-research", "security-review"])
      expect((logged[0] as { selected: string[] }).selected).toEqual(["security-research", "security-review"])

      // when the host recomputes and every record is already present
      rerun()

      // then no second line is emitted for a pass that added nothing
      expect(logged).toHaveLength(1)
    })
  })

  describe("#given a host that registers the callback and runs it later", () => {
    it("#when transform resolves before the first run #then the log is emitted from the first pass", async () => {
      // given a domain whose transform stores the callback instead of invoking it
      const stored = new Map<string, Record<string, unknown>>()
      const logged: Array<unknown> = []
      let deferred: ((editor: unknown) => void) | undefined
      const context = {
        skill: {
          transform: async (callback: (editor: unknown) => void) => {
            deferred = callback
            return { dispose: async () => {} }
          },
        },
      }
      const editor = {
        list: () => [...stored.values()],
        get: (id: string) => stored.get(id),
        add: (skill: Record<string, unknown>) => stored.set(String(skill.id), skill),
      }

      // when
      await bindRuntimeSkillsToV2({
        v2Context: context as never,
        pluginConfig: {},
        log: (_m, data) => logged.push(data),
      })

      // then nothing is claimed before the host actually runs the callback
      expect(stored.size).toBe(0)
      expect(logged).toHaveLength(0)

      // when the host runs it
      deferred?.(editor)

      // then the real work and the honest log both happen
      expect(stored.size).toBe(2)
      expect(logged).toHaveLength(1)
      expect((logged[0] as { registered: string[] }).registered).toEqual(["security-research", "security-review"])
    })
  })

  describe("#given a skill with the same id already exists", () => {
    it("#when binding #then the existing skill is kept instead of overwritten", async () => {
      // given
      const { context, stored } = createMockSkillContext({ existing: ["security-research"] })

      // when
      await bindRuntimeSkillsToV2({ v2Context: context as never, pluginConfig: {}, log: silentLog })

      // then
      expect(String((stored.get("security-research") as { description: unknown }).description)).toBe("pre-existing")
      expect(stored.has("security-review")).toBe(true)
    })
  })
})
