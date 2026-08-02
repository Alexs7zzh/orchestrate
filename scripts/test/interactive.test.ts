import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  AgentNode,
  ClaudeAgentNode,
  InteractiveAttemptState,
  RunState,
  SupervisorNode,
  WorkflowSpec
} from "../src/types.js"

import { runCli } from "../src/cli.js"
import { runWorker } from "../src/engine.js"
import {
  createRun,
  eventsPath,
  pauseRequestPath,
  readRunState,
  runDirectory,
  stopRequestPath
} from "../src/state.js"
import { validateWorkflow, workflowDigest } from "../src/validation.js"

process.env.ORCHESTRATE_ENABLE_MOCK_PROVIDER = "1"

const SCRIPT_PATH = "/unused-script-path"
const SOURCE_SCRIPT_PATH = new URL("../src/main.ts", import.meta.url).pathname

let temporaryRoot = ""
let shimDirectory = ""
let shimLogPath = ""
let tuiDirectory = ""
let originalPath = ""

// A fake herdr executable shaped like the real 0.7.x CLI whose `pane run`
// actually EXECUTES the passed command line in a background shell, so a fake
// `claude` TUI script exercises the real interactive loop end to end.
async function writeHerdrShim(): Promise<void> {
  const counterPath = path.join(temporaryRoot, "herdr-pane-counter")
  const agentStatusPath = path.join(temporaryRoot, "herdr-agent-status")
  const body = `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
printf '%s\\n' "$*" >> ${JSON.stringify(shimLogPath)}
case "$1 $2" in
  "workspace create") printf '%s\\n' '{"id":"t","result":{"type":"workspace_created","workspace":{"workspace_id":"w1"}}}' ;;
  "workspace get") printf '%s\\n' '{"id":"t","result":{"type":"workspace","workspace":{"workspace_id":"w1"}}}' ;;
  "tab create")
    n=$(cat ${JSON.stringify(counterPath)} 2>/dev/null || printf 0); n=$((n+1))
    printf '%s' "$n" > ${JSON.stringify(counterPath)}
    printf '{"id":"t","result":{"type":"tab_created","root_pane":{"pane_id":"w1:p%s"},"tab":{"tab_id":"w1:t%s"}}}\\n' "$n" "$n" ;;
  "pane run")
    shift 3
    ( eval "$*" ) >/dev/null 2>>${JSON.stringify(path.join(temporaryRoot, "pane-run-errors.log"))} &
    printf '%s\\n' '{"id":"t","result":{"type":"ok"}}' ;;
  "agent get")
    status=$(cat ${JSON.stringify(agentStatusPath)} 2>/dev/null || printf working)
    printf '{"id":"t","result":{"type":"agent","agent":{"status":"%s"}}}\\n' "$status" ;;
  *) printf '%s\\n' '{"id":"t","result":{"type":"ok"}}' ;;
esac
`
  await writeFile(path.join(shimDirectory, "herdr"), body)
  await chmod(path.join(shimDirectory, "herdr"), 0o755)
}

