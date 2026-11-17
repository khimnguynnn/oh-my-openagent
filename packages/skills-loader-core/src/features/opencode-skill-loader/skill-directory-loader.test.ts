import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { subscribeSkillDiagnostics, type SkillDiagnostic } from "./skill-provenance"
import { loadSkillsFromDir } from "./skill-directory-loader"

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-dir-loader-"))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

function collectDiagnostics(): { diagnostics: SkillDiagnostic[]; stop: () => void } {
  const diagnostics: SkillDiagnostic[] = []
  const stop = subscribeSkillDiagnostics((diagnostic) => diagnostics.push(diagnostic))
  return { diagnostics, stop }
}

describe("loadSkillsFromDir", () => {
  describe("#given an auto-discovered skill root that was never created", () => {
    it("#then it reports nothing, because a missing optional root is normal", async () => {
      // given a path inside a temp dir that does not exist
      const root = makeRoot()
      const missing = join(root, ".claude", "skills")
      const { diagnostics, stop } = collectDiagnostics()

      // when the loader walks it
      const skills = await loadSkillsFromDir({ skillsDir: missing, scope: "user" })
      stop()

      // then no skill loads and no warning is raised
      expect(skills).toEqual([])
      expect(diagnostics).toEqual([])
    })
  })

  describe("#given a skill root that exists and holds a skill", () => {
    it("#then the skill still loads", async () => {
      // given a directory holding one SKILL.md
      const root = makeRoot()
      const skillsDir = join(root, "skills")
      const skillDir = join(skillsDir, "alpha")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        join(skillDir, "SKILL.md"),
        ["---", "name: alpha", "description: Alpha skill", "---", "", "Body"].join("\n"),
        "utf8",
      )

      // when the loader walks it
      const skills = await loadSkillsFromDir({ skillsDir, scope: "user" })

      // then the skill is discovered
      expect(skills.map((skill) => skill.name)).toEqual(["alpha"])
    })
  })

  describe("#given a skill root that is a file rather than a directory", () => {
    it("#then it reports nothing, because ENOTDIR is an absent root too", async () => {
      // given a regular file standing where a directory is expected
      const root = makeRoot()
      const notADir = join(root, "skills")
      writeFileSync(notADir, "not a directory", "utf8")
      const { diagnostics, stop } = collectDiagnostics()

      // when the loader walks it
      const skills = await loadSkillsFromDir({ skillsDir: notADir, scope: "user" })
      stop()

      // then it stays silent instead of emitting a load error
      expect(skills).toEqual([])
      expect(diagnostics).toEqual([])
    })
  })
})
