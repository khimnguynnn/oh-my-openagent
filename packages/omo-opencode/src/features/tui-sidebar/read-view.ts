import { computeView } from "./compute-view"
import { deriveAgents, deriveConfig, deriveJobBoard, deriveLoop, deriveRoster } from "./derivers"
import { readMirror } from "./mirror-io"
import type { RosterRow } from "./state-types"
import type { SidebarView } from "./state-types"

type RosterResolver = (directory: string) => RosterRow[]

export type PluginValidation = {
  readonly valid: boolean
  readonly messages: readonly string[]
  readonly config: {
    readonly tui?: {
      readonly sidebar?: {
        readonly enabled?: boolean
      }
    }
  }
}

export async function loadPluginValidation(directory: string): Promise<PluginValidation> {
  const { validatePluginConfig } = await import("../../config/validate")
  return validatePluginConfig(directory)
}

async function loadRosterRows(directory: string): Promise<readonly RosterRow[]> {
  const { resolveRoster } = await import("./roster-resolver")
  const resolver: RosterResolver = resolveRoster
  return resolver(directory)
}

export async function readView(directory: string): Promise<SidebarView> {
  const validation = await loadPluginValidation(directory)
  const mirror = readMirror(directory)
  const roster = await loadRosterRows(directory)
  return computeView({
    config: deriveConfig(validation),
    roster: deriveRoster(roster),
    agents: deriveAgents(mirror),
    jobs: deriveJobBoard(mirror),
    loop: deriveLoop(mirror),
  })
}

/**
 * The sidebar is on unless the resolved config turns it off. A config that fails
 * to load still reports its own banner, so it stays enabled.
 */
export async function isSidebarEnabled(directory: string): Promise<boolean> {
  const validation = await loadPluginValidation(directory)
  return validation.config.tui?.sidebar?.enabled !== false
}
