export const MIRROR_DIR_NAME = "tui-state"
export const MIRROR_SCHEMA_VERSION = 1
export const STALE_MS = 6_000
export const LOOP_FRESH_MS = 120_000
export const POLL_INTERVAL_MS = 1_000
export const HEARTBEAT_MS = 2_000
export const WRITE_DEBOUNCE_MS = 250
export const MAX_AGENTS = 12
export const MAX_JOBS = 12
export const LABEL_MAX = 24

/** Braille spinner drawn while an agent is working. */
export const ACTIVITY_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
/** Frame duration for the spinner. The HUD mutates the mounted text node in place. */
export const ACTIVITY_FRAME_MS = 100
/** Agent that is idle and has never run in this session. */
export const STATUS_DOT_GLYPH = "•"
/** Agent whose session finished with an outcome. */
export const STATUS_STOPPED_GLYPH = "⚰"
/** Agent that is idle but has run before. */
export const STATUS_HISTORY_GLYPH = "✦"
/** Column budget for the model id, so a long id cannot push the detail column off. */
export const AGENT_MODEL_MAX = 16
/** Theme tokens an agent colour may name. Anything else falls back to the plain text colour. */
export const AGENT_COLOR_TOKENS = [
  "accent",
  "error",
  "info",
  "success",
  "text",
  "textMuted",
  "warning",
  "borderSubtle",
] as const
