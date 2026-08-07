import { describe, expect, test } from "bun:test"

import { canonicalJson, digestValue } from "../src/digest.js"
import { claudeSessionLineageIdentity } from "../src/session-lineage.js"

describe("canonical workflow digests", () => {
  test("matches the fixed domain vectors", () => {
    expect(digestValue("workflow-ir", { a: 1, b: 2 })).toBe(
      "9adb9cbe5f5c5e9fb230794884a5b09cda5eb7321b8fae29f65d55a553b9677a"
    )
    expect(digestValue("workflow-ir", { a: null })).toBe(
      "e2569a6859468a1f064862cd8ee5e3f95f572ba0683c640d29ebd8d69df4efda"
    )
    expect(digestValue("gate-content", { content: "echo hi\n" })).toBe(
      "6f97e1afe1d5f2596a5c77d6c7ec42441879c15a2780f6e8965ba98943996f19"
    )
  })

  test("sorts object keys while preserving array order", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(digestValue("workflow-ir", { b: 2, a: 1 })).toBe(
      digestValue("workflow-ir", { a: 1, b: 2 })
    )
    expect(digestValue("workflow-ir", [1, 2])).not.toBe(digestValue("workflow-ir", [2, 1]))
  })

  test("keeps every accepted lineage string injective across delimiters and surrogates", () => {
    expect(claudeSessionLineageIdentity("run", "alias\0tail")).not.toBe(
      claudeSessionLineageIdentity("run\0alias", "tail")
    )
    expect(claudeSessionLineageIdentity("run", "\ud800")).not.toBe(
      claudeSessionLineageIdentity("run", "\ud801")
    )
  })

  test("rejects values that JSON would silently coerce or omit", () => {
    const sparse: unknown[] = []
    sparse.length = 1
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 })
    const arrayAccessor = Object.defineProperty([1], "0", { enumerable: true, get: () => 1 })
    const hiddenArrayProperty = Object.defineProperty([1], "hidden", { value: true })
    for (const value of [
      [undefined],
      { a: undefined },
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      new Date(),
      accessor,
      arrayAccessor,
      hiddenArrayProperty,
      sparse,
      cyclic
    ]) {
      expect(() => canonicalJson(value)).toThrow()
    }
    expect(() => canonicalJson([undefined])).toThrow()
    expect(() => canonicalJson(Number.NaN)).toThrow()
    expect(() => digestValue("workflow-ir", { equals: -0 })).toThrow("negative zero")
  })
})
