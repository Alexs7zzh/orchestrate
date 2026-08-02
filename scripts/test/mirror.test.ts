import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AgentNode, RunState, WorkflowSpec } from "../src/types.js"

import { runCli } from "../src/cli.js"
import { mirrorInfoPath } from "../src/runtime/mirror.js"
import { eventsPath, readRunState, runDirectory } from "../src/state.js"
import { validateWorkflow } from "../src/validation.js"

process.env.ORCHESTRATE_ENABLE_MOCK_PROVIDER = "1"

const SCRIPT_PATH = "/unused-script-path"
const SOURCE_SCRIPT_PATH = new URL("../src/main.ts", import.meta.url).pathname

let temporaryRoot = ""
let shimDirectory = ""
let shimLogPath = ""
let originalPath = ""

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-mirror-test-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
  process.env.ORCHESTRATE_DISABLE_AUTO_WAKE = "1"
  originalPath = process.env.PATH ?? ""
  shimDirectory = path.join(temporaryRoot, "herdr-bin")
  shimLogPath = path.join(temporaryRoot, "herdr-log.txt")
  await mkdir(shimDirectory)
})

afterEach(async () => {
  process.env.PATH = originalPath
  delete process.env.ORCHESTRATE_STATE_DIR
  delete process.env.ORCHESTRATE_DISABLE_AUTO_WAKE
  delete process.env.ORCHESTRATE_MIRROR
  delete process.env.ORCHESTRATE_DISABLE_MIRROR
  delete process.env.ORCHESTRATE_MIRROR_TIMEOUT_MS
  await rm(temporaryRoot, { recursive: true, force: true })
})

// A fake herdr executable that records every invocation (argv joined by
// spaces, one line each) and answers with canned JSON shaped like the real
// herdr 0.7.x CLI. Tests never touch a real herdr server.
async function writeHerdrShim(kind: "ok" | "fail" | "hang"): Promise<void> {
  const log = `printf '%s\\n' "$*" >> ${JSON.stringify(shimLogPath)}`
  const body =
    kind === "ok"
      ? `${log}
case "$1 $2" in
  "workspace create") printf '%s\\n' '{"id":"t","result":{"type":"workspace_created","workspace":{"workspace_id":"w42"},"root_pane":{"pane_id":"w42:p1"},"tab":{"tab_id":"w42:t1"}}}' ;;
  "workspace get") printf '%s\\n' '{"id":"t","result":{"type":"workspace","workspace":{"workspace_id":"w42"}}}' ;;
  "tab create") printf '%s\\n' '{"id":"t","result":{"type":"tab_created","root_pane":{"pane_id":"w42:p9"},"tab":{"tab_id":"w42:t9"}}}' ;;
  *) printf '%s\\n' '{"id":"t","result":{"type":"ok"}}' ;;
esac`
      : kind === "fail"
        ? `if [ "$1" = "--version" ]; then exit 0; fi
${log}
exit 1`
        : `if [ "$1" = "--version" ]; then exit 0; fi
${log}
sleep 30`
  const shimPath = path.join(shimDirectory, "herdr")
  await writeFile(shimPath, `#!/bin/sh\n${body}\n`)
  await chmod(shimPath, 0o755)
  process.env.PATH = `${shimDirectory}:${originalPath}`
}

async function shimLog(): Promise<string> {
  return readFile(shimLogPath, "utf8").catch(() => "")
}

async function pollUntil<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMilliseconds = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds
  let value = await read()
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    value = await read()
  }
  return value
}

function workspace(): AgentNode["workspace"] {
  return { mode: "shared", path: null, vcs: "none", writes: [], exclusiveResources: [] }
}

function mockAgent(id: string, gate: "none" | "approval" = "none"): AgentNode {
  return {
    id,
    type: "agent",
    title: id,
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    timeoutMinutes: null,
    retry: { maxAttempts: 1, delaySeconds: 0 },
    gate,
    provider: "mock",
    model: "mock",
    effort: null,
    prompt: `${id} result`,
    session: { mode: "fresh", from: null, saveAs: null, retain: false, reuseOnRepeat: false },
    permissions: { extraArgs: [], inheritEnv: [], env: {} },
    output: { format: "text", schema: null },
    interactive: false
  }
}

