import { describe, expect, it } from "bun:test"

import { ACTIVITY_FRAMES } from "../features/tui-sidebar/constants"
import type { AgentRow, SidebarView } from "../features/tui-sidebar/state-types"
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

type Props = Record<string, unknown>

function fakeSolid(): {
  readonly tags: string[]
  readonly props: Props[]
  readonly inserted: string[]
  readonly solid: {
    createElement: (tag: string) => { tag: string }
    insert: (parent: unknown, child: unknown) => void
    setProp: (node: unknown, name: string, value: unknown) => void
  }
} {
  const tags: string[] = []
  const props: Props[] = []
  const inserted: string[] = []
  return {
    tags,
    props,
    inserted,
    solid: {
      createElement: (tag) => {
        tags.push(tag)
        return { tag }
      },
      insert: (_parent, child) => {
        if (typeof child === "string") inserted.push(child)
      },
      setProp: (_node, name, value) => {
        props.push({ [name]: value })
      },
    },
  }
}

type ViewSource = {
  readonly read: () => Promise<SidebarView>
  readonly reached: (call: number) => Promise<void>
  readonly calls: () => number
  readonly failOn: (call: number, error: Error) => void
}

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

const ABSENCE_WINDOW_MS = 200

/**
 * Proves an animation frame did NOT arrive. A frame timer with the test's 5ms period would land
 * many times inside the window, so observing zero paints after it is a real negative result.
 */
async function expectNoPaint(painted: () => number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ABSENCE_WINDOW_MS))
  expect(painted()).toBe(0)
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

const IDLE_VIEW: SidebarView = {
  kind: "idle",
  roster: { kind: "empty" },
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

describe("V2 sidebar HUD live agent rows", () => {
  const contextAgents: readonly AgentRow[] = [
    { name: "oracle", status: "running", model: "gpt-5", sessionID: "s-oracle", title: "audit the bridge" },
  ]

  it("#given the mirror has no agents but the context does #when the HUD renders #then the context row is drawn", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid, inserted } = fakeSolid()
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      readAgents: () => contextAgents,
      intervalMs: 60_000,
    })

    // when
    claims[0]?.render()

    // then
    expect(inserted).toContain("Agents")
    expect(inserted.some((line) => line.includes("oracle"))).toBe(true)
    hud?.dispose()
  })

  it("#given the context returns no agents #when the HUD renders #then the section is absent", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid, inserted } = fakeSolid()
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      readAgents: () => [],
      intervalMs: 60_000,
    })

    // when
    claims[0]?.render()

    // then
    expect(inserted).not.toContain("Agents")
    hud?.dispose()
  })

  it("#given an idle mirror view #when the context reports a running agent #then the view becomes active with agents", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid, inserted } = fakeSolid()
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => IDLE_VIEW,
      readAgents: () => contextAgents,
      intervalMs: 60_000,
    })

    // when
    claims[0]?.render()

    // then
    expect(inserted).toContain("Agents")
    expect(inserted).not.toContain("Models")
    expect(inserted.some((line) => line.includes("oracle"))).toBe(true)
    hud?.dispose()
  })

  it("#given a broken config view #when the context reports an agent #then the banner survives the promotion", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid, inserted } = fakeSolid()
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ({ kind: "broken", messages: ["bad key"] }),
      readAgents: () => contextAgents,
      intervalMs: 60_000,
    })

    // when
    claims[0]?.render()

    // then
    expect(inserted).toContain("Agents")
    expect(inserted).toContain("config invalid - run doctor")
    hud?.dispose()
  })

  it("#given the agent source throws #when the HUD renders #then the mirror view still renders", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid, tags } = fakeSolid()
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      readAgents: () => {
        throw new Error("context exploded")
      },
      intervalMs: 60_000,
    })

    // when
    claims[0]?.render()

    // then
    expect(hud).not.toBeNull()
    expect(tags).toContain("text")
    hud?.dispose()
  })

  it("#given two sessions of one agent #when the group row is clicked #then the group folds open", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid, props } = fakeSolid()
    const rows: readonly AgentRow[] = [
      { name: "oracle", status: "running", sessionID: "s-oracle" },
      { name: "oracle", status: "idle", sessionID: "s-second" },
    ]
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      readAgents: () => rows,
      intervalMs: 60_000,
    })

    // when
    claims[0]?.render()
    const handler = props.find((entry) => typeof entry.onMouseDown === "function")?.onMouseDown
    expect(typeof handler).toBe("function")
    ;(handler as () => void)()

    // then
    expect(claims.length).toBe(2)
    expect(claims[0]?.released).toBe(true)
    hud?.dispose()
  })

  it("#given no click target #when the HUD renders #then no row carries a handler", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid, props } = fakeSolid()
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      readAgents: () => contextAgents,
      intervalMs: 60_000,
    })

    // when
    claims[0]?.render()

    // then
    expect(props.every((entry) => entry.onMouseDown === undefined)).toBe(true)
    hud?.dispose()
  })

  it("#given no click target #when an agent row is rendered #then the row has no handler instead of a dead click", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid, props } = fakeSolid()
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      readAgents: () => contextAgents,
      intervalMs: 60_000,
    })

    // when
    claims[0]?.render()

    // then
    expect(props.some((entry) => typeof entry.onMouseDown === "function")).toBe(false)
    hud?.dispose()
  })
})

