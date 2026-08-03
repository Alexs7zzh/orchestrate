import { isDeepStrictEqual } from "node:util"

import type { EventRecord, RunState, StatePatchOperation } from "./types.js"

const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/

function encodeSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1")
}

function decodeSegment(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~")
}

function childPath(parent: string, key: string): string {
  return `${parent}/${encodeSegment(key)}`
}

function diffValue(before: unknown, after: unknown, pointer: string): StatePatchOperation[] {
  if (isDeepStrictEqual(before, after)) {
    return []
  }
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return [{ op: "replace", path: pointer, value: after }]
  }
  const left = before as Record<string, unknown>
  const right = after as Record<string, unknown>
  const operations: StatePatchOperation[] = []
  for (const key of Object.keys(left).toSorted()) {
    if (!Object.hasOwn(right, key)) {
      operations.push({ op: "remove", path: childPath(pointer, key) })
    }
  }
  for (const key of Object.keys(right).toSorted()) {
    if (!Object.hasOwn(left, key)) {
      operations.push({ op: "add", path: childPath(pointer, key), value: right[key] })
    } else {
      operations.push(...diffValue(left[key], right[key], childPath(pointer, key)))
    }
  }
  return operations
}

export function diffState(
  before: RunState | null,
  after: RunState
): readonly StatePatchOperation[] {
  return before === null ? [{ op: "add", path: "", value: after }] : diffValue(before, after, "")
}

function parentAt(document: unknown, segments: readonly string[]): unknown {
  let cursor = document
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") {
      throw new Error(`State patch crosses a non-container at "${segment}".`)
    }
    if (Array.isArray(cursor)) {
      const index = ARRAY_INDEX.test(segment) ? Number(segment) : Number.NaN
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        throw new Error(`State patch has invalid array index "${segment}".`)
      }
      cursor = cursor[index]
    } else {
      if (!Object.hasOwn(cursor, segment)) {
        throw new Error(`State patch path does not exist at "${segment}".`)
      }
      cursor = (cursor as Record<string, unknown>)[segment]
    }
  }
  return cursor
}

export function applyStatePatch(
  state: RunState | null,
  operations: readonly StatePatchOperation[]
): RunState {
  let document: unknown = state === null ? null : structuredClone(state)
  for (const operation of operations) {
    if (!JSON_POINTER.test(operation.path)) {
      throw new Error(`Invalid state patch path "${operation.path}".`)
    }
    if (operation.path === "") {
      if (operation.op === "remove") {
        throw new Error("A state patch cannot remove its root.")
      }
      document = structuredClone(operation.value)
      continue
    }
    const segments = operation.path.slice(1).split("/").map(decodeSegment)
    const key = segments.at(-1) as string
    const parent = parentAt(document, segments.slice(0, -1))
    if (parent === null || typeof parent !== "object") {
      throw new Error(`State patch parent for "${operation.path}" is not a container.`)
    }
    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : ARRAY_INDEX.test(key) ? Number(key) : Number.NaN
      if (!Number.isInteger(index) || index < 0 || index > parent.length) {
        throw new Error(`State patch has invalid array index "${key}".`)
      }
      if (operation.op === "add") {
        parent.splice(index, 0, structuredClone(operation.value))
      } else if (operation.op === "remove") {
        if (index >= parent.length) {
          throw new Error(`State patch remove index "${key}" is absent.`)
        }
        parent.splice(index, 1)
      } else {
        if (index >= parent.length) {
          throw new Error(`State patch replace index "${key}" is absent.`)
        }
        parent[index] = structuredClone(operation.value)
      }
      continue
    }
    const record = parent as Record<string, unknown>
    if (operation.op === "remove") {
      if (!Object.hasOwn(record, key)) {
        throw new Error(`State patch remove path is absent.`)
      }
      Reflect.deleteProperty(record, key)
    } else if (operation.op === "replace") {
      if (!Object.hasOwn(record, key)) {
        throw new Error(`State patch replace path is absent.`)
      }
      record[key] = structuredClone(operation.value)
    } else {
      record[key] = structuredClone(operation.value)
    }
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("State patch replay did not produce a state object.")
  }
  return document as RunState
}

export function replayEvents(events: readonly EventRecord[]): RunState {
  let state: RunState | null = null
  let runtimeVersion: string | null = null
  let runId: string | null = null
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as EventRecord
    if (event.sequence !== index + 1) {
      throw new Error(`Event sequence jumps at ${event.sequence}; expected ${index + 1}.`)
    }
    runtimeVersion ??= event.runtimeVersion
    runId ??= event.runId
    if (event.runtimeVersion !== runtimeVersion || event.runId !== runId) {
      throw new Error("Event journal mixes runtime builds or run ids.")
    }
    state = applyStatePatch(state, event.patch)
    if (
      state.sequence !== event.sequence ||
      state.id !== event.runId ||
      state.runtimeVersion !== event.runtimeVersion
    ) {
      throw new Error(`Event ${event.sequence} patch does not produce its declared run state.`)
    }
  }
  if (state === null) {
    throw new Error("Event journal is empty.")
  }
  return state
}
