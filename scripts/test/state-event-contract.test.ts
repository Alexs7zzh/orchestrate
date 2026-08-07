import { Ajv2020 } from "ajv/dist/2020.js"
import { describe, expect, test } from "bun:test"
import path from "node:path"

import type { EventRecord, RunState } from "../src/types.js"

import eventSchema from "../../references/event.schema.json" with { type: "json" }
import stateSchema from "../../references/state.schema.json" with { type: "json" }
import { applyStatePatch, diffState, replayEvents } from "../src/state-patch.js"

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    runtimeVersion: "test-build",
    sequence: 1,
    id: "20260802120000-1234abcd",
    workflowName: "state-test",
    objective: "Prove state and journal replay.",
    digest: "a".repeat(64),
    status: "running",
    createdAt: "2026-08-02T12:00:00.000Z",
    startedAt: "2026-08-02T12:00:00.000Z",
    finishedAt: null,
    updatedAt: "2026-08-02T12:00:00.000Z",
    error: null,
    pause: null,
    origin: null,
    allowWriteConflicts: false,
    starts: 0,
    fuseOverride: false,
    repeatRoundExtensions: {},
    pendingRevision: null,
    nodes: {},
    sessions: {},
    gates: {},
    holds: {},
    repeats: {},
    workrooms: {},
    spawnIntents: {},
    ...overrides
  }
}

function event(after: RunState, before: RunState | null, type: EventRecord["type"]): EventRecord {
  return {
    runtimeVersion: after.runtimeVersion,
    sequence: after.sequence,
    timestamp: after.updatedAt,
    runId: after.id,
    type,
    message: type,
    ...(type === "run.paused" ? { data: { kind: "human" } } : {}),
    patch: diffState(before, after)
  }
}

