import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Option } from "effect"
import { access, chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  AgentNode,
  CommandNode,
  NodeRunState,
  PaneReference,
  RunState,
  SpawnIntent,
  WorkflowSpec
} from "../src/types.js"

import {
  decodeHerdrErrorResponse,
  decodeHerdrPaneCurrentResponse
} from "../src/herdr-api.generated.js"
import {
  fetchBaselineHerdrApiSchema,
  HERDR_SCHEMA_BASELINE_VERSION
} from "../src/herdr-contract.js"
import {
  HerdrObservationError,
  HerdrSurface,
  injectAfterAgentPromptForTests,
  injectBeforeProviderBoundaryForTests,
  removeWorkflowWorktrees,
  setAgentSessionTimeoutForTests
} from "../src/herdr-surface.js"
import { DEFAULT_UI_PREFERENCES } from "../src/preferences.js"
import { prepareNode } from "../src/prompt.js"
import {
  completionSubmissionPath,
  persistNewRun,
  runDirectory as stateRunDirectory,
  runtimeBuild
} from "../src/state.js"
import { createInitialRunState, transition } from "../src/transition.js"
import { validateWorkflow } from "../src/validation.js"

let temporaryRoot = ""
let shimDirectory = ""
let logPath = ""
let profileCapturePath = ""
let originalPath = ""
let originalCodexHome: string | undefined

function workspace() {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "none" as const,
    writes: [],
    exclusiveResources: []
  }
}

function agent(): Extract<AgentNode, { readonly provider: "codex" }> {
  return {
    id: "review",
    type: "agent",
    title: "Review",
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    retry: { maxAttempts: 1 },
    gate: "none",
    provider: "codex",
    model: "provider-default",
    effort: "high",
    prompt: "Review the work.",
    session: { mode: "fresh", from: null, saveAs: "review-session" },
    permissions: {
      execution: { sandbox: "read-only" },
      escalation: "deny",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
    output: { format: "text", schema: null }
  }
}

function claudeAgent(): Extract<AgentNode, { readonly provider: "claude" }> {
  return {
    ...agent(),
    provider: "claude",
    session: { mode: "fresh", from: null, saveAs: null },
    permissions: {
      execution: { permissionMode: "dontAsk" },
      escalation: "deny",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    }
  }
}

function command(): CommandNode {
  return {
    id: "check",
    type: "command",
    title: "Check",
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    retry: { maxAttempts: 1 },
    gate: "none",
    argv: ["/usr/bin/printf", "ok"],
    mutates: false,
    inheritEnv: [],
    env: {},
    allowedExitCodes: [0]
  }
}

function workflow(node: AgentNode | CommandNode): WorkflowSpec {
  return {
    name: "surface-test",
    objective: "Test herdr calls.",
    cwd: temporaryRoot,
    concurrency: 1,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes: [node],
    repeats: []
  }
}

function runtimeNode(id: string): NodeRunState {
  return {
    id,
    templateId: id,
    title: id,
    type: id === "check" ? "command" : "agent",
    provider: id === "check" ? null : "codex",
    needs: [],
    origin: "initial",
    repeatId: null,
    round: null,
    status: "ready",
    attempts: [
      {
        attempt: 1,
        status: "planned",
        token: "token-1",
        pane: null,
        providerSessionId: null,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        error: null,
        resultPath: path.join(temporaryRoot, "submission", id, "token-1", "result.txt"),
        outputPath: path.join(temporaryRoot, "output.log")
      }
    ],
    resultPath: null,
    result: null,
    error: null
  }
}

function placement(id: string, destination: "dedicated" | "origin" = "dedicated") {
  return {
    workspace: destination,
    surface: "tab" as const,
    matchedRuleIndex: 0,
    group: id,
    groupLabel: id,
    groupOrdinal: 1,
    anchorPane: null,
    reusePane: null
  }
}

function state(id: string): RunState {
  return {
    runtimeVersion: "test-build",
    sequence: 1,
    id: "20260802120000-1234abcd",
    workflowName: "surface-test",
    objective: "Test herdr calls.",
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
    nodes: { [id]: runtimeNode(id) },
    sessions: {},
    gates: {},
    holds: {},
    repeats: {},
    workrooms: {},
    spawnIntents: {}
  }
}

function intent(id: string): SpawnIntent {
  return {
    id: `intent-${id}`,
    nodeId: id,
    attempt: 1,
    token: "token-1",
    status: "planned",
    createdAt: "2026-08-02T12:00:00.000Z"
  }
}

async function persistRun(spec: WorkflowSpec): Promise<void> {
  const digest = validateWorkflow(spec).digest
  if (digest === null) {
    throw new Error("invalid test workflow")
  }
  const runId = "20260802120000-1234abcd"
  const initial = createInitialRunState(spec, {
    id: runId,
    runtimeVersion: runtimeBuild(),
    digest,
    now: "2026-08-02T12:00:00.000Z",
    origin: null
  })
  const runDir = stateRunDirectory(runId)
  const started = transition(initial, spec, { type: "run" }, initial.createdAt, {
    prepareNode: (runState, workflowSpec, node) =>
      prepareNode(workflowSpec, runState, runDir, node.id)
  })
  await persistNewRun(spec, DEFAULT_UI_PREFERENCES, started.state, started.events)
}

function herdrPane(
  paneId: string,
  workspaceId: string,
  tabId: string,
  fields: Readonly<Record<string, unknown>> = {}
) {
  return {
    terminal_id: `terminal-${paneId}`,
    agent_status: "idle",
    workspace_id: workspaceId,
    tab_id: tabId,
    pane_id: paneId,
    focused: false,
    revision: 1,
    ...fields
  }
}

function herdrTab(tabId: string, workspaceId: string, label: string) {
  return {
    tab_id: tabId,
    workspace_id: workspaceId,
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    agent_status: "idle"
  }
}

function herdrWorkspace(workspaceId: string, label: string) {
  return {
    workspace_id: workspaceId,
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: "t1",
    agent_status: "idle"
  }
}

function herdrAgent(
  paneId: string,
  provider: "codex" | "claude",
  session: Readonly<Record<string, unknown>> | null | undefined
) {
  return {
    terminal_id: `terminal-${paneId}`,
    agent_status: "working",
    workspace_id: "w1",
    tab_id: "t1",
    pane_id: paneId,
    focused: false,
    revision: 1,
    agent: provider,
    ...(session === undefined ? {} : { agent_session: session })
  }
}

function herdrResponse(result: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ id: `cli:test:${String(result["type"])}`, result })
}

