import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  access,
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { RunReport } from "../src/report.js"
import type {
  AgentNode,
  CommandNode,
  RunState,
  SupervisorDecision,
  SupervisorNode,
  WorkflowSpec
} from "../src/types.js"

import { readNewEvents, runCli } from "../src/cli.js"
import {
  gateApprovalDigest,
  legacyPendingPatchDigest,
  launchWorker,
  pendingPatchDigest,
  supervisorInputDigest
} from "../src/engine.js"
import { preferencesPath, type PreferencesFile } from "../src/preferences.js"
import {
  acquireWorkerLock,
  createRun,
  eventsPath,
  pauseRequestPath,
  readRunState,
  runDirectory,
  stateRoot,
  workflowPath,
  writeRunState
} from "../src/state.js"
import { validateWorkflow } from "../src/validation.js"

process.env.ORCHESTRATE_ENABLE_MOCK_PROVIDER = "1"

const SCRIPT_PATH = "/unused-script-path"
const SOURCE_SCRIPT_PATH = new URL("../src/main.ts", import.meta.url).pathname

let temporaryRoot = ""

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-cli-test-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
  process.env.ORCHESTRATE_DISABLE_AUTO_WAKE = "1"
})

afterEach(async () => {
  delete process.env.ORCHESTRATE_STATE_DIR
  delete process.env.ORCHESTRATE_DISABLE_AUTO_WAKE
  await rm(temporaryRoot, { recursive: true, force: true })
})

function workspace(writes: readonly string[] = []) {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "none" as const,
    writes,
    exclusiveResources: []
  }
}

function session(): AgentNode["session"] {
  return {
    mode: "fresh",
    from: null,
    saveAs: null,
    retain: false,
    reuseOnRepeat: false
  }
}

function mockAgent(id: string, prompt: string): AgentNode {
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
    gate: "none",
    provider: "mock",
    model: "mock",
    effort: null,
    prompt,
    session: session(),
    permissions: {
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
    output: { format: "text", schema: null },
    interactive: false
  }
}

function codexAgent(id: string, model: string): AgentNode {
  return {
    ...mockAgent(id, "implementation"),
    provider: "codex",
    model,
    effort: "high",
    workspace: workspace(["src/**"]),
    permissions: {
      sandbox: "danger-full-access",
      extraArgs: [],
      inheritEnv: ["PATH"],
      env: {}
    }
  }
}

function failingCommand(id: string): CommandNode {
  return {
    id,
    type: "command",
    title: id,
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    timeoutMinutes: null,
    retry: { maxAttempts: 1, delaySeconds: 0 },
    gate: "none",
    argv: [process.execPath, "-e", "process.exit(1)"],
    mutates: false,
    inheritEnv: [],
    env: {},
    allowedExitCodes: [0]
  }
}

function mockSupervisor(decisions: readonly SupervisorDecision[]): SupervisorNode {
  return {
    id: "supervise",
    type: "supervisor",
    title: "Supervise",
    needs: ["seed"],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    timeoutMinutes: null,
    retry: { maxAttempts: 1, delaySeconds: 0 },
    gate: "none",
    provider: "mock",
    model: "mock",
    effort: null,
    prompt: JSON.stringify(decisions),
    session: {
      mode: "fresh",
      from: null,
      saveAs: "supervisor",
      retain: true,
      reuseOnRepeat: true
    },
    permissions: { extraArgs: [], inheritEnv: [], env: {} },
    goal: "Finish the test.",
    envelope: {
      providers: ["mock"],
      models: ["mock"],
      nodeTypes: ["agent", "command"],
      cwdRoots: [temporaryRoot],
      writeRoots: [temporaryRoot],
      workspaceModes: ["shared"],
      vcs: ["none"],
      gitWorktree: {
        allowed: false,
        branchPrefixes: [],
        startPoints: [],
        allowRemoveOnClean: false
      },
      allowCommands: false,
      commandArgvPrefixes: [],
      allowedCommandEnv: [],
      codexSandboxes: [],
      claudePermissionModes: [],
      allowedExtraArgs: [],
      allowedInheritedEnv: [],
      allowedProviderEnv: [],
      resumableSessionAliases: ["supervisor"],
      newSessionAliasPrefixes: ["round-"],
      maxAddedNodesPerRound: null
    },
    termination: {
      success: "The added node completed.",
      convergence: "No further work is requested.",
      maxRounds: 5,
      maxWallTimeMinutes: null
    }
  }
}

function pendingPatch(decision: SupervisorDecision): NonNullable<RunState["pendingPatch"]> {
  const supervisorId = "supervise"
  const reasons = ["out-of-envelope"]
  return {
    supervisorId,
    decision,
    reasons,
    digest: pendingPatchDigest(supervisorId, decision, reasons)
  }
}

function workflow(nodes: readonly WorkflowSpec["nodes"][number][]): WorkflowSpec {
  return {
    version: 1,
    name: "cli-test-workflow",
    objective: "Exercise the CLI layer.",
    cwd: temporaryRoot,
    concurrency: 4,
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
    writeConflicts: "allow-with-approval",
    nodes
  }
}

async function waitForRunState(
  runDir: string,
  predicate: (state: Awaited<ReturnType<typeof readRunState>>) => boolean,
  timeoutMilliseconds = 4_000
): Promise<Awaited<ReturnType<typeof readRunState>>> {
  const deadline = Date.now() + timeoutMilliseconds
  let state = await readRunState(runDir)
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    state = await readRunState(runDir)
  }
  expect(predicate(state)).toBe(true)
  return state
}

async function captureLogs<T>(
  action: () => Promise<T>
): Promise<{ readonly value: T; readonly logs: readonly string[] }> {
  const logs: string[] = []
  const original = console.log
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "))
  }
  try {
    return { value: await action(), logs }
  } finally {
    console.log = original
  }
}

async function captureStdout<T>(
  action: () => Promise<T>
): Promise<{ readonly value: T; readonly output: string }> {
  const original = process.stdout.write.bind(process.stdout)
  const chunks: string[] = []
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }
  try {
    return { value: await action(), output: chunks.join("") }
  } finally {
    process.stdout.write = original
  }
}

async function writeWorkflowFile(spec: WorkflowSpec): Promise<{
  readonly filePath: string
  readonly digest: string
}> {
  const filePath = path.join(temporaryRoot, "workflow.json")
  await writeFile(filePath, `${JSON.stringify(spec, null, 2)}\n`)
  const digest = validateWorkflow(spec).digest
  expect(digest).not.toBeNull()
  return { filePath, digest: digest as string }
}

async function runForeground(spec: WorkflowSpec): Promise<{
  readonly runId: string
  readonly runDir: string
  readonly exitCode: number
}> {
  const { filePath, digest } = await writeWorkflowFile(spec)
  const { value, logs } = await captureLogs(() =>
    runCli(["run", filePath, "--approve", digest, "--foreground"], SCRIPT_PATH)
  )
  const runLine = logs.find((line) => line.startsWith("Run: "))
  expect(runLine).toBeDefined()
  const runId = (runLine as string).slice("Run: ".length)
  return { runId, runDir: runDirectory(runId), exitCode: value }
}

async function createPausedRun(
  overrides: Partial<RunState> = {},
  spec = workflow([mockAgent("seed", "seed result")])
): Promise<{ readonly runId: string; readonly runDir: string }> {
  const validated = validateWorkflow(spec)
  expect(validated.workflow).not.toBeNull()
  const created = await createRun(
    validated.workflow as WorkflowSpec,
    validated.digest as string,
    false,
    false
  )
  const state = await readRunState(created.runDir)
  await writeRunState(created.runDir, {
    ...state,
    status: "paused",
    pauseReason: "Paused for the test.",
    pauseCode: "test",
    ...overrides
  })
  return { runId: state.id, runDir: created.runDir }
}

