import { describe, expect, it, mock } from "bun:test"
import { opencodeV2Server } from "./server-entry"

describe("OpenCode 2 server-entry", () => {
  it("exports a valid OpenCode 2 Plugin definition with id and setup", () => {
    expect(opencodeV2Server.id).toBe("oh-my-openagent")
    expect(typeof opencodeV2Server.setup).toBe("function")
  })

  it("boots the compatibility bridge and returns a cleanup function", async () => {
    const mockToolEditor = {
      list: () => [],
      get: () => undefined,
      namespace: () => {},
      add: mock(() => {}),
      update: () => {},
      remove: () => {},
    }

    const mockContext: any = {
      location: { directory: process.cwd() },
      app: { url: new URL("http://localhost:4096") },
      options: {},
      agent: {
        list: mock(async () => []),
        get: mock(async () => undefined),
      },
      tool: {
        transform: mock(async (callback: any) => {
          callback(mockToolEditor)
          return { dispose: mock(async () => {}) }
        }),
        hook: mock(async () => ({ dispose: mock(async () => {}) })),
      },
      session: {
        hook: mock(async () => ({ dispose: mock(async () => {}) })),
        create: mock(async () => ({ id: "s-1" })),
        get: mock(async () => ({ id: "s-1" })),
        context: mock(async () => ({ sessionID: "s-1", messages: [] })),
        interrupt: mock(async () => {}),
        prompt: mock(async () => ({})),
      },
      event: {
        subscribe: mock(async () => ({ dispose: mock(async () => {}) })),
      },
    }

    const cleanup = await opencodeV2Server.setup(mockContext)
    expect(typeof cleanup).toBe("function")
    expect(mockContext.tool.transform).toHaveBeenCalled()
    expect(mockToolEditor.add).toHaveBeenCalled()

    if (cleanup) {
      await expect(cleanup()).resolves.toBeUndefined()
    }
  })
})
