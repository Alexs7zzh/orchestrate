import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { WorkflowSpec } from "../src/types.js"

import { runProcessEffect } from "../src/process.js"
import { makeRunStore, StatePersistenceError } from "../src/runtime/run-store.js"
import { createRun, readRunState, writeRunState } from "../src/state.js"

let temporaryRoot = ""

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-effect-test-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
})

afterEach(async () => {
  delete process.env.ORCHESTRATE_STATE_DIR
  await rm(temporaryRoot, { recursive: true, force: true })
})

function emptyWorkflow(): WorkflowSpec {
  return {
    version: 1,
    name: "effect-runtime-test",
    objective: "Exercise Effect runtime ownership.",
    cwd: temporaryRoot,
    concurrency: 1,
    heartbeat: {
      intervalMinutes: null,
      milestones: false,
      callback: { type: "none" }
    },
    limits: {
      nodeWallTimeMinutes: null,
      workflowWallTimeMinutes: null,
      maxAgentStarts: null,
      maxGoalRounds: null
    },
    writeConflicts: "reject",
    nodes: []
  }
}

describe("Effect runtime resources", () => {
  test("serializes durable state updates and publishes exactly the persisted value", async () => {
    const created = await createRun(emptyWorkflow(), "digest", false, false)
    const store = await Effect.runPromise(makeRunStore(created.runDir, created.state))

    await Effect.runPromise(
      Effect.all(
        Array.from({ length: 24 }, () =>
          store.update((state) => ({ ...state, agentStarts: state.agentStarts + 1 }))
        ),
        { concurrency: "unbounded" }
      )
    )

    const memory = await Effect.runPromise(store.read)
    const persisted = await readRunState(created.runDir)
    expect(memory.agentStarts).toBe(24)
    expect(persisted).toEqual(memory)
    expect(JSON.parse(await readFile(path.join(created.runDir, "state.json"), "utf8"))).toEqual(
      memory
    )
  })

  test("poisons failed persistence until the explicit recovery transaction succeeds", async () => {
    const created = await createRun(emptyWorkflow(), "digest", false, false)
    let writes = 0
    const store = await Effect.runPromise(
      makeRunStore(created.runDir, created.state, {
        write: async (runDir, state) => {
          writes += 1
          if (writes === 1) {
            throw new Error("injected write failure")
          }
          await writeRunState(runDir, state)
        }
      })
    )

    await expect(
      Effect.runPromise(store.update((state) => ({ ...state, agentStarts: 1 })))
    ).rejects.toBeInstanceOf(StatePersistenceError)
    await expect(
      Effect.runPromise(store.update((state) => ({ ...state, agentStarts: 99 })))
    ).rejects.toBeInstanceOf(StatePersistenceError)
    expect(writes).toBe(1)
    expect((await Effect.runPromise(store.read)).agentStarts).toBe(0)

    const recovered = await Effect.runPromise(
      store.update((state) => ({ ...state, agentStarts: state.agentStarts + 1 }), {
        recoverPersistence: true
      })
    )
    expect(writes).toBe(2)
    expect(recovered.agentStarts).toBe(1)
    expect((await readRunState(created.runDir)).agentStarts).toBe(1)
  })

  test("interrupting a process fiber releases its descendant process group", async () => {
    const marker = path.join(temporaryRoot, "interrupted-descendant")
    const childScript = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(
      marker
    )}, "orphan"), 700)`
    const parentScript = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(
      childScript
    )}], {stdio:"ignore"}); setInterval(() => {}, 1000)`
    const fiber = Effect.runFork(
      runProcessEffect({
        argv: [process.execPath, "-e", parentScript],
        cwd: temporaryRoot,
        stdoutPath: path.join(temporaryRoot, "interrupt-out.log"),
        stderrPath: path.join(temporaryRoot, "interrupt-error.log"),
        timeoutMinutes: null
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await Effect.runPromise(Fiber.interrupt(fiber))
    await new Promise((resolve) => setTimeout(resolve, 800))
    await expect(access(marker)).rejects.toThrow()
  })

  test("an executable that cannot spawn fails the effect with the spawn error", async () => {
    await expect(
      Effect.runPromise(
        runProcessEffect({
          argv: ["/nonexistent-orchestrate-test/binary"],
          cwd: temporaryRoot,
          stdoutPath: path.join(temporaryRoot, "missing-out.log"),
          stderrPath: path.join(temporaryRoot, "missing-error.log"),
          timeoutMinutes: null
        })
      )
    ).rejects.toThrow("ENOENT")
  })

  test("reports a signal death as 128 plus the signal number", async () => {
    const result = await Effect.runPromise(
      runProcessEffect({
        argv: [
          process.execPath,
          "-e",
          "process.kill(process.pid,'SIGKILL');setInterval(()=>{},1000)"
        ],
        cwd: temporaryRoot,
        stdoutPath: path.join(temporaryRoot, "signal-out.log"),
        stderrPath: path.join(temporaryRoot, "signal-error.log"),
        timeoutMinutes: null
      })
    )
    expect(result.signal).toBe("SIGKILL")
    expect(result.exitCode).toBe(137)
  })

  test("flushes a final stdout protocol line without a trailing newline", async () => {
    const lines: string[] = []
    const stdoutPath = path.join(temporaryRoot, "final-line.log")
    const result = await Effect.runPromise(
      runProcessEffect({
        argv: [process.execPath, "-e", "process.stdout.write('final-line')"],
        cwd: temporaryRoot,
        stdoutPath,
        stderrPath: path.join(temporaryRoot, "final-line-error.log"),
        timeoutMinutes: null,
        onStdoutLine: (line) => lines.push(line)
      })
    )
    expect(result.exitCode).toBe(0)
    expect(lines).toEqual(["final-line"])
    expect(await readFile(stdoutPath, "utf8")).toBe("final-line")
  })

  test("timeout release escalates from TERM to KILL before returning the timeout failure", async () => {
    let pid = 0
    const startedAt = Date.now()
    await expect(
      Effect.runPromise(
        runProcessEffect(
          {
            argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
            cwd: temporaryRoot,
            stdoutPath: path.join(temporaryRoot, "forced-timeout-out.log"),
            stderrPath: path.join(temporaryRoot, "forced-timeout-error.log"),
            timeoutMinutes: 0.001,
            onSpawn: (spawnedPid) =>
              Effect.sync(() => {
                pid = spawnedPid
              })
          },
          { terminationGraceMilliseconds: 50 }
        )
      )
    ).rejects.toThrow("timed out")
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
  })
})
