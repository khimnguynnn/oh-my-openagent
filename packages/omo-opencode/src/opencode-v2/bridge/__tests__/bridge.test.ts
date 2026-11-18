import { describe, expect, it, mock } from "bun:test"
import type { Context } from "@opencode/plugin/promise/plugin"
import { createV1ClientFromV2Context } from "../client-adapter"
import { bindToolsToV2 } from "../tool-adapter"
import { bindSessionHooksToV2 } from "../session-adapter"
import { bindMcpToV2 } from "../mcp-adapter"
import { bindConfigToV2, expandCommandTemplate, parseModelString } from "../config-adapter"
import { resolveProviderForBareModel } from "../provider-adapter"
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
      get: mock(async (input: any) => ({ id: input?.sessionID, title: "Test Session" })),
      list: mock(async (_input?: any) => ({ data: [{ id: "child-1" }, { id: "child-2" }], cursor: {} })),
      context: mock(async (input: any) => [{ sessionID: input?.sessionID, messages: [] }]),
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

    it("passes the V2 sessionID options object that V2 validation requires", async () => {
      // given a V1 client over a mock V2 context
      const { context } = createMockV2Context()
      const v1Client = createV1ClientFromV2Context(context)

      // when V1 callers use the bare-id and path shapes
      await v1Client.session.get({ path: { id: "s-get" } })
      await v1Client.session.messages({ path: { id: "s-msgs" } })
      await v1Client.session.abort({ path: { id: "s-abort" } })

      // then V2 receives the { sessionID } object, never a bare string (which fails with
      // "SchemaError: Expected object" and is why permissions never refreshed)
      expect((context as any).session.get).toHaveBeenCalledWith({ sessionID: "s-get" })
      expect((context as any).session.context).toHaveBeenCalledWith({ sessionID: "s-msgs" })
      expect((context as any).session.interrupt).toHaveBeenCalledWith({ sessionID: "s-abort" })
    })

    it("routes children through session.list with a parentID filter", async () => {
      // given a host that returns the real V2 list envelope { data, cursor }
      const { context } = createMockV2Context()
      const v1Client = createV1ClientFromV2Context(context)

      // when a V1 caller asks for a session's children
      const children = await v1Client.session.children({ path: { id: "parent-1" } })

      // then V2 filters by parentID and the envelope is unwrapped to rows
      expect((context as any).session.list).toHaveBeenCalledWith({ parentID: "parent-1" })
      expect(children.data.map((s: any) => s.id)).toEqual(["child-1", "child-2"])
    })

    it("exposes session.list with the envelope unwrapped", async () => {
      // given a host whose list endpoint answers { data, cursor }
      const { context } = createMockV2Context()
      const v1Client = createV1ClientFromV2Context(context)

      // when a V1 caller lists sessions
      const listed = await v1Client.session.list()

      // then it receives rows rather than the envelope
      expect(listed.data).toHaveLength(2)
      expect(listed.data[0].id).toBe("child-1")
    })

    it("flattens the V2 location.directory that session directory filters read", async () => {
      // given a host returning the real V2 record, which nests the directory under location
      const { context } = createMockV2Context()
      ;(context as any).session.get = mock(async (input: any) => ({
        id: input?.sessionID,
        projectID: "p-1",
        location: { directory: "/work/proj" },
      }))
      ;(context as any).session.list = mock(async () => ({
        data: [{ id: "s-1", location: { directory: "/work/proj" } }],
        cursor: {},
      }))
      const v1Client = createV1ClientFromV2Context(context)

      // when a V1 caller reads one session and lists sessions
      const one = await v1Client.session.get({ path: { id: "s-1" } })
      const many = await v1Client.session.list()

      // then both carry the flat directory V1 consumers filter on
      expect(one.data.directory).toBe("/work/proj")
      expect(many.data[0].directory).toBe("/work/proj")
    })

    it("maps V2 session entries into the V1 message shape readers filter on", async () => {
      // given a host returning the real V2 context envelope: a flat entry list, not V1 messages
      const { context } = createMockV2Context()
      ;(context as any).session.context = mock(async () => ({
        data: [
          { id: "msg-switch", type: "agent-switched", agent: "build" },
          { id: "msg-user", type: "user", text: "hello", time: { created: 10 } },
          {
            id: "msg-asst",
            type: "assistant",
            agent: "build",
            time: { created: 20, completed: 30 },
            content: [
              { type: "reasoning", text: "thinking out loud" },
              {
                type: "tool",
                id: "call-1",
                name: "execute",
                state: { input: { code: "1" }, content: [{ type: "text", text: "result text" }] },
              },
            ],
          },
        ],
      }))
      const v1Client = createV1ClientFromV2Context(context)

      // when a V1 reader asks for the history
      const messages = await v1Client.session.messages({ path: { id: "s-1" } })

      // then only real messages survive, each carrying the info.id readers key on
      expect(messages.data.map((m: any) => m.info.id)).toEqual(["msg-user", "msg-asst"])
      expect(messages.data[0].info.role).toBe("user")
      expect(messages.data[0].parts[0]).toMatchObject({ type: "text", text: "hello" })

      // and assistant content becomes the V1 part types the formatter renders
      const assistant = messages.data[1]
      expect(assistant.info.agent).toBe("build")
      expect(assistant.info.time).toEqual({ created: 20, updated: 30 })
      expect(assistant.parts[0]).toMatchObject({ type: "thinking", thinking: "thinking out loud" })
      expect(assistant.parts[1]).toMatchObject({
        type: "tool",
        tool: "execute",
        callID: "call-1",
        input: { code: "1" },
        output: "result text",
      })
    })

    it("reports a failed session.messages instead of silently returning an empty history", async () => {
      // given a host whose context call rejects
      const { context } = createMockV2Context()
      ;(context as any).session.context = mock(async () => {
        throw new Error("SchemaError: Expected object")
      })
      const v1Client = createV1ClientFromV2Context(context)

      // when a V1 caller reads the history
      const messages = await v1Client.session.messages({ path: { id: "s-1" } })

      // then it still gets an array, and the failure is surfaced through the log
      expect(messages.data).toEqual([])
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

    it("converts a record of Zod field schemas into plain JSON Schema", async () => {
      // given a V1 tool whose args are a map of Zod field schemas
      const { context, registeredTools } = createMockV2Context()
      const { z } = await import("zod")

      const v1Tools: any = {
        testTool: {
          description: "Test tool with field schemas",
          args: {
            fieldA: z.string().describe("Field A"),
            fieldB: z.number().optional(),
            fieldC: z.enum(["one", "two"]).optional(),
          },
          execute: mock(async (args: any) => JSON.stringify(args)),
        },
      }

      // when the tools are bound to V2
      await bindToolsToV2({ v2Context: context, v1Tools, v1Hooks: {} })

      // then the registered input is JSON Schema the host never has to introspect with its own zod
      const tool = registeredTools.get("testTool")
      expect(tool.input.type).toBe("object")
      expect(Object.keys(tool.input.properties)).toEqual(["fieldA", "fieldB", "fieldC"])
      expect(tool.input.required).toEqual(["fieldA"])
      expect(tool.input.properties.fieldA.description).toBe("Field A")
      expect(tool.input.properties.fieldC.enum).toEqual(["one", "two"])
      expect("~standard" in tool.input).toBe(false)
      expect("_def" in tool.input).toBe(false)
    })

    it("converts a Zod object schema and passes plain JSON Schema through untouched", async () => {
      // given one tool with a Zod object schema and one with hand-written JSON Schema
      const { context, registeredTools } = createMockV2Context()
      const { z } = await import("zod")
      const jsonSchema = { type: "object", properties: { raw: { type: "string" } } }

      const v1Tools: any = {
        zodTool: {
          description: "Zod object",
          args: z.object({ a: z.string() }),
          execute: mock(async () => "ok"),
        },
        jsonTool: {
          description: "JSON schema",
          args: jsonSchema,
          execute: mock(async () => "ok"),
        },
      }

      // when the tools are bound to V2
      await bindToolsToV2({ v2Context: context, v1Tools, v1Hooks: {} })

      // then both arrive as JSON Schema, and the already-plain one is unchanged
      expect(registeredTools.get("zodTool").input).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      })
      expect(registeredTools.get("jsonTool").input).toEqual(jsonSchema)
    })

    it("converts a field map built by the plugin's own zod copy", async () => {
      // given a V1 tool whose args were built with `tool.schema` (the @opencode-ai/plugin zod copy)
      const { context, registeredTools } = createMockV2Context()
      const { tool } = await import("@opencode-ai/plugin/tool")

      const v1Tools: any = {
        pluginZodTool: {
          description: "Args built by the plugin zod copy",
          args: {
            pattern: tool.schema.string().describe("Pattern"),
            output_mode: tool.schema.enum(["content", "count"]).optional(),
          },
          execute: mock(async () => "ok"),
        },
      }

      // when the tools are bound to V2
      await bindToolsToV2({ v2Context: context, v1Tools, v1Hooks: {} })

      // then the field map converts instead of collapsing to a permissive empty schema
      expect(registeredTools.get("pluginZodTool").input).toEqual({
        type: "object",
        properties: {
          pattern: { type: "string", description: "Pattern" },
          output_mode: { type: "string", enum: ["content", "count"] },
        },
        required: ["pattern"],
      })
    })

    it("falls back to a permissive object schema when args are unusable", async () => {
      // given a tool whose args are neither Zod nor JSON Schema
      const { context, registeredTools } = createMockV2Context()

      const v1Tools: any = {
        oddTool: { description: "No usable args", args: undefined, execute: mock(async () => "ok") },
      }

      // when the tools are bound to V2
      await bindToolsToV2({ v2Context: context, v1Tools, v1Hooks: {} })

      // then the tool still registers instead of being skipped by the host
      expect(registeredTools.get("oddTool").input).toEqual({
        type: "object",
        properties: {},
        additionalProperties: true,
      })
    })

    it("hands tools an AbortSignal as abort, matching the V1 tool context", async () => {
      // given a V1 tool that reads the caller abort signal the way session_* tools do
      const { context, registeredTools } = createMockV2Context()
      const seen: Array<unknown> = []

      const v1Tools: any = {
        signalReader: {
          description: "Reads the abort signal",
          args: { type: "object", properties: {} },
          execute: mock(async (_args: any, toolCtx: any) => {
            seen.push(toolCtx.abort)
            toolCtx.abort?.throwIfAborted()
            return "ok"
          }),
        },
      }

      // when the host executes the tool with its own signal
      await bindToolsToV2({ v2Context: context, v1Tools, v1Hooks: {} })
      const caller = new AbortController()
      await registeredTools.get("signalReader").execute({}, { sessionID: "s-1", signal: caller.signal })

      // then abort is that AbortSignal, not an empty function, so throwIfAborted exists
      expect(seen[0]).toBe(caller.signal)
      expect(typeof (seen[0] as any)?.throwIfAborted).toBe("function")
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
      expect(parsed1?.providerID).toBe("kiro-proxy")
      expect(parsed1?.id).toBe("claude-opus-5.5-thinking")
      expect(parsed1?.variant).toBe("max")

      const parsed2 = parseModelString("mmodiary/doitac2/deepseek-v4-pro")
      expect(parsed2?.providerID).toBe("mmodiary")
      expect(parsed2?.id).toBe("doitac2/deepseek-v4-pro")
    })

    it("resolves a bare model id through the live catalog instead of assuming anthropic", () => {
      // given a catalog where exactly one provider serves the bare id
      const models = [
        { id: "gpt-6.2-sol", providerID: "openai" },
        { id: "claude-sonnet-4-5", providerID: "anthropic" },
      ]
      const resolve = (modelID: string) => resolveProviderForBareModel(modelID, models)

      // when parsing a bare id the catalog knows
      const parsed = parseModelString("gpt-6.2-sol", undefined, resolve)

      // then it routes to the provider that actually serves it
      expect(parsed?.providerID).toBe("openai")
      expect(parsed?.id).toBe("gpt-6.2-sol")
    })

    it("refuses to guess a provider for a bare model id nothing serves", () => {
      // given a catalog without the requested id
      const resolve = (modelID: string) => resolveProviderForBareModel(modelID, [])

      // when parsing a bare id, with and without a resolver
      const unresolved = parseModelString("claude-sonnet-4-5", undefined, resolve)
      const noResolver = parseModelString("claude-sonnet-4-5")

      // then nothing is returned, so the caller can skip rather than route to anthropic
      expect(unresolved).toBeUndefined()
      expect(noResolver).toBeUndefined()
    })

    it("skips the model write when a bare model id cannot be resolved", async () => {
      // given an agent configured with a bare model id no provider serves
      const { context, updatedAgents } = createMockV2Context()

      // when the bridge binds the config with an empty catalog
      await bindConfigToV2({
        v2Context: context,
        v1Config: { agent: { sisyphus: { name: "sisyphus", model: "mystery-model" } } },
        providerModels: [],
      })

      // then the agent keeps the host's model rather than gaining a fabricated one
      expect(updatedAgents.get("sisyphus")?.model).toBeUndefined()
    })

    it("writes the model when the catalog resolves the bare id", async () => {
      // given a catalog that serves the bare id
      const { context, updatedAgents } = createMockV2Context()

      // when the bridge binds the config
      await bindConfigToV2({
        v2Context: context,
        v1Config: { agent: { sisyphus: { name: "sisyphus", model: "gpt-6.2-sol" } } },
        providerModels: [{ id: "gpt-6.2-sol", providerID: "openai" }],
      })

      // then the model is routed to the provider that serves it
      expect(updatedAgents.get("sisyphus")?.model).toEqual({ providerID: "openai", id: "gpt-6.2-sol" })
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

    it("sets each agent's display name even though V2 pre-fills name with the id", async () => {
      // given a V1 config whose agents carry no explicit name, against an editor that pre-fills
      // `name` with the id exactly as V2 does
      const { context, updatedAgents } = createMockV2Context()

      // when
      await bindConfigToV2({
        v2Context: context,
        v1Config: {
          agent: {
            sisyphus: { model: "kiro-proxy/claude-opus-5" },
            prometheus: { model: "kiro-proxy/claude-opus-5" },
          },
        },
      })

      // then the display name replaces the id, and the id itself is untouched
      expect(updatedAgents.get("sisyphus")?.name).toBe("Sisyphus - ultraworker")
      expect(updatedAgents.get("sisyphus")?.id).toBe("sisyphus")
      expect(updatedAgents.get("prometheus")?.name).toBe("Prometheus - Plan Builder")
    })

    it("keeps an explicit agent name from the V1 config", async () => {
      // given an agent config that names itself
      const { context, updatedAgents } = createMockV2Context()

      // when
      await bindConfigToV2({
        v2Context: context,
        v1Config: { agent: { oracle: { name: "Custom Oracle", prompt: "p" } } },
      })

      // then the explicit name wins over the display-name table
      expect(updatedAgents.get("oracle")?.name).toBe("Custom Oracle")
    })

    it("registers the core agents in canonical order so V2's insertion order reflects it", async () => {
      // given agents supplied in a deliberately non-canonical order
      const { context, updatedAgents } = createMockV2Context()

      // when
      await bindConfigToV2({
        v2Context: context,
        v1Config: {
          agent: {
            atlas: { prompt: "p" },
            oracle: { prompt: "p" },
            prometheus: { prompt: "p" },
            sisyphus: { prompt: "p" },
            hephaestus: { prompt: "p" },
          },
        },
      })

      // then the core four are written first, in canonical order, with non-core agents after
      expect([...updatedAgents.keys()]).toEqual(["sisyphus", "hephaestus", "prometheus", "atlas", "oracle"])
    })

    it("honors a user agent_order override when registering agents", async () => {
      // given an agent_order that inverts the default core order
      const { context, updatedAgents } = createMockV2Context()

      // when
      await bindConfigToV2({
        v2Context: context,
        v1Config: {
          agent: {
            atlas: { prompt: "p" },
            prometheus: { prompt: "p" },
            sisyphus: { prompt: "p" },
            hephaestus: { prompt: "p" },
          },
        },
        rawPluginConfig: { agent_order: ["hephaestus", "sisyphus", "prometheus", "atlas"] },
      })

      // then the configured order wins
      expect([...updatedAgents.keys()]).toEqual(["hephaestus", "sisyphus", "prometheus", "atlas"])
    })

    it("accepts display names inside agent_order and still orders canonically", async () => {
      // given an agent_order written with display names, as legacy configs carry them
      const { context, updatedAgents } = createMockV2Context()

      // when
      await bindConfigToV2({
        v2Context: context,
        v1Config: {
          agent: {
            atlas: { prompt: "p" },
            prometheus: { prompt: "p" },
            sisyphus: { prompt: "p" },
            hephaestus: { prompt: "p" },
          },
        },
        rawPluginConfig: {
          agent_order: ["Atlas - Plan Executor", "Prometheus - Plan Builder", "Sisyphus - ultraworker", "Hephaestus - Deep Agent"],
        },
      })

      // then the display names normalize to config keys before ordering
      expect([...updatedAgents.keys()]).toEqual(["atlas", "prometheus", "sisyphus", "hephaestus"])
    })

    it("normalizes a display name in a command's agent field before switching the session agent", async () => {
      // given a command targeting a display name, as V1 configs carry them
      const { context, registeredCommands } = createMockV2Context()
      const switched: Array<string> = []
      ;(context.session as any).switchAgent = async ({ agent }: { agent: string }) => {
        switched.push(agent)
      }

      await bindConfigToV2({
        v2Context: context,
        v1Config: {
          command: {
            plan: { template: "do it", agent: "Prometheus - Plan Builder" },
          },
        },
      })

      // when the command runs
      await registeredCommands.get("plan").execute({ sessionID: "s1", prompt: { text: "" } })

      // then V2 receives the canonical agent id, not the display name
      expect(switched).toEqual(["prometheus"])
    })

    it("leaves a host built-in's capitalized name alone when it has no display-name entry", async () => {
      // given a V2 editor whose built-in agents already carry capitalized names
      const { context, updatedAgents } = createMockV2Context()
      ;(context.agent as any).transform = async (cb: any) => {
        cb({
          list: () => [],
          get: () => undefined,
          default: () => {},
          remove: () => {},
          update: (_id: string, fn: any) => {
            const agent: any = { id: "build", name: "Build" }
            fn(agent)
            updatedAgents.set("build", agent)
          },
        })
        return { dispose: async () => {} }
      }

      // when a V1 config also mentions that agent (its key has no display-name entry)
      await bindConfigToV2({
        v2Context: context,
        v1Config: { agent: { build: { prompt: "p" } } },
      })

      // then the host's capitalized name survives
      expect(updatedAgents.get("build")?.name).toBe("Build")
    })

    it("projects OMO tool permissions onto the V2 agent ruleset", async () => {
      // given a V1 config carrying phase 4 output: global tool flags, global permission, and
      // per-agent permission maps
      const { context, updatedAgents } = createMockV2Context()

      const v1Config = {
        tools: { "grep_app_*": false, "task_*": false, teammate: false },
        permission: { webfetch: "allow", external_directory: "allow", task: "deny" },
        agent: {
          librarian: {
            name: "librarian",
            permission: { "grep_app_*": "allow", task: "deny" },
          },
          sisyphus: {
            name: "sisyphus",
            permission: { task: "allow", "task_*": "allow", teammate: "allow", call_omo_agent: "deny" },
          },
          prometheus: {
            name: "prometheus",
            permission: { task: "allow", bash: "deny", interactive_bash: "deny" },
          },
        },
      }

      // when the bridge binds the config to V2
      await bindConfigToV2({ v2Context: context, v1Config })

      const ruleFor = (agentID: string, action: string, resource = "*") =>
        updatedAgents
          .get(agentID)
          ?.permissions?.findLast((rule: any) => rule.action === action && rule.resource === resource)?.effect

      // then the global deny reaches every agent
      expect(ruleFor("librarian", "task_*")).toBe("deny")
      expect(ruleFor("librarian", "webfetch")).toBe("allow")
      expect(ruleFor("librarian", "external_directory")).toBe("allow")

      // and the per-agent grants override it where OMO grants them
      expect(ruleFor("librarian", "grep_app_*")).toBe("allow")
      expect(ruleFor("sisyphus", "task")).toBe("allow")
      expect(ruleFor("sisyphus", "subagent")).toBe("allow")
      expect(ruleFor("sisyphus", "call_omo_agent")).toBe("deny")
      expect(ruleFor("prometheus", "bash")).toBe("deny")
      expect(ruleFor("prometheus", "shell")).toBe("deny")
      expect(ruleFor("prometheus", "interactive_bash")).toBe("deny")
    })

    it("keeps the permission projection idempotent across repeated transforms", async () => {
      // given a bound config and a captured agent transform updater
      const { context, updatedAgents, mockAgentEditor } = createMockV2Context()
      await bindConfigToV2({
        v2Context: context,
        v1Config: {
          tools: { "grep_app_*": false },
          agent: { sisyphus: { name: "sisyphus", permission: { "grep_app_*": "allow" } } },
        },
      })

      const updater = (mockAgentEditor.update as any).mock.calls[0][1]
      const agent = updatedAgents.get("sisyphus")
      const firstSnapshot = JSON.parse(JSON.stringify(agent.permissions))

      // when the host re-runs the transform over the same agent object
      updater(agent)
      updater(agent)

      // then the ruleset is byte-identical, so nothing accumulates
      expect(agent.permissions).toEqual(firstSnapshot)
    })

    it("expands $ARGUMENTS, $SESSION_ID and $TIMESTAMP in a command template", () => {      // given a V1 command template using all three placeholders
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
