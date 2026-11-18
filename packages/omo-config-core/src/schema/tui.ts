import * as z from "zod"

/**
 * TUI sidebar settings, shared by every harness that renders a sidebar. OMO's OpenCode adapter
 * reads this through the top-level `tui` key or through `[opencode].tui`, so a single file can
 * turn the HUD off without the layer being reported as carrying unknown keys.
 */
const OmoTuiSidebarSettingsShape = {
  /** Render the runtime sidebar. Off hides it on V1 and V2 alike. */
  enabled: z.boolean(),
}

export const OmoTuiSidebarSettingsLayerSchema = z.object(OmoTuiSidebarSettingsShape).partial().strict()

export const OmoTuiSidebarSettingsSchema = OmoTuiSidebarSettingsLayerSchema.extend({
  enabled: z.boolean().default(true),
}).strict()

export const OmoTuiSettingsLayerSchema = z
  .object({
    sidebar: OmoTuiSidebarSettingsLayerSchema.optional(),
  })
  .strict()

export const OmoTuiSettingsSchema = z
  .object({
    sidebar: OmoTuiSidebarSettingsSchema.default({ enabled: true }),
  })
  .strict()

export type OmoTuiSidebarSettings = z.infer<typeof OmoTuiSidebarSettingsSchema>
export type OmoTuiSettings = z.infer<typeof OmoTuiSettingsSchema>