async function writeShim(
  reportSession = true,
  busyOnce = false,
  originLive = true,
  paneFailure: "none" | "transport" | "split-missing" | "split-transport" = "none",
  missingPane: string | null = null,
  reportSessionLate = false,
  promptFailure: "none" | "stall-once" | "stall-once-hidden" | "always" = "none",
  bootDelayOnce = false,
  listedPanes: readonly ReturnType<typeof herdrPane>[] = []
): Promise<void> {
  const busyMarker = path.join(temporaryRoot, "agent-start-busy-once")
  const claudeMarker = path.join(temporaryRoot, "agent-is-claude")
  const sessionLateMarker = path.join(temporaryRoot, "agent-session-reported-late")
  const stallMarker = path.join(temporaryRoot, "agent-prompt-stalled-once")
  const promptVisibleMarker = path.join(temporaryRoot, "agent-prompt-visible-after-retry")
  const bootMarker = path.join(temporaryRoot, "agent-boot-finished")
  const codexSession = {
    agent: "codex",
    kind: "id",
    source: "herdr:codex",
    value: "session-1"
  }
  const claudeSession = {
    agent: "claude",
    kind: "id",
    source: "herdr:claude",
    value: "session-1"
  }
  const originSession = {
    agent: "codex",
    kind: "id",
    source: "herdr:codex",
    value: "origin-session"
  }
  const workspaceCreated = herdrResponse({
    type: "workspace_created",
    workspace: herdrWorkspace("w1", "surface-test"),
    tab: herdrTab("t1", "w1", "surface-test"),
    root_pane: herdrPane("p1", "w1", "t1")
  })
  const tabCreated = herdrResponse({
    type: "tab_created",
    tab: herdrTab("t1", "w1", "surface-test"),
    root_pane: herdrPane("p1", "w1", "t1")
  })
  const paneSplit = herdrResponse({
    type: "pane_info",
    pane: herdrPane("p2", "w1", "t1")
  })
  const currentPane = herdrResponse({
    type: "pane_current",
    pane: herdrPane("origin-pane", "origin-workspace", "origin-tab", {
      agent: "codex",
      agent_session: originSession
    })
  })
  const body = `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
case "$1 $2" in
  "--version ") printf 'herdr 0.7.5\n' ;;
  "workspace list") printf '%s\n' '${herdrResponse({ type: "workspace_list", workspaces: [] })}' ;;
  "workspace create") printf '%s\n' '${workspaceCreated}' ;;
  "tab create") printf '%s\n' '${tabCreated}' ;;
  "tab list") printf '%s\n' '${herdrResponse({ type: "tab_list", tabs: [] })}' ;;
  "pane list") printf '%s\n' '${herdrResponse({ type: "pane_list", panes: listedPanes })}' ;;
  "pane split")
    if [ ${JSON.stringify(paneFailure)} = "split-missing" ]; then
      printf '%s\n' '{"error":{"code":"pane_not_found","message":"anchor closed"},"id":"cli:pane:split"}' >&2
      exit 1
    fi
    if [ ${JSON.stringify(paneFailure)} = "split-transport" ]; then
      printf '%s\n' '{"error":{"code":"server_unavailable","message":"service outage"},"id":"cli:pane:split"}' >&2
      exit 1
    fi
    printf '%s\n' '${paneSplit}' ;;
  "pane current") printf '%s\n' '${currentPane}' ;;
  "pane get")
    if [ ${JSON.stringify(paneFailure)} = "transport" ]; then
      printf '%s\n' '{"error":{"code":"server_unavailable","message":"service outage"},"id":"cli:pane:get"}' >&2
      exit 1
    fi
    if [ "$3" = ${JSON.stringify(missingPane ?? "")} ]; then
      printf '%s\n' '{"error":{"code":"pane_not_found","message":"pane missing"},"id":"cli:pane:get"}' >&2
      exit 1
    fi
    if [ "$3" = "origin-pane" ]; then
      if ${originLive ? "true" : "false"}; then
        printf '%s\n' '${herdrResponse({ type: "pane_info", pane: herdrPane("origin-pane", "origin-workspace", "origin-tab") })}'
      else
        printf '%s\n' '{"error":{"code":"pane_not_found","message":"pane missing"},"id":"cli:pane:get"}' >&2
        exit 1
      fi
    else
      printf '%s\n' '${herdrResponse({ type: "pane_info", pane: herdrPane("p1", "w1", "t1") })}'
    fi ;;
  "agent start")
    if ${busyOnce ? "true" : "false"} && [ ! -f ${JSON.stringify(busyMarker)} ]; then
      touch ${JSON.stringify(busyMarker)}
      printf '%s\n' '{ "error": { "code": "agent_pane_busy", "message": "agent target pane is not an available shell" }, "id": "cli:agent:start" }' >&2
      exit 1
    fi
    previous=""
    for argument in "$@"; do
      if [ "$previous" = "--profile" ]; then
        cp "$CODEX_HOME/$argument.config.toml" ${JSON.stringify(profileCapturePath)}
      fi
      previous="$argument"
    done
    if [ "$5" = "claude" ]; then touch ${JSON.stringify(claudeMarker)}; fi ;;
  "agent read")
    if [ ${JSON.stringify(promptFailure)} = "stall-once-hidden" ] && [ -f ${JSON.stringify(stallMarker)} ] && [ ! -f ${JSON.stringify(promptVisibleMarker)} ]; then
      grep -v -e '^agent prompt ' -e 'orchestrate-delivery:' ${JSON.stringify(logPath)} 2>/dev/null || true
    else
      cat ${JSON.stringify(logPath)} 2>/dev/null || true
    fi ;;
  "agent prompt")
    if { [ ${JSON.stringify(promptFailure)} = "stall-once" ] || [ ${JSON.stringify(promptFailure)} = "stall-once-hidden" ]; } && [ ! -f ${JSON.stringify(stallMarker)} ]; then
      touch ${JSON.stringify(stallMarker)}
      printf '%s\n' '{"error":{"code":"agent_prompt_stalled","message":"agent prompt produced no observed state change within 5000 ms; status is idle"},"id":"cli:agent:prompt"}' >&2
      exit 1
    fi
    if [ ${JSON.stringify(promptFailure)} = "stall-once-hidden" ]; then
      touch ${JSON.stringify(promptVisibleMarker)}
    fi
    if [ ${JSON.stringify(promptFailure)} = "always" ]; then
      printf '%s\n' '{"error":{"code":"agent_prompt_failed","message":"delivery uncertain"},"id":"cli:agent:prompt"}' >&2
      exit 1
    fi ;;
  "agent get")
    if [ "$3" = "origin-pane" ]; then
      printf '%s\n' '${herdrResponse({ type: "agent_info", agent: herdrAgent("origin-pane", "codex", originSession) })}'
    elif ${bootDelayOnce ? "true" : "false"} && [ ! -f ${JSON.stringify(bootMarker)} ]; then
      touch ${JSON.stringify(bootMarker)}
      printf '%s\n' '${herdrResponse({
        type: "agent_info",
        agent: { ...herdrAgent("p1", "codex", undefined), interactive_ready: false }
      })}'
    elif ${reportSessionLate ? "true" : "false"} && [ ! -f ${JSON.stringify(sessionLateMarker)} ]; then
      touch ${JSON.stringify(sessionLateMarker)}
      printf '%s\n' '${herdrResponse({ type: "agent_info", agent: herdrAgent("p1", "codex", undefined) })}'
    else
      if [ -f ${JSON.stringify(claudeMarker)} ]; then
        printf '%s\n' '${
          reportSession
            ? herdrResponse({
                type: "agent_info",
                agent: herdrAgent("p1", "claude", claudeSession)
              })
            : herdrResponse({ type: "agent_info", agent: herdrAgent("p1", "claude", undefined) })
        }'
      else
        printf '%s\n' '${
          reportSession
            ? herdrResponse({ type: "agent_info", agent: herdrAgent("p1", "codex", codexSession) })
            : herdrResponse({ type: "agent_info", agent: herdrAgent("p1", "codex", undefined) })
        }'
      fi
    fi ;;
  *) printf '%s\n' '{"result":{"type":"ok"}}' ;;
esac
`
  const shim = path.join(shimDirectory, "herdr")
  await Bun.write(shim, body, { createPath: false })
  await chmod(shim, 0o755)
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-herdr-surface-"))
  shimDirectory = path.join(temporaryRoot, "bin")
  logPath = path.join(temporaryRoot, "herdr.log")
  profileCapturePath = path.join(temporaryRoot, "codex-profile.toml")
  await mkdir(shimDirectory)
  originalPath = process.env.PATH ?? ""
  process.env.PATH = `${shimDirectory}:${originalPath}`
  process.env.ORCHESTRATE_BIN = "/tmp/orchestrate"
  process.env.ORCHESTRATE_STATE_DIR = `${temporaryRoot}-state`
  originalCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = path.join(temporaryRoot, "codex-home")
  await writeShim()
})

