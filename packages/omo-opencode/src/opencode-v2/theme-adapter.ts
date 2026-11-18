import type { ThemeLike } from "../features/tui-sidebar/render-view"

type Rgba = {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a?: number
  readonly toString: () => string
}

type ThemeNode = Readonly<Record<string, unknown>>

function isRgba(value: unknown): value is Rgba {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Rgba).r === "number" &&
    typeof (value as Rgba).g === "number" &&
    typeof (value as Rgba).b === "number"
  )
}

function at(node: unknown, ...path: readonly string[]): unknown {
  let current = node
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined
    current = (current as ThemeNode)[key]
  }
  return current
}

function toColor(value: unknown): string | undefined {
  if (isRgba(value)) return value.toString()
  if (typeof value === "string") return value
  return undefined
}

function pick(theme: unknown, paths: readonly (readonly string[])[]): string | undefined {
  for (const path of paths) {
    const color = toColor(at(theme, ...path))
    if (color !== undefined) return color
  }
  return undefined
}

/**
 * OpenCode 2 resolves the theme into a nested RGBA tree (`text.base`,
 * `text.feedback.error.base`, `border.base`), while the sidebar renderer was
 * written against V1's flat string tokens. Handing an RGBA object straight to a
 * `fg` prop makes the host's colour clone throw, so every token is flattened here.
 */
export function adaptV2Theme(theme: unknown): ThemeLike {
  return {
    text: pick(theme, [["text", "base"], ["text"]]),
    textMuted: pick(theme, [["text", "muted"], ["text", "faint"]]),
    accent: pick(theme, [["hue", "accent", "500"], ["hue", "accent", "400"], ["text", "base"]]),
    borderSubtle: pick(theme, [["border", "base"], ["border"]]),
    error: pick(theme, [["text", "feedback", "error", "base"], ["text", "feedback", "error"]]),
    warning: pick(theme, [["text", "feedback", "warning", "base"], ["text", "feedback", "warning"]]),
    success: pick(theme, [["text", "feedback", "success", "base"], ["text", "feedback", "success"]]),
    info: pick(theme, [["text", "feedback", "info", "base"], ["text", "feedback", "info"]]),
  }
}
