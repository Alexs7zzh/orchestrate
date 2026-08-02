import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const BUNDLE_PATH = new URL("../orchestrate.mjs", import.meta.url).pathname
const CONTRACT_ROOT = new URL("./contracts/", import.meta.url)

interface MutableWorkflow extends Record<string, unknown> {
  cwd: unknown
  heartbeat: { callback: unknown }
  nodes: Array<{
    provider?: string
    workspace: {
      mode: string
      path: unknown
      vcs?: string
      git?: {
        branch: string
        startPoint: string
        removeOnClean: boolean
      }
      writes: string[]
      exclusiveResources: string[]
    }
    session?: { saveAs: string | null }
    permissions?: {
      sandbox?: string
      permissionMode?: string
      extraArgs: string[]
      inheritEnv: string[]
      env: Record<string, string>
    }
  }>
}

interface CliResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

interface ValidationJson {
  readonly workflow: unknown
  readonly digest: string | null
  readonly issues: readonly {
    readonly severity: "error" | "warning"
    readonly code: string
    readonly message: string
    readonly nodes?: readonly string[]
  }[]
}

type SecretWorkflow = MutableWorkflow & {
  heartbeat: {
    callback: { headers: Record<string, string> }
  }
  nodes: [
    MutableWorkflow["nodes"][number] & { env: Record<string, string> },
    MutableWorkflow["nodes"][number] & {
      permissions: NonNullable<MutableWorkflow["nodes"][number]["permissions"]>
      envelope: {
        allowedCommandEnv: Array<Record<string, string>>
        allowedProviderEnv: Array<Record<string, string>>
      }
    }
  ]
}

let temporaryRoot = ""
let workflowSequence = 0

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-contract-test-"))
  await mkdir(path.join(temporaryRoot, "home"))
  await mkdir(path.join(temporaryRoot, "tmp"))
  const fakeBin = path.join(temporaryRoot, "fake-bin")
  const fakePs = path.join(fakeBin, "ps")
  await mkdir(fakeBin)
  await writeFile(
    fakePs,
    `#!/bin/sh\nfor run in "$ORCHESTRATE_STATE_DIR"/runs/*; do\n  if [ -f "$run/state.json" ] && grep -Eq '"status": "(starting|running|pausing|stopping)"' "$run/state.json"; then\n    printf '__worker %s\\n' "$run"\n    exit 0\n  fi\ndone\nexit 1\n`
  )
  await chmod(fakePs, 0o755)
  workflowSequence = 0
})

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true })
})

async function loadFixture<T = MutableWorkflow>(name: string): Promise<T> {
  const raw = await readFile(new URL(name, CONTRACT_ROOT), "utf8")
  return JSON.parse(raw) as T
}

async function runPackagedCli(
  workflow: unknown,
  command: "validate" | "preview" = "validate",
  flags: readonly string[] = []
): Promise<CliResult> {
  workflowSequence += 1
  const workflowPath = path.join(temporaryRoot, `workflow-${workflowSequence}.json`)
  await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`)
  const environment = contractEnvironment()
  const result = spawnSync("node", [BUNDLE_PATH, command, workflowPath, ...flags], {
    encoding: "utf8",
    env: environment,
    timeout: 10_000,
    maxBuffer: 1_000_000
  })
  if (result.error !== undefined) {
    throw result.error
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

function contractEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: `${path.join(temporaryRoot, "fake-bin")}:${process.env.PATH ?? ""}`,
    HOME: path.join(temporaryRoot, "home"),
    TMPDIR: path.join(temporaryRoot, "tmp"),
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    ORCHESTRATE_DISABLE_PREFS: "1",
    ORCHESTRATE_STATE_DIR: path.join(temporaryRoot, "state")
  }
}

function runPackagedCommand(args: readonly string[]): CliResult {
  const result = spawnSync("node", [BUNDLE_PATH, ...args], {
    encoding: "utf8",
    env: contractEnvironment(),
    timeout: 10_000,
    maxBuffer: 1_000_000
  })
  if (result.error !== undefined) {
    throw result.error
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

async function waitForPackagedState(
  runId: string,
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMilliseconds = 6_000
): Promise<Record<string, unknown>> {
  const statePath = path.join(temporaryRoot, "state", "runs", runId, "state.json")
  const deadline = Date.now() + timeoutMilliseconds
  let state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>
  }
  expect(predicate(state)).toBe(true)
  return state
}

function packagedLifecycleWorkflow(firstDelayMilliseconds: number): Record<string, unknown> {
  const firstMarker = path.join(temporaryRoot, `first-${workflowSequence}.marker`)
  const secondMarker = path.join(temporaryRoot, `second-${workflowSequence}.marker`)
  const common = {
    type: "command",
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
    timeoutMinutes: null,
    retry: { maxAttempts: 1, delaySeconds: 0 },
    gate: "none",
    mutates: false,
    inheritEnv: [],
    env: {},
    allowedExitCodes: [0]
  }
  return {
    version: 1,
    name: "packaged-pause-contract",
    objective: "Exercise packaged pause, resume, and stop.",
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
    nodes: [
      {
        ...common,
        id: "first",
        title: "First",
        argv: [
          process.execPath,
          "-e",
          `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(firstMarker)},"done"),${firstDelayMilliseconds})`
        ]
      },
      {
        ...common,
        id: "second",
        title: "Second",
        argv: [
          process.execPath,
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(secondMarker)},"done")`
        ]
      }
    ]
  }
}

