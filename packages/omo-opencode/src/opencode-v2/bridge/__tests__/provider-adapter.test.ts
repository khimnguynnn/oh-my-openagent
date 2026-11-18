import { describe, expect, it } from "bun:test"
import {
  resolveProviderForBareModel,
  summarizeV1ProviderConfig,
  toV1ProviderConfig,
  type V2ModelInfoLike,
  type V2ProviderInfoLike,
} from "../provider-adapter"

const PROVIDERS: V2ProviderInfoLike[] = [
  { id: "anthropic", headers: { "anthropic-beta": "context-1m-2025-08-07" } },
  { id: "openai" },
  { id: "kiro-proxy", request: { headers: { "x-route": "kiro" } } },
]

const MODELS: V2ModelInfoLike[] = [
  {
    id: "claude-fable-5-2",
    modelID: "claude-fable-5-2",
    providerID: "anthropic",
    capabilities: { input: ["text", "image", "pdf"] },
    limit: { context: 1000000 },
  },
  {
    id: "claude-text-only",
    providerID: "anthropic",
    capabilities: { input: ["text"] },
    limit: { context: 200000 },
  },
  {
    id: "gpt-6.2-sol",
    modelID: "gpt-6.2-sol",
    providerID: "openai",
    capabilities: { input: ["text", "image"] },
    limit: { context: 400000 },
  },
]

describe("toV1ProviderConfig", () => {
  describe("#given a V2 catalog with provider headers", () => {
    it("#when translating #then headers land where phase 1 reads anthropic-beta", () => {
      // given
      const catalog = { providers: PROVIDERS, models: [] }

      // when
      const result = toV1ProviderConfig(catalog)

      // then
      expect(result.anthropic?.options?.headers?.["anthropic-beta"]).toBe("context-1m-2025-08-07")
    })

    it("#when a provider carries headers under request #then they are merged in", () => {
      // given
      const catalog = { providers: PROVIDERS, models: [] }

      // when
      const result = toV1ProviderConfig(catalog)

      // then
      expect(result["kiro-proxy"]?.options?.headers?.["x-route"]).toBe("kiro")
    })

    it("#when a provider has no headers #then no options key is emitted", () => {
      // given
      const catalog = { providers: PROVIDERS, models: [] }

      // when
      const result = toV1ProviderConfig(catalog)

      // then
      expect(result.openai?.options).toBeUndefined()
      expect(result.openai?.models).toEqual({})
    })
  })

  describe("#given models carrying context limits and modalities", () => {
    it("#when translating #then the context limit is keyed by model id", () => {
      // given
      const catalog = { providers: PROVIDERS, models: MODELS }

      // when
      const result = toV1ProviderConfig(catalog)

      // then
      expect(result.anthropic?.models["claude-fable-5-2"]?.limit?.context).toBe(1000000)
      expect(result.openai?.models["gpt-6.2-sol"]?.limit?.context).toBe(400000)
    })

    it("#when a model accepts images #then the modality survives for the vision cache", () => {
      // given
      const catalog = { providers: PROVIDERS, models: MODELS }

      // when
      const result = toV1ProviderConfig(catalog)

      // then
      expect(result.anthropic?.models["claude-fable-5-2"]?.modalities?.input).toContain("image")
      expect(result.anthropic?.models["claude-text-only"]?.modalities?.input).not.toContain("image")
    })

    it("#when a model has no usable context limit #then no limit key is emitted", () => {
      // given
      const models: V2ModelInfoLike[] = [
        { id: "no-limit", providerID: "openai", limit: { context: 0 } },
        { id: "null-limit", providerID: "openai", limit: null },
      ]

      // when
      const result = toV1ProviderConfig({ providers: [], models })

      // then
      expect(result.openai?.models["no-limit"]?.limit).toBeUndefined()
      expect(result.openai?.models["null-limit"]?.limit).toBeUndefined()
    })

    it("#when a model names a provider absent from the provider list #then an entry is still created", () => {
      // given
      const models: V2ModelInfoLike[] = [
        { id: "ghost-model", providerID: "ghost", limit: { context: 1000 } },
      ]

      // when
      const result = toV1ProviderConfig({ providers: [], models })

      // then
      expect(result.ghost?.models["ghost-model"]?.limit?.context).toBe(1000)
    })

    it("#when modelID differs from id #then modelID is the key phase 1 caches under", () => {
      // given
      const models: V2ModelInfoLike[] = [
        { id: "display-id", modelID: "real-model-id", providerID: "openai", limit: { context: 123 } },
      ]

      // when
      const result = toV1ProviderConfig({ providers: [], models })

      // then
      expect(result.openai?.models["real-model-id"]?.limit?.context).toBe(123)
      expect(result.openai?.models["display-id"]).toBeUndefined()
    })
  })
})

describe("summarizeV1ProviderConfig", () => {
  describe("#given a seeded provider map", () => {
    it("#when summarizing #then it reports the counts the caches derive from", () => {
      // given
      const seeded = toV1ProviderConfig({ providers: PROVIDERS, models: MODELS })

      // when
      const summary = summarizeV1ProviderConfig(seeded)

      // then
      expect(summary.providerCount).toBe(3)
      expect(summary.modelCount).toBe(3)
      expect(summary.modelsWithContextLimit).toBe(3)
      expect(summary.imageCapableModels).toBe(2)
    })

    it("#when the map is empty #then every count is zero", () => {
      // when
      const summary = summarizeV1ProviderConfig({})

      // then
      expect(summary).toEqual({
        providerCount: 0,
        modelCount: 0,
        modelsWithContextLimit: 0,
        imageCapableModels: 0,
      })
    })

    it("#when summarized #then no header value is echoed", () => {
      // given
      const seeded = toV1ProviderConfig({ providers: PROVIDERS, models: [] })

      // when
      const serialized = JSON.stringify(summarizeV1ProviderConfig(seeded))

      // then
      expect(serialized).not.toContain("context-1m")
      expect(serialized).not.toContain("kiro")
    })
  })
})

describe("resolveProviderForBareModel", () => {  describe("#given a bare model id", () => {
    it("#when exactly one provider exposes it #then that provider is returned", () => {
      // when
      const resolved = resolveProviderForBareModel("gpt-6.2-sol", MODELS)

      // then
      expect(resolved).toBe("openai")
    })

    it("#when no provider exposes it #then nothing is returned", () => {
      // when
      const resolved = resolveProviderForBareModel("not-a-real-model", MODELS)

      // then
      expect(resolved).toBeUndefined()
    })

    it("#when several providers expose it #then nothing is returned rather than a guess", () => {
      // given
      const models: V2ModelInfoLike[] = [
        { id: "shared-model", providerID: "openai" },
        { id: "shared-model", providerID: "kiro-proxy" },
      ]

      // when
      const resolved = resolveProviderForBareModel("shared-model", models)

      // then
      expect(resolved).toBeUndefined()
    })

    it("#when the same provider lists it twice #then it still resolves", () => {
      // given
      const models: V2ModelInfoLike[] = [
        { id: "dupe", providerID: "openai" },
        { id: "dupe", providerID: "openai" },
      ]

      // when
      const resolved = resolveProviderForBareModel("dupe", models)

      // then
      expect(resolved).toBe("openai")
    })

    it("#when the id is empty #then nothing is returned", () => {
      // when / then
      expect(resolveProviderForBareModel("", MODELS)).toBeUndefined()
    })
  })
})
