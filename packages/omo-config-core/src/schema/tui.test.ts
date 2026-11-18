import { describe, expect, test } from "bun:test"

import { OmoConfigLayerSchema, OmoConfigSchema } from "./config"
import { OmoTuiSidebarSettingsSchema, OmoTuiSettingsLayerSchema, OmoTuiSettingsSchema } from "./tui"

describe("OmoTuiSidebarSettingsSchema", () => {
  describe("#given an empty object", () => {
    test("#then the sidebar is enabled by default", () => {
      // given
      const raw = {}

      // when
      const parsed = OmoTuiSidebarSettingsSchema.parse(raw)

      // then
      expect(parsed.enabled).toBe(true)
    })
  })

  describe("#given enabled false", () => {
    test("#then the value is kept", () => {
      // given
      const raw = { enabled: false }

      // when
      const parsed = OmoTuiSidebarSettingsSchema.parse(raw)

      // then
      expect(parsed.enabled).toBe(false)
    })
  })

  describe("#given an unknown key", () => {
    test("#then it is rejected so a typo cannot silently do nothing", () => {
      // given
      const raw = { enabled: true, widht: 40 }

      // when
      const result = OmoTuiSidebarSettingsSchema.safeParse(raw)

      // then
      expect(result.success).toBe(false)
    })
  })
})

describe("OmoTuiSettingsLayerSchema", () => {
  describe("#given a partial layer", () => {
    test("#then it validates without repeating every field", () => {
      // given
      const raw = { sidebar: {} }

      // when
      const parsed = OmoTuiSettingsLayerSchema.parse(raw)

      // then
      expect(parsed.sidebar).toEqual({})
    })
  })

  describe("#given no sidebar at all", () => {
    test("#then the layer still validates", () => {
      // given
      const raw = {}

      // when
      const result = OmoTuiSettingsLayerSchema.safeParse(raw)

      // then
      expect(result.success).toBe(true)
    })
  })
})

describe("OmoTuiSettingsSchema", () => {
  describe("#given no sidebar", () => {
    test("#then the sidebar defaults to enabled", () => {
      // given
      const raw = {}

      // when
      const parsed = OmoTuiSettingsSchema.parse(raw)

      // then
      expect(parsed.sidebar.enabled).toBe(true)
    })
  })
})

describe("top-level tui in the omo config layer", () => {
  describe("#given tui.sidebar.enabled false at the top level", () => {
    test("#then the layer validates instead of reporting an unknown key", () => {
      // given
      const raw = { tui: { sidebar: { enabled: false } } }

      // when
      const result = OmoConfigLayerSchema.safeParse(raw)

      // then
      expect(result.success).toBe(true)
      expect(result.success && result.data.tui?.sidebar?.enabled).toBe(false)
    })
  })

  describe("#given tui inside the opencode block", () => {
    test("#then it is still accepted as freeform harness config", () => {
      // given
      const raw = { "[opencode]": { tui: { sidebar: { enabled: false } } } }

      // when
      const result = OmoConfigLayerSchema.safeParse(raw)

      // then
      expect(result.success).toBe(true)
    })
  })

  describe("#given the resolved omo config", () => {
    test("#then a missing tui block stays absent so the harness schema owns the default", () => {
      // given
      const raw = {}

      // when
      const parsed = OmoConfigSchema.parse(raw)

      // then
      expect(parsed.tui).toBeUndefined()
    })

    test("#then a present tui block gets the enabled default applied", () => {
      // given
      const raw = { tui: {} }

      // when
      const parsed = OmoConfigSchema.parse(raw)

      // then
      expect(parsed.tui?.sidebar?.enabled).toBe(true)
    })
  })
})
