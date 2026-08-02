import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { RunState, WorkflowSpec } from "../src/types.js"

import { hasCodexWakeHook, installCodexWakeHook } from "../src/runtime/harness-hooks.js"
import {
  detectedWakeOwner,
  listWakes,
  registerWake,
  waitForOwnedRun
} from "../src/runtime/wake-registry.js"
import { createRun, readRunState, writeRunState } from "../src/state.js"

let temporaryRoot = ""
let originalCodexThread: string | undefined
let originalClaudeSession: string | undefined

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-wake-test-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
  process.env.CODEX_HOME = path.join(temporaryRoot, "codex")
  originalCodexThread = process.env.CODEX_THREAD_ID
  originalClaudeSession = process.env.CLAUDE_CODE_SESSION_ID
  delete process.env.CODEX_THREAD_ID
  delete process.env.CLAUDE_CODE_SESSION_ID
})

afterEach(async () => {
  delete process.env.ORCHESTRATE_STATE_DIR
  delete process.env.CODEX_HOME
  if (originalCodexThread === undefined) {
    delete process.env.CODEX_THREAD_ID
  } else {
    process.env.CODEX_THREAD_ID = originalCodexThread
  }
  if (originalClaudeSession === undefined) {
    delete process.env.CLAUDE_CODE_SESSION_ID
  } else {
    process.env.CLAUDE_CODE_SESSION_ID = originalClaudeSession
  }
  await rm(temporaryRoot, { recursive: true, force: true })
})

async function createState(status: RunState["status"]): Promise<RunState> {
  const workflow = {
    version: 1,
    name: "wake-test",
    objective: "Exercise harness wake delivery.",
    cwd: temporaryRoot,
    concurrency: 1,
    heartbeat: { intervalMinutes: null, milestones: false, callback: { type: "none" } },
    limits: {
      nodeWallTimeMinutes: null,
      workflowWallTimeMinutes: null,
      maxAgentStarts: null,
      maxGoalRounds: null
    },
    writeConflicts: "reject",
    nodes: []
  } as WorkflowSpec
  const created = await createRun(workflow, "a".repeat(64), false, false)
  const state = await readRunState(created.runDir)
  const updated = {
    ...state,
    status,
    pauseReason: status === "paused" ? "Needs approval." : null,
    finishedAt:
      status === "completed" || status === "failed" || status === "stopped"
        ? new Date().toISOString()
        : null,
    updatedAt: new Date().toISOString()
  }
  await writeRunState(created.runDir, updated)
  return updated
}

describe("wake registration", () => {
  test("detects the native harness owner without mixing nested Codex and Claude sessions", () => {
    process.env.CODEX_THREAD_ID = "codex-thread"
    expect(detectedWakeOwner()).toEqual({ harness: "codex", sessionId: "codex-thread" })
    process.env.CLAUDE_CODE_SESSION_ID = "claude-session"
    expect(detectedWakeOwner()).toEqual({ harness: "claude", sessionId: "claude-session" })
  })

  test("does not miss a run that settled before the hook starts and consumes it once", async () => {
    const state = await createState("completed")
    await registerWake("codex", "session-a", state.id)
    await registerWake("codex", "session-a", state.id)
    expect(await listWakes("codex", "session-a")).toHaveLength(1)

    const settled = await waitForOwnedRun("codex", "session-a", 5)
    expect(settled?.state.status).toBe("completed")
    expect(settled?.state.id).toBe(state.id)
    expect(await listWakes("codex", "session-a")).toEqual([])
  })

  test("wakes for whichever owned run needs attention first and preserves the rest", async () => {
    const first = await createState("running")
    const second = await createState("running")
    await registerWake("claude", "session-b", first.id)
    await registerWake("claude", "session-b", second.id)

    const pending = waitForOwnedRun("claude", "session-b", 5)
    const secondState = await readRunState(
      path.join(process.env.ORCHESTRATE_STATE_DIR as string, "runs", second.id)
    )
    await writeRunState(path.join(process.env.ORCHESTRATE_STATE_DIR as string, "runs", second.id), {
      ...secondState,
      status: "paused",
      pauseReason: "Review required.",
      updatedAt: new Date().toISOString()
    })

    const settled = await pending
    expect(settled?.state.id).toBe(second.id)
    expect(settled?.state.status).toBe("paused")
    expect((await listWakes("claude", "session-b")).map((item) => item.runId)).toEqual([first.id])
  })

  test("clears a registration for a damaged run and still delivers the healthy one", async () => {
    const damaged = await createState("running")
    const healthy = await createState("running")
    await registerWake("codex", "session-damaged", damaged.id)
    await registerWake("codex", "session-damaged", healthy.id)
    const runsDir = path.join(process.env.ORCHESTRATE_STATE_DIR as string, "runs")
    await writeFile(path.join(runsDir, damaged.id, "state.json"), "{ not json")

    const pending = waitForOwnedRun("codex", "session-damaged", 5)
    const healthyState = await readRunState(path.join(runsDir, healthy.id))
    await writeRunState(path.join(runsDir, healthy.id), {
      ...healthyState,
      status: "completed",
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })

    const settled = await pending
    expect(settled?.state.id).toBe(healthy.id)
    expect(settled?.state.status).toBe("completed")
    // The damaged run's registration was cleared instead of wedging delivery.
    expect(await listWakes("codex", "session-damaged")).toEqual([])
  })

  test("keeps registrations isolated by exact harness session", async () => {
    const state = await createState("completed")
    await registerWake("codex", "session-one", state.id)
    expect(await listWakes("codex", "session-two")).toEqual([])
    expect(await listWakes("claude", "session-one")).toEqual([])
  })
})