// A fake claude TUI: it receives the prompt as its final argument (the shell
// substitutes the prompt file exactly as a real pane would), extracts the
// result path and the exact node-done command from the contract text, then
// follows the per-node mode recorded by the test.
async function writeFakeClaude(): Promise<void> {
  const body = `#!/bin/sh
for argument in "$@"; do prompt="$argument"; done
resultfile=$(printf '%s\\n' "$prompt" | grep -m1 -oE '/[^ ]*/result\\.txt')
donecmd=$(printf '%s\\n' "$prompt" | grep -m1 -E 'node-done .* --token' | sed 's/^ *//; s/ --outcome completed$//')
attemptdir=$(dirname "$resultfile")
nodeid=$(basename "$(dirname "$attemptdir")")
attempt=$(basename "$attemptdir" | sed 's/attempt-//')
printf '%s' "$prompt" > "\${FAKE_TUI_DIR}/prompt-$nodeid-$attempt.txt"
printf '%s\\n' "$donecmd" > "\${FAKE_TUI_DIR}/donecmd-$nodeid-$attempt.txt"
mode=$(cat "\${FAKE_TUI_DIR}/mode-$nodeid" 2>/dev/null || printf complete)
case "$mode" in
  never-done)
    sleep 120 ;;
  fail-then-complete)
    if [ "$attempt" = "1" ]; then
      printf 'attempt %s of %s could not finish\\n' "$attempt" "$nodeid" > "$resultfile"
      eval "$donecmd --outcome failed" >> "\${FAKE_TUI_DIR}/node-done.log" 2>&1
    else
      printf 'interactive report from %s attempt %s\\n' "$nodeid" "$attempt" > "$resultfile"
      eval "$donecmd --outcome completed" >> "\${FAKE_TUI_DIR}/node-done.log" 2>&1
    fi ;;
  *)
    printf 'interactive report from %s\\n' "$nodeid" > "$resultfile"
    eval "$donecmd --outcome completed" >> "\${FAKE_TUI_DIR}/node-done.log" 2>&1 ;;
esac
`
  await writeFile(path.join(shimDirectory, "claude"), body)
  await chmod(path.join(shimDirectory, "claude"), 0o755)
}