async function launchPackagedWorkflow(
  workflow: Record<string, unknown>,
  flags: readonly string[] = []
): Promise<string> {
  workflowSequence += 1
  const workflowFile = path.join(temporaryRoot, `lifecycle-${workflowSequence}.json`)
  await writeFile(workflowFile, `${JSON.stringify(workflow, null, 2)}\n`)
  const validation = runPackagedCommand(["validate", workflowFile, "--json"])
  expect(validation.status).toBe(0)
  const digest = (JSON.parse(validation.stdout) as { digest: string }).digest
  const launched = runPackagedCommand(["run", workflowFile, "--approve", digest, ...flags])
  expect(launched.status).toBe(0)
  const match = launched.stdout.match(/^Run: (.+)$/m)
  expect(match).not.toBeNull()
  return match?.[1] as string
}

// A fake herdr on the contract PATH that records argv lines and answers with
// canned herdr-0.7-shaped JSON; contract tests never require a real herdr.
async function installFakeHerdr(): Promise<string> {
  const logPath = path.join(temporaryRoot, "herdr-log.txt")
  const shimPath = path.join(temporaryRoot, "fake-bin", "herdr")
  await writeFile(
    shimPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
case "$1 $2" in
  "workspace create") printf '%s\\n' '{"id":"t","result":{"type":"workspace_created","workspace":{"workspace_id":"w7"},"root_pane":{"pane_id":"w7:p1"},"tab":{"tab_id":"w7:t1"}}}' ;;
  "tab create") printf '%s\\n' '{"id":"t","result":{"type":"tab_created","root_pane":{"pane_id":"w7:p2"},"tab":{"tab_id":"w7:t2"}}}' ;;
  *) printf '%s\\n' '{"id":"t","result":{"type":"ok"}}' ;;
