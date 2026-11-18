import { describe, expect, it } from "bun:test"

import type { SidebarView } from "../features/tui-sidebar/state-types"
import { startSidebarHud } from "./sidebar-hud"
import type { SidebarSlotHost } from "./sidebar-hud"

type Claim = {
  readonly append: "sidebar.content"
  readonly render: () => unknown
}

type RecordedClaim = {
  readonly append: string
  readonly render: () => unknown
  released: boolean
}

function recordingHost(): {
  readonly claims: RecordedClaim[]
  readonly host: SidebarSlotHost
} {
  const claims: RecordedClaim[] = []
  return {
    claims,
    host: {
      theme: { text: "#fff" },
      ui: {
        slot: (claim: Claim) => {
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

function fakeSolid(): {
  readonly tags: string[]
  readonly solid: {
    createElement: (tag: string) => { tag: string }
    insert: () => void
    setProp: () => void
  }
} {
  const tags: string[] = []
  return {
    tags,
    solid: {
      createElement: (tag) => {
        tags.push(tag)
        return { tag }
      },
      insert: () => undefined,
      setProp: () => undefined,
    },
  }
}

type ViewSource = {
  readonly read: () => Promise<SidebarView>
  readonly reached: (call: number) => Promise<void>
  readonly calls: () => number
  readonly failOn: (call: number, error: Error) => void
}

/**
 * A view source whose N-th call settles a promise, so a test awaits the poll
 * itself instead of sleeping for a guess at how long a timer needs.
 */
function viewSource(view: () => SidebarView): ViewSource {
  let calls = 0
  const waiters: Array<{ readonly target: number; readonly resolve: () => void }> = []
  const failures = new Map<number, Error>()
  return {
    read: async () => {
      calls += 1
      const failure = failures.get(calls)
      for (const waiter of [...waiters]) {
        if (calls >= waiter.target) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve()
        }
      }
      if (failure) throw failure
      return view()
    },
    reached: (call) => {
      if (calls >= call) return Promise.resolve()
      return new Promise<void>((resolve) => {
        waiters.push({ target: call, resolve })
      })
    },
    calls: () => calls,
    failOn: (call, error) => {
      failures.set(call, error)
    },
  }
}

const TIMEOUT_MS = 2_000

async function withTimeout(signal: Promise<void>, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`waited ${TIMEOUT_MS}ms for ${what}, never fired`)), TIMEOUT_MS)
  })
  try {
    await Promise.race([signal, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

const ACTIVE_VIEW: SidebarView = {
  kind: "active",
  configBanner: { kind: "none" },
  agents: { kind: "list", agents: [{ name: "oracle", status: "running" }] },
  jobs: { kind: "none" },
  loop: { kind: "none" },
}

const ACTIVE_VIEW_CHANGED: SidebarView = {
  kind: "active",
  configBanner: { kind: "none" },
  agents: { kind: "list", agents: [{ name: "explore", status: "busy" }] },
  jobs: { kind: "none" },
  loop: { kind: "none" },
}

describe("V2 sidebar HUD", () => {
  it("#given an enabled sidebar #when the HUD starts #then it claims sidebar.content and renders the view lazily", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid, tags } = fakeSolid()

    // when
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      intervalMs: 60_000,
    })

    // then
    expect(hud).not.toBeNull()
    expect(claims).toHaveLength(1)
    expect(claims[0]?.append).toBe("sidebar.content")
    expect(tags).toEqual([])

    claims[0]?.render()
    expect(tags).toContain("text")
    hud?.dispose()
  })

  it("#given the sidebar is disabled in config #when the HUD starts #then it claims nothing", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid } = fakeSolid()

    // when
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => false,
      readView: async () => ACTIVE_VIEW,
    })

    // then
    expect(hud).toBeNull()
    expect(claims).toEqual([])
  })

  it("#given a claimed sidebar #when disposed #then the claim is released immediately", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid } = fakeSolid()
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      intervalMs: 60_000,
    })

    // when
    hud?.dispose()

    // then
    expect(claims).toHaveLength(1)
    expect(claims[0]?.released).toBe(true)
  })

  it("#given a view that changes #when the poll runs #then the old claim is released and a fresh one takes its place", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid } = fakeSolid()
    let view = ACTIVE_VIEW
    const source = viewSource(() => view)
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: source.read,
      intervalMs: 5,
    })

    // when
    view = ACTIVE_VIEW_CHANGED
    await withTimeout(source.reached(2), "the poll to re-read the view")

    // then
    expect(claims).toHaveLength(2)
    expect(claims[0]?.released).toBe(true)
    expect(claims[1]?.released).toBe(false)
    hud?.dispose()
  })

  it("#given an unchanged view #when the poll runs again #then the existing claim is kept", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid } = fakeSolid()
    const source = viewSource(() => ACTIVE_VIEW)
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: source.read,
      intervalMs: 5,
    })

    // when
    await withTimeout(source.reached(3), "three poll cycles")

    // then
    expect(source.calls()).toBeGreaterThanOrEqual(3)
    expect(claims).toHaveLength(1)
    hud?.dispose()
  })

  it("#given the view reader throws during a poll #when the poll runs #then the error is reported and polling continues", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid } = fakeSolid()
    const errors: Error[] = []
    let reported: (() => void) | null = null
    const sawError = new Promise<void>((resolve) => {
      reported = resolve
    })
    const source = viewSource(() => ACTIVE_VIEW)
    source.failOn(2, new Error("mirror unreadable"))
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: source.read,
      intervalMs: 5,
      onPollError: (error) => {
        errors.push(error)
        reported?.()
      },
    })

    // when
    await withTimeout(sawError, "the poll error to be reported")

    // then
    expect(errors.map((error) => error.message)).toEqual(["mirror unreadable"])
    expect(claims).toHaveLength(1)
    hud?.dispose()
  })
})