// The contract's node-done command runs from inside the fake TUI's shell, so
// ORCHESTRATE_BIN points it at a wrapper that execs this checkout's CLI.
async function writeOrchestrateWrapper(): Promise<void> {
  const wrapperPath = path.join(shimDirectory, "orchestrate-under-test")
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SOURCE_SCRIPT_PATH)} "$@"\n`
  )
  await chmod(wrapperPath, 0o755)
  process.env.ORCHESTRATE_BIN = wrapperPath
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-interactive-test-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
  process.env.ORCHESTRATE_DISABLE_AUTO_WAKE = "1"
  originalPath = process.env.PATH ?? ""
  shimDirectory = path.join(temporaryRoot, "shim-bin")
  shimLogPath = path.join(temporaryRoot, "herdr-log.txt")
  tuiDirectory = path.join(temporaryRoot, "tui")
  await mkdir(shimDirectory)
  await mkdir(tuiDirectory)
  process.env.FAKE_TUI_DIR = tuiDirectory
  await writeHerdrShim()
  await writeFakeClaude()
  await writeOrchestrateWrapper()
  process.env.PATH = `${shimDirectory}:${originalPath}`
})

afterEach(async () => {
  process.env.PATH = originalPath
  delete process.env.ORCHESTRATE_STATE_DIR
  delete process.env.ORCHESTRATE_DISABLE_AUTO_WAKE
  delete process.env.ORCHESTRATE_BIN
  delete process.env.FAKE_TUI_DIR
  delete process.env.ORCHESTRATE_INTERACTIVE_IDLE_TICKS
  await rm(temporaryRoot, { recursive: true, force: true })
})

async function setTuiMode(nodeId: string, mode: string): Promise<void> {
  await writeFile(path.join(tuiDirectory, `mode-${nodeId}`), mode)
}

async function shimLog(): Promise<string> {
  return readFile(shimLogPath, "utf8").catch(() => "")
}

function workspace(): AgentNode["workspace"] {
  return { mode: "shared", path: null, vcs: "none", writes: [], exclusiveResources: [] }
}

function session(overrides: Partial<AgentNode["session"]> = {}): AgentNode["session"] {
  return {
    mode: "fresh",
    from: null,
    saveAs: null,
    retain: false,
    reuseOnRepeat: false,
    ...overrides
  }
}

function interactiveClaude(id: string, overrides: Partial<ClaudeAgentNode> = {}): ClaudeAgentNode {
  return {
    id,
    type: "agent",
    title: `Interactive ${id}`,
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    timeoutMinutes: null,
    retry: { maxAttempts: 1, delaySeconds: 0 },
    gate: "none",
    provider: "claude",
    model: "provider-default",
    effort: null,
    prompt: `Do the ${id} task together with the human.`,
    session: session(),
    permissions: { permissionMode: "plan", extraArgs: [], inheritEnv: [], env: {} },
    output: { format: "text", schema: null },
    interactive: true,
    ...overrides
  }
}

function mockAgent(id: string, prompt: string, overrides: Partial<AgentNode> = {}): AgentNode {
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
    permissions: { extraArgs: [], inheritEnv: [], env: {} },
    output: { format: "text", schema: null },
    interactive: false,
    ...overrides
  } as AgentNode
}

function workflow(nodes: readonly WorkflowSpec["nodes"][number][]): WorkflowSpec {
  return {
    version: 1,
    name: "interactive-test",
    objective: "Exercise interactive agent nodes.",
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

async function waitForRunState(
  runDir: string,
  predicate: (state: RunState) => boolean,
  timeoutMilliseconds = 15_000
): Promise<RunState> {
  const deadline = Date.now() + timeoutMilliseconds
  let state = await readRunState(runDir)
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    state = await readRunState(runDir)
  }
  expect(predicate(state)).toBe(true)
  return state
}

function awaitingRecord(state: RunState, nodeId: string): InteractiveAttemptState {
  const record = state.nodes[nodeId]?.interactive ?? null
  expect(record).not.toBeNull()
  return record as InteractiveAttemptState
}

async function captureStdout(action: () => Promise<number>): Promise<string> {
  const lines: string[] = []
  const original = console.log
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "))
  }
  try {
    await action()
  } finally {
    console.log = original
  }
  return lines.join("\n")
}

async function launchForeground(
  spec: WorkflowSpec,
  flags: readonly string[] = []
): Promise<{ readonly exitCode: number; readonly runId: string }> {
  const filePath = path.join(temporaryRoot, `workflow-${Math.random().toString(16).slice(2)}.json`)
  await writeFile(filePath, `${JSON.stringify(spec, null, 2)}\n`)
  const digest = validateWorkflow(spec).digest as string
  const lines: string[] = []
  const original = console.log
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "))
  }
  let exitCode: number
  try {
    exitCode = await runCli(
      ["run", filePath, "--approve", digest, "--foreground", ...flags],
      SCRIPT_PATH
    )
  } finally {
    console.log = original
  }
  const match = lines.join("\n").match(/^Run: (.+)$/m)
  expect(match).not.toBeNull()
  return { exitCode, runId: match?.[1] as string }
}

async function eventTypes(runDir: string): Promise<readonly string[]> {
  const raw = await readFile(eventsPath(runDir), "utf8")
  return raw
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { type: string }).type)
}

describe("interactive node validation", () => {
  test("rejects structured output, codex saveAs, forked saveAs, and the mock provider", () => {
    const jsonOutput = interactiveClaude("json-node", {
      output: { format: "json", schema: { type: "object" } }
    })
    const schemaOnly = interactiveClaude("schema-node", {
      output: { format: "text", schema: { type: "object" } }
    })
    const codexSave: AgentNode = {
      ...interactiveClaude("codex-save"),
      provider: "codex",
      permissions: { sandbox: "read-only", extraArgs: [], inheritEnv: [], env: {} },
      session: session({ saveAs: "impl", retain: true })
    }
    const forkSave = interactiveClaude("fork-save", {
      needs: ["json-node"],
      session: session({ mode: "fork", from: "source", saveAs: "forked", retain: true })
    })
    const source = interactiveClaude("source-node", {
      session: session({ saveAs: "source", retain: true })
    })
    const mockInteractive = mockAgent("mock-live", "mock", { interactive: true })
    const result = validateWorkflow(
      workflow([jsonOutput, schemaOnly, codexSave, source, forkSave, mockInteractive])
    )
    const codes = result.issues.map((issue) => `${issue.code}:${issue.message.split('"')[1]}`)
    expect(codes).toContain("interactive-output:json-node")
    expect(codes).toContain("interactive-output:schema-node")
    expect(codes).toContain("interactive-session:codex-save")
    expect(codes).toContain("interactive-session:fork-save")
    expect(codes).toContain("interactive-provider:mock-live")
  })

  test("preview marks interactive nodes", async () => {
    const spec = workflow([interactiveClaude("implement")])
    const filePath = path.join(temporaryRoot, "preview.json")
    await writeFile(filePath, `${JSON.stringify(spec, null, 2)}\n`)
    const lines: string[] = []
    const original = console.log
    console.log = (...parts: unknown[]) => {
      lines.push(parts.map(String).join(" "))
    }
    try {
      expect(await runCli(["preview", filePath], SCRIPT_PATH)).toBe(0)
    } finally {
      console.log = original
    }
    expect(lines.join("\n")).toContain(
      "INTERACTIVE: runs as a live TUI in herdr; human may participate"
    )
  })
})

describe("interactive node execution", () => {
  test("completes via node-done, records the pinned session, and feeds downstream nodes", async () => {
    const implement = interactiveClaude("implement", {
      session: session({ saveAs: "impl-session", retain: true })
    })
    const summarize = mockAgent("summarize", "Summarize the handoff.", {
      needs: ["implement"],
      inputs: [{ from: "implement", as: "Interactive handoff", include: "content" }]
    })
    const { exitCode, runId } = await launchForeground(workflow([implement, summarize]))
    expect(exitCode).toBe(0)
    const runDir = runDirectory(runId)
    const state = await readRunState(runDir)
    expect(state.status).toBe("completed")
    expect(state.nodes.implement?.status).toBe("completed")
    expect(state.nodes.implement?.interactive ?? null).toBeNull()

    // The downstream mock echoes its rendered prompt, so the interactive
    // node's report must appear in its result.
    const downstream = await readFile(state.nodes.summarize?.resultPath as string, "utf8")
    expect(downstream).toContain("interactive report from implement")

    // The full prompt is rendered prompt + contract; the pinned fresh session
    // id was recorded under the alias.
    const prompt = await readFile(path.join(tuiDirectory, "prompt-implement-1.txt"), "utf8")
    expect(prompt).toContain("Do the implement task together with the human.")
    expect(prompt).toContain("Orchestrate interactive-node contract")
    expect(prompt).toContain(`node-done ${runId} implement --token `)
    expect(state.sessions["impl-session"]?.sessionId).toMatch(/^[0-9a-f-]{36}$/)

    const log = await shimLog()
    expect(log).toContain("workspace create")
    expect(log).toContain("--label implement")
    expect(log).toMatch(/pane run w1:p\d+ claude --session-id/)
    expect(log).toContain("--permission-mode plan")
    // The pane stays open after node-done by design.
    expect(log).not.toContain("pane close")

    const events = await eventTypes(runDir)
    expect(events).toContain("node.interactive.started")
    expect(events).toContain("node.interactive.completed")
  })

  test("rejects a wrong token, demands the result file with its path, then accepts and rejects reuse", async () => {
    await setTuiMode("implement", "never-done")
    const spec = workflow([interactiveClaude("implement")])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    const live = await waitForRunState(
      created.runDir,
      (state) => (state.nodes.implement?.interactive?.paneId ?? null) !== null
    )
    const record = awaitingRecord(live, "implement")

    await expect(
      runCli(
        ["node-done", live.id, "implement", "--token", "0".repeat(64), "--outcome", "completed"],
        SCRIPT_PATH
      )
    ).rejects.toThrow("does not match")

    const resultPath = path.join(created.runDir, "nodes", "implement", "attempt-1", "result.txt")
    await expect(
      runCli(
        ["node-done", live.id, "implement", "--token", record.token, "--outcome", "completed"],
        SCRIPT_PATH
      )
    ).rejects.toThrow(`Write the result report first: ${resultPath}`)

    await writeFile(resultPath, "manual interactive report\n")
    expect(
      await runCli(
        ["node-done", live.id, "implement", "--token", record.token, "--outcome", "completed"],
        SCRIPT_PATH
      )
    ).toBe(0)
    await running
    const settled = await readRunState(created.runDir)
    expect(settled.status).toBe("completed")

    // Reusing the token after settlement is rejected: the node no longer
    // awaits an interactive completion.
    await expect(
      runCli(
        ["node-done", live.id, "implement", "--token", record.token, "--outcome", "completed"],
        SCRIPT_PATH
      )
    ).rejects.toThrow("not awaiting an interactive completion")
  })

  test("--outcome failed retries with a fresh token and tab, then completes", async () => {
    await setTuiMode("implement", "fail-then-complete")
    const { exitCode, runId } = await launchForeground(
      workflow([interactiveClaude("implement", { retry: { maxAttempts: 2, delaySeconds: 0 } })])
    )
    expect(exitCode).toBe(0)
    const runDir = runDirectory(runId)
    const state = await readRunState(runDir)
    expect(state.status).toBe("completed")
    expect(state.nodes.implement?.attempts).toBe(2)

    const firstCommand = await readFile(path.join(tuiDirectory, "donecmd-implement-1.txt"), "utf8")
    const secondCommand = await readFile(path.join(tuiDirectory, "donecmd-implement-2.txt"), "utf8")
    const firstToken = firstCommand.match(/--token ([0-9a-f]+)/)?.[1]
    const secondToken = secondCommand.match(/--token ([0-9a-f]+)/)?.[1]
    expect(firstToken).toMatch(/^[0-9a-f]{64}$/)
    expect(secondToken).toMatch(/^[0-9a-f]{64}$/)
    expect(firstToken).not.toBe(secondToken)

    const log = await shimLog()
    expect(log).toContain("--label implement ")
    expect(log).toContain("--label implement #2")
    const events = await eventTypes(runDir)
    expect(events).toContain("node.interactive.failed")
    expect(events).toContain("node.retrying")
    expect(events).toContain("node.interactive.completed")
  })

  test("a node timeout closes the pane best-effort and fails the attempt", async () => {
    await setTuiMode("implement", "never-done")
    const { exitCode, runId } = await launchForeground(
      workflow([interactiveClaude("implement", { timeoutMinutes: 0.02 })])
    )
    expect(exitCode).toBe(1)
    const state = await readRunState(runDirectory(runId))
    expect(state.status).toBe("failed")
    expect(state.nodes.implement?.status).toBe("failed")
    expect(state.nodes.implement?.error).toContain("timed out")
    expect(state.nodes.implement?.interactive ?? null).toBeNull()
    expect(await shimLog()).toMatch(/pane close w1:p\d+/)
  })

  test("stop closes the pane and cancels the interactive node", async () => {
    await setTuiMode("implement", "never-done")
    const spec = workflow([interactiveClaude("implement")])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    const live = await waitForRunState(
      created.runDir,
      (state) => (state.nodes.implement?.interactive?.paneId ?? null) !== null
    )
    await writeFile(
      stopRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: live.workerToken })}\n`,
      { mode: 0o600 }
    )
    await running
    const stopped = await readRunState(created.runDir)
    expect(stopped.status).toBe("stopped")
    expect(stopped.nodes.implement?.status).toBe("cancelled")
    expect(await shimLog()).toMatch(/pane close w1:p\d+/)
  })

  test("pause waits on the interactive node, names it, and settles after node-done", async () => {
    await setTuiMode("implement", "never-done")
    const spec = {
      ...workflow([
        interactiveClaude("implement"),
        mockAgent("follow-up", "later", { needs: ["implement"] })
      ]),
      concurrency: 1
    }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    let live = await waitForRunState(
      created.runDir,
      (state) => (state.nodes.implement?.interactive?.paneId ?? null) !== null
    )
    await writeFile(
      pauseRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: live.workerToken })}\n`,
      { mode: 0o600 }
    )
    live = await waitForRunState(created.runDir, (state) => state.status === "pausing")
    expect(live.pauseReason).toContain("waiting on interactive nodes: implement")
    // The interactive node keeps running through the drain.
    expect(live.nodes.implement?.status).toBe("running")

    const record = awaitingRecord(live, "implement")
    const resultPath = path.join(created.runDir, "nodes", "implement", "attempt-1", "result.txt")
    await writeFile(resultPath, "finished during pause drain\n")
    expect(
      await runCli(
        ["node-done", live.id, "implement", "--token", record.token, "--outcome", "completed"],
        SCRIPT_PATH
      )
    ).toBe(0)
    await running
    const paused = await readRunState(created.runDir)
    expect(paused.status).toBe("paused")
    expect(paused.nodes.implement?.status).toBe("completed")
    expect(paused.nodes["follow-up"]?.status).toBe("pending")
  })

  test("report and status surface the awaiting-interactive entry with the exact node-done command", async () => {
    await setTuiMode("implement", "never-done")
    const spec = workflow([interactiveClaude("implement")])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    const live = await waitForRunState(
      created.runDir,
      (state) => (state.nodes.implement?.interactive?.paneId ?? null) !== null
    )
    const record = awaitingRecord(live, "implement")

    const reportJson = await captureStdout(() => runCli(["report", live.id, "--json"], SCRIPT_PATH))
    const statusText = await captureStdout(() => runCli(["status", live.id], SCRIPT_PATH))
    const report = JSON.parse(reportJson) as {
      needsAttention: readonly {
        kind: string
        summary: string
        detail: string | null
        resumeCommand: string | null
      }[]
    }
    const attention = report.needsAttention.find((item) => item.kind === "awaiting-interactive")
    expect(attention).toBeDefined()
    expect(attention?.summary).toContain(record.paneId ?? "")
    expect(attention?.resumeCommand).toBe(
      `orchestrate node-done ${live.id} implement --token ${record.token} --outcome completed`
    )
    expect(attention?.detail).toContain("result.txt")
    expect(statusText).toContain(`Awaiting interactive node "implement"`)
    expect(statusText).toContain(record.token)

    const resultPath = path.join(created.runDir, "nodes", "implement", "attempt-1", "result.txt")
    await writeFile(resultPath, "report-driven completion\n")
    expect(
      await runCli(
        ["node-done", live.id, "implement", "--token", record.token, "--outcome", "completed"],
        SCRIPT_PATH
      )
    ).toBe(0)
    await running
  })

  test("an idle-looking pane journals one nudge per continuous idle period", async () => {
    process.env.ORCHESTRATE_INTERACTIVE_IDLE_TICKS = "2"
    await setTuiMode("implement", "never-done")
    await writeFile(path.join(temporaryRoot, "herdr-agent-status"), "idle")
    const spec = workflow([interactiveClaude("implement")])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    const live = await waitForRunState(
      created.runDir,
      (state) => (state.nodes.implement?.interactive?.idleSince ?? null) !== null
    )
    const record = awaitingRecord(live, "implement")
    expect(record.idleSince).not.toBeNull()
    // Give further idle polls a chance to (incorrectly) duplicate the event.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    const events = await eventTypes(created.runDir)
    expect(events.filter((type) => type === "node.interactive.idle")).toHaveLength(1)

    const resultPath = path.join(created.runDir, "nodes", "implement", "attempt-1", "result.txt")
    await writeFile(resultPath, "completed after idle nudge\n")
    expect(
      await runCli(
        ["node-done", live.id, "implement", "--token", record.token, "--outcome", "completed"],
        SCRIPT_PATH
      )
    ).toBe(0)
    await running
    expect((await readRunState(created.runDir)).status).toBe("completed")
  })

  test("gate and interactive compose: approval binds the rendered prompt without the contract", async () => {
    const spec = workflow([interactiveClaude("implement", { gate: "approval" })])
    const { exitCode, runId } = await launchForeground(spec)
    expect(exitCode).toBe(1)
    const runDir = runDirectory(runId)
    const paused = await readRunState(runDir)
    expect(paused.status).toBe("paused")
    const gate = paused.pendingGate as NonNullable<RunState["pendingGate"]>
    expect(gate.nodeId).toBe("implement")
    expect(gate.content).toContain("Do the implement task together with the human.")
    // The done contract and its token are runtime plumbing, never gate content.
    expect(gate.content).not.toContain("node-done")

    expect(
      await runCli(
        ["resume", runId, "--approve-gate", "implement", "--gate-digest", gate.digest],
        SOURCE_SCRIPT_PATH
      )
    ).toBe(0)
    const settled = await waitForRunState(runDir, (state) => state.status === "completed", 20_000)
    expect(settled.nodes.implement?.status).toBe("completed")
    expect(await shimLog()).toMatch(/pane run w1:p\d+ claude --session-id/)
  }, 30_000)

  test("launching without herdr fails cleanly before creating a run", async () => {
    await rm(path.join(shimDirectory, "herdr"))
    // Only the shim directory: a real herdr elsewhere on PATH must not leak in.
    process.env.PATH = shimDirectory
    const spec = workflow([interactiveClaude("implement")])
    const filePath = path.join(temporaryRoot, "workflow.json")
    await writeFile(filePath, `${JSON.stringify(spec, null, 2)}\n`)
    const digest = validateWorkflow(spec).digest as string
    await expect(
      runCli(["run", filePath, "--approve", digest, "--foreground"], SCRIPT_PATH)
    ).rejects.toThrow("herdr CLI is required")
    const runs = await readdir(path.join(temporaryRoot, "state", "runs")).catch(() => [])
    expect(runs).toEqual([])
  })

  test("resuming a run with a pending interactive node requires herdr", async () => {
    const spec = workflow([interactiveClaude("implement", { gate: "approval" })])
    const { exitCode, runId } = await launchForeground(spec)
    expect(exitCode).toBe(1) // paused at the gate; the interactive node is still pending
    const paused = await readRunState(runDirectory(runId))
    const gate = paused.pendingGate as NonNullable<RunState["pendingGate"]>
    await rm(path.join(shimDirectory, "herdr"))
    // Only the shim directory: a real herdr elsewhere on PATH must not leak in.
    process.env.PATH = shimDirectory
    await expect(
      runCli(
        ["resume", runId, "--approve-gate", "implement", "--gate-digest", gate.digest],
        SOURCE_SCRIPT_PATH
      )
    ).rejects.toThrow("herdr CLI is required")
  })

  test("a supervisor patch that adds an interactive node is rejected outright", async () => {
    const seed = mockAgent("seed", "seed result")
    const decision = {
      status: "continue" as const,
      reason: "Add a human-attended fixer.",
      addNodes: [interactiveClaude("live-fix")]
    }
    const supervise: SupervisorNode = {
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
      prompt: JSON.stringify([decision]),
      session: session({ saveAs: "supervisor", retain: true, reuseOnRepeat: true }),
      permissions: { extraArgs: [], inheritEnv: [], env: {} },
      goal: "Finish the test.",
      envelope: {
        providers: ["mock", "claude"],
        models: ["*"],
        nodeTypes: ["agent"],
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
        claudePermissionModes: ["acceptEdits"],
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
        maxRounds: null,
        maxWallTimeMinutes: null
      }
    }
    const spec = workflow([seed, supervise])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)
    expect(state.status).toBe("paused")
    expect(state.pauseCode).toBe("invalid-patch:supervise")
    expect(state.pauseReason).toContain('interactive node "live-fix"')
    expect(state.pauseReason).toContain("cannot be approved")
    // Hard rejection: nothing was staged for --approve-patch.
    expect(state.pendingPatch).toBeNull()
    expect(state.dynamicNodes).toEqual([])
  })
})
