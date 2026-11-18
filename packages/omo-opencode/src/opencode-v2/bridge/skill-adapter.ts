/**
 * Registers OMO's code-only skills on OpenCode V2.
 *
 * `security-research` and `security-review` live as `BuiltinSkill` objects rather than files, so the
 * host's own disk loader never sees them. V1 makes them visible by starting a small HTTP server and
 * appending its URL into `config.skills.urls`, which the host then fetches. Neither half survives V2:
 * the plugin context has no `config` domain, and the bridge never reads `skills` off the V1 config.
 * V2 instead exposes a real `skill.add` through its editor, so the entries are pushed straight in and
 * the URL round-trip is unnecessary.
 */

import type { Context } from "@opencode/plugin/promise/plugin"
import { selectRuntimeSecuritySkills } from "../../features/opencode-runtime-skills"
import type { RuntimeSkillSourceEntry } from "../../features/opencode-runtime-skills"

type V2SkillEditor = Parameters<Parameters<Context["skill"]["transform"]>[0]>[0]
type V2SkillInfo = Parameters<V2SkillEditor["add"]>[0]

const FRONTMATTER_DELIMITER = "---"

/**
 * Removes the leading YAML frontmatter block, because that is the shape the host itself reports for
 * every on-disk skill: `id`, `name` and `description` sit in their own fields and `content` is the
 * body alone. `createOpenCodeSkillMarkdown` always emits a block, so this is deterministic; a
 * template without one keeps its full text rather than losing the opening lines.
 */
export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith(FRONTMATTER_DELIMITER)) return markdown

  const rest = markdown.slice(FRONTMATTER_DELIMITER.length)
  const closingIndex = rest.indexOf(`\n${FRONTMATTER_DELIMITER}`)
  if (closingIndex === -1) return markdown

  const afterBlock = rest.slice(closingIndex + FRONTMATTER_DELIMITER.length + 1)
  return afterBlock.replace(/^(?:\r?\n)+/, "")
}

/**
 * Maps one emitted skill onto the record shape the V2 host stores.
 *
 * The `skill://<name>/SKILL.md` path form is what the host uses for its own file-less skills, so it
 * is the honest value here: these entries have no file behind them either. The cast is scoped to the
 * field rather than widening to `any`, since V2 brands these identifiers.
 */
export function toV2SkillInfo(entry: RuntimeSkillSourceEntry): V2SkillInfo {
  const info = {
    id: entry.name,
    name: entry.name,
    description: entry.description,
    path: `skill://${entry.name}/SKILL.md`,
    content: stripFrontmatter(entry.markdown),
  }
  return info as unknown as V2SkillInfo
}

/**
 * Registers the selected runtime security skills on V2.
 *
 * Selection goes through `selectRuntimeSecuritySkills`, the same source of truth the V1 path uses,
 * so `disabled_skills` behaves identically on both hosts and the two cannot drift.
 *
 * Each add is guarded by `editor.get`: the V2 transform callback re-runs on every skill-list
 * recompute, so adding unconditionally would append duplicates. The guard is also the collision
 * rule, since a skill already present under that id (for example a user's own
 * `.agents/skills/security-research/`) must win rather than be overwritten.
 */
export async function bindRuntimeSkillsToV2(args: {
  v2Context: Context
  pluginConfig: Parameters<typeof selectRuntimeSecuritySkills>[0]
  log: (message: string, data?: unknown) => void
}): Promise<Array<() => Promise<void>>> {
  const { v2Context, pluginConfig, log } = args
  const skills = selectRuntimeSecuritySkills(pluginConfig)

  if (skills.length === 0) {
    log("[v2-bridge:skill] no runtime security skills selected, skipping registration")
    return []
  }

  const records = skills.map(toV2SkillInfo)
  let reported = false

  const registration = await v2Context.skill.transform((editor) => {
    const added: string[] = []
    for (const record of records) {
      if (editor.get(record.id)) continue
      editor.add(record)
      added.push(String(record.id))
    }
    // V2 registers the callback and runs it later, on every list recompute, so a log emitted right
    // after `transform` resolves reports nothing and the later passes report an empty list. Only the
    // first pass can describe what this binder actually did, so it logs and the rest stay silent.
    if (!reported) {
      reported = true
      log("[v2-bridge:skill] registered runtime security skills", {
        selected: records.map((record) => String(record.id)),
        registered: added,
      })
    }
  })

  return [async () => registration.dispose()]
}
