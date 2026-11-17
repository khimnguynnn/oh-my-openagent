import { describe, expect, it, mock } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { createV1ClientFromV2Context } from "../client-adapter"
import { bindToolsToV2 } from "../tool-adapter"
import { bindSessionHooksToV2 } from "../session-adapter"
import { bindMcpToV2 } from "../mcp-adapter"
import { bindConfigToV2, expandCommandTemplate, parseModelString } from "../config-adapter"
import { setupOpenCodeV2Bridge } from "../bridge-runner"

function createMockV2Context(overrides: Partial<Record<string, unknown>> = {}): {
  context: Context
  registeredTools: Map<string, any>
  registeredToolHooks: Map<string, any>
  registeredSessionHooks: Map<string, any>
  registeredMcps: Map<string, any>
  emittedEvents: Array<any>
} {
  const registeredTools = new Map<string, any>()
  const registeredToolHooks = new Map<string, any>()
  const registeredSessionHooks = new Map<string, any>()
  const registeredMcps = new Map<string, any>()
  const registeredCommands = new Map<string, any>()
  const updatedAgents = new Map<string, any>()
  let configuredDefaultAgent: string | undefined

  const mockAgentEditor = {
    list: () => [
      { id: "sisyphus", name: "sisyphus" },
      { id: "hephaestus", name: "hephaestus" },
    ],
    get: (id: string) => ({ id, name: id }),
    update: mock((id: string, updater: any) => {
      const a: any = { id, name: id }
      updater(a)
      updatedAgents.set(id, a)
      return a
    }),
    default: mock((id: string) => {
      configuredDefaultAgent = id
    }),
    remove: mock((id: string) => {}),
  }

  const mockCommandEditor = {
    add: mock((def: any) => {
      registeredCommands.set(def.name, def)
    }),
  }
  const emittedEvents: Array<any> = []

  const mockToolEditor = {
    list: () => [],
    get: (id: string) => registeredTools.get(id),
    namespace: () => {},
    add: (tool: any) => {
      registeredTools.set(tool.name, tool)
    },
    update: () => {},
    remove: (id: string) => {
      registeredTools.delete(id)
    },
  }

  const mockMcpEditor = {
    list: () => [...registeredMcps.entries()],
    get: (name: string) => registeredMcps.get(name),
    set: (name: string, config: any) => {
      registeredMcps.set(name, config)
    },
    update: (name: string, updater: any) => {
      const cur = registeredMcps.get(name)
      if (cur) updater(cur)
    },
    remove: (name: string) => {
      registeredMcps.delete(name)
    },
  }

  const mockContext: any = {
    location: { directory: process.cwd() },
    app: { url: new URL("http://localhost:4096") },
    options: {},
    agent: {
      list: mock(async () => [
        { id: "sisyphus", name: "sisyphus" },
        { id: "hephaestus", name: "hephaestus" },
      ]),
      get: mock(async () => undefined),
      transform: mock(async (callback: (editor: any) => void) => {
        await callback(mockAgentEditor)
        return { dispose: mock(async () => {}) }
      }),
    },
    command: {
      transform: mock(async (callback: (editor: any) => void) => {
        await callback(mockCommandEditor)
        return { dispose: mock(async () => {}) }
      }),
      list: mock(async () => []),
    },
    mcp: {
      transform: mock(async (callback: (editor: any) => void) => {
        callback(mockMcpEditor)
        return { dispose: mock(async () => {}) }
      }),
      list: mock(async () => []),
      reload: mock(async () => {}),
    },
    tool: {
      transform: mock(async (callback: (editor: any) => void) => {
        callback(mockToolEditor)
        return { dispose: mock(async () => {}) }
      }),
      hook: mock(async (name: string, callback: any) => {
        registeredToolHooks.set(name, callback)
        return { dispose: mock(async () => {}) }
      }),
    },
    session: {
      hook: mock(async (name: string, callback: any) => {
        registeredSessionHooks.set(name, callback)
        return { dispose: mock(async () => {}) }
      }),
      create: mock(async (body: any) => ({ id: "mock-session-123", ...body })),
      get: mock(async (id: string) => ({ id, title: "Test Session" })),
      context: mock(async (id: string) => [{ sessionID: id, messages: [] }]),
      interrupt: mock(async () => {}),
      prompt: mock(async (input: any) => ({ id: String(input?.sessionID), response: `Echo: ${input?.text}` })),
      wait: mock(async (_input: any) => {}),
      switchAgent: mock(async (_input: any) => {}),
    },
    event: {
      subscribe: mock((_options?: any) => {
        return (async function* () {
          yield { type: "session.idle", sessionID: "s-1" }
        })()
      }),
    },
    ...overrides,
  }

  return {
    context: mockContext,
    registeredTools,
    registeredToolHooks,
    registeredSessionHooks,
    registeredMcps,
    registeredCommands,
    updatedAgents,
    mockAgentEditor,
    mockCommandEditor,
    emittedEvents,
  }
}

