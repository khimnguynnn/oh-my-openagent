import type { BackgroundTaskStatus } from "../background-agent/types"

export type AgentStatus = "busy" | "idle" | "error" | "running" | "retry"

export type AgentOutcome = "succeeded" | "failed" | "interrupted"

export type AgentRow = {
  readonly name: string
  readonly status: AgentStatus
  /** Model id the agent runs on, when the source knows it. */
  readonly model?: string
  /** Model variant (for example a reasoning level), when the source knows it. */
  readonly variant?: string
  /** Theme token name the agent asked for, resolved against the theme at render time. */
  readonly color?: string
  /** Session title, used as the row's detail column. */
  readonly title?: string
  /** Session the row belongs to, so a click can open it. */
  readonly sessionID?: string
  /** Epoch millis the current run started, so elapsed time needs no extra clock. */
  readonly activeSince?: number
  /** Terminal outcome, when the session already finished. */
  readonly outcome?: AgentOutcome
}

export type JobRow = {
  readonly title: string
  readonly status: BackgroundTaskStatus
  readonly toolCalls: number | null
  readonly lastTool: string | null
}

export type RosterRow = {
  readonly label: string
  readonly model: string
}

export type ConfigState =
  { readonly kind: "valid" } | { readonly kind: "invalid"; readonly messages: readonly string[] }

export type RosterState = { readonly kind: "empty" } | { readonly kind: "rows"; readonly rows: readonly RosterRow[] }

export type AgentsState = { readonly kind: "none" } | { readonly kind: "list"; readonly agents: readonly AgentRow[] }

export type JobBoardState = { readonly kind: "none" } | { readonly kind: "list"; readonly jobs: readonly JobRow[] }

export type LoopLive = {
  readonly kind: "live"
  readonly goalsDone: number
  readonly goalsTotal: number
  readonly pass: number
  readonly fail: number
  readonly pending: number
  readonly blocked: number
  readonly activeGoal: string | null
}

export type LoopState = { readonly kind: "none" } | LoopLive

export type ConfigBanner = { readonly kind: "none" } | { readonly kind: "invalid" }

export type SidebarView =
  | {
      readonly kind: "active"
      readonly loop: LoopState
      readonly agents: AgentsState
      readonly jobs: JobBoardState
      readonly configBanner: ConfigBanner
    }
  | { readonly kind: "broken"; readonly messages: readonly string[] }
  | { readonly kind: "idle"; readonly roster: RosterState }

export function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`)
}