describe("state and event contract", () => {
  test("validates canonical records and replays the exact state", () => {
    const first = state()
    const paused = state({
      sequence: 2,
      status: "paused",
      updatedAt: "2026-08-02T12:01:00.000Z",
      pause: {
        kind: "human",
        message: "Paused by the human.",
        repeatId: null,
        createdAt: "2026-08-02T12:01:00.000Z"
      }
    })
    const events = [event(first, null, "run.started"), event(paused, first, "run.paused")]
    const validateState = new Ajv2020({ allErrors: true, strict: false }).compile(stateSchema)
    const validateEvent = new Ajv2020({ allErrors: true, strict: false }).compile(eventSchema)

    expect(validateState(first)).toBe(true)
    expect(events.every((record) => validateEvent(record))).toBe(true)
    expect(events[0]!.patch).toEqual([{ op: "add", path: "", value: first }])
    expect(replayEvents(events)).toEqual(paused)
  })

  test("rejects invalid patch pointers before replay", () => {
    const first = state()
    const invalid: EventRecord = {
      ...event(first, null, "run.started"),
      patch: [{ op: "replace", path: "/bad~2escape", value: "broken" }]
    }
    const validateEvent = new Ajv2020({ allErrors: true, strict: false }).compile(eventSchema)
    expect(validateEvent(invalid)).toBe(false)
    expect(() => applyStatePatch(first, invalid.patch)).toThrow("Invalid state patch path")
  })

  test("rejects non-canonical array indices during replay", () => {
    const first = state({
      pendingRevision: {
        provenance: { source: "/tmp/workflow.yaml", origins: {}, inferredNeeds: {} },
        workflow: {} as never,
        digest: "b".repeat(64),
        summary: ["first"],
        createdAt: "2026-08-02T12:00:00.000Z"
      }
    })
    for (const index of ["0junk", "00", "+0", "-0"]) {
      expect(() =>
        applyStatePatch(first, [
          { op: "replace", path: `/pendingRevision/summary/${index}`, value: "tampered" }
        ])
      ).toThrow(`invalid array index "${index}"`)
    }
    expect(
      applyStatePatch(first, [
        { op: "replace", path: "/pendingRevision/summary/0", value: "canonical" }
      ]).pendingRevision?.summary
    ).toEqual(["canonical"])
  })

  test("replays completed outcome and downstream hold as separate exact records", () => {
    const base = state()
    const completed = state({
      sequence: 2,
      updatedAt: "2026-08-02T12:01:00.000Z"
    })
    const held = state({
      sequence: 3,
      updatedAt: "2026-08-02T12:01:00.000Z",
      holds: {
        work: {
          target: "work",
          scope: "instance",
          setAt: "2026-08-02T12:01:00.000Z"
        }
      }
    })
    const events = [
      event(base, null, "run.started"),
      {
        ...event(completed, base, "node.completed"),
        nodeId: "work",
        data: { attempt: 1 }
      },
      {
        ...event(held, completed, "hold.set"),
        nodeId: "work",
        data: { scope: "instance", source: "node-done" }
      }
    ]
    const validateEvent = new Ajv2020({ allErrors: true, strict: false }).compile(eventSchema)

    expect(events.every((record) => validateEvent(record))).toBe(true)
    expect(replayEvents(events)).toEqual(held)
    expect(events[1]?.patch.some((operation) => operation.path === "/holds")).toBe(false)
    expect(events[2]?.patch).toEqual([
      { op: "add", path: "/holds/work", value: held.holds.work },
      { op: "replace", path: "/sequence", value: 3 }
    ])
  })

  test("rejects event variants with missing node identity or mismatched data", () => {
    const current = state()
    const validateEvent = new Ajv2020({ allErrors: true, strict: false }).compile(eventSchema)
    expect(validateEvent(event(current, null, "node.completed"))).toBe(false)
    expect(
      validateEvent({
        ...event(current, null, "node.completed"),
        nodeId: "work",
        data: { digest: "not-completion-data" }
      })
    ).toBe(false)
    expect(validateEvent({ ...event(current, null, "run.completed"), nodeId: "impossible" })).toBe(
      false
    )
  })

  test("accepts scheduler-owned skipped events for instantiated repeat nodes", () => {
    const current = state()
    const validateEvent = new Ajv2020({ allErrors: true, strict: false }).compile(eventSchema)
    expect(
      validateEvent({
        ...event(current, null, "node.skipped"),
        nodeId: "review--r2",
        data: {
          conditionNode: "verdict--r2",
          pointer: "/done",
          reason: "condition-false"
        }
      })
    ).toBe(true)
  })

  test("requires skip metadata exactly for skipped authoritative node state", () => {
    const validateState = new Ajv2020({ allErrors: true, strict: false }).compile(stateSchema)
    const skippedNode = {
      id: "optional",
      templateId: "optional",
      title: "Optional",
      type: "command",
      provider: null,
      needs: ["decision"],
      origin: "initial",
      repeatId: null,
      round: null,
      status: "skipped",
      attempts: [],
      resultPath: null,
      result: null,
      error: null,
      skip: {
        reason: "condition-false",
        conditionNode: "decision",
        pointer: "/run",
        skippedAt: "2026-08-02T12:01:00.000Z"
      }
    }
    expect(validateState(state({ nodes: { optional: skippedNode } } as never))).toBe(true)
    const { skip: _skip, ...missingMetadata } = skippedNode
    expect(validateState(state({ nodes: { optional: missingMetadata } } as never))).toBe(false)
    expect(
      validateState(
        state({ nodes: { optional: { ...skippedNode, status: "completed" } } } as never)
      )
    ).toBe(false)
  })

  test("omits the removed compound vocabulary from source, tests, schemas, and documents", async () => {
    const compound = ["completed", "held"].join("-")
    const roots = ["scripts/src", "scripts/test", "references", "agents", "herdr-plugin"] as const
    const files = ["README.md", "SKILL.md"]
    const repositoryRoot = path.resolve(import.meta.dir, "../..")
    for (const root of roots) {
      const glob = new Bun.Glob("**/*.{ts,json,md,yaml,toml}")
      for await (const relative of glob.scan({ cwd: path.join(repositoryRoot, root) })) {
        files.push(`${root}/${relative}`)
      }
    }
    for (const file of files) {
      expect(await Bun.file(path.join(repositoryRoot, file)).text()).not.toContain(compound)
    }
    expect(JSON.stringify(stateSchema)).not.toContain(compound)
    expect(JSON.stringify(eventSchema)).not.toContain(compound)
  })
})