describe("OpenCode V2 Compatibility Bridge", () => {
  describe("client-adapter", () => {
    it("creates V1 client shim that delegates session and agent operations to V2 context", async () => {
      const { context } = createMockV2Context()
      const v1Client = createV1ClientFromV2Context(context)

      const createRes = await v1Client.session.create({ title: "New Session" })
      expect(createRes.data.id).toBe("mock-session-123")

      const getRes = await v1Client.session.get({ path: { id: "s-1" } })
      expect(getRes.data.id).toBe("s-1")

      const agentsRes = await v1Client.app.agents()
      expect(agentsRes.data).toHaveLength(2)
      expect(agentsRes.data[0].id).toBe("sisyphus")
    })

    it("unwraps the V2 agent.list envelope instead of nesting it", async () => {
      // given a host that returns the real V2 shape { location, data }
      const { context } = createMockV2Context()
      ;(context as any).agent.list = mock(async () => ({
        location: { directory: "/tmp" },
        data: [{ id: "sisyphus" }, { id: "atlas" }],
      }))
      const v1Client = createV1ClientFromV2Context(context)

      // when a V1 caller asks for the agent list
      const agentsRes = await v1Client.app.agents()

      // then it receives a flat array, not the envelope
      expect(Array.isArray(agentsRes.data)).toBe(true)
      expect(agentsRes.data.map((a: any) => a.id)).toEqual(["sisyphus", "atlas"])
    })

    it("calls V2 session.prompt with a single input object and distinguishes sync from async", async () => {
      // given a V1 client over a mock V2 context
      const { context } = createMockV2Context()
      const v1Client = createV1ClientFromV2Context(context)

      // when a V1 caller dispatches an async prompt
      await v1Client.session.promptAsync({ path: { id: "s-42" }, body: { parts: [{ type: "text", text: "hi" }] } })

      // then V2 receives one object carrying sessionID and text, and is not awaited to completion
      expect((context as any).session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: "s-42", text: "hi" }),
      )
      expect((context as any).session.wait).not.toHaveBeenCalled()

      // when the same caller dispatches a synchronous prompt
      await v1Client.session.prompt({ path: { id: "s-42" }, body: { parts: [{ type: "text", text: "hi" }] } })

      // then the bridge blocks until the session goes idle
      expect((context as any).session.wait).toHaveBeenCalledWith({ sessionID: "s-42" })
    })
  })

  describe("tool-adapter", () => {
    it("registers tools in V2 editor and adapts execution result", async () => {
      const { context, registeredTools } = createMockV2Context()
      const mockV1Execute = mock(async (args: any) => `hello ${args.name}`)

      const v1Tools: any = {
        greet: {
          description: "Greets someone",
          args: { type: "object", properties: { name: { type: "string" } } },
          execute: mockV1Execute,
        },
      }

      await bindToolsToV2({
        v2Context: context,
        v1Tools,
        v1Hooks: {},
      })

      expect(registeredTools.has("greet")).toBe(true)
      const registeredGreet = registeredTools.get("greet")
      expect(registeredGreet.description).toBe("Greets someone")

      const toolCtx = {
        sessionID: "sess-1",
        messageID: "msg-1",
        agent: "sisyphus",
        signal: new AbortController().signal,
      }
      const execResult = await registeredGreet.execute({ name: "Alice" }, toolCtx)
      expect(execResult).toEqual({ content: "hello Alice" })
      expect(mockV1Execute).toHaveBeenCalled()
    })

    it("normalizes record of Zod field schemas into a Zod object schema", async () => {
      const { context, registeredTools } = createMockV2Context()
      const { z } = await import("zod")

      const v1Tools: any = {
        testTool: {
          description: "Test tool with field schemas",
          args: {
            fieldA: z.string().describe("Field A"),
            fieldB: z.number().optional(),
          },
          execute: mock(async (args: any) => JSON.stringify(args)),
        },
      }

      await bindToolsToV2({
        v2Context: context,
        v1Tools,
        v1Hooks: {},
      })

      expect(registeredTools.has("testTool")).toBe(true)
      const tool = registeredTools.get("testTool")
      expect("~standard" in tool.input || "_def" in tool.input).toBe(true)
    })

    it("wires tool.execute.before and tool.execute.after hooks", async () => {
      const { context, registeredToolHooks } = createMockV2Context()

      const v1Before = mock(async (_input: any, output: any) => {
        output.args.injected = true
      })
      const v1After = mock(async (_input: any, output: any) => {
        output.output = output.output.toUpperCase()
        output.metadata.processed = true
      })

      await bindToolsToV2({
        v2Context: context,
        v1Tools: {},
        v1Hooks: {
          "tool.execute.before": v1Before,
          "tool.execute.after": v1After,
        },
      })

      // Test execute.before hook
      const beforeHook = registeredToolHooks.get("execute.before")
      expect(beforeHook).toBeDefined()
      const beforeEvent: any = {
        tool: "custom_tool",
        sessionID: "s-1",
        id: "call-1",
        input: { original: 123 },
      }
      await beforeHook(beforeEvent)
      expect(beforeEvent.input.injected).toBe(true)

      // Test execute.after hook
      const afterHook = registeredToolHooks.get("execute.after")
      expect(afterHook).toBeDefined()
      const afterEvent: any = {
        tool: "custom_tool",
        sessionID: "s-1",
        id: "call-1",
        status: "completed",
        result: {
          content: "sample text",
          metadata: {},
        },
      }
      await afterHook(afterEvent)
      expect(afterEvent.result.content).toBe("SAMPLE TEXT")
      expect(afterEvent.result.metadata.processed).toBe(true)
    })
  })

  describe("session-adapter", () => {
    it("wires prompt, context, model.request, and compaction hooks", async () => {
      const { context, registeredSessionHooks } = createMockV2Context()

      const v1ChatMessage = mock(async (_input: any, output: any) => {
        output.parts[0].text = "enhanced prompt"
      })
      const v1SystemTransform = mock(async (_input: any, output: any) => {
        output.system.push("injected rule")
      })
      const v1MessagesTransform = mock(async (_input: any, output: any) => {
        output.messages.push({ role: "system", content: "guard" })
      })
      const v1ChatParams = mock(async (_input: any, output: any) => {
        output.options = { reasoningEffort: "high" }
      })
      const v1ChatHeaders = mock(async (_input: any, output: any) => {
        output.headers = { "x-custom-auth": "secret" }
      })
      const v1Compacting = mock(async () => {})

      await bindSessionHooksToV2({
        v2Context: context,
        v1Hooks: {
          "chat.message": v1ChatMessage,
          "experimental.chat.system.transform": v1SystemTransform,
          "experimental.chat.messages.transform": v1MessagesTransform,
          "chat.params": v1ChatParams,
          "chat.headers": v1ChatHeaders,
          "experimental.session.compacting": v1Compacting,
        },
      })

      // 1. prompt hook
      const promptHook = registeredSessionHooks.get("prompt")
      const promptEvent: any = { sessionID: "s-1", prompt: "original", metadata: {} }
      await promptHook(promptEvent)
      expect(promptEvent.prompt).toBe("enhanced prompt")

      // 2. context hook
      const contextHook = registeredSessionHooks.get("context")
      const contextEvent: any = {
        sessionID: "s-1",
        agent: "sisyphus",
        model: {},
        system: ["base prompt"],
        messages: [{ role: "user", content: "hi" }],
        options: {},
      }
      await contextHook(contextEvent)
      expect(contextEvent.system.map((s: any) => s.text)).toContain("injected rule")
      expect(contextEvent.messages).toHaveLength(2)
      expect(contextEvent.options.reasoningEffort).toBe("high")

      // 3. model.request hook
      const modelReqHook = registeredSessionHooks.get("model.request")
      const modelReqEvent: any = { sessionID: "s-1", agent: "sisyphus", headers: {} }
      await modelReqHook(modelReqEvent)
      expect(modelReqEvent.headers["x-custom-auth"]).toBe("secret")

      // 4. compaction hook
      const compactionHook = registeredSessionHooks.get("compaction")
      const compactionEvent: any = { sessionID: "s-1" }
      await compactionHook(compactionEvent)
      expect(v1Compacting).toHaveBeenCalled()
    })
  })

  describe("mcp-adapter", () => {
    it("registers built-in OMO MCP servers via v2Context.mcp.transform", async () => {
      const { context, registeredMcps } = createMockV2Context()
      const disposers = await bindMcpToV2({
        v2Context: context,
        directory: process.cwd(),
      })

      expect(disposers.length).toBeGreaterThan(0)
      expect(registeredMcps.has("context7")).toBe(true)
      expect(registeredMcps.has("grep_app")).toBe(true)
      expect(registeredMcps.has("websearch")).toBe(true)
      expect(registeredMcps.has("lsp")).toBe(true)

      const context7 = registeredMcps.get("context7")
      expect(context7.type).toBe("remote")
      expect(context7.url).toBe("https://mcp.context7.com/mcp")

      // Existing servers are not overwritten
      registeredMcps.set("custom-server", { type: "remote", url: "https://custom.com" })
      await bindMcpToV2({ v2Context: context, directory: process.cwd() })
      expect(registeredMcps.get("custom-server").url).toBe("https://custom.com")

      // Disposers work
      for (const dispose of disposers) {
        await expect(dispose()).resolves.toBeUndefined()
      }
    })
  })

  describe("config-adapter", () => {
    it("parseModelString extracts providerID and modelID properly", () => {
      const parsed1 = parseModelString("kiro-proxy/claude-opus-5.5-thinking", "max")
      expect(parsed1.providerID).toBe("kiro-proxy")
      expect(parsed1.id).toBe("claude-opus-5.5-thinking")
      expect(parsed1.variant).toBe("max")

      const parsed2 = parseModelString("mmodiary/doitac2/deepseek-v4-pro")
      expect(parsed2.providerID).toBe("mmodiary")
      expect(parsed2.id).toBe("doitac2/deepseek-v4-pro")

      const parsed3 = parseModelString("claude-sonnet-4-5")
      expect(parsed3.providerID).toBe("anthropic")
      expect(parsed3.id).toBe("claude-sonnet-4-5")
    })

    it("binds OMO agent model overrides and default agent into V2 agent domain", async () => {
      const { context, updatedAgents, mockAgentEditor } = createMockV2Context()

      const v1Config = {
        default_agent: "sisyphus",
        agent: {
          sisyphus: {
            model: "kiro-proxy/claude-opus-5.5-thinking",
            mode: "primary",
            prompt: "Custom Sisyphus prompt",
          },
        },
      }

      const disposers = await bindConfigToV2({
        v2Context: context,
        v1Config,
      })

      expect(mockAgentEditor.default).toHaveBeenCalledWith("sisyphus")
      expect(mockAgentEditor.update).toHaveBeenCalled()

      const updatedSisyphus = updatedAgents.get("sisyphus")
      expect(updatedSisyphus).toBeDefined()
      expect(updatedSisyphus.model).toEqual({
        providerID: "kiro-proxy",
        id: "claude-opus-5.5-thinking",
      })
      expect(updatedSisyphus.system).toBe("Custom Sisyphus prompt")

      for (const dispose of disposers) {
        await expect(dispose()).resolves.toBeUndefined()
      }
    })

    it("expands $ARGUMENTS, $SESSION_ID and $TIMESTAMP in a command template", () => {
      // given a V1 command template using all three placeholders
      const template = "<cmd>$ARGUMENTS</cmd> session=$SESSION_ID at=$TIMESTAMP"

      // when it is expanded for a real invocation
      const expanded = expandCommandTemplate(template, {
        args: "fix the bug",
        sessionID: "ses_abc",
        timestamp: "2026-11-17T00:00:00.000Z",
      })

      // then every placeholder is substituted and none survive
      expect(expanded).toBe("<cmd>fix the bug</cmd> session=ses_abc at=2026-11-17T00:00:00.000Z")
      expect(expanded).not.toContain("$")
    })

    it("dispatches the expanded template as a prompt when a command executes", async () => {
      // given an OMO command carrying a template and a target agent
      const { context, registeredCommands } = createMockV2Context()
      await bindConfigToV2({
        v2Context: context,
        v1Config: {
          command: {
            "ulw-execute": {
              description: "Execute a plan",
              agent: "atlas",
              template: "<user-request>$ARGUMENTS</user-request>",
            },
          },
        },
      })
      const command = registeredCommands.get("ulw-execute")
      expect(command).toBeDefined()

      // when the host executes it
      await command.execute({ sessionID: "ses_xyz", prompt: { text: "my-plan.md" }, delivery: "queue" })

      // then the declared agent is selected and the expanded template reaches the session
      expect((context as any).session.switchAgent).toHaveBeenCalledWith({ sessionID: "ses_xyz", agent: "atlas" })
      expect((context as any).session.prompt).toHaveBeenCalledWith({
        sessionID: "ses_xyz",
        text: "<user-request>my-plan.md</user-request>",
        delivery: "queue",
      })
    })
  })

  describe("setupOpenCodeV2Bridge", () => {
    it("initializes OMO runtime, registers tools and hooks, and disposes cleanly", async () => {
      const { context, registeredTools, registeredSessionHooks, registeredMcps, mockAgentEditor } = createMockV2Context()

      const cleanup = await setupOpenCodeV2Bridge(context)

      // Verify tools from OMO were registered
      expect(registeredTools.size).toBeGreaterThan(0)
      expect(registeredTools.has("session_list") || registeredTools.has("grep") || registeredTools.has("skill")).toBe(true)

      // Verify session hooks were registered
      expect(registeredSessionHooks.has("prompt")).toBe(true)
      expect(registeredSessionHooks.has("context")).toBe(true)

      // Verify MCP servers were registered
      expect(registeredMcps.has("context7")).toBe(true)
      expect(registeredMcps.has("grep_app")).toBe(true)

      // Verify agent transform updated agents
      expect(mockAgentEditor.update).toHaveBeenCalled()

      // Test cleanup
      await expect(cleanup()).resolves.toBeUndefined()
    })
  })
})
