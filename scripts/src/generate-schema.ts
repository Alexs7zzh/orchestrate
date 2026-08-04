import { readFile, writeFile } from "node:fs/promises"

import { fetchBaselineHerdrApiSchema } from "./herdr-contract.js"
import {
  EventRecordSchema,
  jsonSchemaDocumentFor,
  PreferencesSchema,
  RunStateSchema,
  WorkflowSchema
} from "./schema.js"

type JsonObject = Record<string, unknown>

const HERDR_RESULT_TYPES = [
  "workspace_created",
  "workspace_list",
  "tab_created",
  "tab_list",
  "agent_info",
  "pane_info",
  "pane_list",
  "pane_current"
] as const

const herdrSnapshotUrl = new URL("../schema/herdr-api.schema.json", import.meta.url)
const herdrGeneratedUrl = new URL("./herdr-api.generated.ts", import.meta.url)

function record(value: unknown, name: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Herdr API schema has no object at ${name}.`)
  }
  return value as JsonObject
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Herdr API schema has no array at ${name}.`)
  }
  return value
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Herdr API schema has no string at ${name}.`)
  }
  return value
}

function referenceName(reference: string, prefix: string): string {
  if (!reference.startsWith(prefix)) {
    throw new Error(`Unsupported Herdr API schema reference: ${reference}`)
  }
  return reference.slice(prefix.length)
}

function references(value: unknown, prefix: string): readonly string[] {
  const found = new Set<string>()
  function visit(current: unknown): void {
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (current === null || typeof current !== "object") {
      return
    }
    const item = current as JsonObject
    if (typeof item["$ref"] === "string") {
      found.add(referenceName(item["$ref"], prefix))
    }
    Object.values(item).forEach(visit)
  }
  visit(value)
  return [...found].toSorted()
}

function resultType(value: unknown): string | null {
  const variant = record(value, "success result variant")
  const properties = record(variant["properties"], "success result variant.properties")
  const type = record(properties["type"], "success result variant.properties.type")["const"]
  return typeof type === "string" ? type : null
}

function compactHerdrSchema(value: unknown): JsonObject {
  const document = record(value, "root")
  const schemas = record(document["schemas"], "schemas")
  const success = record(schemas["success_response"], "schemas.success_response")
  const definitions = record(success["$defs"], "schemas.success_response.$defs")
  const responseResult = record(definitions["ResponseResult"], "ResponseResult")
  const variants = array(responseResult["oneOf"], "ResponseResult.oneOf")
  const selected = HERDR_RESULT_TYPES.map((type) => {
    const variant = variants.find((candidate) => resultType(candidate) === type)
    if (variant === undefined) {
      throw new Error(`Herdr API schema has no ${type} success result.`)
    }
    return variant
  })

  const reachable = new Set<string>()
  const definitionPrefix = "#/schemas/success_response/$defs/"
  function includeReferences(current: unknown): void {
    for (const name of references(current, definitionPrefix)) {
      if (name === "ResponseResult" || reachable.has(name)) {
        continue
      }
      const definition = definitions[name]
      if (definition === undefined) {
        throw new Error(`Herdr API schema has no referenced definition ${name}.`)
      }
      reachable.add(name)
      includeReferences(definition)
    }
  }
  selected.forEach(includeReferences)

  const selectedDefinitions = Object.fromEntries(
    [...reachable]
      .toSorted()
      .map((name) => [name, definitions[name]])
      .concat([["ResponseResult", { oneOf: selected }]])
  )

  return {
    $schema: document["$schema"],
    protocol: document["protocol"],
    schema_version: document["schema_version"],
    schemas: {
      error_response: schemas["error_response"],
      success_response: {
        $schema: success["$schema"],
        properties: success["properties"],
        required: success["required"],
        title: success["title"],
        type: success["type"],
        $defs: selectedDefinitions
      }
    }
  }
}

async function runHerdrSchemaCommand(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["herdr", ...args], {
    stdout: "pipe",
    stderr: "pipe"
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  if (exitCode !== 0) {
    throw new Error(`herdr ${args.join(" ")} failed: ${stderr.trim()}`)
  }
  return stdout
}

async function refreshHerdrSnapshot(): Promise<void> {
  const compact = compactHerdrSchema(await fetchBaselineHerdrApiSchema(runHerdrSchemaCommand))
  await writeFile(herdrSnapshotUrl, `${JSON.stringify(compact, null, 2)}\n`)
}

function schemaIdentifier(name: string): string {
  return `Herdr${name.replaceAll(/(^|_)([a-z])/g, (_match, _prefix, letter: string) => letter.toUpperCase())}Schema`
}

function schemaExpression(value: unknown, prefix: string, indent = 0): string {
  if (value === true) {
    return "Schema.Unknown"
  }
  const definition = record(value, "schema definition")
  if (typeof definition["$ref"] === "string") {
    return schemaIdentifier(referenceName(definition["$ref"], prefix))
  }
  if (definition["const"] !== undefined) {
    return `Schema.Literal(${JSON.stringify(definition["const"])})`
  }
  if (Array.isArray(definition["enum"])) {
    return `Schema.Literals(${JSON.stringify(definition["enum"])})`
  }
  if (Array.isArray(definition["anyOf"])) {
    return `Schema.Union([${definition["anyOf"].map((item) => schemaExpression(item, prefix, indent)).join(", ")}])`
  }
  if (Array.isArray(definition["oneOf"])) {
    return `Schema.Union([${definition["oneOf"].map((item) => schemaExpression(item, prefix, indent)).join(", ")}])`
  }
  if (Array.isArray(definition["type"])) {
    return `Schema.Union([${definition["type"].map((type) => schemaExpression({ type }, prefix, indent)).join(", ")}])`
  }

  switch (definition["type"]) {
    case "null":
      return "Schema.Null"
    case "boolean":
      return "Schema.Boolean"
    case "string": {
      const base = "Schema.String"
      return typeof definition["pattern"] === "string"
        ? `${base}.check(Schema.isPattern(new RegExp(${JSON.stringify(definition["pattern"])})))`
        : base
    }
    case "number":
    case "integer": {
      let base = definition["type"] === "integer" ? "Schema.Int" : "Schema.Number"
      if (typeof definition["minimum"] === "number") {
        base = `${base}.check(Schema.isGreaterThanOrEqualTo(${definition["minimum"]}))`
      }
      return base
    }
    case "array":
      return `Schema.Array(${schemaExpression(definition["items"], prefix, indent)})`
    case "object": {
      const properties = definition["properties"]
      if (properties === undefined) {
        const additional = definition["additionalProperties"]
        if (additional === undefined || additional === true) {
          return "Schema.Record(Schema.String, Schema.Unknown)"
        }
        const key = {
          type: "string",
          ...record(definition["propertyNames"] ?? {}, "propertyNames")
        }
        let expression = `Schema.Record(${schemaExpression(key, prefix, indent)}, ${schemaExpression(additional, prefix, indent)})`
        if (typeof definition["maxProperties"] === "number") {
          expression = `${expression}.check(Schema.isMaxProperties(${definition["maxProperties"]}))`
        }
        return expression
      }
      if (definition["additionalProperties"] !== undefined) {
        throw new Error("Mixed fixed and additional Herdr response properties are unsupported.")
      }
      const fields = record(properties, "properties")
      const required = new Set(
        array(definition["required"] ?? [], "required").map((item) => string(item, "required item"))
      )
      const padding = " ".repeat(indent)
      const childPadding = " ".repeat(indent + 2)
      const entries = Object.entries(fields).map(([key, field]) => {
        const expression = schemaExpression(field, prefix, indent + 2)
        return `${childPadding}${JSON.stringify(key)}: ${required.has(key) ? expression : `Schema.optionalKey(${expression})`}`
      })
      return `Schema.Struct({\n${entries.join(",\n")}\n${padding}})`
    }
    default:
      throw new Error(`Unsupported Herdr API schema type: ${String(definition["type"])}`)
  }
}

function orderedDefinitions(definitions: JsonObject, prefix: string): readonly string[] {
  const ordered: string[] = []
  const complete = new Set<string>()
  const active = new Set<string>()
  function visit(name: string): void {
    if (complete.has(name)) {
      return
    }
    if (active.has(name)) {
      throw new Error(`Recursive Herdr API definition ${name} is unsupported.`)
    }
    const definition = definitions[name]
    if (definition === undefined) {
      throw new Error(`Herdr API schema has no definition ${name}.`)
    }
    active.add(name)
    references(definition, prefix).forEach(visit)
    active.delete(name)
    complete.add(name)
    ordered.push(name)
  }
  Object.keys(definitions)
    .filter((name) => name !== "ResponseResult")
    .toSorted()
    .forEach(visit)
  return ordered
}

function responseEnvelope(envelope: JsonObject, result: unknown): JsonObject {
  const properties = { ...record(envelope["properties"], "response properties"), result }
  return { ...envelope, properties }
}

function generatedHerdrModule(value: unknown): string {
  const document = record(value, "root")
  const schemas = record(document["schemas"], "schemas")
  const success = record(schemas["success_response"], "success_response")
  const successDefinitions = record(success["$defs"], "success_response.$defs")
  const successPrefix = "#/schemas/success_response/$defs/"
  const responseResult = record(successDefinitions["ResponseResult"], "ResponseResult")
  const variants = array(responseResult["oneOf"], "ResponseResult.oneOf")

  const error = record(schemas["error_response"], "error_response")
  const errorDefinitions = record(error["$defs"], "error_response.$defs")
  const errorPrefix = "#/schemas/error_response/$defs/"

  const lines = [
    "// Generated by generate-schema.ts from `herdr api schema --json`. Do not edit.",
    'import { Schema } from "effect"',
    ""
  ]
  for (const name of orderedDefinitions(errorDefinitions, errorPrefix)) {
    lines.push(
      `const ${schemaIdentifier(name)} = ${schemaExpression(errorDefinitions[name], errorPrefix)}`,
      ""
    )
  }
  lines.push(
    `export const HerdrErrorResponseSchema = ${schemaExpression(error, errorPrefix)}`,
    "export const decodeHerdrErrorResponse = Schema.decodeUnknownOption(HerdrErrorResponseSchema)",
    ""
  )

  for (const name of orderedDefinitions(successDefinitions, successPrefix)) {
    lines.push(
      `const ${schemaIdentifier(name)} = ${schemaExpression(successDefinitions[name], successPrefix)}`,
      ""
    )
  }
  for (const type of HERDR_RESULT_TYPES) {
    const variant = variants.find((candidate) => resultType(candidate) === type)
    if (variant === undefined) {
      throw new Error(`Herdr schema snapshot has no ${type} success result.`)
    }
    const name = type.replaceAll(/(^|_)([a-z])/g, (_match, _prefix, letter: string) =>
      letter.toUpperCase()
    )
    const responseSchemaName = `Herdr${name}ResponseSchema`
    lines.push(
      `export const ${responseSchemaName} = ${schemaExpression(responseEnvelope(success, variant), successPrefix)}`,
      `export const decodeHerdr${name}Response = Schema.decodeUnknownOption(${responseSchemaName})`,
      ""
    )
  }
  return `${lines.join("\n")}\n`
}

if (process.argv.includes("--refresh-herdr")) {
  await refreshHerdrSnapshot()
}

const outputs = [
  ["../../references/workflow.schema.json", WorkflowSchema],
  ["../../references/preferences.schema.json", PreferencesSchema],
  ["../../references/state.schema.json", RunStateSchema],
  ["../../references/event.schema.json", EventRecordSchema]
] as const

for (const [relativePath, schema] of outputs) {
  await writeFile(
    new URL(relativePath, import.meta.url),
    `${JSON.stringify(jsonSchemaDocumentFor(schema), null, 2)}\n`
  )
}

const herdrSnapshot = JSON.parse(await readFile(herdrSnapshotUrl, "utf8")) as unknown
await writeFile(herdrGeneratedUrl, generatedHerdrModule(herdrSnapshot))
