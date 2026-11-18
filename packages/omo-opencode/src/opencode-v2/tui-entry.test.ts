import { describe, expect, it } from "bun:test"

import tuiModule from "../tui"
import { showOpenCodeV2Notice } from "./tui-entry"

type ShownToast = { readonly title: string; readonly message: string; readonly variant: string }

type RecordedClaim = { readonly append: string; readonly render: () => unknown; released: boolean }

function recordingContext(): {
  readonly shown: ShownToast[]
  readonly context: Parameters<typeof showOpenCodeV2Notice>[0]
} {
  const shown: ShownToast[] = []
  return { shown, context: { ui: { toast: { show: (options) => shown.push(options) } } } }
}

function contextWithSlot(directory: string): {
  readonly claims: RecordedClaim[]
  readonly context: Record<string, unknown>
} {
  const claims: RecordedClaim[] = []
  return {
    claims,
    context: {
      location: { directory },
      theme: { text: "#fff", textMuted: "#888" },
      ui: {
        toast: { show: () => undefined },
        slot: (claim: { append: string; render: () => unknown }) => {
          const recorded: RecordedClaim = { append: claim.append, render: claim.render, released: false }
          claims.push(recorded)
          return () => {
            recorded.released = true
          }
        },
      },
    },
  }
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

describe("OpenCode 2 sidebar wiring", () => {
  it("#given a V2 context that offers a slot #when setup runs #then it claims sidebar.content and returns a disposer", async () => {
    // given
    const { claims, context } = contextWithSlot(process.cwd())
    const setup = (tuiModule as Record<string, unknown>)["setup"]
    if (typeof setup !== "function") throw new Error("setup missing")

    // when
    const dispose = await setup(context)

    // then
    expect(claims).toHaveLength(1)
    expect(claims[0]?.append).toBe("sidebar.content")
    expect(claims[0]?.render).toBeFunction()
    expect(typeof dispose).toBe("function")

    if (typeof dispose === "function") dispose()
    expect(claims[0]?.released).toBe(true)
  })

  it("#given a V2 context with no slot domain #when setup runs #then it still shows the notice and degrades quietly", async () => {
    // given
    const shown: ShownToast[] = []
    const setup = (tuiModule as Record<string, unknown>)["setup"]
    if (typeof setup !== "function") throw new Error("setup missing")
    const context = { location: { directory: process.cwd() }, ui: { toast: { show: (options: ShownToast) => shown.push(options) } } }

    // when
    const dispose = await setup(context)

    // then
    expect(shown).toHaveLength(1)
    expect(dispose).toBeUndefined()
  })
})
