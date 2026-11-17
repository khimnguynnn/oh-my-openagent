import { describe, expect, it } from "bun:test"
import { tool } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import { normalizeInputSchema } from "../tool-input-schema"

describe("normalizeInputSchema", () => {
  it("converts a field map built by the plugin zod copy, keeping descriptions", () => {
    // given args built with tool.schema, the zod copy inside @opencode-ai/plugin
    const args = {
      pattern: tool.schema.string().describe("The regex pattern"),
      include: tool.schema.string().optional().describe("File pattern"),
      output_mode: tool.schema.enum(["content", "files_with_matches", "count"]).optional(),
      head_limit: tool.schema.number().optional(),
    }

    // when the args are normalized for OpenCode V2
    const schema = normalizeInputSchema(args)

    // then V2 receives plain JSON Schema with every field described and only required fields required
    expect(schema).toEqual({
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regex pattern" },
        include: { type: "string", description: "File pattern" },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
        head_limit: { type: "number" },
      },
      required: ["pattern"],
    })
  })

  it("converts a field map built by the root zod copy", () => {
    // given args built with the root zod import
    const args = { name: z.string().describe("A name"), count: z.number().int().optional() }

    // when the args are normalized
    const schema = normalizeInputSchema(args)

    // then the same JSON Schema comes out regardless of which zod copy built the fields
    expect(schema).toEqual({
      type: "object",
      properties: { name: { type: "string", description: "A name" }, count: { type: "integer" } },
      required: ["name"],
    })
  })

  it("converts a whole Zod object schema", () => {
    // given a tool that declares a Zod object instead of a field map
    const args = z.object({ query: z.string().describe("Search terms") })

    // when the args are normalized
    const schema = normalizeInputSchema(args)

    // then it is converted the same way
    expect(schema).toEqual({
      type: "object",
      properties: { query: { type: "string", description: "Search terms" } },
      required: ["query"],
    })
  })

  it("converts nested objects, arrays, unions, records, literals, and nullables", () => {
    // given a field map using the shapes real tools use
    const args = {
      nested: z.object({ inner: z.string() }),
      list: z.array(z.string()),
      either: z.union([z.string(), z.number()]),
      map: z.record(z.string(), z.unknown()),
      kind: z.literal("fixed"),
      maybe: z.string().nullable(),
      flagged: z.boolean().default(false),
    }

    // when the args are normalized
    const schema = normalizeInputSchema(args)
    const properties = schema.properties as Record<string, Record<string, unknown>>

    // then each shape maps to its JSON Schema equivalent
    expect(properties.nested).toEqual({ type: "object", properties: { inner: { type: "string" } }, required: ["inner"] })
    expect(properties.list).toEqual({ type: "array", items: { type: "string" } })
    expect(properties.either).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] })
    expect(properties.map).toEqual({ type: "object", additionalProperties: {} })
    expect(properties.kind).toEqual({ const: "fixed" })
    expect(properties.maybe).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] })
    expect(properties.flagged).toEqual({ type: "boolean" })
  })

  it("passes hand-written JSON Schema through untouched", () => {
    // given a tool that already declares JSON Schema
    const args = { type: "object", properties: { raw: { type: "string" } } }

    // when the args are normalized
    const schema = normalizeInputSchema(args)

    // then it is returned unchanged
    expect(schema).toEqual(args)
  })

  it("falls back to a permissive object schema when args are unusable", () => {
    // given missing args
    // when the args are normalized
    // then the tool still gets a valid object schema instead of being dropped by the host
    for (const args of [undefined, null, {}, 42, "nope"]) {
      expect(normalizeInputSchema(args)).toEqual({
        type: "object",
        properties: {},
        additionalProperties: true,
      })
    }
  })
})
