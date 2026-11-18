import { describe, expect, it } from "bun:test"

import { adaptV2Theme } from "./theme-adapter"

type Rgba = { readonly r: number; readonly g: number; readonly b: number; readonly toString: () => string }

function rgba(hex: string): Rgba {
  const value = Number.parseInt(hex.slice(1), 16)
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
    toString: () => hex,
  }
}

function resolvedTheme(): unknown {
  return {
    text: {
      base: rgba("#e6e6e6"),
      muted: rgba("#8a8a8a"),
      faint: rgba("#5a5a5a"),
      feedback: {
        error: { base: rgba("#ff5555"), muted: rgba("#aa3333") },
        warning: { base: rgba("#ffaa00"), muted: rgba("#aa7700") },
        success: { base: rgba("#55ff55"), muted: rgba("#33aa33") },
        info: { base: rgba("#55aaff"), muted: rgba("#3377aa") },
      },
    },
    border: { base: rgba("#333333") },
    hue: { accent: { 400: rgba("#44bbcc"), 500: rgba("#33aabb") } },
    surface: () => resolvedTheme(),
  }
}

describe("adaptV2Theme", () => {
  it("#given a resolved V2 theme #when adapting #then every sidebar token becomes a colour string, never an object", () => {
    // given
    const theme = resolvedTheme()

    // when
    const adapted = adaptV2Theme(theme)

    // then
    expect(adapted.text).toBe("#e6e6e6")
    expect(adapted.textMuted).toBe("#8a8a8a")
    expect(adapted.borderSubtle).toBe("#333333")
    expect(adapted.accent).toBe("#33aabb")
    expect(adapted.error).toBe("#ff5555")
    expect(adapted.warning).toBe("#ffaa00")
    expect(adapted.success).toBe("#55ff55")
    expect(adapted.info).toBe("#55aaff")

    for (const value of Object.values(adapted)) {
      expect(typeof value).toBe("string")
    }
  })

  it("#given an accent scale missing the 500 step #when adapting #then it falls back to 400", () => {
    // given
    const theme = { text: { base: rgba("#eeeeee") }, border: { base: rgba("#222222") }, hue: { accent: { 400: rgba("#44bbcc") } } }

    // when
    const adapted = adaptV2Theme(theme)

    // then
    expect(adapted.accent).toBe("#44bbcc")
  })

  it("#given a theme with no feedback tokens #when adapting #then those tokens are undefined rather than an object", () => {
    // given
    const theme = { text: { base: rgba("#eeeeee"), muted: rgba("#999999") }, border: { base: rgba("#222222") } }

    // when
    const adapted = adaptV2Theme(theme)

    // then
    expect(adapted.error).toBeUndefined()
    expect(adapted.warning).toBeUndefined()
    expect(adapted.success).toBeUndefined()
    expect(adapted.info).toBeUndefined()
    expect(adapted.text).toBe("#eeeeee")
  })

  it("#given a V1 flat theme #when adapting #then the tokens it can see pass through as strings", () => {
    // given
    const theme = {
      text: "#e6e6e6",
      textMuted: "#888888",
      accent: "#00aaff",
      borderSubtle: "#333333",
      error: "#ff0000",
      warning: "#ffaa00",
      success: "#00ff00",
      info: "#00aaff",
    }

    // when
    const adapted = adaptV2Theme(theme)

    // then
    expect(adapted.text).toBe("#e6e6e6")
    expect(Object.values(adapted).every((value) => value === undefined || typeof value === "string")).toBe(true)
  })

  it("#given an empty theme #when adapting #then nothing throws and every token is undefined", () => {
    // given
    const theme = {}

    // when
    const adapted = adaptV2Theme(theme)

    // then
    expect(Object.values(adapted).every((value) => value === undefined)).toBe(true)
  })
})
