import { createHash } from "node:crypto"

import type { WorkflowSpec } from "./types.js"

type Seen = Set<object>

function objectKeys(value: object): readonly string[] {
  const symbols = Object.getOwnPropertySymbols(value)
  if (symbols.length > 0) {
    throw new TypeError("Canonical JSON does not accept symbol keys.")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError("Canonical JSON does not accept accessors.")
    }
    if (descriptor.enumerable !== true) {
      throw new TypeError("Canonical JSON accepts only own enumerable properties.")
    }
  }
  return Object.keys(descriptors).toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  )
}

function encode(value: unknown, seen: Seen): string {
  if (value === null) {
    return "null"
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON accepts only finite numbers.")
    }
    if (Object.is(value, -0)) {
      throw new TypeError("Canonical JSON does not accept negative zero.")
    }
    return JSON.stringify(value)
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON does not accept ${typeof value}.`)
  }
  if (seen.has(value)) {
    throw new TypeError("Canonical JSON does not accept cycles.")
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("Canonical JSON does not accept symbol keys.")
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length") {
          continue
        }
        if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError("Canonical JSON arrays cannot have named properties.")
        }
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new TypeError("Canonical JSON does not accept accessors.")
        }
        if (descriptor.enumerable !== true) {
          throw new TypeError("Canonical JSON array items must be enumerable.")
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical JSON does not accept sparse arrays.")
        }
      }
      return `[${value.map((entry) => encode(entry, seen)).join(",")}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only plain objects.")
    }
    return `{${objectKeys(value)
      .map(
        (key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], seen)}`
      )
      .join(",")}}`
  } finally {
    seen.delete(value)
  }
}

export function canonicalJson(value: unknown): string {
  const encoded = encode(value, new Set())
  JSON.parse(encoded)
  return encoded
}

export function digestValue(
  domain:
    | "workflow-ir"
    | "gate-content"
    | "attempt-capability"
    | "completion-contract"
    | "session-lineage",
  value: unknown
): string {
  const preimage = `orchestrate:digest/v1\0${domain}\0${canonicalJson(value)}`
  return createHash("sha256").update(preimage, "utf8").digest("hex")
}

export function digestWorkflow(workflow: WorkflowSpec): string {
  return digestValue("workflow-ir", workflow)
}

export function digestGate(content: string): string {
  return digestValue("gate-content", { content })
}
