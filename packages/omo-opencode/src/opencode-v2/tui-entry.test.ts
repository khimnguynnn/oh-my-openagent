import { describe, expect, it } from "bun:test"

import tuiModule from "../tui"
import { showOpenCodeV2Notice } from "./tui-entry"

type ShownToast = { readonly title: string; readonly message: string; readonly variant: string }

function recordingContext(): {
  readonly shown: ShownToast[]
  readonly context: Parameters<typeof showOpenCodeV2Notice>[0]
} {
  const shown: ShownToast[] = []
  return { shown, context: { ui: { toast: { show: (options) => shown.push(options) } } } }
}

describe("OpenCode 2 TUI notice", () => {
  it("shows an info toast confirming Compatibility Bridge is active", () => {
    // given
    const { shown, context } = recordingContext()

    // when
    showOpenCodeV2Notice(context)

    // then
    expect(shown).toHaveLength(1)
    expect(shown[0]?.variant).toBe("info")
    expect(shown[0]?.message).toContain("Compatibility Bridge active")
  })

  it("keeps the V1 tui entry and adds a V2 setup that shows the notice on every start", async () => {
    // given
    const definition: Record<string, unknown> = tuiModule
    const { shown, context } = recordingContext()
    const setup = definition["setup"]

    // when
    if (typeof setup !== "function") throw new Error("setup missing")
    await setup(context)
    await setup(context)

    // then
    expect(definition["id"]).toBe("oh-my-openagent:tui")
    expect(typeof definition["tui"]).toBe("function")
    expect(shown).toHaveLength(2)
  })
})
