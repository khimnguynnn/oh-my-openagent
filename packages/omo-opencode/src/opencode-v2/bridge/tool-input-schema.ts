// OMO tools build their args with `tool.schema` (the zod copy inside @opencode-ai/plugin) while
// everything around them uses the root zod. `z.toJSONSchema()` only works on schemas its own copy
// built: on a foreign schema it throws `seen.ref`, and OpenCode V2 answers that by logging
// `Skipping invalid tool registration` and dropping every OMO tool. Both copies are zod 4 and share
// the same `_zod.def` shape, so walking that structure converts either copy's schemas.

interface ZodDef {
  readonly type?: string
  readonly innerType?: unknown
  readonly element?: unknown
  readonly valueType?: unknown
  readonly options?: readonly unknown[]
  readonly values?: readonly unknown[]
  readonly entries?: Record<string, unknown>
  readonly shape?: Record<string, unknown> | (() => Record<string, unknown>)
  readonly checks?: readonly { readonly _zod?: { readonly def?: { readonly check?: string; readonly format?: string } } }[]
}

type JsonSchema = Record<string, unknown>

const PERMISSIVE_OBJECT: JsonSchema = { type: "object", properties: {}, additionalProperties: true }

function zodDef(schema: unknown): ZodDef | undefined {
  if (!schema || typeof schema !== "object") return undefined
  const core = (schema as { _zod?: { def?: ZodDef } })._zod
  return core?.def ?? (schema as { _def?: ZodDef })._def
}

export function isZodSchema(value: unknown): boolean {
  return zodDef(value) !== undefined
}

function withDescription(schema: unknown, converted: JsonSchema): JsonSchema {
  const description = (schema as { description?: unknown }).description
  if (typeof description !== "string" || description.length === 0) return converted
  return { ...converted, description }
}

function resolveShape(def: ZodDef): Record<string, unknown> {
  const { shape } = def
  if (typeof shape === "function") return shape()
  return shape ?? {}
}

function isOptionalNode(schema: unknown): boolean {
  const type = zodDef(schema)?.type
  return type === "optional" || type === "default" || type === "prefault"
}

function convertObject(def: ZodDef): JsonSchema {
  const shape = resolveShape(def)
  const properties: JsonSchema = {}
  const required: string[] = []
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = convertNode(field)
    if (!isOptionalNode(field)) required.push(key)
  }
  const converted: JsonSchema = { type: "object", properties }
  if (required.length > 0) converted.required = required
  return converted
}

function isIntegerNode(def: ZodDef): boolean {
  return (def.checks ?? []).some((check) => {
    const inner = check?._zod?.def
    return inner?.check === "number_format" && inner?.format === "safeint"
  })
}

function convertNode(schema: unknown): JsonSchema {
  const def = zodDef(schema)
  if (!def) return {}
  switch (def.type) {
    case "string":
      return withDescription(schema, { type: "string" })
    case "number":
      return withDescription(schema, { type: isIntegerNode(def) ? "integer" : "number" })
    case "int":
    case "bigint":
      return withDescription(schema, { type: "integer" })
    case "boolean":
      return withDescription(schema, { type: "boolean" })
    case "null":
      return withDescription(schema, { type: "null" })
    case "enum":
      return withDescription(schema, { type: "string", enum: Object.values(def.entries ?? {}) })
    case "literal": {
      const values = def.values ?? []
      return withDescription(schema, values.length === 1 ? { const: values[0] } : { enum: [...values] })
    }
    case "array":
      return withDescription(schema, { type: "array", items: convertNode(def.element) })
    case "object":
      return withDescription(schema, convertObject(def))
    case "record":
      return withDescription(schema, { type: "object", additionalProperties: convertNode(def.valueType) })
    case "union":
      return withDescription(schema, { anyOf: (def.options ?? []).map(convertNode) })
    case "nullable":
      return withDescription(schema, { anyOf: [convertNode(def.innerType), { type: "null" }] })
    case "optional":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return withDescription(schema, convertNode(def.innerType))
    default:
      return withDescription(schema, {})
  }
}

export function normalizeInputSchema(rawSchema: unknown): JsonSchema {
  if (!rawSchema || typeof rawSchema !== "object") return { ...PERMISSIVE_OBJECT }
  if (isZodSchema(rawSchema)) {
    const converted = convertNode(rawSchema)
    return converted.type === "object" ? converted : { ...PERMISSIVE_OBJECT }
  }
  const fields = Object.entries(rawSchema)
  if (fields.length > 0 && fields.every(([, field]) => isZodSchema(field))) {
    const properties: JsonSchema = {}
    const required: string[] = []
    for (const [key, field] of fields) {
      properties[key] = convertNode(field)
      if (!isOptionalNode(field)) required.push(key)
    }
    const converted: JsonSchema = { type: "object", properties }
    if (required.length > 0) converted.required = required
    return converted
  }
  if ("type" in rawSchema) return rawSchema as JsonSchema
  return { ...PERMISSIVE_OBJECT }
}