function mirrorWorkflow(nodes: readonly WorkflowSpec["nodes"][number][]): WorkflowSpec {
  return {
    version: 1,
    name: "mirror-test",
    objective: "Exercise herdr mirroring.",
    cwd: temporaryRoot,
    concurrency: 2,
    heartbeat: { intervalMinutes: null, milestones: false, callback: { type: "none" } },
    limits: {
      nodeWallTimeMinutes: null,
      workflowWallTimeMinutes: null,
      maxAgentStarts: null,
      maxGoalRounds: null
    },
    writeConflicts: "reject",
    nodes
  }
}

async function captureRunId(action: () => Promise<number>): Promise<{
  readonly exitCode: number
  readonly runId: string
}> {
  const lines: string[] = []
  const original = console.log
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "))
  }
  let exitCode: number
  try {
    exitCode = await action()
  } finally {
    console.log = original
  }
  const match = lines.join("\n").match(/^Run: (.+)$/m)
  expect(match).not.toBeNull()
  return { exitCode, runId: match?.[1] as string }
}

async function launchMirrored(
  spec: WorkflowSpec,
  flags: readonly string[]
): Promise<{ readonly exitCode: number; readonly runId: string }> {
  const filePath = path.join(temporaryRoot, "workflow.json")
  await writeFile(filePath, `${JSON.stringify(spec, null, 2)}\n`)
  const digest = validateWorkflow(spec).digest as string
  return captureRunId(() =>
    runCli(["run", filePath, "--approve", digest, "--foreground", ...flags], SCRIPT_PATH)
  )
}