esac
`
  )
  await chmod(shimPath, 0o755)
  return logPath
}

function expectSuccessfulValidation(result: CliResult): void {
  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toContain("Digest:")
  expect(result.stdout).toMatch(/Digest: [a-f0-9]{64}/)
}

function validationJson(result: CliResult): ValidationJson {
  expect(result.stderr).toBe("")
  return JSON.parse(result.stdout) as ValidationJson
}

function expectSuccessfulJsonValidation(result: CliResult): ValidationJson {
  expect(result.status).toBe(0)
  const parsed = validationJson(result)
  expect(parsed.workflow).not.toBeNull()
  expect(parsed.issues).toEqual([])
  expect(parsed.digest).toMatch(/^[a-f0-9]{64}$/)
  return parsed
}

describe("packaged public workflow contract", () => {
  test("runs the installed entrypoint directly under its Node shebang", () => {
    const result = spawnSync(BUNDLE_PATH, ["--help"], {
      encoding: "utf8",
      env: contractEnvironment(),
      timeout: 10_000,
      maxBuffer: 1_000_000
    })
    if (result.error !== undefined) {
      throw result.error
    }
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("orchestrate pause <run-id>")
    expect(result.stdout).toContain("orchestrate wait <run-id>")
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("orchestrate validate <workflow.json>")
  })

  test("pauses a packaged run at a boundary and resumes without replaying completed work", async () => {
    const runId = await launchPackagedWorkflow(packagedLifecycleWorkflow(900))
    await waitForPackagedState(
      runId,
      (state) => (state.nodes as Record<string, { status: string }>).first?.status === "running"
    )
    const pausedRequest = runPackagedCommand(["pause", runId])
    expect(pausedRequest.status).toBe(0)
    expect(pausedRequest.stdout).toContain("Pause requested")
    const paused = await waitForPackagedState(runId, (state) => state.status === "paused")
    const pausedNodes = paused.nodes as Record<string, { status: string; attempts: number }>
    expect(pausedNodes.first).toMatchObject({ status: "completed", attempts: 1 })
    expect(pausedNodes.second).toMatchObject({ status: "pending", attempts: 0 })

    expect(runPackagedCommand(["status", runId]).status).toBe(2)
    expect(runPackagedCommand(["watch", runId, "--once"]).status).toBe(2)
    expect(runPackagedCommand(["wait", runId, "--json"]).status).toBe(2)
    const resumed = runPackagedCommand(["resume", runId])
    expect(resumed.status).toBe(0)
    const completed = await waitForPackagedState(runId, (state) => state.status === "completed")
    const completedNodes = completed.nodes as Record<string, { status: string; attempts: number }>
    expect(completedNodes.first).toMatchObject({ status: "completed", attempts: 1 })
    expect(completedNodes.second).toMatchObject({ status: "completed", attempts: 1 })
    const waited = runPackagedCommand(["wait", runId, "--json"])
    expect(waited.status).toBe(0)
    expect((JSON.parse(waited.stdout) as { status: string }).status).toBe("completed")
  })

  test("renders a packaged report with status exit codes and a stable JSON shape", async () => {
    const runId = await launchPackagedWorkflow(packagedLifecycleWorkflow(900))
    await waitForPackagedState(
      runId,
      (state) => (state.nodes as Record<string, { status: string }>).first?.status === "running"
    )
    expect(runPackagedCommand(["pause", runId]).status).toBe(0)
    await waitForPackagedState(runId, (state) => state.status === "paused")

    const pausedReport = runPackagedCommand(["report", runId])
    expect(pausedReport.status).toBe(2)
    expect(pausedReport.stdout).toContain(`Run: ${runId}`)
    expect(pausedReport.stdout).toContain("Needs attention:")
    expect(pausedReport.stdout).toContain(`Resume: orchestrate resume ${runId}`)

    expect(runPackagedCommand(["resume", runId]).status).toBe(0)
    await waitForPackagedState(runId, (state) => state.status === "completed")
    const report = runPackagedCommand(["report", runId])
    expect(report.status).toBe(0)
    expect(report.stdout).toContain("Status: completed")
    expect(report.stdout).toContain("  completed:")
    expect(report.stdout).toContain(`Follow up: orchestrate watch ${runId}`)

    const jsonReport = runPackagedCommand(["report", runId, "--json"])
    expect(jsonReport.status).toBe(0)
    const parsed = JSON.parse(jsonReport.stdout) as {
      run: { id: string; status: string }
      needsAttention: unknown[]
      nodes: readonly { id: string; status: string; resultPath: string | null }[]
      supervisorRounds: unknown[]
    }
    expect(Object.keys(parsed)).toEqual(["run", "needsAttention", "nodes", "supervisorRounds"])
    expect(parsed.run).toMatchObject({ id: runId, status: "completed" })
    expect(parsed.needsAttention).toEqual([])
    expect(parsed.supervisorRounds).toEqual([])
    expect(parsed.nodes.map((node) => node.id)).toEqual(["first", "second"])
    expect(parsed.nodes[0]?.status).toBe("completed")
    expect(parsed.nodes[0]?.resultPath).toContain("result.txt")
  })

  test("gates a packaged node before it starts and runs it only after digest-bound approval", async () => {
    const workflow = packagedLifecycleWorkflow(10) as {
      nodes: Array<Record<string, unknown>>
    }
    workflow.nodes[1]!.needs = ["first"]
    workflow.nodes[1]!.inputs = [{ from: "first", as: "First result", include: "content" }]
    workflow.nodes[1]!.gate = "approval"
    const runId = await launchPackagedWorkflow(workflow)
    const paused = await waitForPackagedState(
      runId,
      (state) => state.status === "paused" && state.pauseCode === "gate:second"
    )
    const pausedNodes = paused.nodes as Record<string, { status: string; attempts: number }>
    expect(pausedNodes.first).toMatchObject({ status: "completed", attempts: 1 })
    expect(pausedNodes.second).toMatchObject({ status: "pending", attempts: 0 })
    const gate = paused.pendingGate as { nodeId: string; content: string; digest: string }
    expect(gate.nodeId).toBe("second")
    expect(gate.content).toContain('"argv"')
    expect(gate.digest).toMatch(/^[a-f0-9]{64}$/)

    expect(runPackagedCommand(["status", runId]).status).toBe(2)
    const report = runPackagedCommand(["report", runId])
    expect(report.status).toBe(2)
    expect(report.stdout).toContain('Node "second" ("Second") is gated')
    expect(report.stdout).toContain(`Digest: ${gate.digest}`)
    expect(report.stdout).toContain(
      `Approve: orchestrate resume ${runId} --approve-gate second --gate-digest ${gate.digest}`
    )

    const unapproved = runPackagedCommand(["resume", runId])
    expect(unapproved.status).toBe(1)
    expect(unapproved.stderr).toContain('gated before node "second"')
    const stale = runPackagedCommand([
      "resume",
      runId,
      "--approve-gate",
      "second",
      "--gate-digest",
      "0".repeat(64)
    ])
    expect(stale.status).toBe(1)
    expect(stale.stderr).toContain("Gate approval is stale")

    const approved = runPackagedCommand([
      "resume",
      runId,
      "--approve-gate",
      "second",
      "--gate-digest",
      gate.digest
    ])
    expect(approved.status).toBe(0)
    const completed = await waitForPackagedState(runId, (state) => state.status === "completed")
    const completedNodes = completed.nodes as Record<string, { status: string; attempts: number }>
    expect(completedNodes.second).toMatchObject({ status: "completed", attempts: 1 })
    expect(completed.pendingGate).toBeNull()
    expect(completed.satisfiedGates).toEqual(["second"])
  })

  test("revises a paused packaged run only after digest-bound approval", async () => {
    const runId = await launchPackagedWorkflow(packagedLifecycleWorkflow(900))
    await waitForPackagedState(
      runId,
      (state) => (state.nodes as Record<string, { status: string }>).first?.status === "running"
    )
    expect(runPackagedCommand(["pause", runId]).status).toBe(0)
    await waitForPackagedState(runId, (state) => state.status === "paused")

    const runDir = path.join(temporaryRoot, "state", "runs", runId)
    const stored = JSON.parse(await readFile(path.join(runDir, "workflow.json"), "utf8")) as {
      nodes: Array<Record<string, unknown>>
    }
    const revisedMarker = path.join(temporaryRoot, "contract-revised.marker")
    const addedMarker = path.join(temporaryRoot, "contract-added.marker")
    stored.nodes[1]!.argv = [
      process.execPath,
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(revisedMarker)},"revised")`
    ]
    stored.nodes.push({
      ...stored.nodes[1],
      id: "added",
      title: "Added",
      needs: ["second"],
      argv: [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(addedMarker)},"added")`
      ]
    })
    const revisedFile = path.join(temporaryRoot, "contract-revised-workflow.json")
    await writeFile(revisedFile, `${JSON.stringify(stored, null, 2)}\n`)

    const proposed = runPackagedCommand(["revise", runId, revisedFile])
    expect(proposed.status).toBe(0)
    expect(proposed.stdout).toContain("Modified nodes: second")
    expect(proposed.stdout).toContain("Added nodes: added")
    const digest = proposed.stdout.match(/^Revision digest: ([a-f0-9]{64})$/m)?.[1] ?? ""
    expect(digest).toMatch(/^[a-f0-9]{64}$/)

    const refused = runPackagedCommand(["resume", runId])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(`--approve-revision ${digest}`)

    const approved = runPackagedCommand(["resume", runId, "--approve-revision", digest])
    expect(approved.status).toBe(0)
    const completed = await waitForPackagedState(runId, (state) => state.status === "completed")
    const nodes = completed.nodes as Record<string, { status: string; attempts: number }>
    expect(nodes.first).toMatchObject({ status: "completed", attempts: 1 })
    expect(nodes.second).toMatchObject({ status: "completed", attempts: 1 })
    expect(nodes.added).toMatchObject({ status: "completed", attempts: 1 })
    expect(completed.digest).toBe(digest)
    expect(await readFile(revisedMarker, "utf8")).toBe("revised")
    expect(await readFile(addedMarker, "utf8")).toBe("added")
    expect(
      JSON.parse(await readFile(path.join(runDir, "revisions", "1-workflow.json"), "utf8"))
    ).toMatchObject({ name: "packaged-pause-contract" })
    expect(await readFile(path.join(runDir, "events.jsonl"), "utf8")).toContain("run.revised")
  })

  test("keeps packaged stop terminal and non-resumable", async () => {
    const runId = await launchPackagedWorkflow(packagedLifecycleWorkflow(5_000))
    await waitForPackagedState(
      runId,
      (state) => (state.nodes as Record<string, { status: string }>).first?.status === "running"
    )
    expect(runPackagedCommand(["stop", runId]).status).toBe(0)
    const stopped = await waitForPackagedState(runId, (state) => state.status === "stopped")
    expect(stopped.status).toBe("stopped")
    const resume = runPackagedCommand(["resume", runId])
    expect(resume.status).toBe(1)
    expect(resume.stderr).toContain("Only paused runs can resume normally")
  })

  test("mirrors a packaged run into a fake herdr without touching the outcome", async () => {
    const logPath = await installFakeHerdr()
    const runId = await launchPackagedWorkflow(packagedLifecycleWorkflow(10), ["--mirror"])
    const completed = await waitForPackagedState(runId, (state) => state.status === "completed")
    expect(completed.mirror).toBe("herdr")
    const nodes = completed.nodes as Record<string, { status: string }>
    expect(nodes.first?.status).toBe("completed")
    expect(nodes.second?.status).toBe("completed")

    const deadline = Date.now() + 5_000
    let log = ""
    while (Date.now() < deadline) {
      log = await readFile(logPath, "utf8").catch(() => "")
      if (log.includes("tail -n +1 -F") && log.includes("--label second")) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(log).toContain(`--label packaged-pause-contract ${runId}`)
    expect(log).toContain("--label status")
    expect(log).toContain(`watch ${runId}`)
    expect(log).toContain("--label first")
    expect(log).toContain("--label second")
    expect(log).toContain("tail -n +1 -F")
  })

  test("runs a packaged interactive node end to end via the node-done contract", async () => {
    const logPath = path.join(temporaryRoot, "herdr-log.txt")
    const fakeBin = path.join(temporaryRoot, "fake-bin")
    const tuiDirectory = path.join(temporaryRoot, "tui")
    await mkdir(tuiDirectory)
    const counterPath = path.join(temporaryRoot, "herdr-pane-counter")
    // An executing fake herdr: `pane run` runs the typed command line in a
    // background shell, exactly like a real pane's shell would.
    await writeFile(
      path.join(fakeBin, "herdr"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
case "$1 $2" in
  "workspace create") printf '%s\\n' '{"id":"t","result":{"type":"workspace_created","workspace":{"workspace_id":"w9"}}}' ;;
  "workspace get") printf '%s\\n' '{"id":"t","result":{"type":"workspace","workspace":{"workspace_id":"w9"}}}' ;;
  "tab create")
    n=$(cat ${JSON.stringify(counterPath)} 2>/dev/null || printf 0); n=$((n+1))
    printf '%s' "$n" > ${JSON.stringify(counterPath)}
    printf '{"id":"t","result":{"type":"tab_created","root_pane":{"pane_id":"w9:p%s"},"tab":{"tab_id":"w9:t%s"}}}\\n' "$n" "$n" ;;
  "pane run")
    shift 3
    ( eval "$*" ) >/dev/null 2>>${JSON.stringify(path.join(temporaryRoot, "pane-run-errors.log"))} &
    printf '%s\\n' '{"id":"t","result":{"type":"ok"}}' ;;
  *) printf '%s\\n' '{"id":"t","result":{"type":"ok"}}' ;;
esac
`
    )
    await chmod(path.join(fakeBin, "herdr"), 0o755)
    // A fake claude TUI that follows the prompt contract: write the report,
    // then run the exact node-done command extracted from the contract text.
    await writeFile(
      path.join(fakeBin, "claude"),
      `#!/bin/sh
for argument in "$@"; do prompt="$argument"; done
resultfile=$(printf '%s\\n' "$prompt" | grep -m1 -oE '/[^ ]*/result\\.txt')
donecmd=$(printf '%s\\n' "$prompt" | grep -m1 -E 'node-done .* --token' | sed 's/^ *//; s/ --outcome completed$//')
printf 'interactive report from the packaged TUI\\n' > "$resultfile"
eval "$donecmd --outcome completed" >> ${JSON.stringify(path.join(tuiDirectory, "node-done.log"))} 2>&1
`
    )
    await chmod(path.join(fakeBin, "claude"), 0o755)
    const wrapperPath = path.join(fakeBin, "orchestrate-under-test")
    await writeFile(wrapperPath, `#!/bin/sh\nexec node ${JSON.stringify(BUNDLE_PATH)} "$@"\n`)
    await chmod(wrapperPath, 0o755)

    const interactiveWorkflow = {
      version: 1,
      name: "packaged-interactive-contract",
      objective: "Exercise the packaged interactive node loop.",
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
      nodes: [
        {
          id: "implement",
          type: "agent",
          title: "Co-driven implementation",
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
          timeoutMinutes: null,
          retry: { maxAttempts: 1, delaySeconds: 0 },
          gate: "none",
          provider: "claude",
          model: "provider-default",
          effort: null,
          prompt: "Implement the change together with the human.",
          session: { mode: "fresh", from: null, saveAs: null, retain: false, reuseOnRepeat: false },
          permissions: { permissionMode: "plan", extraArgs: [], inheritEnv: [], env: {} },
          output: { format: "text", schema: null },
          interactive: true
        }
      ]
    }
    workflowSequence += 1
    const workflowFile = path.join(temporaryRoot, `interactive-${workflowSequence}.json`)
    await writeFile(workflowFile, `${JSON.stringify(interactiveWorkflow, null, 2)}\n`)
    const validation = runPackagedCommand(["validate", workflowFile, "--json"])
    expect(validation.status).toBe(0)
    const digest = (JSON.parse(validation.stdout) as { digest: string }).digest

    const environment = {
      ...contractEnvironment(),
      ORCHESTRATE_BIN: wrapperPath,
      FAKE_TUI_DIR: tuiDirectory
    }
    const launched = spawnSync(
      "node",
      [BUNDLE_PATH, "run", workflowFile, "--approve", digest, "--foreground"],
      { encoding: "utf8", env: environment, timeout: 30_000, maxBuffer: 1_000_000 }
    )
    if (launched.error !== undefined) {
      throw launched.error
    }
    expect(launched.stderr).toBe("")
    expect(launched.status).toBe(0)
    const runId = launched.stdout.match(/^Run: (.+)$/m)?.[1] as string
    const settled = await waitForPackagedState(runId, (state) => state.status === "completed")
    const nodes = settled.nodes as Record<string, { status: string }>
    expect(nodes.implement?.status).toBe("completed")

    const result = runPackagedCommand(["result", runId, "implement"])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("interactive report from the packaged TUI")

    const log = await readFile(logPath, "utf8")
    expect(log).toContain("workspace create")
    expect(log).toContain("--label implement")
    expect(log).toMatch(/pane run w9:p\d+ claude --session-id/)
  }, 40_000)

  test("delivers a settled run through the packaged session wake hook exactly once", async () => {
    const runId = await launchPackagedWorkflow(packagedLifecycleWorkflow(10))
    await waitForPackagedState(runId, (state) => state.status === "completed")
    const registered = runPackagedCommand([
      "wake",
      runId,
      "--harness",
      "codex",
      "--session",
      "contract-session"
    ])
    expect(registered.status).toBe(0)

    const invokeHook = (payload: Record<string, unknown>, extraArgs: readonly string[] = []) =>
      spawnSync("node", [BUNDLE_PATH, "__wake-hook", "codex", ...extraArgs], {
        encoding: "utf8",
        env: contractEnvironment(),
        input: `${JSON.stringify(payload)}\n`,
        timeout: 10_000,
        maxBuffer: 1_000_000
      })
    const first = invokeHook({ session_id: "contract-session" })
    expect(first.status).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining(`run ${runId} reached completed`)
    })
    const second = invokeHook({ session_id: "contract-session" })
    expect(second.status).toBe(0)
    expect(second.stdout).toBe("")

    // A stop inside a continuation chain carries stop_hook_active: true for
    // every stop until the user returns; owned runs registered after the
    // first wake must still be delivered on such a stop.
    const reRegistered = runPackagedCommand([
      "wake",
      runId,
      "--harness",
      "codex",
      "--session",
      "contract-session"
    ])
    expect(reRegistered.status).toBe(0)
    const chained = invokeHook({ session_id: "contract-session", stop_hook_active: true })
    expect(chained.status).toBe(0)
    expect(JSON.parse(chained.stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining(`run ${runId} reached completed`)
    })
    const drained = invokeHook({ session_id: "contract-session", stop_hook_active: true })
    expect(drained.status).toBe(0)
    expect(drained.stdout).toBe("")
  })

  test("tolerates marker flags and stray positionals on the packaged wake hook", () => {
    const invoke = (extraArgs: readonly string[]) =>
      spawnSync("node", [BUNDLE_PATH, "__wake-hook", "codex", ...extraArgs], {
        encoding: "utf8",
        env: contractEnvironment(),
        input: `${JSON.stringify({ session_id: "unowned-session" })}\n`,
        timeout: 10_000,
        maxBuffer: 1_000_000
      })
    // The installed Codex command carries an identifying --marker flag; a
    // harness that execs argv directly may also pass a legacy shell-comment
    // marker through as stray positionals. Neither may fail the stop.
    for (const extraArgs of [
      ["--marker", "orchestrate-wake-hook"],
      ["#", "orchestrate-wake-hook"]
    ]) {
      const result = invoke(extraArgs)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toBe("")
    }
  })

  test("doctor reports wake adapters without overstating Codex hook trust", async () => {
    const before = runPackagedCommand(["doctor"])
    expect(before.stdout).toContain("codex wake hook: not installed (run orchestrate setup)")
    expect(before.stdout).toContain("claude wake hook: plugin manifest at")
    expect(before.stdout).toContain("must load this plugin for auto-wake")

    const codexHome = path.join(temporaryRoot, "home", ".codex")
    await mkdir(codexHome, { recursive: true })
    await writeFile(
      path.join(codexHome, "hooks.json"),
      `${JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "'/tmp/orchestrate' __wake-hook codex --marker orchestrate-wake-hook",
                  timeout: 86_400
                }
              ]
            }
          ]
        }
      })}\n`
    )
    const after = runPackagedCommand(["doctor"])
    // Codex trusts hooks by hash, so doctor must caveat that installation
    // alone does not make the hook live.
    expect(after.stdout).toContain(
      "codex wake hook: installed; Codex must approve it in-app after any setup change"
    )
  })

  const callbacks: readonly [string, unknown][] = [
    ["none", { type: "none" }],
    ["notification", { type: "notification" }],
    ["command", { type: "command", argv: ["/usr/bin/true"], timeoutSeconds: 15 }],
    [
      "webhook",
      {
        type: "webhook",
        url: "https://example.test/orchestrate",
        headers: {},
        timeoutSeconds: 15
      }
    ]
  ]

  for (const [name, callback] of callbacks) {
    test(`accepts the ${name} callback object`, async () => {
      const workflow = await loadFixture("minimal-command.json")
      workflow.heartbeat.callback = callback
      expectSuccessfulValidation(await runPackagedCli(workflow))
      expectSuccessfulJsonValidation(await runPackagedCli(workflow, "validate", ["--json"]))
    })
  }

  test("rejects a callback string without exposing a digest", async () => {
    const workflow = await loadFixture("minimal-command.json")
    workflow.heartbeat.callback = "notification"
    const result = await runPackagedCli(workflow)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("ERROR schema")
    expect(result.stdout).not.toContain("Digest:")

    const jsonResult = await runPackagedCli(workflow, "validate", ["--json"])
    expect(jsonResult.status).toBe(1)
    const parsed = validationJson(jsonResult)
    expect(parsed.digest).toBeNull()
    expect(parsed.issues.map((issue) => issue.code)).toEqual(["schema"])
  })

  const workspaces: readonly [string, MutableWorkflow["nodes"][number]["workspace"]][] = [
    [
      "shared with a null path",
      {
        mode: "shared",
        path: null,
        vcs: "plastic",
        writes: [],
        exclusiveResources: []
      }
    ],
    [
      "existing",
      {
        mode: "existing",
        path: "/tmp",
        vcs: "other",
        writes: [],
        exclusiveResources: []
      }
    ],
    [
      "git-worktree with a controller-selected path",
      {
        mode: "git-worktree",
        path: null,
        vcs: "git",
        git: {
          branch: "contract-{{runId}}-{{nodeId}}",
          startPoint: "HEAD",
          removeOnClean: false
        },
        writes: [],
        exclusiveResources: []
      }
    ]
  ]

  for (const [name, workspace] of workspaces) {
    test(`accepts the ${name} workspace variant`, async () => {
      const workflow = await loadFixture("minimal-command.json")
      workflow.nodes[0]!.workspace = structuredClone(workspace)
      expectSuccessfulValidation(await runPackagedCli(workflow))
      expectSuccessfulJsonValidation(await runPackagedCli(workflow, "validate", ["--json"]))
    })
  }

  test("localizes a missing shared-workspace vcs error", async () => {
    const workflow = await loadFixture("minimal-command.json")
    delete workflow.nodes[0]!.workspace.vcs
    const result = await runPackagedCli(workflow)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain("required property 'vcs'")
    expect(result.stdout).not.toContain("path must be string")
    expect(result.stdout).not.toContain("required property 'git'")
    expect(result.stdout).not.toContain("must match a schema in anyOf")
    expect(result.stdout).not.toContain("permissionMode")
    expect(result.stdout).not.toContain("Digest:")

    const jsonResult = await runPackagedCli(workflow, "validate", ["--json"])
    expect(jsonResult.status).toBe(1)
    const parsed = validationJson(jsonResult)
    expect(parsed.workflow).toBeNull()
    expect(parsed.digest).toBeNull()
    expect(parsed.issues.map(({ severity, code }) => ({ severity, code }))).toEqual([
      { severity: "error", code: "schema" }
    ])
  })

  test("accepts a linear resume chain without re-saving its alias", async () => {
    const workflow = await loadFixture("linear-resume.json")
    expectSuccessfulValidation(await runPackagedCli(workflow))
    expectSuccessfulJsonValidation(await runPackagedCli(workflow, "validate", ["--json"]))
  })

  test("reports one duplicate-alias error without backwards dependency advice", async () => {
    const workflow = await loadFixture("linear-resume.json")
    workflow.nodes[1]!.session!.saveAs = "impl"
    workflow.nodes[2]!.session!.saveAs = "impl"
    const result = await runPackagedCli(workflow)
    expect(result.status).toBe(1)
    expect(result.stdout.match(/duplicate-session-alias/g)).toHaveLength(1)
    expect(result.stdout).toContain('"implement"')
    expect(result.stdout).toContain('"apply-findings"')
    expect(result.stdout).toContain('"nativize-presentation"')
    expect(result.stdout).not.toContain("session-order")
    expect(result.stdout).not.toContain("Digest:")

    const jsonResult = await runPackagedCli(workflow, "validate", ["--json"])
    expect(jsonResult.status).toBe(1)
    const parsed = validationJson(jsonResult)
    expect(parsed.workflow).not.toBeNull()
    expect(parsed.digest).toBeNull()
    expect(parsed.issues).toHaveLength(1)
    expect(parsed.issues[0]).toMatchObject({
      severity: "error",
      code: "duplicate-session-alias",
      nodes: ["implement", "apply-findings", "nativize-presentation"]
    })
  })

  test("applies the Plastic resource convention only to mutating nodes", async () => {
    const readOnly = await loadFixture("plastic-reviewer.json")
    const readOnlyResult = await runPackagedCli(readOnly)
    expectSuccessfulValidation(readOnlyResult)
    expect(readOnlyResult.stdout).not.toContain("plastic-resource")
    expectSuccessfulJsonValidation(await runPackagedCli(readOnly, "validate", ["--json"]))

    const plan = structuredClone(readOnly)
    plan.nodes[0]!.provider = "claude"
    plan.nodes[0]!.permissions = {
      permissionMode: "plan",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    }
    const planResult = await runPackagedCli(plan)
    expectSuccessfulValidation(planResult)
    expect(planResult.stdout).not.toContain("plastic-resource")
    expectSuccessfulJsonValidation(await runPackagedCli(plan, "validate", ["--json"]))

    const mutating = structuredClone(readOnly)
    mutating.nodes[0]!.permissions!.sandbox = "workspace-write"
    const mutatingResult = await runPackagedCli(mutating)
    expectSuccessfulValidation(mutatingResult)
    expect(mutatingResult.stdout).toContain("WARN  plastic-resource")
    const mutatingJson = validationJson(await runPackagedCli(mutating, "validate", ["--json"]))
    expect(mutatingJson.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(
      mutatingJson.issues.map(({ severity, code, nodes }) => ({ severity, code, nodes }))
    ).toEqual([{ severity: "warning", code: "plastic-resource", nodes: ["review"] }])

    const reserved = structuredClone(mutating)
    reserved.nodes[0]!.workspace.exclusiveResources = ["plastic-scm"]
    const reservedResult = await runPackagedCli(reserved)
    expectSuccessfulValidation(reservedResult)
    expect(reservedResult.stdout).not.toContain("plastic-resource")
    expectSuccessfulJsonValidation(await runPackagedCli(reserved, "validate", ["--json"]))
  })

  test("proves that the packaged validator uses the public schema", async () => {
    const workflow = await loadFixture("plastic-reviewer.json")
    workflow.nodes[0]!.provider = "mock"
    delete workflow.nodes[0]!.permissions!.sandbox
    const result = await runPackagedCli(workflow, "validate", ["--json"])
    expect(result.status).toBe(1)
    const parsed = validationJson(result)
    expect(parsed.workflow).toBeNull()
    expect(parsed.digest).toBeNull()
    expect(parsed.issues.map((issue) => issue.code)).toEqual(["schema"])
  })

  test("never exposes a digest for semantic failures in text, JSON, or preview", async () => {
    const workflow = await loadFixture("minimal-command.json")
    workflow.cwd = "relative/path"

    const textResult = await runPackagedCli(workflow)
    expect(textResult.status).toBe(1)
    expect(textResult.stdout).toContain("ERROR workflow-cwd")
    expect(textResult.stdout).not.toContain("Digest:")

    const jsonResult = await runPackagedCli(workflow, "validate", ["--json"])
    expect(jsonResult.status).toBe(1)
    const parsed = validationJson(jsonResult)
    expect(parsed.digest).toBeNull()
    expect(parsed.issues.map((issue) => issue.code)).toEqual(["workflow-cwd"])

    const previewResult = await runPackagedCli(workflow, "preview")
    expect(previewResult.status).toBe(1)
    expect(`${previewResult.stdout}\n${previewResult.stderr}`).not.toContain("Approval digest:")
  })

  test("redacts every packaged secret surface while binding each value in the digest", async () => {
    const workflow = await loadFixture<SecretWorkflow>("secret-redaction.json")
    const sentinels = [
      "webhook-secret-v1",
      "command-secret-v1",
      "agent-secret-v1",
      "adaptive-command-secret-v1",
      "adaptive-agent-secret-v1"
    ]
    const baseResult = await runPackagedCli(workflow, "validate", ["--json"])
    const base = expectSuccessfulJsonValidation(baseResult)
    const redacted = base.workflow as SecretWorkflow
    for (const sentinel of sentinels) {
      expect(`${baseResult.stdout}\n${baseResult.stderr}`).not.toContain(sentinel)
    }
    expect(redacted.heartbeat.callback.headers.Authorization).toBe("<redacted>")
    expect(redacted.nodes[0].env.COMMAND_SECRET).toBe("<redacted>")
    expect(redacted.nodes[1].permissions.env.AGENT_SECRET).toBe("<redacted>")
    expect(redacted.nodes[1].envelope.allowedCommandEnv[0]?.ADAPTIVE_COMMAND_SECRET).toBe(
      "<redacted>"
    )
    expect(redacted.nodes[1].envelope.allowedProviderEnv[0]?.ADAPTIVE_AGENT_SECRET).toBe(
      "<redacted>"
    )

    const preview = await runPackagedCli(workflow, "preview")
    expect(preview.status).toBe(0)
    expect(preview.stderr).toBe("")
    expect(preview.stdout).toContain(`Approval digest: ${base.digest}`)
    for (const sentinel of sentinels) {
      expect(`${preview.stdout}\n${preview.stderr}`).not.toContain(sentinel)
    }
    for (const key of [
      "Authorization",
      "COMMAND_SECRET",
      "AGENT_SECRET",
      "ADAPTIVE_COMMAND_SECRET",
      "ADAPTIVE_AGENT_SECRET"
    ]) {
      expect(preview.stdout).toContain(key)
    }
    expect(preview.stdout).toContain("<redacted>")

    const mutations: Array<(changed: SecretWorkflow) => void> = [
      (changed) => {
        changed.heartbeat.callback.headers.Authorization = "webhook-secret-v2"
      },
      (changed) => {
        changed.nodes[0].env.COMMAND_SECRET = "command-secret-v2"
      },
      (changed) => {
        changed.nodes[1].permissions.env.AGENT_SECRET = "agent-secret-v2"
      },
      (changed) => {
        changed.nodes[1].envelope.allowedCommandEnv[0]!.ADAPTIVE_COMMAND_SECRET =
          "adaptive-command-secret-v2"
      },
      (changed) => {
        changed.nodes[1].envelope.allowedProviderEnv[0]!.ADAPTIVE_AGENT_SECRET =
          "adaptive-agent-secret-v2"
      }
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(workflow)
      mutate(changed)
      const changedResult = await runPackagedCli(changed, "validate", ["--json"])
      const changedValidation = expectSuccessfulJsonValidation(changedResult)
      expect(changedValidation.workflow).toEqual(base.workflow)
      expect(changedValidation.digest).not.toBe(base.digest)
    }
  })
})