describe("V2 sidebar HUD agent scoping", () => {
  it("#given the host render passes a session #when the HUD renders #then the agent reader is scoped to it", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid } = fakeSolid()
    const asked: Array<string | undefined> = []
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      readAgents: (sessionID) => {
        asked.push(sessionID)
        return [{ name: "oracle", status: "running", sessionID: "s-oracle" }]
      },
      intervalMs: 60_000,
    })

    // when
    claims[0]?.render({ sessionID: "s-root" })

    // then
    expect(asked).toContain("s-root")
    hud?.dispose()
  })

  it("#given the host render passes no session #when the HUD renders #then the reader still gets a call", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid } = fakeSolid()
    const asked: Array<string | undefined> = []
    const hud = await startSidebarHud({
      directory: "/proj",
      host,
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      readAgents: (sessionID) => {
        asked.push(sessionID)
        return []
      },
      intervalMs: 60_000,
    })

    // when
    claims[0]?.render()

    // then
    expect(asked).toEqual([undefined])
    hud?.dispose()
  })
})

describe("V2 sidebar HUD spinner", () => {
  it("#given an active agent #when a frame elapses #then the mounted node is rewritten in place without a new claim", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid, props } = fakeSolid()
    const frames: unknown[] = []
    const PAINTS = 3
    let painted: (() => void) | null = null
    const firstPaint = new Promise<void>((resolve) => {
      painted = resolve
    })
    const hostWithRenderer: SidebarSlotHost = {
      ...host,
      renderer: {
        requestRender: () => {
          if (frames.length >= PAINTS) painted?.()
        },
      },
    }
    const hud = await startSidebarHud({
      directory: "/proj",
      host: hostWithRenderer,
      solid: {
        ...solid,
        setProp: (node, name, value) => {
          solid.setProp(node, name, value)
          if (name === "content") frames.push(value)
        },
      },
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      readAgents: () => [{ name: "oracle", status: "running", sessionID: "s-oracle" }],
      intervalMs: 60_000,
      frameMs: 5,
    })

    // when
    claims[0]?.render()
    await withTimeout(firstPaint, "three spinner frames to repaint through requestRender")

    // then
    expect(frames.length).toBeGreaterThan(0)
    const first = String(frames[0])
    expect(first).toContain("oracle")
    expect(ACTIVITY_FRAMES.includes(first.charAt(0))).toBe(true)
    // a later frame must actually advance, otherwise the spinner is a static glyph
    const distinct = new Set(frames.map((frame) => String(frame).charAt(0)))
    expect(distinct.size).toBeGreaterThan(1)
    expect(claims).toHaveLength(1)
    hud?.dispose()
  })

  it("#given no active agent #when the HUD starts #then no animation timer is armed", async () => {
    // given
    const { host, claims } = recordingHost()
    const { solid } = fakeSolid()
    let renders = 0
    const hud = await startSidebarHud({
      directory: "/proj",
      host: { ...host, renderer: { requestRender: () => (renders += 1) } },
      solid,
      isEnabled: async () => true,
      readView: async () => ACTIVE_VIEW,
      readAgents: () => [{ name: "oracle", status: "idle", sessionID: "s-oracle" }],
      intervalMs: 60_000,
      frameMs: 5,
    })

    // when
    claims[0]?.render()
    await expectNoPaint(() => renders)

    // then
    expect(renders).toBe(0)
    hud?.dispose()
  })
})
