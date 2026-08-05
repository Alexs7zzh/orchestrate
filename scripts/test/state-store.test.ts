import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { EventRecord, RunState, WorkflowSpec } from "../src/types.js"

import { DEFAULT_UI_PREFERENCES } from "../src/preferences.js"
import { diffState } from "../src/state-patch.js"
import {
  acquireRunLock,
  appendEvents,
  eventsPath,
  injectAtomicWriteFaultForTests,
  persistNewRun,
  readEvents,
  readRunState,
  readUiSnapshot,
  readWorkflow,
  runStatePath,
  setRuntimeBuildForTests,
  uiPath,
  workflowPath
} from "../src/state.js"

let temporaryRoot = ""

function workflow(): WorkflowSpec {
  return {
    name: "state-store-test",
    objective: "Test durable crank state.",
    cwd: "/tmp",
    concurrency: 3,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes: [
      {
        id: "check",
        type: "command",
        title: "Check",
        needs: [],
        cwd: null,
        workspace: {
          mode: "shared",
          path: null,
          vcs: "none",
          writes: [],
          exclusiveResources: []
        },
        inputs: [],
        retry: { maxAttempts: 1 },
        gate: "none",
        argv: ["/usr/bin/true"],
        mutates: false,
        inheritEnv: [],
        env: {},
        allowedExitCodes: [0]
      }
    ],
    repeats: []
  }
}

function state(sequence = 1): RunState {
  return {
    runtimeVersion: "test-build",
    sequence,
    id: "20260802120000-1234abcd",
    workflowName: "state-store-test",
    objective: "Test durable crank state.",
    digest: "a".repeat(64),
    status: sequence === 1 ? "running" : "paused",
    createdAt: "2026-08-02T12:00:00.000Z",
    startedAt: "2026-08-02T12:00:00.000Z",
    finishedAt: null,
    updatedAt: sequence === 1 ? "2026-08-02T12:00:00.000Z" : "2026-08-02T12:01:00.000Z",
    error: null,
    pause:
      sequence === 1
        ? null
        : {
            kind: "human",
            message: "Paused.",
            repeatId: null,
            createdAt: "2026-08-02T12:01:00.000Z"
          },
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
    spawnIntents: {}
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

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-state-store-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
  setRuntimeBuildForTests("test-build")
})

