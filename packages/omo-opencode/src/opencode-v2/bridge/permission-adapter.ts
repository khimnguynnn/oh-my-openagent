/**
 * Translates OMO's V1 tool-permission maps into OpenCode V2 permission rules.
 *
 * V1 expressed permissions as a map of tool name to effect ("ask" | "allow" | "deny"), plus an
 * optional map of pattern to effect for tools that scope by argument. V2 instead resolves an
 * ordered `Permission.Rule[]` of `{ action, resource, effect }` with last-match-wins glob
 * matching, so the two are not interchangeable: the map has to be flattened into ordered rules
 * and the tool names have to be aliased the same way the host aliases them.
 */

export type V2PermissionEffect = "allow" | "deny" | "ask"

export interface V2PermissionRule {
  action: string
  resource: string
  effect: V2PermissionEffect
}

const VALID_EFFECTS: ReadonlySet<string> = new Set(["allow", "deny", "ask"])

/**
 * V2's config normalizer renames three action names before storing rules
 * (`write`/`patch`/`apply_patch` -> `edit`, `task` -> `subagent`, `bash` -> `shell`). It does that
 * only on its own config path, never on rules handed to it through `agent.permissions`, so the
 * bridge must reproduce the mapping or a `bash`/`task` grant would never match the action V2
 * actually checks.
 */
const V2_ACTION_ALIASES: Readonly<Record<string, string>> = {
  write: "edit",
  patch: "edit",
  apply_patch: "edit",
  task: "subagent",
  bash: "shell",
}

function isEffect(value: unknown): value is V2PermissionEffect {
  return typeof value === "string" && VALID_EFFECTS.has(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Emits the action under both its V1 name and its V2 alias when the two differ.
 *
 * Both names have to be governed: OMO registers its own `task` tool through the tool adapter while
 * V2's built-in delegation tool is `subagent`, and Prometheus denies `bash` while V2's shell action
 * is `shell`. Emitting one name only would leave the other ungoverned.
 */
function actionCandidates(action: string): string[] {
  const alias = V2_ACTION_ALIASES[action]
  if (alias === undefined || alias === action) {
    return [action]
  }
  return [action, alias]
}

function ruleKey(rule: V2PermissionRule): string {
  return `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`
}

/**
 * Drops duplicates while keeping first occurrence order, which is the order `findLast` cares
 * about. Called on every emission so repeated projection stays byte-stable.
 */
export function dedupePermissionRules(rules: readonly V2PermissionRule[]): V2PermissionRule[] {
  const seen = new Set<string>()
  const result: V2PermissionRule[] = []
  for (const rule of rules) {
    const key = ruleKey(rule)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(rule)
  }
  return result
}

/**
 * Flattens V1's per-agent `permission` map into V2 rules.
 *
 * A string value becomes a wildcard-resource rule. A nested record becomes one rule per pattern,
 * with the pattern as the rule's resource; a nested `*` key collapses onto the wildcard rule so it
 * is not emitted twice. Unknown effects are dropped rather than guessed, matching the host's own
 * refusal to accept a fourth effect.
 */
export function toV2PermissionRules(permission: unknown): V2PermissionRule[] {
  if (!isPlainRecord(permission)) return []

  const rules: V2PermissionRule[] = []
  for (const [rawAction, value] of Object.entries(permission)) {
    if (!rawAction) continue

    if (isEffect(value)) {
      for (const action of actionCandidates(rawAction)) {
        rules.push({ action, resource: "*", effect: value })
      }
      continue
    }

    if (!isPlainRecord(value)) continue
    for (const [pattern, patternEffect] of Object.entries(value)) {
      if (!isEffect(patternEffect)) continue
      const resource = pattern || "*"
      for (const action of actionCandidates(rawAction)) {
        rules.push({ action, resource, effect: patternEffect })
      }
    }
  }
  return dedupePermissionRules(rules)
}

/**
 * Flattens V1's global `tools` enable/disable map into V2 rules.
 *
 * V2 models a disabled tool as a deny rule whose action matches the tool name and whose resource
 * is `*`; that is the shape its own config normalizer produces from `tools`, and it is also what
 * hides the tool from the model rather than merely blocking the call.
 */
export function toolFlagsToV2PermissionRules(tools: unknown): V2PermissionRule[] {
  if (!isPlainRecord(tools)) return []

  const rules: V2PermissionRule[] = []
  for (const [rawAction, enabled] of Object.entries(tools)) {
    if (!rawAction || typeof enabled !== "boolean") continue
    const effect: V2PermissionEffect = enabled ? "allow" : "deny"
    for (const action of actionCandidates(rawAction)) {
      rules.push({ action, resource: "*", effect })
    }
  }
  return dedupePermissionRules(rules)
}

export interface V2PermissionProjector {
  project(agentID: string, agent: { permissions?: V2PermissionRule[] }, v1Permission?: unknown): number
}

/**
 * Builds a projector that rewrites an agent's V2 ruleset from the V1 permission maps.
 *
 * The V2 transform callback is lazy and runs again on every agent-list recompute, and the same
 * editor hands back the same agent object each time. Appending unconditionally would therefore
 * grow the ruleset on every recompute, so the pre-projection ruleset is captured once per agent and
 * every projection is recomputed from that base. That also keeps the V2 defaults (the catch-all
 * allow plus the `.env` read asks) intact.
 *
 * Ordering is load-bearing because V2 resolves with last-match-wins:
 * base defaults, then the global rules from `applyToolConfig`, then the per-agent overrides. An
 * agent-level `task: allow` therefore wins over the global `task: deny`, which is exactly the V1
 * semantics, while a global `todowrite: false` still overrides the base catch-all allow.
 */
export function createV2PermissionProjector(args: {
  globalRules: readonly V2PermissionRule[]
}): V2PermissionProjector {
  const baseByAgent = new Map<string, V2PermissionRule[]>()

  return {
    project(agentID, agent, v1Permission) {
      const current = Array.isArray(agent.permissions) ? agent.permissions : []
      const base = baseByAgent.get(agentID)
      const baseRules = base ?? [...current]
      if (base === undefined) {
        baseByAgent.set(agentID, baseRules)
      }

      const agentRules = toV2PermissionRules(v1Permission)

      const merged = dedupePermissionRules([...baseRules, ...args.globalRules, ...agentRules])
      agent.permissions = merged
      return merged.length
    },
  }
}