describe("executable documentation contract", () => {
  test("keeps every JSON fence parseable and validates every full workflow publicly", async () => {
    const documents = [
      new URL("../../references/examples.md", import.meta.url),
      new URL("../../references/workflow-format.md", import.meta.url)
    ]
    let fullWorkflowCount = 0
    for (const documentPath of documents) {
      const document = await readFile(documentPath, "utf8")
      const blocks = [...document.matchAll(/```json\n([\s\S]*?)```/g)]
      expect(blocks.length).toBeGreaterThan(0)
      for (const match of blocks) {
        const parsed = JSON.parse(match[1] as string) as Record<string, unknown>
        if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) {
          continue
        }
        fullWorkflowCount += 1
        expectSuccessfulValidation(await runPackagedCli(parsed))
      }
    }
    expect(fullWorkflowCount).toBeGreaterThan(0)
  })

  test("documents the semantic rules represented by the public fixtures", async () => {
    const document = await readFile(
      new URL("../../references/workflow-format.md", import.meta.url),
      "utf8"
    )
    expect(document).toContain('`{ "type": "notification" }`')
    expect(document).toMatch(/`vcs` is\s+required in every mode/)
    expect(document).toContain('reserve `"plastic-scm"`')
    expect(document).toMatch(/exactly one node may produce a given\s+alias/)
    expect(document).toMatch(/later nodes use `from: "alias"`, `saveAs: null`/)
  })
})