describe("cli approval and resume gating", () => {
  test("run rejects a wrong approval digest without revealing the correct digest", async () => {
    const { filePath, digest } = await writeWorkflowFile(
      workflow([mockAgent("implement", "implementation result")])
    )
    const wrongDigest = "0".repeat(64)
    expect(wrongDigest).not.toBe(digest)
    let message = ""
    try {
      await runCli(["run", filePath, "--approve", wrongDigest, "--foreground"], SCRIPT_PATH)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain("approval")
    expect(message).not.toContain(digest)
    expect(await readFile(preferencesPath(), "utf8").catch(() => null)).toBeNull()
  })

  test("run does not capture a valid digest without required write-conflict approval", async () => {
    const unsafe = { ...codexAgent("implement", "write-model"), workspace: workspace() }
    const { filePath, digest } = await writeWorkflowFile(workflow([unsafe]))
    await expect(
      runCli(["run", filePath, "--approve", digest, "--foreground"], SCRIPT_PATH)
    ).rejects.toThrow("--allow-write-conflicts")
    expect(await readFile(preferencesPath(), "utf8").catch(() => null)).toBeNull()
  })

  test("resume refuses a pending patch without approval and a stale patch digest", async () => {
    const decision: SupervisorDecision = {
      status: "continue",
      reason: "Add a node.",
      addNodes: [codexAgent("implement", "write-model")]
    }
    const patch = pendingPatch(decision)
    const { runId } = await createPausedRun({
      pendingPatch: patch
    })
    await expect(runCli(["resume", runId], SCRIPT_PATH)).rejects.toThrow(
      "pending out-of-envelope patch"
    )
    await expect(
      runCli(["resume", runId, "--approve-patch", "b".repeat(64)], SCRIPT_PATH)
    ).rejects.toThrow("Patch approval is stale")
    expect(await readFile(preferencesPath(), "utf8").catch(() => null)).toBeNull()
  })

  test("captures an exactly approved adaptive patch before worker launch", async () => {
    const codexNode = codexAgent("implement", "write-model")
    const patch = pendingPatch({
      status: "continue",
      reason: "Add a node.",
      addNodes: [codexNode]
    })
    const { runId } = await createPausedRun({
      pendingPatch: patch
    })
    await expect(
      runCli(
        ["resume", runId, "--approve-patch", patch.digest],
        "/definitely/missing/orchestrate.mjs"
      )
    ).rejects.toThrow("exited before startup")
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    expect(stored.global.providers.codex?.mutating?.model).toBe("write-model")
    expect(stored.global.providers.codex?.permissionCeiling).toBe("danger-full-access")
  })

  test("refuses patch capture when the stored workflow digest changed", async () => {
    const patch = pendingPatch({
      status: "continue",
      reason: "Add a node.",
      addNodes: [codexAgent("implement", "write-model")]
    })
    const { runId, runDir } = await createPausedRun({
      pendingPatch: patch
    })
    const storedWorkflow = JSON.parse(await readFile(workflowPath(runDir), "utf8")) as WorkflowSpec
    await writeFile(
      workflowPath(runDir),
      `${JSON.stringify({ ...storedWorkflow, cwd: path.join(temporaryRoot, "tampered") })}\n`
    )
    await expect(
      runCli(["resume", runId, "--approve-patch", patch.digest], SCRIPT_PATH)
    ).rejects.toThrow("Stored workflow integrity check failed")
    expect(await readFile(preferencesPath(), "utf8").catch(() => null)).toBeNull()
  })

  test("refuses a pending patch whose decision no longer matches its digest", async () => {
    const patch = pendingPatch({
      status: "continue",
      reason: "Original decision.",
      addNodes: [codexAgent("implement", "write-model")]
    })
    const { runId } = await createPausedRun({
      pendingPatch: {
        ...patch,
        decision: { ...patch.decision, reason: "Tampered decision." }
      }
    })
    await expect(
      runCli(["resume", runId, "--approve-patch", patch.digest], SCRIPT_PATH)
    ).rejects.toThrow("no longer matches its approval digest")
    expect(await readFile(preferencesPath(), "utf8").catch(() => null)).toBeNull()
  })

  test("refuses a pending patch whose supervisor no longer matches its digest", async () => {
    const patch = pendingPatch({
      status: "continue",
      reason: "Original decision.",
      addNodes: [codexAgent("implement", "write-model")]
    })
    const { runId } = await createPausedRun({
      pendingPatch: { ...patch, supervisorId: "different-supervisor" }
    })
    await expect(
      runCli(["resume", runId, "--approve-patch", patch.digest], SCRIPT_PATH)
    ).rejects.toThrow("no longer matches its approval digest")
    expect(await readFile(preferencesPath(), "utf8").catch(() => null)).toBeNull()
  })

  test("refreshes a legacy pending-patch digest and requires new approval", async () => {
    const patch = pendingPatch({
      status: "continue",
      reason: "Legacy decision.",
      addNodes: [codexAgent("implement", "write-model")]
    })
    const legacyDigest = legacyPendingPatchDigest(patch.decision)
    const { runId, runDir } = await createPausedRun({
      pendingPatch: { ...patch, digest: legacyDigest }
    })
    await expect(
      runCli(["resume", runId, "--approve-patch", legacyDigest], SCRIPT_PATH)
    ).rejects.toThrow("legacy patch approval digest")
    const refreshed = await readRunState(runDir)
    expect(refreshed.pendingPatch?.digest).toBe(
      pendingPatchDigest(patch.supervisorId, patch.decision, patch.reasons)
    )
    expect(refreshed.pendingPatch?.digest).not.toBe(legacyDigest)
    expect(await readFile(preferencesPath(), "utf8").catch(() => null)).toBeNull()
  })

  test("resume requires a response bound to the pending input digest", async () => {
    const inputDigest = supervisorInputDigest("supervise", "Which option should win?", 0)
    const { runId } = await createPausedRun({
      pendingInput: {
        supervisorId: "supervise",
        reason: "Which option should win?",
        digest: inputDigest
      }
    })
    await expect(runCli(["resume", runId], SCRIPT_PATH)).rejects.toThrow("requires a response")
    await expect(
      runCli(
        ["resume", runId, "--respond", "option a", "--input-digest", "d".repeat(64)],
        SCRIPT_PATH
      )
    ).rejects.toThrow("Supervisor input approval is stale")
  })

  test("resume refuses pending input whose question no longer matches its digest", async () => {
    const inputDigest = supervisorInputDigest("supervise", "Original question?", 0)
    const { runId } = await createPausedRun({
      pendingInput: {
        supervisorId: "supervise",
        reason: "Different question?",
        digest: inputDigest
      }
    })
    await expect(
      runCli(
        ["resume", runId, "--respond", "original answer", "--input-digest", inputDigest],
        SCRIPT_PATH
      )
    ).rejects.toThrow("no longer matches its approval digest")
  })

  test("resume requires a gate approval bound to the pending gate digest", async () => {
    const { runId, runDir } = await createPausedRun({ pauseCode: "gate:seed" })
    const content = "Fixed prompt frame.\n\n# Workflow inputs\n\n## Generated task\nplanner output"
    const digest = gateApprovalDigest(runId, "seed", content)
    const state = await readRunState(runDir)
    await writeRunState(runDir, {
      ...state,
      pendingGate: { nodeId: "seed", title: "seed", content, digest }
    })

    let message = ""
    try {
      await runCli(["resume", runId], SCRIPT_PATH)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('gated before node "seed"')
    expect(message).toContain(`--approve-gate seed --gate-digest ${digest}`)
    expect(message).toContain(`orchestrate status ${runId} --json`)

    await expect(
      runCli(
        ["resume", runId, "--approve-gate", "other-node", "--gate-digest", digest],
        SCRIPT_PATH
      )
    ).rejects.toThrow('gated before node "seed", not "other-node"')
    await expect(
      runCli(
        ["resume", runId, "--approve-gate", "seed", "--gate-digest", "e".repeat(64)],
        SCRIPT_PATH
      )
    ).rejects.toThrow("Gate approval is stale")

    const approved = await runCli(
      ["resume", runId, "--approve-gate", "seed", "--gate-digest", digest],
      "/definitely/missing/orchestrate.mjs"
    ).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(approved).toContain("exited before startup")
    const resumed = await readRunState(runDir)
    expect(resumed.status).toBe("starting")
    expect(resumed.approvedPendingGate).toBe(true)
    // The pending gate stays for the worker's independent content re-check.
    expect(resumed.pendingGate?.digest).toBe(digest)
  })

  test("resume refuses a pending gate whose content no longer matches its digest", async () => {
    const { runId, runDir } = await createPausedRun({ pauseCode: "gate:seed" })
    const digest = gateApprovalDigest(runId, "seed", "original rendered content")
    const state = await readRunState(runDir)
    await writeRunState(runDir, {
      ...state,
      pendingGate: { nodeId: "seed", title: "seed", content: "tampered rendered content", digest }
    })
    await expect(
      runCli(["resume", runId, "--approve-gate", "seed", "--gate-digest", digest], SCRIPT_PATH)
    ).rejects.toThrow("no longer matches its digest")
  })

  test("resume rejects gate flags when no gate is pending", async () => {
    const { runId } = await createPausedRun()
    await expect(
      runCli(
        ["resume", runId, "--approve-gate", "seed", "--gate-digest", "f".repeat(64)],
        SCRIPT_PATH
      )
    ).rejects.toThrow("no pending approval gate")
  })

  test("recovery validates the stored contract before inspecting recorded children", async () => {
    const spec = workflow([mockAgent("seed", "seed result")])
    const validated = validateWorkflow(spec)
    const created = await createRun(
      validated.workflow as WorkflowSpec,
      validated.digest as string,
      false,
      false
    )
    const state = await readRunState(created.runDir)
    await writeRunState(created.runDir, {
      ...state,
      contractVersion: 999,
      status: "running",
      pid: null,
      nodes: {
        ...state.nodes,
        seed: {
          ...state.nodes.seed!,
          status: "running",
          attempts: 1,
          processPid: process.pid,
          processIdentity: null
        }
      }
    })

    await expect(runCli(["resume", state.id, "--recover"], SCRIPT_PATH)).rejects.toThrow(
      "recovery requires contract 1 and was refused before signaling"
    )
  })
})

describe("cli stop", () => {
  test("stop finalizes a paused run without a live worker", async () => {
    const { runId, runDir } = await createPausedRun()
    const { value } = await captureLogs(() => runCli(["stop", runId], SCRIPT_PATH))
    expect(value).toBe(0)
    const state = await readRunState(runDir)
    expect(state.status).toBe("stopped")
    expect(state.finishedAt).not.toBeNull()
    expect(state.pid).toBeNull()
    const events = await readFile(eventsPath(runDir), "utf8")
    expect(events).toContain("run.stopped")
  })

  test("stop still refuses a non-paused run without a live worker", async () => {
    const validated = validateWorkflow(workflow([mockAgent("seed", "seed result")]))
    const created = await createRun(
      validated.workflow as WorkflowSpec,
      validated.digest as string,
      false,
      false
    )
    const state = await readRunState(created.runDir)
    await expect(runCli(["stop", state.id], SCRIPT_PATH)).rejects.toThrow("no live worker")
  })

  test("stop of a paused run delivers its terminal callback before publishing stopped", async () => {
    const callbackEvents = path.join(temporaryRoot, "paused-stop-callbacks.jsonl")
    const base = workflow([mockAgent("seed", "seed result")])
    const spec: WorkflowSpec = {
      ...base,
      heartbeat: {
        ...base.heartbeat,
        callback: {
          type: "command",
          argv: [
            process.execPath,
            "-e",
            `const fs=require("fs"),path=require("path");const event=JSON.parse(process.argv[2]);const state=JSON.parse(fs.readFileSync(path.join(process.env.ORCHESTRATE_STATE_DIR,"runs",process.argv[3],"state.json"),"utf8"));fs.appendFileSync(process.argv[1],JSON.stringify({type:event.type,status:state.status})+"\\n")`,
            callbackEvents,
            "{{event}}",
            "{{runId}}"
          ],
          timeoutSeconds: 5
        }
      }
    }
    const { runId, runDir } = await createPausedRun({}, spec)
    expect(await runCli(["stop", runId], SCRIPT_PATH)).toBe(0)
    expect((await readRunState(runDir)).status).toBe("stopped")
    const callbacks = (await readFile(callbackEvents, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; status: string })
    expect(callbacks).toEqual([{ type: "run.stopped", status: "paused" }])
    expect(await readFile(eventsPath(runDir), "utf8")).not.toContain("callback.failed")
  })
})

describe("cli pause", () => {
  test("is idempotent for paused runs and refuses every terminal state without mutation", async () => {
    const paused = await createPausedRun()
    const pausedState = await readFile(path.join(paused.runDir, "state.json"), "utf8")
    const pausedEvents = await readFile(eventsPath(paused.runDir), "utf8")
    const result = await captureLogs(() => runCli(["pause", paused.runId], SCRIPT_PATH))
    expect(result.value).toBe(0)
    expect(result.logs).toContain(`Run ${paused.runId} is already paused.`)
    expect(await readFile(path.join(paused.runDir, "state.json"), "utf8")).toBe(pausedState)
    expect(await readFile(eventsPath(paused.runDir), "utf8")).toBe(pausedEvents)

    for (const status of ["completed", "failed", "stopped"] as const) {
      const terminal = await createPausedRun({ status })
      const stateBefore = await readFile(path.join(terminal.runDir, "state.json"), "utf8")
      const eventsBefore = await readFile(eventsPath(terminal.runDir), "utf8")
      await expect(runCli(["pause", terminal.runId], SCRIPT_PATH)).rejects.toThrow(
        `is ${status} and cannot be paused`
      )
      expect(await readFile(path.join(terminal.runDir, "state.json"), "utf8")).toBe(stateBefore)
      expect(await readFile(eventsPath(terminal.runDir), "utf8")).toBe(eventsBefore)
    }
  })

  test("refuses a stale non-paused run with recovery guidance", async () => {
    const validated = validateWorkflow(workflow([mockAgent("seed", "seed result")]))
    const created = await createRun(
      validated.workflow as WorkflowSpec,
      validated.digest as string,
      false,
      false
    )
    await expect(runCli(["pause", created.state.id], SCRIPT_PATH)).rejects.toThrow(
      `orchestrate resume ${created.state.id} --recover`
    )
  })

  test("requests a live boundary pause and resumes it through the public command", async () => {
    const firstDone = path.join(temporaryRoot, "cli-pause-first")
    const secondDone = path.join(temporaryRoot, "cli-pause-second")
    const first: CommandNode = {
      id: "first",
      type: "command",
      title: "First",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      argv: [
        process.execPath,
        "-e",
        `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(firstDone)},"done"),800)`
      ],
      mutates: false,
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const second: CommandNode = {
      ...first,
      id: "second",
      title: "Second",
      argv: [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(secondDone)},"done")`
      ]
    }
    const spec = { ...workflow([first, second]), concurrency: 1 }
    const validated = validateWorkflow(spec)
    const created = await createRun(
      validated.workflow as WorkflowSpec,
      validated.digest as string,
      false,
      false
    )
    const fakeBin = path.join(temporaryRoot, "fake-bin")
    const fakePs = path.join(fakeBin, "ps")
    await mkdir(fakeBin)
    await writeFile(
      fakePs,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(`bun orchestrate __worker ${created.runDir}`)}\n`
    )
    await chmod(fakePs, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`
    try {
      launchWorker(SOURCE_SCRIPT_PATH, created.runDir)
      await waitForRunState(created.runDir, (state) => state.nodes.first?.status === "running")
      const pauseResult = await captureLogs(() =>
        runCli(["pause", created.state.id], SOURCE_SCRIPT_PATH)
      )
      expect(pauseResult.value).toBe(0)
      expect(pauseResult.logs[0]).toContain("Pause requested")
      const paused = await waitForRunState(created.runDir, (state) => state.status === "paused")
      expect(paused.status).toBe("paused")
      expect(paused.nodes.first?.status).toBe("completed")
      expect(paused.nodes.second?.status).toBe("pending")

      expect(await runCli(["resume", created.state.id], SOURCE_SCRIPT_PATH)).toBe(0)
      const completed = await waitForRunState(
        created.runDir,
        (state) => state.status === "completed",
        6_000
      )
      expect(completed.nodes.first?.attempts).toBe(1)
      expect(completed.nodes.second?.attempts).toBe(1)
      expect(await readFile(firstDone, "utf8")).toBe("done")
      expect(await readFile(secondDone, "utf8")).toBe("done")
      await expect(runCli(["resume", created.state.id], SOURCE_SCRIPT_PATH)).rejects.toThrow(
        "Only paused runs can resume normally"
      )
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
    }
  })

  test("recovers a stale pause drain without accepting the dead worker token", async () => {
    const completedMarker = path.join(temporaryRoot, "recovered-pause-node")
    const node: CommandNode = {
      id: "recoverable",
      type: "command",
      title: "Recoverable",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 2, delaySeconds: 0 },
      gate: "none",
      argv: [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(completedMarker)},"done")`
      ],
      mutates: false,
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const spec = workflow([node])
    const validated = validateWorkflow(spec)
    const created = await createRun(
      validated.workflow as WorkflowSpec,
      validated.digest as string,
      false,
      false
    )
    await writeRunState(created.runDir, {
      ...created.state,
      status: "pausing",
      pid: null,
      workerToken: "dead-worker-token",
      pauseReason: "Worker died while draining a requested pause.",
      pauseCode: "user-request",
      nodes: {
        ...created.state.nodes,
        recoverable: {
          ...created.state.nodes.recoverable!,
          status: "running",
          attempts: 1,
          processPid: null,
          processIdentity: null
        }
      }
    })
    await writeFile(
      pauseRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: "dead-worker-token" })}\n`
    )
    const fakeBin = path.join(temporaryRoot, "recovery-fake-bin")
    const fakePs = path.join(fakeBin, "ps")
    await mkdir(fakeBin)
    await writeFile(
      fakePs,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(`bun orchestrate __worker ${created.runDir}`)}\n`
    )
    await chmod(fakePs, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`
    try {
      expect(await runCli(["resume", created.state.id, "--recover"], SOURCE_SCRIPT_PATH)).toBe(0)
      const completed = await waitForRunState(
        created.runDir,
        (state) => state.status === "completed",
        6_000
      )
      expect(completed.nodes.recoverable?.attempts).toBe(2)
      expect(await readFile(completedMarker, "utf8")).toBe("done")
      await expect(access(pauseRequestPath(created.runDir))).rejects.toThrow()
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
    }
  })
})

describe("cli inspection commands", () => {
  test("result prints a node's recorded result text and rejects missing results", async () => {
    const run = await runForeground(workflow([mockAgent("implement", "implementation result")]))
    expect(run.exitCode).toBe(0)
    const latest = await captureStdout(() =>
      runCli(["result", run.runId, "implement"], SCRIPT_PATH)
    )
    expect(latest.value).toBe(0)
    expect(latest.output).toBe("implementation result")
    const explicit = await captureStdout(() =>
      runCli(["result", run.runId, "implement", "--attempt", "1"], SCRIPT_PATH)
    )
    expect(explicit.output).toBe("implementation result")
    await expect(runCli(["result", run.runId, "missing-node"], SCRIPT_PATH)).rejects.toThrow(
      'no node "missing-node"'
    )
    await expect(
      runCli(["result", run.runId, "implement", "--attempt", "7"], SCRIPT_PATH)
    ).rejects.toThrow("no result")
    const unstarted = await createPausedRun()
    await expect(runCli(["result", unstarted.runId, "seed"], SCRIPT_PATH)).rejects.toThrow(
      "no recorded result"
    )
  })

  test("events prints the full event log as text and as a JSON array", async () => {
    const run = await runForeground(workflow([mockAgent("implement", "implementation result")]))
    const text = await captureLogs(() => runCli(["events", run.runId], SCRIPT_PATH))
    expect(text.value).toBe(0)
    expect(text.logs.some((line) => line.includes("run.created"))).toBe(true)
    expect(text.logs.some((line) => line.includes("run.completed"))).toBe(true)
    const json = await captureLogs(() => runCli(["events", run.runId, "--json"], SCRIPT_PATH))
    expect(json.value).toBe(0)
    const events = JSON.parse(json.logs.join("\n")) as readonly { readonly type?: string }[]
    expect(Array.isArray(events)).toBe(true)
    expect(events[0]?.type).toBe("run.created")
    expect(events.some((event) => event.type === "run.completed")).toBe(true)
  })

  test("watch --once does a single pass with the watch exit-code scheme", async () => {
    const run = await runForeground(workflow([mockAgent("implement", "implementation result")]))
    const completed = await captureLogs(() => runCli(["watch", run.runId, "--once"], SCRIPT_PATH))
    expect(completed.value).toBe(0)
    expect(completed.logs.some((line) => line.includes("run.completed"))).toBe(true)
    expect(completed.logs.some((line) => line.includes("Status: completed"))).toBe(true)
    const paused = await createPausedRun()
    const pausedPass = await captureLogs(() =>
      runCli(["watch", paused.runId, "--once"], SCRIPT_PATH)
    )
    expect(pausedPass.value).toBe(2)
    expect(pausedPass.logs.some((line) => line.includes("Status: paused"))).toBe(true)
  })

  test("wait returns immediately for settled states with stable exit codes and JSON", async () => {
    const run = await runForeground(workflow([mockAgent("implement", "implementation result")]))
    const completed = await captureLogs(() => runCli(["wait", run.runId, "--json"], SCRIPT_PATH))
    expect(completed.value).toBe(0)
    expect((JSON.parse(completed.logs.join("\n")) as RunState).status).toBe("completed")

    const paused = await createPausedRun()
    const pausedWait = await captureLogs(() => runCli(["wait", paused.runId], SCRIPT_PATH))
    expect(pausedWait.value).toBe(2)
    expect(pausedWait.logs.some((line) => line.includes("Status: paused"))).toBe(true)
  })

  test("runs lists damaged run directories in text and JSON mode", async () => {
    const healthy = await createPausedRun()
    const damagedName = "20260101000000-deadbeef"
    const damagedDir = path.join(stateRoot(), "runs", damagedName)
    await mkdir(damagedDir, { recursive: true })
    await writeFile(path.join(damagedDir, "state.json"), "{ this is not json")
    const text = await captureLogs(() => runCli(["runs"], SCRIPT_PATH))
    expect(text.value).toBe(0)
    expect(text.logs.some((line) => line.includes(healthy.runId))).toBe(true)
    expect(text.logs.some((line) => line.includes(damagedName) && line.includes("damaged"))).toBe(
      true
    )
    const json = await captureLogs(() => runCli(["runs", "--json"], SCRIPT_PATH))
    const listing = JSON.parse(json.logs.join("\n")) as {
      readonly runs: readonly { readonly id: string }[]
      readonly damaged: readonly { readonly id: string; readonly status: string }[]
    }
    expect(listing.runs.some((run) => run.id === healthy.runId)).toBe(true)
    expect(listing.damaged).toEqual([{ id: damagedName, status: "damaged" }])
  })
})

describe("cli report", () => {
  const longPrompt = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n")

  test("report renders a settled run with bounded summaries and the status exit codes", async () => {
    const run = await runForeground(
      workflow([mockAgent("verbose", longPrompt), failingCommand("broken")])
    )
    expect(run.exitCode).toBe(1)
    const { value, logs } = await captureLogs(() => runCli(["report", run.runId], SCRIPT_PATH))
    expect(value).toBe(1)
    const output = logs.join("\n")
    expect(output).toContain(`Run: ${run.runId}`)
    expect(output).toContain("Status: failed")
    expect(output).toContain("Run failed.")
    expect(output).toContain("  failed:")
    expect(output).toContain("  completed:")
    expect(output).toContain("error: Command exited with 1")
    expect(output).toContain("| line-1")
    expect(output).toContain("| line-15")
    expect(output).toContain("| line-30")
    expect(output).not.toContain("line-18")
    expect(output).toContain(`… (10 lines omitted, see: orchestrate result ${run.runId} verbose)`)
    expect(output).toContain(`Follow up: orchestrate watch ${run.runId}`)
  })

  test("report surfaces pending input with its digest and a copyable resume command", async () => {
    const question = "Which option should win?"
    const digest = supervisorInputDigest("supervise", question, 0)
    const { runId } = await createPausedRun({
      pauseReason: `Supervisor "supervise" requested input: ${question}`,
      pauseCode: "supervisor-input:supervise",
      pendingInput: { supervisorId: "supervise", reason: question, digest }
    })
    const { value, logs } = await captureLogs(() => runCli(["report", runId], SCRIPT_PATH))
    expect(value).toBe(2)
    const output = logs.join("\n")
    expect(output).toContain("Needs attention:")
    expect(output).toContain(question)
    expect(output).toContain(`Digest: ${digest}`)
    expect(output).toContain(
      `Respond: orchestrate resume ${runId} --respond "<answer>" --input-digest ${digest}`
    )
  })

  test("report shows pending patches and limit pauses without leaking patch env values", async () => {
    const secretNode: AgentNode = {
      ...codexAgent("fix-1", "write-model"),
      provider: "codex",
      title: "Fix the finding",
      permissions: {
        sandbox: "danger-full-access",
        extraArgs: [],
        inheritEnv: [],
        env: { PATCH_SECRET: "patch-secret-v1" }
      }
    }
    const patch = pendingPatch({
      status: "continue",
      reason: "Fix the review finding.",
      addNodes: [secretNode]
    })
    const patched = await createPausedRun({
      pendingPatch: patch,
      pauseCode: "adaptive-patch:supervise",
      pauseReason: 'Supervisor "supervise" proposed work outside its approved envelope.'
    })
    const text = await captureLogs(() => runCli(["report", patched.runId], SCRIPT_PATH))
    expect(text.value).toBe(2)
    const output = text.logs.join("\n")
    expect(output).toContain(`Digest: ${patch.digest}`)
    expect(output).toContain(
      `Approve: orchestrate resume ${patched.runId} --approve-patch ${patch.digest}`
    )
    expect(output).toContain('fix-1 "Fix the finding"')
    expect(output).not.toContain("patch-secret-v1")
    const json = await captureLogs(() => runCli(["report", patched.runId, "--json"], SCRIPT_PATH))
    expect(json.value).toBe(2)
    expect(json.logs.join("\n")).not.toContain("patch-secret-v1")

    const limited = await createPausedRun({
      pauseCode: "max-agent-starts",
      pauseReason: "Reached the approved agent-start limit.",
      agentStarts: 5
    })
    const limit = await captureLogs(() => runCli(["report", limited.runId], SCRIPT_PATH))
    expect(limit.value).toBe(2)
    expect(limit.logs.join("\n")).toContain('Paused at approved limit "max-agent-starts".')
    expect(limit.logs.join("\n")).toContain(
      `Override: orchestrate resume ${limited.runId} --override-limit`
    )
  })

  test("report surfaces a pending gate with bounded content, digest, and resume command", async () => {
    const content = [
      "Fixed prompt frame.",
      "",
      "# Workflow inputs",
      "",
      "## Generated task",
      ...Array.from({ length: 28 }, (_, index) => `line-${index + 1}`)
    ].join("\n")
    const { runId, runDir } = await createPausedRun({
      pauseCode: "gate:consume",
      pauseReason: 'Node "consume" ("Consume the plan") is gated.'
    })
    const digest = gateApprovalDigest(runId, "consume", content)
    const state = await readRunState(runDir)
    await writeRunState(runDir, {
      ...state,
      pendingGate: { nodeId: "consume", title: "Consume the plan", content, digest }
    })
    const { value, logs } = await captureLogs(() => runCli(["report", runId], SCRIPT_PATH))
    expect(value).toBe(2)
    const output = logs.join("\n")
    expect(output).toContain("Needs attention:")
    expect(output).toContain('Node "consume" ("Consume the plan") is gated')
    expect(output).toContain("Fixed prompt frame.")
    expect(output).toContain("line-10")
    expect(output).toContain("line-28")
    expect(output).not.toContain("line-15")
    expect(output).toContain(`lines omitted, see: orchestrate status ${runId} --json`)
    expect(output).toContain(`Digest: ${digest}`)
    expect(output).toContain(
      `Approve: orchestrate resume ${runId} --approve-gate consume --gate-digest ${digest}`
    )
    const json = await captureLogs(() => runCli(["report", runId, "--json"], SCRIPT_PATH))
    const parsed = JSON.parse(json.logs.join("\n")) as RunReport
    expect(parsed.needsAttention).toHaveLength(1)
    expect(parsed.needsAttention[0]).toMatchObject({ kind: "pending-gate", digest })
  })

  test("report --json exposes the stable shape without inlining full result text", async () => {
    const run = await runForeground(workflow([mockAgent("verbose", longPrompt)]))
    expect(run.exitCode).toBe(0)
    const { value, logs } = await captureLogs(() =>
      runCli(["report", run.runId, "--json"], SCRIPT_PATH)
    )
    expect(value).toBe(0)
    const raw = logs.join("\n")
    const parsed = JSON.parse(raw) as RunReport
    expect(Object.keys(parsed)).toEqual(["run", "needsAttention", "nodes", "supervisorRounds"])
    expect(parsed.run).toMatchObject({
      id: run.runId,
      workflowName: "cli-test-workflow",
      objective: "Exercise the CLI layer.",
      status: "completed",
      workerAlive: false
    })
    expect(parsed.run.limits.agentStarts).toEqual({ used: 1, max: null })
    expect(parsed.needsAttention).toEqual([])
    expect(parsed.supervisorRounds).toEqual([])
    expect(parsed.nodes).toHaveLength(1)
    const node = parsed.nodes[0] as RunReport["nodes"][number]
    expect(node).toMatchObject({
      id: "verbose",
      type: "agent",
      provider: "mock",
      model: "mock",
      status: "completed",
      attempts: 1,
      resultLinesOmitted: 10,
      resultCommand: `orchestrate result ${run.runId} verbose`
    })
    expect(node.resultPath).toContain(path.join("nodes", "verbose", "attempt-1", "result.txt"))
    expect(node.resultSummary).toContain("line-1")
    expect(node.resultSummary).toContain("line-30")
    expect(raw).not.toContain("line-18")
  })

  test("report tolerates missing result files and damaged event lines", async () => {
    const run = await runForeground(workflow([mockAgent("implement", "implementation result")]))
    await rm(path.join(run.runDir, "nodes", "implement", "attempt-1", "result.txt"))
    await appendFile(eventsPath(run.runDir), "{ this is not json\n")
    const text = await captureLogs(() => runCli(["report", run.runId], SCRIPT_PATH))
    expect(text.value).toBe(0)
    const output = text.logs.join("\n")
    expect(output).toContain('implement "implement"')
    expect(output).toContain("note: result file is unreadable at")
    const json = await captureLogs(() => runCli(["report", run.runId, "--json"], SCRIPT_PATH))
    expect(json.value).toBe(0)
    const parsed = JSON.parse(json.logs.join("\n")) as RunReport
    const node = parsed.nodes[0] as RunReport["nodes"][number]
    expect(node.resultSummary).toBeNull()
    expect(node.note).toContain("result file is unreadable")
  })

  test("report reconstructs supervisor rounds from the event journal", async () => {
    const decisions: readonly SupervisorDecision[] = [
      {
        status: "continue",
        reason: "Found issues to fix.",
        addNodes: [{ ...mockAgent("round-fix", "fix applied"), title: "Fix the issues" }]
      },
      { status: "complete", reason: "All clear.", addNodes: [] }
    ]
    const run = await runForeground(
      workflow([mockAgent("seed", "seed result"), mockSupervisor(decisions)])
    )
    expect(run.exitCode).toBe(0)
    const text = await captureLogs(() => runCli(["report", run.runId], SCRIPT_PATH))
    expect(text.value).toBe(0)
    const output = text.logs.join("\n")
    expect(output).toContain("Goal rounds: supervise 1 of 5")
    expect(output).toContain("Supervisor rounds:")
    expect(output).toContain("supervise round 1: continue — Found issues to fix.")
    expect(output).toContain('added: round-fix "Fix the issues"')
    expect(output).toContain("supervise round 2: complete")
    const json = await captureLogs(() => runCli(["report", run.runId, "--json"], SCRIPT_PATH))
    const parsed = JSON.parse(json.logs.join("\n")) as RunReport
    expect(parsed.supervisorRounds).toEqual([
      {
        supervisorId: "supervise",
        round: 1,
        decision: "continue",
        reason: "Found issues to fix.",
        addedNodes: [{ id: "round-fix", title: "Fix the issues" }]
      },
      {
        supervisorId: "supervise",
        round: 2,
        decision: "complete",
        reason: null,
        addedNodes: []
      }
    ])
    expect(parsed.run.limits.goalRounds).toEqual([{ supervisorId: "supervise", used: 1, max: 5 }])
  })
})

describe("cli provider failure stderr surfacing", () => {
  test("a failing command's node error carries a bounded stderr tail into report and status", async () => {
    const noisy: CommandNode = {
      ...failingCommand("untrusted"),
      argv: [
        process.execPath,
        "-e",
        'process.stderr.write("preamble line\\nNot inside a trusted directory and --skip-git-repo-check was not specified.\\n");process.exit(1)'
      ]
    }
    const run = await runForeground(workflow([noisy]))
    expect(run.exitCode).toBe(1)
    const state = await readRunState(run.runDir)
    expect(state.nodes.untrusted?.error).toContain("Command exited with 1")
    expect(state.nodes.untrusted?.error).toContain("Last stderr:")
    expect(state.nodes.untrusted?.error).toContain(
      "Not inside a trusted directory and --skip-git-repo-check was not specified."
    )
    const report = await captureLogs(() => runCli(["report", run.runId], SCRIPT_PATH))
    expect(report.logs.join("\n")).toContain(
      "Last stderr: preamble line | Not inside a trusted directory and --skip-git-repo-check was not specified."
    )
    const status = await captureLogs(() => runCli(["status", run.runId, "--json"], SCRIPT_PATH))
    expect(status.logs.join("\n")).toContain("Last stderr:")
    // The full log file is untouched by the bounded tail.
    expect(
      await readFile(path.join(run.runDir, "nodes", "untrusted", "attempt-1", "stderr.log"), "utf8")
    ).toContain("preamble line\nNot inside a trusted directory")
  })
})

function markerCommand(
  id: string,
  marker: string,
  content: string,
  needs: readonly string[] = []
): CommandNode {
  return {
    id,
    type: "command",
    title: id,
    needs,
    cwd: null,
    workspace: workspace(),
    inputs: [],
    timeoutMinutes: null,
    retry: { maxAttempts: 1, delaySeconds: 0 },
    gate: "none",
    argv: [
      process.execPath,
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(marker)},${JSON.stringify(content)})`
    ],
    mutates: false,
    inheritEnv: [],
    env: {},
    allowedExitCodes: [0]
  }
}

async function writeRevisedFile(spec: WorkflowSpec, name = "revised.json"): Promise<string> {
  const filePath = path.join(temporaryRoot, name)
  await writeFile(filePath, `${JSON.stringify(spec, null, 2)}\n`)
  return filePath
}

// A paused run whose "first" node already executed and whose remaining
// nodes are untouched pending work — the canonical revision starting point.
async function createPartiallyExecutedPausedRun(spec: WorkflowSpec): Promise<{
  readonly runId: string
  readonly runDir: string
  readonly digest: string
}> {
  const validated = validateWorkflow(spec)
  expect(validated.workflow).not.toBeNull()
  const created = await createRun(
    validated.workflow as WorkflowSpec,
    validated.digest as string,
    false,
    false
  )
  const state = await readRunState(created.runDir)
  const now = new Date().toISOString()
  await writeRunState(created.runDir, {
    ...state,
    status: "paused",
    startedAt: now,
    pauseReason: "Paused for the revision test.",
    pauseCode: "user-request",
    nodes: {
      ...state.nodes,
      first: {
        ...state.nodes.first!,
        status: "completed",
        attempts: 1,
        startedAt: now,
        finishedAt: now,
        exitCode: 0
      }
    }
  })
  return { runId: state.id, runDir: created.runDir, digest: validated.digest as string }
}

describe("cli revise", () => {
  test("revise refuses a run that is not paused with pause guidance", async () => {
    const spec = workflow([mockAgent("seed", "seed result")])
    const validated = validateWorkflow(spec)
    const created = await createRun(
      validated.workflow as WorkflowSpec,
      validated.digest as string,
      false,
      false
    )
    const revisedFile = await writeRevisedFile(spec)
    await expect(runCli(["revise", created.state.id, revisedFile], SCRIPT_PATH)).rejects.toThrow(
      `Pause it first with: orchestrate pause ${created.state.id}`
    )
  })

  test("pause, revise, approve: the revised plan runs, archives the prior workflow, and journals run.revised", async () => {
    const firstMarker = path.join(temporaryRoot, "revise-first.marker")
    const secondMarker = path.join(temporaryRoot, "revise-second.marker")
    const obsoleteMarker = path.join(temporaryRoot, "revise-obsolete.marker")
    const addedMarker = path.join(temporaryRoot, "revise-added.marker")
    const spec = workflow([
      markerCommand("first", firstMarker, "first"),
      markerCommand("second", secondMarker, "original-second", ["first"]),
      markerCommand("obsolete", obsoleteMarker, "obsolete")
    ])
    const { runId, runDir, digest } = await createPartiallyExecutedPausedRun(spec)

    const revisedSpec = workflow([
      spec.nodes[0] as CommandNode,
      markerCommand("second", secondMarker, "revised-second", ["first"]),
      markerCommand("added", addedMarker, "added", ["second"])
    ])
    const revisedValidation = validateWorkflow(revisedSpec)
    const revisedDigest = revisedValidation.digest as string
    expect(revisedDigest).not.toBe(digest)
    const revisedFile = await writeRevisedFile(revisedSpec)

    const proposed = await captureLogs(() => runCli(["revise", runId, revisedFile], SCRIPT_PATH))
    expect(proposed.value).toBe(0)
    const proposedOutput = proposed.logs.join("\n")
    expect(proposedOutput).toContain("Added nodes: added")
    expect(proposedOutput).toContain("Modified nodes: second")
    expect(proposedOutput).toContain("Removed nodes: obsolete")
    expect(proposedOutput).toContain(`Revision digest: ${revisedDigest}`)
    expect(proposedOutput).toContain(
      `Apply with: orchestrate resume ${runId} --approve-revision ${revisedDigest}`
    )

    const report = await captureLogs(() => runCli(["report", runId, "--json"], SCRIPT_PATH))
    const parsedReport = JSON.parse(report.logs.join("\n")) as RunReport
    const attention = parsedReport.needsAttention.find(
      (item) => item.kind === "pending-revision"
    ) as RunReport["needsAttention"][number]
    expect(attention).toBeDefined()
    expect(attention.digest).toBe(revisedDigest)
    expect(attention.detail).toContain("Modified nodes: second")
    expect(attention.resumeCommand).toBe(
      `orchestrate resume ${runId} --approve-revision ${revisedDigest}`
    )

    await expect(runCli(["resume", runId], SCRIPT_PATH)).rejects.toThrow(
      `--approve-revision ${revisedDigest}`
    )

    expect(
      await runCli(["resume", runId, "--approve-revision", revisedDigest], SOURCE_SCRIPT_PATH)
    ).toBe(0)
    const completed = await waitForRunState(runDir, (state) => state.status === "completed", 6_000)
    expect(completed.digest).toBe(revisedDigest)
    expect(completed.pendingRevision ?? null).toBeNull()
    expect(completed.nodes.first).toMatchObject({ status: "completed", attempts: 1 })
    expect(completed.nodes.second).toMatchObject({ status: "completed", attempts: 1 })
    expect(completed.nodes.added).toMatchObject({ status: "completed", attempts: 1 })
    expect(completed.nodes.obsolete).toBeUndefined()
    expect(await readFile(secondMarker, "utf8")).toBe("revised-second")
    expect(await readFile(addedMarker, "utf8")).toBe("added")
    expect(await readFile(obsoleteMarker, "utf8").catch(() => null)).toBeNull()
    // The completed "first" node never re-ran under the revision.
    expect(await readFile(firstMarker, "utf8").catch(() => null)).toBeNull()

    const archived = JSON.parse(
      await readFile(path.join(runDir, "revisions", "1-workflow.json"), "utf8")
    ) as WorkflowSpec
    expect(validateWorkflow(archived).digest).toBe(digest)
    const events = await readFile(eventsPath(runDir), "utf8")
    expect(events).toContain("run.revision-proposed")
    expect(events).toContain("run.revised")
    expect(events).toContain(revisedDigest)
  })

  test("revise refuses every mid-run invariant violation with listed errors", async () => {
    const firstMarker = path.join(temporaryRoot, "invariant-first.marker")
    const keepMarker = path.join(temporaryRoot, "invariant-keep.marker")
    const leafMarker = path.join(temporaryRoot, "invariant-leaf.marker")
    const spec = workflow([
      markerCommand("first", firstMarker, "first"),
      markerCommand("keep", keepMarker, "keep"),
      markerCommand("leaf", leafMarker, "leaf", ["keep"])
    ])
    const { runId } = await createPartiallyExecutedPausedRun(spec)

    const modifiedExecuted = await writeRevisedFile(
      workflow([
        { ...(spec.nodes[0] as CommandNode), title: "renamed executed node" },
        spec.nodes[1] as CommandNode,
        spec.nodes[2] as CommandNode
      ]),
      "revised-modified-executed.json"
    )
    await expect(runCli(["revise", runId, modifiedExecuted], SCRIPT_PATH)).rejects.toThrow(
      'Node "first" has executed (status completed, attempts 1) and must stay byte-identical'
    )

    const removedExecuted = await writeRevisedFile(
      workflow([spec.nodes[1] as CommandNode, spec.nodes[2] as CommandNode]),
      "revised-removed-executed.json"
    )
    await expect(runCli(["revise", runId, removedExecuted], SCRIPT_PATH)).rejects.toThrow(
      'Node "first" has executed (status completed, attempts 1) and may not be removed'
    )

    const renamedWorkflow = await writeRevisedFile(
      { ...workflow([...spec.nodes]), name: "renamed-workflow" },
      "revised-renamed.json"
    )
    await expect(runCli(["revise", runId, renamedWorkflow], SCRIPT_PATH)).rejects.toThrow(
      'Workflow "name" may not change in a revision'
    )

    const movedCwd = await writeRevisedFile(
      { ...workflow([...spec.nodes]), cwd: path.join(temporaryRoot, "elsewhere") },
      "revised-moved-cwd.json"
    )
    await expect(runCli(["revise", runId, movedCwd], SCRIPT_PATH)).rejects.toThrow(
      'Workflow "cwd" may not change in a revision'
    )

    const brokenNeeds = await writeRevisedFile(
      workflow([spec.nodes[0] as CommandNode, spec.nodes[2] as CommandNode]),
      "revised-broken-needs.json"
    )
    await expect(runCli(["revise", runId, brokenNeeds], SCRIPT_PATH)).rejects.toThrow(
      'Node "leaf" depends on missing node "keep"'
    )
  })

  test("approve-revision refuses tampered stored content, a wrong digest, and a missing proposal", async () => {
    const spec = workflow([mockAgent("seed", "seed result")])
    const { runId, runDir } = await createPausedRun({}, spec)
    await expect(
      runCli(["resume", runId, "--approve-revision", "a".repeat(64)], SCRIPT_PATH)
    ).rejects.toThrow("no pending revision")

    const revisedSpec = workflow([mockAgent("seed", "revised seed result")])
    const revisedDigest = validateWorkflow(revisedSpec).digest as string
    const revisedFile = await writeRevisedFile(revisedSpec)
    expect(await runCli(["revise", runId, revisedFile], SCRIPT_PATH)).toBe(0)

    await expect(
      runCli(["resume", runId, "--approve-revision", "b".repeat(64)], SCRIPT_PATH)
    ).rejects.toThrow("Revision approval is stale")

    const state = await readRunState(runDir)
    const pending = state.pendingRevision as NonNullable<RunState["pendingRevision"]>
    expect(pending.digest).toBe(revisedDigest)
    await writeRunState(runDir, {
      ...state,
      pendingRevision: {
        ...pending,
        workflow: { ...pending.workflow, objective: "tampered objective" }
      }
    })
    await expect(
      runCli(["resume", runId, "--approve-revision", revisedDigest], SCRIPT_PATH)
    ).rejects.toThrow("no longer matches its approval digest")
  })

  test("plain resume is refused while a revision is pending; --discard clears it", async () => {
    const spec = workflow([mockAgent("seed", "seed result")])
    const { runId, runDir } = await createPausedRun({}, spec)
    const revisedSpec = workflow([mockAgent("seed", "revised seed result")])
    const revisedFile = await writeRevisedFile(revisedSpec)
    expect(await runCli(["revise", runId, revisedFile], SCRIPT_PATH)).toBe(0)

    await expect(runCli(["resume", runId], SCRIPT_PATH)).rejects.toThrow(
      `orchestrate revise ${runId} --discard`
    )

    const discarded = await captureLogs(() => runCli(["revise", runId, "--discard"], SCRIPT_PATH))
    expect(discarded.value).toBe(0)
    expect(discarded.logs.join("\n")).toContain("Discarded pending revision")
    expect((await readRunState(runDir)).pendingRevision ?? null).toBeNull()
    expect(await readFile(eventsPath(runDir), "utf8")).toContain("run.revision-discarded")

    // A second discard is an idempotent no-op.
    const again = await captureLogs(() => runCli(["revise", runId, "--discard"], SCRIPT_PATH))
    expect(again.logs.join("\n")).toContain("no pending revision to discard")

    // Plain resume now proceeds past the refusal (and fails only on the
    // deliberately missing worker script).
    await expect(runCli(["resume", runId], "/definitely/missing/orchestrate.mjs")).rejects.toThrow(
      "exited before startup"
    )
    expect((await readRunState(runDir)).status).toBe("starting")
  })

  test("a revision of the gated pending node re-gates it with freshly rendered content", async () => {
    const plannerMarker = path.join(temporaryRoot, "gate-planner.marker")
    const consumeMarker = path.join(temporaryRoot, "gate-consume.marker")
    const spec = {
      ...workflow([
        markerCommand("planner", plannerMarker, "planner"),
        { ...markerCommand("consume", consumeMarker, "consume-v1", ["planner"]), gate: "approval" }
      ]),
      concurrency: 1
    } as WorkflowSpec
    const validated = validateWorkflow(spec)
    const created = await createRun(
      validated.workflow as WorkflowSpec,
      validated.digest as string,
      false,
      false
    )
    launchWorker(SOURCE_SCRIPT_PATH, created.runDir)
    const gated = await waitForRunState(
      created.runDir,
      (state) => state.status === "paused" && state.pauseCode === "gate:consume",
      6_000
    )
    const originalGate = gated.pendingGate as NonNullable<RunState["pendingGate"]>
    expect(originalGate.content).toContain("consume-v1")

    const revisedSpec = {
      ...spec,
      nodes: [
        spec.nodes[0] as CommandNode,
        {
          ...markerCommand("consume", consumeMarker, "consume-v2", ["planner"]),
          gate: "approval"
        }
      ]
    } as WorkflowSpec
    const revisedDigest = validateWorkflow(revisedSpec).digest as string
    const revisedFile = await writeRevisedFile(revisedSpec, "revised-gated.json")
    expect(await runCli(["revise", created.state.id, revisedFile], SCRIPT_PATH)).toBe(0)

    expect(
      await runCli(
        ["resume", created.state.id, "--approve-revision", revisedDigest],
        SOURCE_SCRIPT_PATH
      )
    ).toBe(0)
    const regated = await waitForRunState(
      created.runDir,
      (state) =>
        state.status === "paused" &&
        state.pauseCode === "gate:consume" &&
        state.pendingGate !== null &&
        state.pendingGate.digest !== originalGate.digest,
      6_000
    )
    const freshGate = regated.pendingGate as NonNullable<RunState["pendingGate"]>
    expect(freshGate.content).toContain("consume-v2")
    expect(freshGate.content).not.toContain("consume-v1")
    expect(regated.satisfiedGates).toEqual([])

    expect(
      await runCli(
        [
          "resume",
          created.state.id,
          "--approve-gate",
          "consume",
          "--gate-digest",
          freshGate.digest
        ],
        SOURCE_SCRIPT_PATH
      )
    ).toBe(0)
    await waitForRunState(created.runDir, (state) => state.status === "completed", 6_000)
    expect(await readFile(consumeMarker, "utf8")).toBe("consume-v2")
  })

  test("revised limits govern the resumed run without a limit override", async () => {
    const spec: WorkflowSpec = {
      ...workflow([mockAgent("a", "a result"), mockAgent("b", "b result")]),
      concurrency: 1,
      limits: {
        nodeWallTimeMinutes: null,
        workflowWallTimeMinutes: null,
        maxAgentStarts: 1,
        maxGoalRounds: null
      }
    }
    const run = await runForeground(spec)
    const paused = await readRunState(run.runDir)
    expect(paused.status).toBe("paused")
    expect(paused.pauseCode).toBe("max-agent-starts")
    expect(paused.nodes.a?.status).toBe("completed")
    expect(paused.nodes.b?.status).toBe("pending")

    const revisedSpec: WorkflowSpec = {
      ...spec,
      limits: { ...spec.limits, maxAgentStarts: 3 }
    }
    const revisedDigest = validateWorkflow(revisedSpec).digest as string
    const revisedFile = await writeRevisedFile(revisedSpec, "revised-limits.json")
    const proposed = await captureLogs(() =>
      runCli(["revise", run.runId, revisedFile], SCRIPT_PATH)
    )
    expect(proposed.logs.join("\n")).toContain("Changed workflow fields: limits")

    // No --override-limit: the revised limit itself authorizes continuing.
    expect(
      await runCli(["resume", run.runId, "--approve-revision", revisedDigest], SOURCE_SCRIPT_PATH)
    ).toBe(0)
    const completed = await waitForRunState(
      run.runDir,
      (state) => state.status === "completed",
      6_000
    )
    expect(completed.nodes.b).toMatchObject({ status: "completed", attempts: 1 })
    expect(completed.agentStarts).toBe(2)
    expect(completed.overriddenLimits).toEqual([])
  })
})

describe("worker lock", () => {
  test("takes over a worker lock naming a dead PID", async () => {
    const runDir = path.join(temporaryRoot, "lock-run")
    await mkdir(runDir, { recursive: true })
    const exited = spawnSync(process.execPath, ["--version"], { stdio: "ignore" })
    expect(exited.pid).toBeGreaterThan(0)
    await writeFile(
      path.join(runDir, "worker.lock"),
      `${JSON.stringify({ pid: exited.pid, token: "stale", kind: "worker" })}\n`
    )
    const release = await acquireWorkerLock(runDir, "fresh-token")
    const lock = JSON.parse(await readFile(path.join(runDir, "worker.lock"), "utf8")) as {
      readonly token?: string
    }
    expect(lock.token).toBe("fresh-token")
    await release()
  })

  test("waits for a live cli lock and acquires promptly after release", async () => {
    const runDir = path.join(temporaryRoot, "lock-run")
    await mkdir(runDir, { recursive: true })
    const lockPath = path.join(runDir, "worker.lock")
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, token: "holder", kind: "cli" })}\n`
    )
    let acquired = false
    const pending = acquireWorkerLock(runDir, "waiter", "cli").then((release) => {
      acquired = true
      return release
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(acquired).toBe(false)
    await rm(lockPath, { force: true })
    const release = await pending
    expect(acquired).toBe(true)
    await release()
  })

  test("concurrent contenders hold the lock one at a time", async () => {
    const runDir = path.join(temporaryRoot, "lock-run")
    await mkdir(runDir, { recursive: true })
    let holders = 0
    let maxHolders = 0
    await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const release = await acquireWorkerLock(runDir, `token-${index}`, "cli")
        holders += 1
        maxHolders = Math.max(maxHolders, holders)
        await new Promise((resolve) => setTimeout(resolve, 20))
        holders -= 1
        await release()
      })
    )
    expect(maxHolders).toBe(1)
  })
})

describe("event tailing", () => {
  test("readNewEvents defers a partial trailing line until it completes", async () => {
    const filePath = path.join(temporaryRoot, "events.jsonl")
    await writeFile(filePath, "partial")
    const first = await readNewEvents(filePath, 0)
    expect(first.lines).toEqual([])
    expect(first.position).toBe(0)
    await appendFile(filePath, " line\n")
    const second = await readNewEvents(filePath, first.position)
    expect(second.lines).toEqual(["partial line"])
    expect(second.position).toBe("partial line\n".length)
    const third = await readNewEvents(filePath, second.position)
    expect(third.lines).toEqual([])
    expect(third.position).toBe(second.position)
  })
})

describe("workflow validation output", () => {
  test("failed validation exposes no approval digest in text or JSON", async () => {
    const invalid = {
      ...workflow([mockAgent("implement", "implementation")]),
      cwd: "relative/path"
    }
    const filePath = path.join(temporaryRoot, "invalid-workflow.json")
    await writeFile(filePath, `${JSON.stringify(invalid, null, 2)}\n`)

    const textResult = await captureLogs(() => runCli(["validate", filePath], SCRIPT_PATH))
    expect(textResult.value).toBe(1)
    expect(textResult.logs.join("\n")).toContain("ERROR workflow-cwd")
    expect(textResult.logs.join("\n")).not.toContain("Digest:")

    const jsonResult = await captureLogs(() =>
      runCli(["validate", filePath, "--json"], SCRIPT_PATH)
    )
    expect(jsonResult.value).toBe(1)
    const parsed = JSON.parse(jsonResult.logs.join("\n")) as {
      readonly digest: string | null
      readonly issues: readonly { readonly code: string }[]
    }
    expect(parsed.digest).toBeNull()
    expect(parsed.issues.some((issue) => issue.code === "workflow-cwd")).toBe(true)
  })
})

describe("documentation", () => {
  test("the first documented example workflow validates against the real contract", async () => {
    const documentPath = new URL("../../references/examples.md", import.meta.url)
    const document = await readFile(documentPath, "utf8")
    const match = document.match(/```json\n([\s\S]*?)```/)
    expect(match).not.toBeNull()
    const raw = (match as RegExpMatchArray)[1]
    expect(raw).toBeDefined()
    const result = validateWorkflow(JSON.parse(raw as string))
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([])
    expect(result.workflow).not.toBeNull()
    expect(result.digest).not.toBeNull()
  })
})