afterEach(async () => {
  injectAfterAgentPromptForTests(null)
  injectBeforeProviderBoundaryForTests(null)
  setAgentSessionTimeoutForTests(null)
  process.env.PATH = originalPath
  delete process.env.ORCHESTRATE_BIN
  await rm(process.env.ORCHESTRATE_STATE_DIR as string, {
    recursive: true,
    force: true
  })
  delete process.env.ORCHESTRATE_STATE_DIR
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe("herdr surface", () => {
  test("requires socket correlation ids on generated CLI envelopes", () => {
    const success = JSON.parse(
      herdrResponse({
        type: "pane_current",
        pane: herdrPane("p1", "w1", "t1")
      })
    ) as Record<string, unknown>
    const { id: _successId, ...successWithoutId } = success
    expect(Option.isSome(decodeHerdrPaneCurrentResponse(success))).toBeTrue()
    expect(Option.isNone(decodeHerdrPaneCurrentResponse(successWithoutId))).toBeTrue()

    const error = {
      id: "cli:pane:get",
      error: { code: "pane_not_found", message: "missing" }
    }
    const { id: _errorId, ...errorWithoutId } = error
    expect(Option.isSome(decodeHerdrErrorResponse(error))).toBeTrue()
    expect(Option.isNone(decodeHerdrErrorResponse(errorWithoutId))).toBeTrue()
  })

  test("rejects a schema refresh from a non-baseline Herdr before reading its schema", async () => {
    const calls: Array<readonly string[]> = []
    await expect(
      fetchBaselineHerdrApiSchema(async (args) => {
        calls.push(args)
        return "herdr 0.8.0"
      })
    ).rejects.toThrow(`requires exactly ${HERDR_SCHEMA_BASELINE_VERSION}`)
    expect(calls).toEqual([["--version"]])
  })

  test("reads the schema only after confirming the exact baseline Herdr", async () => {
    const calls: Array<readonly string[]> = []
    const schema = await fetchBaselineHerdrApiSchema(async (args) => {
      calls.push(args)
      return args[0] === "--version" ? `herdr ${HERDR_SCHEMA_BASELINE_VERSION}` : '{"protocol":17}'
    })
    expect(schema).toEqual({ protocol: 17 })
    expect(calls).toEqual([["--version"], ["api", "schema", "--json"]])
  })

  test("creates an origin-workspace tab when the launching pane is still live", async () => {
    const node = command()
    const runState: RunState = {
      ...state(node.id),
      origin: {
        workspaceId: "origin-workspace",
        tabId: "origin-tab",
        paneId: "origin-pane",
        provider: "codex",
        sessionId: "origin-session"
      }
    }
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: runState,
      intent: intent(node.id),
      prompt: null,
      placement: placement(node.id, "origin")
    })
    const log = await Bun.file(logPath).text()
    expect(observation.pane.workspaceId).toBe("origin-workspace")
    expect(log).toContain("pane get origin-pane")
    expect(log).toContain("tab create --workspace origin-workspace")
    expect(log).not.toContain("workspace create")
  })

  test("reuses a dedicated run workspace's initial pane even when a live origin exists", async () => {
    const node = command()
    const runState: RunState = {
      ...state(node.id),
      origin: {
        workspaceId: "origin-workspace",
        tabId: "origin-tab",
        paneId: "origin-pane",
        provider: "codex",
        sessionId: "origin-session"
      }
    }
    await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: runState,
      intent: intent(node.id),
      prompt: null,
      placement: placement(node.id, "dedicated")
    })
    const log = await Bun.file(logPath).text()
    expect(log).toContain("workspace create")
    expect(log).toContain("--env ORCHESTRATE_NODE_ID=check")
    expect(log).toContain("tab rename t1 check")
    expect(log).not.toContain("tab create --workspace w1")
    expect(log).not.toContain("pane get origin-pane")
  })

  test("falls back to a dedicated run workspace when no live origin exists", async () => {
    await writeShim(true, false, false)
    const node = command()
    const runState: RunState = {
      ...state(node.id),
      origin: {
        workspaceId: "origin-workspace",
        tabId: "origin-tab",
        paneId: "origin-pane",
        provider: "codex",
        sessionId: "origin-session"
      }
    }
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: runState,
      intent: intent(node.id),
      prompt: null,
      placement: {
        ...placement(node.id, "origin"),
        surface: "split",
        anchorPane: {
          workspaceId: "origin-workspace",
          tabId: "old-tab",
          paneId: "old-pane",
          group: node.id,
          surface: "split"
        }
      }
    })
    const log = await Bun.file(logPath).text()
    expect(observation.pane.workspaceId).toBe("w1")
    expect(log).toContain("pane get origin-pane")
    expect(log).toContain("workspace create")
    expect(log).toContain("tab rename t1 check")
    expect(log).not.toContain("tab create --workspace w1")
    expect(log).not.toContain("pane split --pane old-pane")
  })

  test("claims a created workspace pane once, then creates later tabs normally", async () => {
    const first = command()
    const second = agent()
    const spec: WorkflowSpec = {
      ...workflow(first),
      concurrency: 2,
      nodes: [first, second]
    }
    const baseState = state(first.id)
    const runState: RunState = {
      ...baseState,
      nodes: {
        [first.id]: baseState.nodes[first.id] as NodeRunState,
        [second.id]: runtimeNode(second.id)
      }
    }
    const surface = new HerdrSurface()

    await surface.spawn({
      workflow: spec,
      state: runState,
      intent: intent(first.id),
      prompt: null,
      placement: placement(first.id)
    })
    await surface.spawn({
      workflow: spec,
      state: runState,
      intent: intent(second.id),
      prompt: "Review after the first node.",
      placement: placement(second.id)
    })

    const log = await Bun.file(logPath).text()
    expect(log.match(/workspace create/g)).toHaveLength(1)
    expect(log.match(/tab rename t1 check/g)).toHaveLength(1)
    expect(log.match(/tab create --workspace w1/g)).toHaveLength(1)
  })

  test("does not reclaim a root pane from a recovered run workspace", async () => {
    const node = command()
    const baseState = state(node.id)
    const current = baseState.nodes[node.id] as NodeRunState
    const runState: RunState = {
      ...baseState,
      nodes: {
        [node.id]: {
          ...current,
          attempts: [
            {
              ...(current.attempts[0] as NodeRunState["attempts"][number]),
              pane: {
                workspaceId: "w1",
                tabId: "existing-tab",
                paneId: "existing-pane",
                group: "previous",
                surface: "tab"
              }
            }
          ]
        }
      }
    }

    await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: runState,
      intent: intent(node.id),
      prompt: null,
      placement: placement(node.id)
    })

    const log = await Bun.file(logPath).text()
    expect(log).toContain("workspace get w1")
    expect(log).toContain("tab create --workspace w1")
    expect(log).not.toContain("workspace create")
    expect(log).not.toContain("tab rename")
  })

  test("uses a newly created workspace's initial pane for the board", async () => {
    const spec = workflow(command())
    await persistRun(spec)

    await new HerdrSurface().openBoard("20260802120000-1234abcd", {
      ...DEFAULT_UI_PREFERENCES,
      board: "dedicated-workspace"
    })

    const log = await Bun.file(logPath).text()
    expect(log).toContain("workspace create")
    expect(log).toContain("tab rename t1 Board")
    expect(log).not.toContain("tab create")
    expect(log).toContain("pane rename p1 surface-test: board")
    expect(log).toContain("pane run p1 /tmp/orchestrate board 20260802120000-1234abcd")
  })

  test("distinguishes explicit pane absence from herdr transport failure", async () => {
    await writeShim(true, false, false)
    await expect(new HerdrSurface().paneExists("origin-pane")).resolves.toBe(false)
    await writeShim(true, false, true, "transport")
    await expect(new HerdrSurface().paneExists("p1")).rejects.toThrow("server_unavailable")
  })

  test("starts an agent, captures its session id, and submits the prompt", async () => {
    const node = agent()
    const surface = new HerdrSurface()
    await surface.connect()
    const observation = await surface.spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: "Rendered prompt and node-done contract.",
      placement: placement(node.id)
    })
    const log = await Bun.file(logPath).text()
    expect(observation).toEqual({
      pane: {
        workspaceId: "w1",
        tabId: "t1",
        paneId: "p1",
        group: "review",
        surface: "tab"
      },
      providerSessionId: "session-1"
    })
    expect(log).toContain("agent start o-review-7f87e2e85f26e92d --kind codex --pane p1")
    const submissionDirectory = path.dirname(state(node.id).nodes[node.id]!.attempts[0]!.resultPath)
    const runDirectory = path.join(process.env.ORCHESTRATE_STATE_DIR!, "runs", state(node.id).id)
    const profileDocument = await Bun.file(profileCapturePath).text()
    expect(log).toContain("--ask-for-approval never")
    expect(log).toContain("--profile orchestrate-control-")
    expect(log).not.toContain("default_permissions")
    expect(profileDocument).toContain('default_permissions="orchestrate-control-')
    expect(profileDocument).toContain('[permissions."orchestrate-control-')
    expect(profileDocument).toContain('extends=":read-only"')
    expect(profileDocument).toContain(".filesystem]")
    expect(profileDocument).toContain(`${JSON.stringify(submissionDirectory)}="write"`)
    expect(profileDocument).not.toContain(`filesystem={"${runDirectory}"="write"}`)
    expect(await readdir(process.env.CODEX_HOME!)).toHaveLength(1)
    await surface.closePane(observation.pane.paneId)
    expect(await readdir(process.env.CODEX_HOME!)).toEqual([])
    expect(log).not.toContain("--sandbox workspace-write")
    expect(log).not.toContain(`--add-dir ${process.env.ORCHESTRATE_STATE_DIR}`)
    expect(log).toContain("agent get p1")
    expect(log).toContain("agent prompt p1 Rendered prompt and node-done contract.")
    expect(log).toContain("--until working --until done --until blocked")
    expect(log.lastIndexOf("agent get p1")).toBeGreaterThan(log.indexOf("agent prompt p1"))
  })

  test("does not require a provider session id when no lineage alias is saved", async () => {
    await writeShim(false)
    const node = {
      ...agent(),
      session: { mode: "fresh" as const, from: null, saveAs: null }
    }
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: "Run without preserving this session.",
      placement: placement(node.id)
    })
    const log = await Bun.file(logPath).text()
    expect(observation.providerSessionId).toBeNull()
    expect(log).toContain("agent prompt p1 Run without preserving this session.")
    expect(log.slice(log.indexOf("agent prompt p1"))).not.toContain("agent get p1")
  })

  test("forks and captures a repeat resume without mutating its committed Codex head", async () => {
    const node = {
      ...agent(),
      session: { mode: "resume" as const, from: "reviewer", saveAs: null }
    }
    const runtime = {
      ...runtimeNode("review--r1"),
      templateId: "review",
      repeatId: "loop",
      round: 1
    }
    const runState: RunState = {
      ...state("review--r1"),
      nodes: { "review--r1": runtime },
      sessions: {
        reviewer: {
          alias: "reviewer",
          provider: "codex",
          sessionId: "committed-session",
          sourceNodeId: "seed"
        }
      }
    }
    const observation = await new HerdrSurface().spawn({
      workflow: {
        ...workflow(node),
        repeats: [
          {
            id: "loop",
            members: ["review"],
            until: { type: "agent-output", node: "review", pointer: "/done", equals: true },
            maxRounds: 2
          }
        ]
      },
      state: runState,
      intent: intent("review--r1"),
      prompt: "REVIEW s1 r1.",
      placement: placement("review--r1")
    })
    const log = await Bun.file(logPath).text()
    expect(observation.providerSessionId).toBe("session-1")
    expect(log).toContain("fork committed-session")
    expect(log).not.toContain("resume committed-session")
  })

  test("launches a repeat resume as a named Claude fork", async () => {
    const node = {
      ...claudeAgent(),
      session: { mode: "resume" as const, from: "reviewer", saveAs: null }
    }
    const runtime = {
      ...runtimeNode("review--r1"),
      templateId: "review",
      provider: "claude" as const,
      repeatId: "loop",
      round: 1
    }
    const runState: RunState = {
      ...state("review--r1"),
      nodes: { "review--r1": runtime },
      sessions: {
        reviewer: {
          alias: "reviewer",
          provider: "claude",
          sessionId: "committed-session",
          sourceNodeId: "seed"
        }
      }
    }
    const observation = await new HerdrSurface().spawn({
      workflow: {
        ...workflow(node),
        repeats: [
          {
            id: "loop",
            members: ["review"],
            until: { type: "agent-output", node: "review", pointer: "/done", equals: true },
            maxRounds: 2
          }
        ]
      },
      state: runState,
      intent: intent("review--r1"),
      prompt: "REVIEW s1 r1.",
      placement: placement("review--r1")
    })
    const log = await Bun.file(logPath).text()
    expect(observation.providerSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(log).toContain("--resume committed-session")
    expect(log).toContain("--fork-session")
    expect(log).toContain(`--session-id ${observation.providerSessionId}`)
  })

  test("confines a workspace-write Codex node to declared roots and its submission", async () => {
    const node = {
      ...agent(),
      workspace: { ...workspace(), writes: ["allowed/**"] },
      permissions: {
        ...agent().permissions,
        execution: { sandbox: "workspace-write" as const }
      }
    }
    const runState = state(node.id)
    await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: runState,
      intent: intent(node.id),
      prompt: "Write source and report completion.",
      placement: placement(node.id)
    })
    const log = await Bun.file(logPath).text()
    const submissionDirectory = path.dirname(runState.nodes[node.id]!.attempts[0]!.resultPath)
    const authoritativeRunDirectory = path.join(
      process.env.ORCHESTRATE_STATE_DIR!,
      "runs",
      runState.id
    )
    const canonicalTemporaryRoot = await realpath(temporaryRoot)
    const canonicalAllowedRoot = path.join(canonicalTemporaryRoot, "allowed")
    const canonicalSubmissionsRoot = `${canonicalTemporaryRoot}-state-submissions`
    const profileDocument = await Bun.file(profileCapturePath).text()
    expect(log).toContain("--ask-for-approval never --profile orchestrate-control-")
    expect(profileDocument).toContain('extends=":read-only"')
    expect(profileDocument).toContain(`${JSON.stringify(canonicalAllowedRoot)}="write"`)
    expect(profileDocument).toContain(`${JSON.stringify(submissionDirectory)}="write"`)
    expect(profileDocument).toContain(`${JSON.stringify(canonicalSubmissionsRoot)}="deny"`)
    expect(profileDocument).not.toContain('extends=":workspace"')
    expect(log).not.toContain("--sandbox workspace-write")
    expect(log).not.toContain(`--add-dir ${submissionDirectory}`)
    expect(log).not.toContain(`--add-dir ${authoritativeRunDirectory}`)
    expect(log).not.toContain(`--add-dir ${process.env.ORCHESTRATE_STATE_DIR} `)
  })

  test("rejects protected provider roots before Codex or Claude can create a pane", async () => {
    const protectedRoot = process.env.ORCHESTRATE_STATE_DIR as string
    const codex = {
      ...agent(),
      workspace: { ...workspace(), path: protectedRoot, writes: ["**"] },
      permissions: {
        ...agent().permissions,
        execution: { sandbox: "workspace-write" as const }
      }
    }
    const claude = {
      ...claudeAgent(),
      workspace: {
        ...workspace(),
        path: path.join(protectedRoot, "runs", state("review").id),
        writes: ["**"]
      },
      permissions: {
        ...claudeAgent().permissions,
        execution: { permissionMode: "bypassPermissions" as const }
      }
    }
    for (const node of [codex, claude]) {
      await expect(
        new HerdrSurface().spawn({
          workflow: workflow(node),
          state: state(node.id),
          intent: intent(node.id),
          prompt: "Attempt protected mutation.",
          placement: placement(node.id)
        })
      ).rejects.toThrow("overlaps Orchestrate-owned authority")
    }
    expect(
      await Bun.file(logPath)
        .text()
        .catch(() => "")
    ).not.toContain("tab create")
  })

  test("rejects direct-launch Claude mode and argument adversaries before Herdr access", async () => {
    for (const node of [
      {
        ...claudeAgent(),
        permissions: {
          ...claudeAgent().permissions,
          execution: { permissionMode: "bypassPermissions" as const }
        }
      },
      {
        ...claudeAgent(),
        permissions: {
          ...claudeAgent().permissions,
          extraArgs: ["--allowedTools", "Edit(/**)"]
        }
      }
    ]) {
      await expect(
        new HerdrSurface().spawn({
          workflow: workflow(node),
          state: state(node.id),
          intent: intent(node.id),
          prompt: "Attempt authority expansion.",
          placement: placement(node.id)
        })
      ).rejects.toThrow("must use dontAsk and launcher-owned arguments")
    }
    expect(
      await Bun.file(logPath)
        .text()
        .catch(() => "")
    ).toBe("")
  })

  test("rejects a protected-root symlink swap after the last preparation check without touching herdr", async () => {
    const safeTarget = path.join(temporaryRoot, "safe-target")
    const providerLink = path.join(temporaryRoot, "provider-root")
    const protectedRoot = process.env.ORCHESTRATE_STATE_DIR as string
    await mkdir(safeTarget)
    await mkdir(protectedRoot)
    await Bun.write(path.join(protectedRoot, "state-marker"), "untouched\n", { createPath: false })
    await symlink(safeTarget, providerLink)
    const node = {
      ...agent(),
      workspace: { ...workspace(), path: providerLink, writes: ["src/**"] },
      permissions: {
        ...agent().permissions,
        execution: { sandbox: "workspace-write" as const }
      }
    }
    injectBeforeProviderBoundaryForTests(async () => {
      await rm(providerLink)
      await symlink(protectedRoot, providerLink)
    })
    await expect(
      new HerdrSurface().spawn({
        workflow: workflow(node),
        state: state(node.id),
        intent: intent(node.id),
        prompt: "Do not escape.",
        placement: placement(node.id)
      })
    ).rejects.toThrow("changed during launch")
    expect(
      await Bun.file(logPath)
        .text()
        .catch(() => "")
    ).toBe("")
    expect(await Bun.file(path.join(protectedRoot, "state-marker")).text()).toBe("untouched\n")
  })

  test("rejects a mutating declared write prefix with a symlink component", async () => {
    const realWrite = path.join(temporaryRoot, "real-write")
    const linkedWrite = path.join(temporaryRoot, "linked-write")
    await mkdir(realWrite)
    await symlink(realWrite, linkedWrite)
    const node = {
      ...agent(),
      workspace: { ...workspace(), writes: ["linked-write/**"] },
      permissions: {
        ...agent().permissions,
        execution: { sandbox: "workspace-write" as const }
      }
    }
    await expect(
      new HerdrSurface().spawn({
        workflow: workflow(node),
        state: state(node.id),
        intent: intent(node.id),
        prompt: "Do not follow write links.",
        placement: placement(node.id)
      })
    ).rejects.toThrow("contains a symlink component")
    expect(
      await Bun.file(logPath)
        .text()
        .catch(() => "")
    ).toBe("")
  })

  test("gives Claude only the attempt submission directory and exact completion operations", async () => {
    const node = claudeAgent()
    const runState = state(node.id)
    await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: runState,
      intent: intent(node.id),
      prompt: "Review and report completion.",
      placement: placement(node.id)
    })
    const log = await Bun.file(logPath).text()
    const submissionDirectory = path.dirname(runState.nodes[node.id]!.attempts[0]!.resultPath)
    const canonicalSubmissionDirectory = await realpath(submissionDirectory)
    const canonicalTemporaryRoot = await realpath(temporaryRoot)
    const canonicalSubmissionsRoot = `${canonicalTemporaryRoot}-state-submissions`
    const authoritativeRunDirectory = path.join(
      process.env.ORCHESTRATE_STATE_DIR!,
      "runs",
      runState.id
    )
    const settingsPath = path.join(submissionDirectory, "claude-settings.json")
    const settings = await Bun.file(settingsPath).text()
    expect(log).toContain(`--safe-mode --settings ${settingsPath}`)
    expect(log).toContain("--permission-mode dontAsk")
    expect(log).toContain("--tools Bash")
    // The PTY input line caps at 1024 bytes, so every launch stays typed
    // configuration-free: settings live in the file, never inline.
    expect(log).not.toContain("--allowedTools")
    expect(log).not.toContain('"failIfUnavailable"')
    const startLine = log.split("\n").find((line) => line.startsWith("agent start"))
    expect(startLine).toBeDefined()
    expect((startLine as string).length).toBeLessThan(1_024)
    expect(settings).toContain('"failIfUnavailable":true')
    expect(settings).toContain('"allowUnsandboxedCommands":false')
    expect(settings).toContain(`"allowRead":[${JSON.stringify(submissionDirectory)}]`)
    expect(settings).toContain(JSON.stringify(canonicalSubmissionsRoot))
    expect(log).not.toContain(`--add-dir ${submissionDirectory}`)
    expect(log).toContain(`--cwd ${canonicalSubmissionDirectory}`)
    expect(settings).not.toContain(`Edit(${submissionDirectory}/**)`)
    expect(log).not.toContain(`--add-dir ${authoritativeRunDirectory}`)
    expect(settings).toContain(
      `Bash('/tmp/orchestrate' 'node-done' '${runState.id}' '${node.id}' '--token' 'token-1' '--outcome' 'completed')`
    )
    expect(settings).toContain(
      `Bash('/tmp/orchestrate' 'node-done' '${runState.id}' '${node.id}' '--token' 'token-1' '--outcome' 'failed')`
    )
    expect(settings).toContain(
      `Bash('/tmp/orchestrate' 'node-done' '${runState.id}' '${node.id}' '--token' 'token-1' '--outcome' 'completed' '--hold')`
    )
    expect(log).not.toContain(`--add-dir ${process.env.ORCHESTRATE_STATE_DIR} `)
  })

  test("routes auto-review separately from the execution sandbox", async () => {
    const node = {
      ...agent(),
      permissions: {
        ...agent().permissions,
        escalation: "auto-review" as const
      }
    }
    await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: "Review without human approvals.",
      placement: placement(node.id)
    })
    const log = await Bun.file(logPath).text()
    const profileDocument = await Bun.file(profileCapturePath).text()
    expect(log).toContain("--ask-for-approval on-request")
    expect(log).toContain("--profile orchestrate-control-")
    expect(profileDocument).toContain('extends=":read-only"')
    expect(log).toContain('approvals_reviewer="auto_review"')
  })

  test("retries a newly created pane until its interactive shell is ready", async () => {
    await writeShim(true, true)
    const node = agent()
    await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: "Review after the shell is ready.",
      placement: placement(node.id)
    })
    const log = await Bun.file(logPath).text()
    expect(log.match(/agent start o-review-7f87e2e85f26e92d/g)).toHaveLength(2)
    expect(log).toContain("--timeout 120000")
  })

  test("captures and verifies the launching agent before prompting it", async () => {
    const surface = new HerdrSurface()
    const origin = await surface.captureOrigin()
    expect(origin).toEqual({
      workspaceId: "origin-workspace",
      tabId: "origin-tab",
      paneId: "origin-pane",
      provider: "codex",
      sessionId: "origin-session"
    })
    await surface.promptOrigin(origin!, "The workflow completed.")
    const log = await Bun.file(logPath).text()
    expect(log).toContain("agent get origin-pane")
    expect(log).toContain("agent prompt origin-pane The workflow completed.")
  })

  test("distinguishes a non-agent origin from invalid or failed Herdr observation", async () => {
    const shim = path.join(shimDirectory, "herdr")
    await Bun.write(
      shim,
      `#!/bin/sh\nprintf '%s\\n' '${herdrResponse({
        type: "pane_current",
        pane: herdrPane("p1", "w1", "t1", { agent: null, agent_session: null })
      })}'\n`,
      { createPath: false }
    )
    await chmod(shim, 0o755)
    expect(await new HerdrSurface().captureOrigin()).toBeNull()

    await Bun.write(
      shim,
      `#!/bin/sh\nprintf '%s\\n' '{"result":{"pane":{"agent":"codex","agent_session":{"agent":"codex","kind":"id","source":"herdr:codex","value":"origin-session"},"workspace_id":"w1","tab_id":"t1","pane_id":"p1"}}}'\n`,
      { createPath: false }
    )
    await expect(new HerdrSurface().captureOrigin()).rejects.toThrow(
      "invalid current-pane response"
    )

    await Bun.write(shim, "#!/bin/sh\nprintf '%s\\n' 'not-json'\n", { createPath: false })
    await expect(new HerdrSurface().captureOrigin()).rejects.toThrow(
      "invalid current-pane response"
    )

    await Bun.write(
      shim,
      `#!/bin/sh\nprintf '%s\\n' '{ "error": { "code": "server_unavailable", "message": "outage" }, "id": "cli:pane:current" }' >&2\nexit 1\n`,
      { createPath: false }
    )
    await expect(new HerdrSurface().captureOrigin()).rejects.toThrow("server_unavailable")
  })

  test("runs a command through the durable node-exit trampoline", async () => {
    const node = command()
    const surface = new HerdrSurface()
    const observation = await surface.spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: null,
      placement: placement(node.id)
    })
    const log = await Bun.file(logPath).text()
    expect(observation.providerSessionId).toBeNull()
    const runLine = log.split("\n").find((line) => line.startsWith("pane run p1")) as string
    // Every typed word must be quoting-free: the pane shell re-splits them.
    expect(runLine).toMatch(/^pane run p1 \/bin\/bash \S+command\.sh$/)
    const commandPath = runLine.split(" ").at(-1) as string
    const script = await Bun.file(commandPath).text()
    expect(script).toContain("node-exit")
    expect(script).toContain(`'/usr/bin/printf' 'ok' 2>&1 | tee "$ORCHESTRATE_OUTPUT_PATH"`)
  })

  test("creates a no-focus split in the selected group and closes a retry slot", async () => {
    const node = command()
    const anchor = {
      workspaceId: "w1",
      tabId: "t1",
      paneId: "anchor",
      group: "check",
      surface: "split" as const
    }
    await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: null,
      placement: {
        ...placement(node.id),
        surface: "split",
        anchorPane: anchor,
        reusePane: { ...anchor, paneId: "old-slot" }
      }
    })
    const log = await Bun.file(logPath).text()
    expect(log).toContain("pane split --pane old-slot --direction down")
    expect(log).toContain("--no-focus")
    expect(log).toContain("pane close old-slot")
  })

  test("replaces a resumed session in its existing tab instead of opening another tab", async () => {
    const node = command()
    const existing = {
      workspaceId: "w1",
      tabId: "t1",
      paneId: "session-pane",
      group: "session-group",
      surface: "tab" as const
    }
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: null,
      placement: { ...placement(node.id), reusePane: existing }
    })
    const log = await Bun.file(logPath).text()
    expect(log).toContain("pane get session-pane")
    expect(log).toContain("pane split --pane session-pane --direction down")
    expect(log).toContain("pane close session-pane")
    expect(log).not.toContain("tab create")
    expect(log).not.toContain("tab close")
    expect(observation.pane).toMatchObject({ group: "session-group", surface: "tab" })
  })

  test("verifies and replaces a live participant seat inside its declared workroom", async () => {
    const node = {
      ...agent(),
      workroom: "review-room",
      seat: "reviewer"
    } satisfies AgentNode
    const existing: PaneReference = {
      workspaceId: "w1",
      tabId: "review-tab",
      paneId: "reviewer-pane",
      group: "orchestrate/run/review-room/1",
      surface: "tab"
    }
    await writeShim(true, false, true, "none", null, false, "none", false, [
      herdrPane(existing.paneId, existing.workspaceId, existing.tabId)
    ])
    const spec: WorkflowSpec = {
      ...workflow(node),
      presentation: {
        workrooms: [
          {
            id: "review-room",
            label: "Review room",
            layout: "columns",
            seats: [{ id: "reviewer", label: "Reviewer" }],
            settlesOn: ["review"]
          }
        ]
      }
    }
    const runState: RunState = {
      ...state(node.id),
      workrooms: {
        "review-room": {
          id: "review-room",
          status: "active",
          workspaceId: existing.workspaceId,
          tabId: existing.tabId,
          seats: {
            reviewer: {
              id: "reviewer",
              status: "parked",
              nodeId: "review",
              pane: existing
            }
          }
        }
      }
    }
    await new HerdrSurface().spawn({
      workflow: spec,
      state: runState,
      intent: intent(node.id),
      prompt: "Review again.",
      placement: {
        ...placement(node.id),
        surface: "split",
        anchorPane: existing,
        reusePane: existing,
        splitDirection: "right",
        workroom: {
          id: "review-room",
          seatId: "reviewer",
          workspaceId: existing.workspaceId,
          tabId: existing.tabId,
          seats: [{ id: "reviewer", pane: existing }]
        }
      }
    })
    const log = await Bun.file(logPath).text()
    expect(log).toContain("pane list")
    expect(log).toContain("pane split --pane reviewer-pane --direction right")
    expect(log).toContain("pane close reviewer-pane")
    expect(log).not.toContain("tab create")
  })

  test("leaves a workroom spawn planned when missing-seat occupancy is ambiguous", async () => {
    const node = command()
    const missing: PaneReference = {
      workspaceId: "w1",
      tabId: "review-tab",
      paneId: "missing-seat",
      group: "orchestrate/run/review-room/1",
      surface: "tab"
    }
    await writeShim(true, false, true, "none", null, false, "none", false, [
      herdrPane("unowned-pane", "w1", "review-tab")
    ])
    await expect(
      new HerdrSurface().spawn({
        workflow: workflow(node),
        state: state(node.id),
        intent: intent(node.id),
        prompt: null,
        placement: {
          ...placement(node.id),
          surface: "split",
          anchorPane: null,
          reusePane: missing,
          workroom: {
            id: "review-room",
            seatId: "reviewer",
            workspaceId: "w1",
            tabId: "review-tab",
            seats: [{ id: "reviewer", pane: missing }]
          }
        }
      })
    ).rejects.toThrow("unowned live occupants")
    const log = await Bun.file(logPath).text()
    expect(log).not.toContain("workspace create")
    expect(log).not.toContain("tab create")
    expect(log).not.toContain("pane split")
  })

  test("does not spill a workroom seat when its verified anchor disappears", async () => {
    const node = command()
    const missing: PaneReference = {
      workspaceId: "w1",
      tabId: "review-tab",
      paneId: "missing-seat",
      group: "orchestrate/run/review-room/1",
      surface: "split"
    }
    const anchor: PaneReference = { ...missing, paneId: "implementer-pane" }
    await writeShim(true, false, true, "split-missing", null, false, "none", false, [
      herdrPane(anchor.paneId, anchor.workspaceId, anchor.tabId)
    ])
    await expect(
      new HerdrSurface().spawn({
        workflow: workflow(node),
        state: state(node.id),
        intent: intent(node.id),
        prompt: null,
        placement: {
          ...placement(node.id),
          surface: "split",
          anchorPane: anchor,
          reusePane: missing,
          workroom: {
            id: "review-room",
            seatId: "reviewer",
            workspaceId: "w1",
            tabId: "review-tab",
            seats: [
              { id: "implementer", pane: anchor },
              { id: "reviewer", pane: missing }
            ]
          }
        }
      })
    ).rejects.toThrow("changed after its occupancy was verified")
    const log = await Bun.file(logPath).text()
    expect(log).toContain("pane split --pane implementer-pane")
    expect(log).not.toContain("tab create")
  })

  test.each(["dedicated", "origin"] as const)(
    "falls back from an explicitly missing split anchor to a fresh %s-workspace tab",
    async (destination) => {
      await writeShim(true, false, true, "none", "stale-anchor")
      const node = command()
      const runState: RunState = {
        ...state(node.id),
        origin:
          destination === "origin"
            ? {
                workspaceId: "origin-workspace",
                tabId: "origin-tab",
                paneId: "origin-pane",
                provider: "codex",
                sessionId: "origin-session"
              }
            : null
      }
      const observation = await new HerdrSurface().spawn({
        workflow: workflow(node),
        state: runState,
        intent: intent(node.id),
        prompt: null,
        placement: {
          ...placement(node.id, destination),
          surface: "split",
          anchorPane: {
            workspaceId: destination === "origin" ? "origin-workspace" : "w1",
            tabId: "stale-tab",
            paneId: "stale-anchor",
            group: node.id,
            surface: "split"
          }
        }
      })
      const expectedWorkspace = destination === "origin" ? "origin-workspace" : "w1"
      expect(observation.pane).toMatchObject({
        workspaceId: expectedWorkspace,
        surface: "tab"
      })
      const log = await Bun.file(logPath).text()
      expect(log).toContain("pane get stale-anchor")
      if (destination === "dedicated") {
        expect(log).toContain("tab rename t1 check")
        expect(log).not.toContain("tab create --workspace w1")
      } else {
        expect(log).toContain(`tab create --workspace ${expectedWorkspace}`)
      }
      expect(log).not.toContain("pane split --pane stale-anchor")
    }
  )

  test("propagates split-anchor transport errors without creating a fallback pane", async () => {
    await writeShim(true, false, true, "transport")
    const node = command()
    await expect(
      new HerdrSurface().spawn({
        workflow: workflow(node),
        state: state(node.id),
        intent: intent(node.id),
        prompt: null,
        placement: {
          ...placement(node.id),
          surface: "split",
          anchorPane: {
            workspaceId: "w1",
            tabId: "tab-1",
            paneId: "anchor",
            group: node.id,
            surface: "split"
          }
        }
      })
    ).rejects.toThrow("Could not verify split anchor")
    const log = await Bun.file(logPath).text()
    expect(log).not.toContain("pane split --pane anchor")
    expect(log).not.toContain("tab create")
  })

  test("falls back exactly once when a verified split anchor closes before the split", async () => {
    await writeShim(true, false, true, "split-missing")
    const node = command()
    const runState = state(node.id)
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: runState,
      intent: intent(node.id),
      prompt: null,
      placement: {
        ...placement(node.id),
        surface: "split",
        anchorPane: {
          workspaceId: "w1",
          tabId: "tab-1",
          paneId: "anchor",
          group: node.id,
          surface: "split"
        }
      }
    })
    expect(observation.pane).toMatchObject({
      workspaceId: "w1",
      surface: "tab"
    })
    expect(runState.nodes.check?.attempts).toHaveLength(1)
    const log = await Bun.file(logPath).text()
    expect(log.match(/pane get anchor/g)).toHaveLength(1)
    expect(log.match(/pane split --pane anchor/g)).toHaveLength(1)
    expect(log.match(/tab rename t1 check/g)).toHaveLength(1)
    expect(log).not.toContain("tab create --workspace w1")
  })

  test("preserves split intent when the split itself has a transport error", async () => {
    await writeShim(true, false, true, "split-transport")
    const node = command()
    await expect(
      new HerdrSurface().spawn({
        workflow: workflow(node),
        state: state(node.id),
        intent: intent(node.id),
        prompt: null,
        placement: {
          ...placement(node.id),
          surface: "split",
          anchorPane: {
            workspaceId: "w1",
            tabId: "tab-1",
            paneId: "anchor",
            group: node.id,
            surface: "split"
          }
        }
      })
    ).rejects.toBeInstanceOf(HerdrObservationError)
    const log = await Bun.file(logPath).text()
    expect(log).toContain("pane split --pane anchor")
    expect(log).not.toContain("tab create")
  })

  test("adopts a receipt-backed pane after a crash before spawn observation was journaled", async () => {
    const node = command()
    const request = {
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: null,
      placement: placement(node.id)
    }
    const first = await new HerdrSurface().spawn(request)
    const recovered = await new HerdrSurface().recoverOrSpawn(request)
    expect(recovered).toEqual(first)
    const log = await Bun.file(logPath).text()
    expect(log.match(/workspace create/g)).toHaveLength(1)
    expect(log).not.toContain("tab create")
  })

  test("adopts one prompt after acceptance-before-receipt crash without closing or respawning", async () => {
    const node = agent()
    const runState = state(node.id)
    const activeIntent = intent(node.id)
    const request = {
      workflow: workflow(node),
      state: runState,
      intent: activeIntent,
      prompt: "Execute exactly once.",
      placement: placement(node.id)
    }
    const attempt = runState.nodes[node.id]!.attempts[0]!
    injectAfterAgentPromptForTests(async () => {
      await Bun.write(attempt.resultPath, '{"clean":true}\n', { createPath: false })
      await Bun.write(
        path.join(path.dirname(attempt.resultPath), "completion.json"),
        `${JSON.stringify({
          runId: runState.id,
          nodeId: node.id,
          token: activeIntent.token,
          outcome: "completed",
          hold: false
        })}\n`,
        { createPath: false }
      )
      throw new Error("injected crash after prompt acceptance")
    })
    await expect(new HerdrSurface().spawn(request)).rejects.toBeInstanceOf(HerdrObservationError)
    const recovered = await new HerdrSurface().recoverOrSpawn(request)
    expect(recovered.pane.paneId).toBe("p1")
    expect(await Bun.file(path.join(path.dirname(attempt.outputPath), "prompt.txt")).text()).toBe(
      "Execute exactly once."
    )
    const log = await Bun.file(logPath).text()
    expect(log.match(/workspace create/g)).toHaveLength(1)
    expect(log).not.toContain("tab create")
    expect(log.match(/agent start o-review-7f87e2e85f26e92d/g)).toHaveLength(1)
    expect(log.match(/agent prompt p1 Execute exactly once\./g)).toHaveLength(1)
    expect(log).not.toContain("pane close p1")
  })

  test("preserves a ready receipt when its pane liveness lookup has a service outage", async () => {
    const node = command()
    const request = {
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: null,
      placement: placement(node.id)
    }
    await new HerdrSurface().spawn(request)
    const receipt = path.join(temporaryRoot, "spawn.json")
    const before = await Bun.file(receipt).text()
    await writeShim(true, false, true, "transport")

    const failure = await new HerdrSurface()
      .recoverOrSpawn(request)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HerdrObservationError)
    expect((failure as Error).message).toContain("Could not verify receipt pane")
    expect(await Bun.file(receipt).text()).toBe(before)
    const log = await Bun.file(logPath).text()
    expect(log.match(/workspace create/g)).toHaveLength(1)
    expect(log).not.toContain("tab create")
  })

  test("stops for inspection when an incomplete receipt still has a live pane", async () => {
    const node = command()
    const request = {
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: null,
      placement: placement(node.id)
    }
    await new HerdrSurface().spawn(request)
    const receipt = path.join(temporaryRoot, "spawn.json")
    const value = JSON.parse(await Bun.file(receipt).text()) as Record<string, unknown>
    await Bun.write(receipt, `${JSON.stringify({ ...value, status: "created" })}\n`, {
      createPath: false
    })
    await expect(new HerdrSurface().recoverOrSpawn(request)).rejects.toThrow(
      'Spawn for node "check" is created; inspect pane "p1" and resume explicitly.'
    )
    const log = await Bun.file(logPath).text()
    expect(log).not.toContain("pane close p1")
    expect(log.match(/workspace create/g)).toHaveLength(1)
    expect(log).not.toContain("tab create")
  })

  test("abandons a planned receipt without starting another pane", async () => {
    const node = command()
    const request = {
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: null,
      placement: placement(node.id)
    }
    const surface = new HerdrSurface()
    await surface.spawn(request)
    await surface.abandonPlanned(request)
    const log = await Bun.file(logPath).text()
    expect(log).toContain("pane close p1")
    expect(log.match(/workspace create/g)).toHaveLength(1)
    expect(log).not.toContain("tab create")
  })

  test("creates distinct explicit Git worktrees for two repeat rounds and cleans both", async () => {
    for (const args of [
      ["init"],
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "init"
      ]
    ]) {
      const child = Bun.spawn(["git", ...args], {
        cwd: temporaryRoot,
        stdout: "ignore",
        stderr: "pipe"
      })
      expect(await child.exited).toBe(0)
    }
    const base = command()
    const node: CommandNode = {
      ...base,
      workspace: {
        mode: "git-worktree",
        path: path.join(
          path.dirname(temporaryRoot),
          `${path.basename(temporaryRoot)}-worktrees`,
          "{{nodeId}}"
        ),
        vcs: "git",
        writes: ["src/**"],
        exclusiveResources: [],
        git: {
          branch: "test/{{runId}}/{{nodeId}}",
          startPoint: "HEAD",
          removeOnClean: true
        }
      }
    }
    const spec = workflow(node)
    const repeatedNode = (id: string, round: number): NodeRunState => ({
      ...runtimeNode("check"),
      id,
      templateId: "check",
      origin: "loop-round",
      repeatId: "check-loop",
      round,
      attempts: [
        {
          ...runtimeNode("check").attempts[0]!,
          resultPath: path.join(temporaryRoot, id, "result.txt"),
          outputPath: path.join(temporaryRoot, id, "output.log")
        }
      ]
    })
    const firstId = "check--r1"
    const secondId = "check--r2"
    const runState: RunState = {
      ...state("check"),
      nodes: {
        [firstId]: repeatedNode(firstId, 1),
        [secondId]: repeatedNode(secondId, 2)
      }
    }
    for (const runtimeId of [firstId, secondId]) {
      await new HerdrSurface().spawn({
        workflow: spec,
        state: runState,
        intent: { ...intent(runtimeId), nodeId: runtimeId },
        prompt: null,
        placement: placement(runtimeId)
      })
    }
    const targets = [firstId, secondId].map((runtimeId) =>
      node.workspace.path!.replaceAll("{{nodeId}}", runtimeId)
    )
    expect(new Set(targets).size).toBe(2)
    for (const [index, target] of targets.entries()) {
      expect(
        await access(target).then(
          () => true,
          () => false
        )
      ).toBeTrue()
      expect(
        Bun.spawnSync(["git", "-C", target, "branch", "--show-current"]).stdout.toString().trim()
      ).toBe(`test/${runState.id}/check--r${index + 1}`)
    }

    const replacedTarget = targets[0] as string
    expect(
      Bun.spawnSync(["git", "worktree", "remove", replacedTarget], {
        cwd: temporaryRoot,
        stderr: "pipe"
      }).exitCode
    ).toBe(0)
    expect(
      Bun.spawnSync(["git", "worktree", "add", "-b", "replacement", replacedTarget, "HEAD"], {
        cwd: temporaryRoot,
        stderr: "pipe"
      }).exitCode
    ).toBe(0)
    await expect(removeWorkflowWorktrees(spec, runState)).rejects.toThrow(
      `is on branch "replacement", expected "test/${runState.id}/check--r1"`
    )
    expect(await access(replacedTarget).then(() => true)).toBeTrue()
    expect(
      Bun.spawnSync(["git", "worktree", "remove", replacedTarget], {
        cwd: temporaryRoot,
        stderr: "pipe"
      }).exitCode
    ).toBe(0)
    expect(
      Bun.spawnSync(["git", "worktree", "add", replacedTarget, `test/${runState.id}/check--r1`], {
        cwd: temporaryRoot,
        stderr: "pipe"
      }).exitCode
    ).toBe(0)
    const canonicalTargets = await Promise.all(targets.map((target) => realpath(target)))
    expect(await removeWorkflowWorktrees(spec, runState)).toEqual(canonicalTargets)
    for (const target of targets) {
      expect(
        await access(target).then(
          () => true,
          () => false
        )
      ).toBeFalse()
    }
    await rm(path.dirname(targets[0] as string), {
      recursive: true,
      force: true
    })
  })

  test("rejects unrelated and wrong-branch pre-existing worktree targets before pane creation", async () => {
    for (const args of [
      ["init"],
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "init"
      ]
    ]) {
      expect(
        await Bun.spawn(["git", ...args], {
          cwd: temporaryRoot,
          stdout: "ignore",
          stderr: "ignore"
        }).exited
      ).toBe(0)
    }
    const target = path.join(
      path.dirname(temporaryRoot),
      `${path.basename(temporaryRoot)}-existing`
    )
    const base = command()
    const node: CommandNode = {
      ...base,
      workspace: {
        mode: "git-worktree",
        path: target,
        vcs: "git",
        writes: [],
        exclusiveResources: [],
        git: { branch: "expected", startPoint: "HEAD", removeOnClean: false }
      }
    }
    const request = {
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: null,
      placement: placement(node.id)
    }
    await mkdir(target)
    await expect(new HerdrSurface().spawn(request)).rejects.toThrow("not a valid Git worktree")
    await rm(target, { recursive: true, force: true })
    expect(
      Bun.spawnSync(["git", "worktree", "add", "-b", "wrong", target, "HEAD"], {
        cwd: temporaryRoot,
        stderr: "pipe"
      }).exitCode
    ).toBe(0)
    await expect(new HerdrSurface().spawn(request)).rejects.toThrow(
      'is on branch "wrong", expected "expected"'
    )
    expect(
      await Bun.file(logPath)
        .text()
        .catch(() => "")
    ).toBe("")
    Bun.spawnSync(["git", "worktree", "remove", "--force", target], {
      cwd: temporaryRoot
    })
  })

  test("holds the prompt until the agent reports interactive readiness", async () => {
    await writeShim(true, false, true, "none", null, false, "none", true)
    const node = agent()
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: "Prompt",
      placement: placement(node.id)
    })
    expect(observation.providerSessionId).toBe("session-1")
    const log = await Bun.file(logPath).text()
    // Two readiness polls (not-ready, then ready) both precede the prompt.
    const promptIndex = log.indexOf("agent prompt p1")
    const polls = [...log.matchAll(/agent get p1/g)].filter(
      (match) => (match.index ?? 0) < promptIndex
    )
    expect(polls.length).toBeGreaterThanOrEqual(2)
  })

  test("delivers an over-budget prompt as a pointer to the durable prompt file", async () => {
    await writeShim(true)
    const node = agent()
    const longPrompt = `Review everything. ${"Detail. ".repeat(600)}`
    const runState = state(node.id)
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: runState,
      intent: intent(node.id),
      prompt: longPrompt,
      placement: placement(node.id)
    })
    expect(observation.providerSessionId).toBe("session-1")
    const attempt = runState.nodes[node.id]!.attempts[0]!
    const promptFile = path.join(path.dirname(attempt.resultPath), "prompt.txt")
    expect(await Bun.file(promptFile).text()).toBe(longPrompt)
    const log = await Bun.file(logPath).text()
    const promptLine = log.split("\n").find((line) => line.startsWith("agent prompt")) as string
    expect(promptLine).toContain(`saved it to ${promptFile}`)
    expect(promptLine).toContain("orchestrate launcher")
    expect(log).toContain("[orchestrate-delivery:token-1]")
    expect(promptLine).not.toContain("Detail. Detail.")
    expect(promptLine.length).toBeLessThan(1_024)
  })

  test("nudges a visible stalled prompt instead of resending its full text", async () => {
    await writeShim(true, false, true, "none", null, false, "stall-once")
    const node = agent()
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: "Prompt",
      placement: placement(node.id)
    })
    expect(observation.providerSessionId).toBe("session-1")
    const log = await Bun.file(logPath).text()
    expect(log.split("\n").filter((line) => line.startsWith("agent prompt")).length).toBe(1)
    expect(log).toContain("[orchestrate-delivery:token-1]")
    expect(log).toContain("agent send-keys p1 enter")
    expect(log).toContain("agent wait p1 --until working --until done --until blocked --timeout")
    expect(log).not.toContain("pane close p1")
  })

  test("retries a stalled prompt only while its unique marker remains invisible", async () => {
    await writeShim(true, false, true, "none", null, false, "stall-once-hidden")
    const node = agent()
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: "Prompt",
      placement: placement(node.id)
    })
    expect(observation.providerSessionId).toBe("session-1")
    const log = await Bun.file(logPath).text()
    expect(log.split("\n").filter((line) => line.startsWith("agent prompt")).length).toBe(2)
    expect(log).not.toContain("agent send-keys p1 enter")
    expect(log).not.toContain("pane close p1")
  }, 15_000)

  test("recovers an ambiguous Claude spawn from its recorded id and a token-valid submission", async () => {
    await writeShim(false, false, true, "none", null, false, "always")
    const node = {
      ...claudeAgent(),
      session: { mode: "fresh" as const, from: null, saveAs: "claude-session" }
    }
    const runState = state(node.id)
    const request = {
      workflow: workflow(node),
      state: runState,
      intent: intent(node.id),
      prompt: "Review and report completion.",
      placement: placement(node.id)
    }
    const surface = new HerdrSurface()
    const failure = await surface.spawn(request).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HerdrObservationError)
    expect((failure as Error).message).toContain("ambiguous")
    const attempt = runState.nodes[node.id]!.attempts[0]!
    const receipt = JSON.parse(
      await Bun.file(path.join(path.dirname(attempt.outputPath), "spawn.json")).text()
    ) as { status: string; providerSessionId: string | null }
    expect(receipt.status).toBe("ambiguous")
    expect(receipt.providerSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )

    // The agent finishes out of band and submits, then its pane disappears.
    // Recovery must adopt the exact launcher-chosen id without observing a
    // replacement session or re-prompting.
    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(
      completionSubmissionPath(attempt.resultPath),
      JSON.stringify({
        runId: runState.id,
        nodeId: node.id,
        token: "token-1",
        outcome: "completed",
        hold: false
      }),
      { createPath: false }
    )
    await writeShim(false, false, true, "none", "p1", false, "always")
    const before = await Bun.file(logPath).text()
    const observation = await surface.recoverOrSpawn(request)
    expect(observation.providerSessionId).toBe(receipt.providerSessionId)
    const after = await Bun.file(logPath).text()
    expect(after.split("agent get p1").length).toBe(before.split("agent get p1").length)
    expect(after.split("agent prompt").length).toBe(before.split("agent prompt").length)
    expect(after.split("agent start").length).toBe(before.split("agent start").length)
  })

  test("fails a dead prompt-bearing receipt instead of cross-wiring its completion token", async () => {
    await writeShim(false, false, true, "none", null, false, "always")
    const node = agent()
    const runState = state(node.id)
    const activeIntent = intent(node.id)
    const request = {
      workflow: workflow(node),
      state: runState,
      intent: activeIntent,
      prompt: "Review and report completion.",
      placement: placement(node.id)
    }
    const surface = new HerdrSurface()
    await expect(surface.spawn(request)).rejects.toBeInstanceOf(HerdrObservationError)
    const attempt = runState.nodes[node.id]!.attempts[0]!
    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(attempt.resultPath, '{"clean":true}\n', { createPath: false })
    await Bun.write(
      completionSubmissionPath(attempt.resultPath),
      `${JSON.stringify({
        runId: runState.id,
        nodeId: node.id,
        token: activeIntent.token,
        outcome: "completed",
        hold: false
      })}\n`,
      { createPath: false }
    )
    await writeShim(true, false, true, "none", "p1")
    const before = await Bun.file(logPath).text()

    await expect(surface.recoverOrSpawn(request)).rejects.toThrow(
      "failing this attempt instead of reusing its completion token"
    )
    const after = await Bun.file(logPath).text()
    expect(after.split("agent prompt").length).toBe(before.split("agent prompt").length)
    expect(after.split("agent start").length).toBe(before.split("agent start").length)
    const receipt = JSON.parse(
      await Bun.file(path.join(path.dirname(attempt.outputPath), "spawn.json")).text()
    ) as { status: string; providerSessionId: string | null }
    expect(receipt).toMatchObject({ status: "ambiguous", providerSessionId: null })
  })

  test("chooses the Claude session id at launch instead of observing herdr", async () => {
    // herdr never reports a claude session (safe-mode disables the hook that
    // would); the launcher-chosen id must make that irrelevant.
    await writeShim(false)
    const node = {
      ...claudeAgent(),
      session: { mode: "fresh" as const, from: null, saveAs: "claude-session" }
    }
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: "Review and report completion.",
      placement: placement(node.id)
    })
    expect(observation.providerSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    const log = await Bun.file(logPath).text()
    expect(log).toContain(`--session-id ${observation.providerSessionId}`)
    expect(log.slice(log.indexOf("agent prompt p1"))).not.toContain("agent get p1")
    // Claude sessions are project-scoped by cwd: lineage nodes launch from
    // the run-shared session directory, carved into the sandbox.
    const workspaceLine = log
      .split("\n")
      .find((line) => line.startsWith("workspace create")) as string
    expect(workspaceLine).toContain("claude-sessions")
    const runState = state(node.id)
    const settings = await Bun.file(
      path.join(
        path.dirname(runState.nodes[node.id]!.attempts[0]!.resultPath),
        "claude-settings.json"
      )
    ).text()
    expect(settings).toContain("claude-sessions")
  })

  test("records session-pending when herdr never reports a lineage session id", async () => {
    await writeShim(false)
    setAgentSessionTimeoutForTests(300)
    const node = agent()
    const surface = new HerdrSurface()
    const request = {
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: "Prompt",
      placement: placement(node.id)
    }
    const failure = await surface.spawn(request).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HerdrObservationError)
    expect((failure as Error).message).toContain("Session capture")
    expect((failure as Error).cause).toBeInstanceOf(Error)
    expect(((failure as Error).cause as Error).message).toContain("session.saveAs")
    const log = await Bun.file(logPath).text()
    expect(log.indexOf("agent prompt p1 Prompt")).toBeLessThan(log.lastIndexOf("agent get p1"))
    expect(log).not.toContain("pane close p1")

    // Reconcile retries only the session capture on the live pane: once the
    // provider reports its id, the receipt promotes to ready without a second
    // prompt delivery.
    await writeShim(true)
    const observation = await surface.recoverOrSpawn(request)
    expect(observation.providerSessionId).toBe("session-1")
    expect(observation.pane.paneId).toBe("p1")
    const healed = await Bun.file(logPath).text()
    expect(healed.split("agent prompt p1").length - 1).toBe(1)
    expect(healed.split("agent start").length - 1).toBe(1)

    const adopted = await surface.recoverOrSpawn(request)
    expect(adopted.providerSessionId).toBe("session-1")
  })

  test("keeps polling a working agent until the late session id arrives", async () => {
    await writeShim(true, false, true, "none", null, true)
    const node = agent()
    const observation = await new HerdrSurface().spawn({
      workflow: workflow(node),
      state: state(node.id),
      intent: intent(node.id),
      prompt: "Prompt",
      placement: placement(node.id)
    })
    expect(observation.providerSessionId).toBe("session-1")
    const log = await Bun.file(logPath).text()
    expect(log.split("agent get p1").length - 1).toBeGreaterThanOrEqual(2)
    expect(log).not.toContain("pane close p1")
  })
})
