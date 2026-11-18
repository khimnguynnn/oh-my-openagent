import type { Context } from "@opencode/plugin/promise/plugin"
import { log } from "../../shared/logger"

/**
 * Feeds OpenCode V2's live provider catalog into the V1 config pipeline.
 *
 * Phase 1 of that pipeline (`applyProviderConfig`) derives three caches from `config.provider`:
 * per-model context limits, the image-capable model set, and the Anthropic 1M-context flag. The
 * bridge starts the pipeline from an empty object, so on V2 every one of those caches was built
 * from nothing. V2 does expose the same facts, just under a different shape and across two calls,
 * so the fix is to translate its catalog into the shape phase 1 already reads rather than to
 * duplicate the cache logic.
 */

export interface V2ProviderInfoLike {
  id: string
  headers?: Record<string, string> | null
  request?: { headers?: Record<string, string> | null } | null
}

export interface V2ModelInfoLike {
  id: string
  modelID?: string
  providerID: string
  capabilities?: { input?: readonly string[] | null } | null
  limit?: { context?: number | null } | null
}

export interface V1ProviderModelConfig {
  limit?: { context: number }
  modalities?: { input: string[] }
}

export interface V1ProviderConfig {
  options?: { headers: Record<string, string> }
  models: Record<string, V1ProviderModelConfig>
}

export interface V2ProviderCatalog {
  providers: readonly V2ProviderInfoLike[]
  models: readonly V2ModelInfoLike[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** V2 list endpoints answer either a bare array or an envelope, depending on the call path. */
function unwrapList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value.data)) return value.data
  return []
}

function collectHeaders(provider: V2ProviderInfoLike): Record<string, string> | undefined {
  const merged: Record<string, string> = {}
  for (const source of [provider.headers, provider.request?.headers]) {
    if (!isRecord(source)) continue
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string") merged[key] = value
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function modelKey(model: V2ModelInfoLike): string {
  return model.modelID ?? model.id
}

/**
 * Translates a V2 catalog into the provider map `applyProviderConfig` reads.
 *
 * `capabilities.input` is V2's modality list (`["text","image","pdf"]`), which is the same fact V1
 * spells `modalities.input`, so image support survives the hop. A model whose provider is absent
 * from the provider list still gets an entry, because the model list is the authority on which
 * models exist.
 */
export function toV1ProviderConfig(catalog: V2ProviderCatalog): Record<string, V1ProviderConfig> {
  const result: Record<string, V1ProviderConfig> = {}

  for (const provider of catalog.providers) {
    if (!provider?.id) continue
    const headers = collectHeaders(provider)
    result[provider.id] = headers ? { options: { headers }, models: {} } : { models: {} }
  }

  for (const model of catalog.models) {
    if (!model?.providerID) continue
    const key = modelKey(model)
    if (!key) continue

    const providerEntry = result[model.providerID] ?? { models: {} }
    result[model.providerID] = providerEntry

    const modelConfig: V1ProviderModelConfig = {}

    const context = model.limit?.context
    if (typeof context === "number" && context > 0) {
      modelConfig.limit = { context }
    }

    const modalities = model.capabilities?.input
    if (Array.isArray(modalities)) {
      modelConfig.modalities = { input: modalities.filter((entry): entry is string => typeof entry === "string") }
    }

    providerEntry.models[key] = modelConfig
  }

  return result
}

/**
 * Summarizes a seeded provider map without echoing its contents.
 *
 * Provider headers can carry credentials, so only derived counts are reported. These two numbers
 * are exactly what silently read zero before the catalog was seeded.
 */
export function summarizeV1ProviderConfig(providerConfig: Record<string, V1ProviderConfig>): {
  providerCount: number
  modelCount: number
  modelsWithContextLimit: number
  imageCapableModels: number
} {
  let modelCount = 0
  let modelsWithContextLimit = 0
  let imageCapableModels = 0

  for (const provider of Object.values(providerConfig)) {
    for (const model of Object.values(provider.models)) {
      modelCount += 1
      if (typeof model.limit?.context === "number") modelsWithContextLimit += 1
      if (model.modalities?.input?.includes("image")) imageCapableModels += 1
    }
  }

  return {
    providerCount: Object.keys(providerConfig).length,
    modelCount,
    modelsWithContextLimit,
    imageCapableModels,
  }
}

/**
 * Finds the provider that exposes a model id given without one.
 *
 * Returns undefined when nothing matches and when several providers match, so an ambiguous id is
 * reported instead of silently resolved to whichever provider happened to be listed first.
 */
export function resolveProviderForBareModel(
  modelID: string,
  models: readonly V2ModelInfoLike[],
): string | undefined {
  if (!modelID) return undefined

  const matches = new Set<string>()
  for (const model of models) {
    if (!model?.providerID) continue
    if (modelKey(model) === modelID) matches.add(model.providerID)
  }

  if (matches.size !== 1) return undefined
  return [...matches][0]
}

/**
 * Reads V2's provider and model lists.
 *
 * Returns undefined on any failure so a listing error degrades to the previous behavior, an empty
 * provider map, instead of taking down plugin load.
 */
export async function readV2ProviderCatalog(v2Context: Context): Promise<V2ProviderCatalog | undefined> {
  try {
    const [providersRaw, modelsRaw] = await Promise.all([
      v2Context.provider.list({}),
      v2Context.model.list({}),
    ])

    const providers = unwrapList(providersRaw).filter((entry): entry is V2ProviderInfoLike => {
      return isRecord(entry) && typeof entry.id === "string"
    })
    const models = unwrapList(modelsRaw).filter((entry): entry is V2ModelInfoLike => {
      return isRecord(entry) && typeof entry.providerID === "string"
    })

    if (providers.length === 0 && models.length === 0) return undefined
    return { providers, models }
  } catch (err) {
    log("[v2-bridge:provider] failed to read the V2 provider catalog:", { error: String(err) })
    return undefined
  }
}