describe("herdr mirror mode", () => {
  test("mirror-enabled run opens a labeled workspace, status pane, and node panes", async () => {
    await writeHerdrShim("ok")
    const { exitCode, runId } = await launchMirrored(mirrorWorkflow([mockAgent("implement")]), [
      "--mirror"
    ])
    expect(exitCode).toBe(0)
    const state = await readRunState(runDirectory(runId))
    expect(state.status).toBe("completed")
    expect(state.mirror).toBe("herdr")

    const log = await pollUntil(shimLog, (content) => content.includes("tail -n +1 -F"))
    expect(log).toContain(
      `workspace create --cwd ${temporaryRoot} --label mirror-test ${runId} --no-focus`
    )
    expect(log).toContain("tab create --workspace w42")
    expect(log).toContain("--label status")
    // The status pane's shell does not inherit the worker environment, so the
    // state root must travel with the tab.
    expect(log).toContain(`--env ORCHESTRATE_STATE_DIR=${path.join(temporaryRoot, "state")}`)
    expect(log).toContain(`watch ${runId}`)
    expect(log).toContain("--label implement")
    expect(log).toContain("pane rename w42:p9 implement: implement")
    expect(log).toContain(path.join("nodes", "implement", "attempt-1", "stdout.log"))

    const info = JSON.parse(await readFile(mirrorInfoPath(runDirectory(runId)), "utf8")) as {
      workspaceId: string
    }
    expect(info.workspaceId).toBe("w42")
  })

  test("herdr failures never change the outcome and journal one degraded event", async () => {
    await writeHerdrShim("fail")
    const { exitCode, runId } = await launchMirrored(mirrorWorkflow([mockAgent("implement")]), [
      "--mirror"
    ])
    expect(exitCode).toBe(0)
    const state = await readRunState(runDirectory(runId))
    expect(state.status).toBe("completed")
    expect(state.nodes.implement?.status).toBe("completed")

    const events = await pollUntil(
      () => readFile(eventsPath(runDirectory(runId)), "utf8"),
      (content) => content.includes("mirror.degraded")
    )
    expect(events).toContain("mirror.degraded")
    expect(events).toContain("the run is unaffected")
    await new Promise((resolve) => setTimeout(resolve, 200))
    const settled = await readFile(eventsPath(runDirectory(runId)), "utf8")
    expect(settled.split("mirror.degraded").length - 1).toBe(1)
  })

  test("a hanging herdr never slows the run beyond the configured timeout", async () => {
    await writeHerdrShim("hang")
    process.env.ORCHESTRATE_MIRROR_TIMEOUT_MS = "600"
    const startedAt = Date.now()
    const { exitCode, runId } = await launchMirrored(
      mirrorWorkflow([mockAgent("first"), mockAgent("second")]),
      ["--mirror"]
    )
    const elapsed = Date.now() - startedAt
    expect(exitCode).toBe(0)
    expect((await readRunState(runDirectory(runId))).status).toBe("completed")
    // The shim sleeps 30s per call; a run that waited on even one mirrored
    // call past its 600ms timeout could not finish this quickly.
    expect(elapsed).toBeLessThan(5_000)
  })

  test("--mirror without a usable herdr CLI fails cleanly before creating a run", async () => {
    process.env.PATH = shimDirectory // exists but contains no herdr
    const spec = mirrorWorkflow([mockAgent("implement")])
    const filePath = path.join(temporaryRoot, "workflow.json")
    await writeFile(filePath, `${JSON.stringify(spec, null, 2)}\n`)
    const digest = validateWorkflow(spec).digest as string
    await expect(
      runCli(["run", filePath, "--approve", digest, "--foreground", "--mirror"], SCRIPT_PATH)
    ).rejects.toThrow("--mirror requires the herdr CLI")
    const runs = await readdir(path.join(temporaryRoot, "state", "runs")).catch(() => [])
    expect(runs).toEqual([])
  })

  test("ORCHESTRATE_DISABLE_MIRROR wins over the flag and the environment", async () => {
    await writeHerdrShim("ok")
    process.env.ORCHESTRATE_DISABLE_MIRROR = "1"
    process.env.ORCHESTRATE_MIRROR = "herdr"
    const { exitCode, runId } = await launchMirrored(mirrorWorkflow([mockAgent("implement")]), [
      "--mirror"
    ])
    expect(exitCode).toBe(0)
    const state = await readRunState(runDirectory(runId))
    expect(state.status).toBe("completed")
    expect(state.mirror ?? null).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await shimLog()).toBe("")
  })

  test("ORCHESTRATE_MIRROR=herdr mirrors without the flag and resume keeps mirroring", async () => {
    await writeHerdrShim("ok")
    process.env.ORCHESTRATE_MIRROR = "herdr"
    const { exitCode, runId } = await launchMirrored(
      mirrorWorkflow([mockAgent("seed", "approval")]),
      []
    )
    expect(exitCode).toBe(1) // paused at the gate before the node started
    const runDir = runDirectory(runId)
    const paused = await readRunState(runDir)
    expect(paused.status).toBe("paused")
    expect(paused.mirror).toBe("herdr")
    await pollUntil(shimLog, (content) => content.includes("workspace create"))

    // Resume without the flag or environment: the recorded choice survives.
    delete process.env.ORCHESTRATE_MIRROR
    await rm(shimLogPath, { force: true })
    const gate = paused.pendingGate as NonNullable<RunState["pendingGate"]>
    expect(
      await runCli(
        ["resume", runId, "--approve-gate", "seed", "--gate-digest", gate.digest],
        SOURCE_SCRIPT_PATH
      )
    ).toBe(0)
    const settled = await pollUntil(
      () => readRunState(runDir),
      (state) => state.status === "completed",
      10_000
    )
    expect(settled.status).toBe("completed")
    expect(settled.mirror).toBe("herdr")
    const stdoutLogPath = path.join("nodes", "seed", "attempt-1", "stdout.log")
    const log = await pollUntil(shimLog, (content) => content.includes(stdoutLogPath))
    // The recorded workspace was probed and reused instead of recreated.
    expect(log).toContain("workspace get w42")
    expect(log).not.toContain("workspace create")
    expect(log).toContain("--label seed")
    expect(log).toContain(stdoutLogPath)
  }, 20_000)

  test("clean closes the recorded mirror workspace best-effort", async () => {
    await writeHerdrShim("ok")
    const { exitCode, runId } = await launchMirrored(mirrorWorkflow([mockAgent("implement")]), [
      "--mirror"
    ])
    expect(exitCode).toBe(0)
    const runDir = runDirectory(runId)
    await pollUntil(
      () => readFile(mirrorInfoPath(runDir), "utf8").catch(() => ""),
      (content) => content.includes("w42")
    )
    await pollUntil(shimLog, (content) => content.includes("tail -n +1 -F"))
    await rm(shimLogPath, { force: true })
    expect(await runCli(["clean", runId], SCRIPT_PATH)).toBe(0)
    expect(await shimLog()).toContain("workspace close w42")
    expect(await readdir(path.join(temporaryRoot, "state", "runs"))).toEqual([])
  })
})