afterEach(async () => {
  delete process.env.ORCHESTRATE_STATE_DIR
  delete process.env.ORCHESTRATE_BUILD_ID
  injectAtomicWriteFaultForTests(null)
  setRuntimeBuildForTests(null)
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe("state store", () => {
  test("recovers state when a journal commit landed first", async () => {
    const initial = state(1)
    const runDir = await persistNewRun(workflow(), DEFAULT_UI_PREFERENCES, initial, [
      event(initial, null, "run.started")
    ])
    const paused = state(2)
    await appendEvents(runDir, [event(paused, initial, "run.paused")])

    expect(await readRunState(runDir)).toEqual(paused)
  })

  test("recovers missing and torn initial snapshots from the authoritative journal", async () => {
    for (const damage of ["missing", "torn"] as const) {
      const initial = state(1)
      const runDir = await persistNewRun(workflow(), DEFAULT_UI_PREFERENCES, initial, [
        event(initial, null, "run.started")
      ])
      if (damage === "missing") {
        await rm(runStatePath(runDir))
      } else {
        await Bun.write(runStatePath(runDir), '{"sequence":', { createPath: false })
      }
      expect(await readRunState(runDir)).toEqual(initial)
      const release = await acquireRunLock(runDir)
      try {
        expect(await readRunState(runDir, { repair: true })).toEqual(initial)
      } finally {
        await release()
      }
      expect(JSON.parse(await Bun.file(runStatePath(runDir)).text())).toEqual(initial)
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("recovers an approved workflow revision from the journal transaction", async () => {
    const initial = state(1)
    const original = workflow()
    const runDir = await persistNewRun(original, DEFAULT_UI_PREFERENCES, initial, [
      event(initial, null, "run.started")
    ])
    const revised: WorkflowSpec = {
      ...original,
      objective: "Recovered revised objective."
    }
    const revisedState: RunState = {
      ...initial,
      sequence: 2,
      objective: revised.objective,
      digest: "b".repeat(64),
      updatedAt: "2026-08-02T12:01:00.000Z"
    }
    await appendEvents(runDir, [
      {
        ...event(revisedState, initial, "revision.approved"),
        data: { digest: revisedState.digest, workflow: revised }
      }
    ])

    const release = await acquireRunLock(runDir)
    try {
      expect(await readRunState(runDir, { repair: true })).toEqual(revisedState)
    } finally {
      await release()
    }
    expect(await readWorkflow(runDir)).toEqual(revised)
  })

  test("replays stale snapshots for readers without racing a repair write", async () => {
    const initial = state(1)
    const runDir = await persistNewRun(workflow(), DEFAULT_UI_PREFERENCES, initial, [
      event(initial, null, "run.started")
    ])
    const paused = state(2)
    await appendEvents(runDir, [event(paused, initial, "run.paused")])

    expect(await readRunState(runDir)).toEqual(paused)
    expect(JSON.parse(await Bun.file(runStatePath(runDir)).text())).toEqual(initial)
  })

  test("serializes concurrent crank lock holders", async () => {
    const initial = state(1)
    const runDir = await persistNewRun(workflow(), DEFAULT_UI_PREFERENCES, initial, [
      event(initial, null, "run.started")
    ])
    const releaseFirst = await acquireRunLock(runDir)
    let secondAcquired = false
    const second = acquireRunLock(runDir).then((release) => {
      secondAcquired = true
      return release
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(secondAcquired).toBe(false)
    await releaseFirst()
    const releaseSecond = await second
    expect(secondAcquired).toBe(true)
    await releaseSecond()
  })

  test("serializes A B C subprocess interleavings without an ABA admission gap", async () => {
    const runDir = path.join(temporaryRoot, "abc-run")
    const log = path.join(temporaryRoot, "abc.log")
    await mkdir(runDir)
    const moduleUrl = new URL("../src/state.ts", import.meta.url).href
    const children = ["A", "B", "C"].map((name) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { appendFile } from "node:fs/promises"; import { acquireRunLock } from ${JSON.stringify(moduleUrl)}; const release = await acquireRunLock(${JSON.stringify(runDir)}); await appendFile(${JSON.stringify(log)}, ${JSON.stringify(name)} + ":enter\\n"); await Bun.sleep(40); await appendFile(${JSON.stringify(log)}, ${JSON.stringify(name)} + ":exit\\n"); await release();`
        ],
        { env: process.env, stdout: "ignore", stderr: "pipe" }
      )
    )
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0])
    const records = (await Bun.file(log).text()).trim().split("\n")
    expect(records).toHaveLength(6)
    let active: string | null = null
    for (const record of records) {
      const [name, phase] = record.split(":")
      if (phase === "enter") {
        expect(active).toBeNull()
        active = name as string
      } else {
        expect(active).toBe(name as string)
        active = null
      }
    }
    expect(active).toBeNull()
  })

  test("refuses a different runtime build", async () => {
    const initial = state(1)
    const runDir = await persistNewRun(workflow(), DEFAULT_UI_PREFERENCES, initial, [
      event(initial, null, "run.started")
    ])
    setRuntimeBuildForTests("different-build")
    process.env.ORCHESTRATE_BUILD_ID = "test-build"
    await expect(readRunState(runDir)).rejects.toThrow("matching CLI")
  })

  test("rejects corrupted durable workflow and UI snapshots at the read boundary", async () => {
    const initial = state(1)
    const runDir = await persistNewRun(workflow(), DEFAULT_UI_PREFERENCES, initial, [
      event(initial, null, "run.started")
    ])
    await Bun.write(workflowPath(runDir), JSON.stringify({ name: "incomplete" }), {
      createPath: false
    })
    await expect(readWorkflow(runDir)).rejects.toThrow("Invalid workflow snapshot")
    await Bun.write(uiPath(runDir), JSON.stringify({ board: "split-right" }), { createPath: false })
    await expect(readUiSnapshot(runDir)).rejects.toThrow("Invalid UI snapshot")
  })

  test("atomically replaces a multi-event journal batch across short-write ENOSPC and restart", async () => {
    const initial = state(1)
    const runDir = await persistNewRun(workflow(), DEFAULT_UI_PREFERENCES, initial, [
      event(initial, null, "run.started")
    ])
    const paused = state(2)
    const held: RunState = {
      ...state(3),
      holds: {
        check: {
          target: "check",
          scope: "instance",
          setAt: "2026-08-02T12:01:00.000Z"
        }
      }
    }
    const batch = [
      event(paused, initial, "run.paused"),
      {
        ...event(held, paused, "hold.set"),
        nodeId: "check",
        data: { scope: "instance", source: "manual" }
      }
    ] as const
    const priorJournal = await Bun.file(eventsPath(runDir)).text()
    const enospc = Object.assign(new Error("injected ENOSPC after a short write"), {
      code: "ENOSPC"
    })
    injectAtomicWriteFaultForTests({
      targetPath: eventsPath(runDir),
      afterBytes: 37,
      preserveTemporary: true,
      error: enospc
    })

    await expect(appendEvents(runDir, batch)).rejects.toThrow("injected ENOSPC")
    expect(await Bun.file(eventsPath(runDir)).text()).toBe(priorJournal)
    expect(await readRunState(runDir)).toEqual(initial)
    expect((await readdir(runDir)).some((entry) => entry.endsWith(".tmp"))).toBeTrue()

    await appendEvents(runDir, batch)
    expect(await readEvents(runDir)).toHaveLength(3)
    expect(await readRunState(runDir)).toEqual(held)
  })

  test("reports post-rename directory fsync failure while replay stays a whole batch", async () => {
    const initial = state(1)
    const runDir = await persistNewRun(workflow(), DEFAULT_UI_PREFERENCES, initial, [
      event(initial, null, "run.started")
    ])
    const paused = state(2)
    const held: RunState = {
      ...state(3),
      holds: {
        check: {
          target: "check",
          scope: "instance",
          setAt: "2026-08-02T12:01:00.000Z"
        }
      }
    }
    const batch = [
      event(paused, initial, "run.paused"),
      {
        ...event(held, paused, "hold.set"),
        nodeId: "check",
        data: { scope: "instance", source: "manual" }
      }
    ] as const
    const eio = Object.assign(new Error("injected directory fsync EIO after rename"), {
      code: "EIO"
    })
    injectAtomicWriteFaultForTests({
      targetPath: eventsPath(runDir),
      phase: "directory-sync",
      afterBytes: 0,
      preserveTemporary: false,
      error: eio
    })
    await expect(appendEvents(runDir, batch)).rejects.toThrow("directory fsync EIO")
    const replayed = await readEvents(runDir)
    expect([1, 3]).toContain(replayed.length)
    expect(replayed.length === 1 ? await readRunState(runDir) : replayed.at(-1)?.sequence).toEqual(
      replayed.length === 1 ? initial : 3
    )
  })
})