describe("Codex hook installation", () => {
  test("merges with existing hooks and is idempotent", async () => {
    const hooksPath = path.join(process.env.CODEX_HOME as string, "hooks.json")
    await mkdir(path.dirname(hooksPath), { recursive: true })
    await writeFile(
      hooksPath,
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "existing" }] }] }, extra: true })}\n`
    )
    const first = await installCodexWakeHook("/tmp/orchestrate command")
    const second = await installCodexWakeHook("/tmp/orchestrate command")
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    const installed = JSON.parse(await readFile(hooksPath, "utf8")) as {
      readonly hooks: {
        readonly Stop: readonly { readonly hooks: readonly { readonly command: string }[] }[]
      }
      readonly extra: boolean
    }
    expect(installed.extra).toBe(true)
    expect(installed.hooks.Stop).toHaveLength(2)
    expect(installed.hooks.Stop[0]?.hooks[0]?.command).toBe("existing")
    // The marker travels as a CLI flag, never as a shell comment, so the
    // command stays valid when Codex execs argv directly instead of sh -c.
    expect(installed.hooks.Stop[1]?.hooks[0]?.command).toContain(
      "__wake-hook codex --marker orchestrate-wake-hook"
    )
    expect(installed.hooks.Stop[1]?.hooks[0]?.command).not.toContain("#")
    expect(await hasCodexWakeHook()).toBe(true)
  })

  test("upgrades a legacy comment-marker hook in place without duplicating it", async () => {
    const hooksPath = path.join(process.env.CODEX_HOME as string, "hooks.json")
    await mkdir(path.dirname(hooksPath), { recursive: true })
    await writeFile(
      hooksPath,
      `${JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "existing" }] },
            {
              hooks: [
                {
                  type: "command",
                  command: "'/old/orchestrate' __wake-hook codex # orchestrate-wake-hook",
                  timeout: 86_400
                }
              ]
            }
          ]
        }
      })}\n`
    )
    expect(await hasCodexWakeHook()).toBe(true)
    const upgraded = await installCodexWakeHook("/tmp/orchestrate")
    expect(upgraded.changed).toBe(true)
    const installed = JSON.parse(await readFile(hooksPath, "utf8")) as {
      readonly hooks: {
        readonly Stop: readonly { readonly hooks: readonly { readonly command: string }[] }[]
      }
    }
    expect(installed.hooks.Stop).toHaveLength(2)
    expect(installed.hooks.Stop[0]?.hooks[0]?.command).toBe("existing")
    expect(installed.hooks.Stop[1]?.hooks[0]?.command).toContain(
      "__wake-hook codex --marker orchestrate-wake-hook"
    )
    expect(installed.hooks.Stop[1]?.hooks[0]?.command).not.toContain("#")
    expect(await hasCodexWakeHook()).toBe(true)
    // Re-running with the same target is idempotent after the upgrade.
    expect((await installCodexWakeHook("/tmp/orchestrate")).changed).toBe(false)
  })
})
