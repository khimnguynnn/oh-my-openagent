import { describe, expect, it } from "bun:test"
import { bindMcpToV2 } from "../mcp-adapter"

function createMockMcpContext() {
  const stored = new Map<string, Record<string, unknown>>()
  const editor = {
    list: () => [...stored.entries()],
    get: (name: string) => stored.get(name),
    set: (name: string, config: Record<string, unknown>) => {
      stored.set(name, config)
    },
    update: () => {},
    remove: (name: string) => {
      stored.delete(name)
    },
  }

  const transformCalls: Array<(editor: typeof editor) => void> = []
  const context = {
    mcp: {
      transform: async (callback: (editor: typeof editor) => void) => {
        transformCalls.push(callback)
        callback(editor)
        return { dispose: async () => {} }
      },
      list: async () => [],
      reload: async () => {},
    },
  }

  return { context, stored, transformCalls, rerun: () => transformCalls.forEach((cb) => cb(editor)) }
}

const REMOTE = { type: "remote", url: "https://mcp.example.com/mcp", enabled: true }
const LOCAL = { type: "local", command: ["bun", "server.ts"], enabled: true }

describe("bindMcpToV2", () => {
  describe("#given a merged map holding one remote server", () => {
    it("#when projecting #then it registers the remote config with url and oauth", async () => {
      // given
      const { context, stored } = createMockMcpContext()

      // when
      const disposers = await bindMcpToV2({
        v2Context: context as never,
        directory: "/proj",
        mcps: { context7: REMOTE },
      })

      // then
      expect(disposers.length).toBe(1)
      expect(stored.get("context7")).toEqual({
        type: "remote",
        url: "https://mcp.example.com/mcp",
        oauth: false,
      })
    })
  })

  describe("#given a remote server carrying headers", () => {
    it("#when projecting #then the headers survive", async () => {
      // given
      const { context, stored } = createMockMcpContext()
      const withHeaders = { ...REMOTE, headers: { Authorization: "Bearer x" } }

      // when
      await bindMcpToV2({
        v2Context: context as never,
        directory: "/proj",
        mcps: { websearch: withHeaders },
      })

      // then
      expect((stored.get("websearch") as { headers?: Record<string, string> }).headers).toEqual({
        Authorization: "Bearer x",
      })
    })
  })

  describe("#given a local server with no cwd", () => {
    it("#when projecting #then cwd defaults to the bridge directory", async () => {
      // given
      const { context, stored } = createMockMcpContext()

      // when
      await bindMcpToV2({
        v2Context: context as never,
        directory: "/proj",
        mcps: { lsp: LOCAL },
      })

      // then
      expect(stored.get("lsp")).toEqual({
        type: "local",
        command: ["bun", "server.ts"],
        cwd: "/proj",
      })
    })
  })

  describe("#given a local server with environment and an explicit cwd", () => {
    it("#when projecting #then both are preserved", async () => {
      // given
      const { context, stored } = createMockMcpContext()
      const withEnv = { ...LOCAL, cwd: "/custom", environment: { FOO: "bar" } }

      // when
      await bindMcpToV2({
        v2Context: context as never,
        directory: "/proj",
        mcps: { lsp: withEnv },
      })

      // then
      expect(stored.get("lsp")).toEqual({
        type: "local",
        command: ["bun", "server.ts"],
        cwd: "/custom",
        environment: { FOO: "bar" },
      })
    })
  })

  describe("#given an entry the user marked enabled false", () => {
    it("#when projecting #then it is not registered", async () => {
      // given
      const { context, stored } = createMockMcpContext()

      // when
      await bindMcpToV2({
        v2Context: context as never,
        directory: "/proj",
        mcps: { context7: { ...REMOTE, enabled: false }, grep_app: REMOTE },
      })

      // then
      expect(stored.has("context7")).toBe(false)
      expect(stored.has("grep_app")).toBe(true)
    })
  })

  describe("#given the host already declared a server of the same name", () => {
    it("#when projecting #then the host config wins", async () => {
      // given
      const { context, stored } = createMockMcpContext()
      stored.set("lsp", { type: "local", command: ["host-own"], cwd: "/host" })

      // when
      await bindMcpToV2({
        v2Context: context as never,
        directory: "/proj",
        mcps: { lsp: LOCAL },
      })

      // then
      expect((stored.get("lsp") as { command: string[] }).command).toEqual(["host-own"])
    })
  })

  describe("#given an empty merged map", () => {
    it("#when projecting #then nothing is registered", async () => {
      // given
      const { context, stored } = createMockMcpContext()

      // when
      const disposers = await bindMcpToV2({
        v2Context: context as never,
        directory: "/proj",
        mcps: {},
      })

      // then
      expect(stored.size).toBe(0)
      expect(disposers.length).toBe(1)
    })
  })

  describe("#given an entry with an unusable shape", () => {
    it("#when projecting #then it is skipped without throwing", async () => {
      // given
      const { context, stored } = createMockMcpContext()

      // when
      await bindMcpToV2({
        v2Context: context as never,
        directory: "/proj",
        mcps: {
          noType: { url: "https://example.com" },
          remoteNoUrl: { type: "remote" },
          localNoCommand: { type: "local" },
          notAnObject: "nope",
          good: REMOTE,
        } as never,
      })

      // then
      expect([...stored.keys()]).toEqual(["good"])
    })
  })

  describe("#given the transform re-runs on a later registry recompute", () => {
    it("#when re-running #then the registered set does not grow", async () => {
      // given
      const { context, stored, rerun } = createMockMcpContext()
      await bindMcpToV2({
        v2Context: context as never,
        directory: "/proj",
        mcps: { context7: REMOTE, lsp: LOCAL },
      })
      const firstKeys = [...stored.keys()].sort()

      // when
      rerun()
      rerun()

      // then
      expect([...stored.keys()].sort()).toEqual(firstKeys)
      expect(stored.size).toBe(2)
    })
  })
})
