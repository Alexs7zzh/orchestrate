import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  AgentNode,
  CommandNode,
  NodeRunState,
  RunState,
  SpawnIntent,
  WorkflowSpec
} from "../src/types.js"

import {
  HerdrObservationError,
  HerdrSurface,
  injectAfterAgentPromptForTests,
  injectBeforeProviderBoundaryForTests,
  removeWorkflowWorktrees
} from "../src/herdr-surface.js"

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

async function writeShim(
  reportSession = true,
  busyOnce = false,
  originLive = true,
  paneFailure: "none" | "transport" | "split-missing" | "split-transport" = "none",
  missingPane: string | null = null
): Promise<void> {
  const busyMarker = path.join(temporaryRoot, "agent-start-busy-once")
  const claudeMarker = path.join(temporaryRoot, "agent-is-claude")
  const body = `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
case "$1 $2" in
  "--version ") printf 'herdr 0.7.5\n' ;;
  "workspace create") printf '%s\n' '{"result":{"workspace":{"workspace_id":"w1"}}}' ;;
  "tab create") printf '%s\n' '{"result":{"root_pane":{"pane_id":"p1"},"tab":{"tab_id":"t1"}}}' ;;
  "pane split")
    if [ ${JSON.stringify(paneFailure)} = "split-missing" ]; then
      printf '%s\n' '{"error":{"code":"pane_not_found","message":"anchor closed"}}' >&2
      exit 1
    fi
    if [ ${JSON.stringify(paneFailure)} = "split-transport" ]; then
      printf '%s\n' '{"error":{"code":"server_unavailable","message":"service outage"}}' >&2
      exit 1
    fi
    printf '%s\n' '{"result":{"pane":{"pane_id":"p2","tab_id":"t1"}}}' ;;
  "pane current") printf '%s\n' '{"result":{"pane":{"agent":"codex","agent_session":{"agent":"codex","kind":"id","source":"herdr:codex","value":"origin-session"},"workspace_id":"origin-workspace","tab_id":"origin-tab","pane_id":"origin-pane"}}}' ;;
  "pane get")
    if [ ${JSON.stringify(paneFailure)} = "transport" ]; then
      printf '%s\n' '{"error":{"code":"server_unavailable","message":"service outage"}}' >&2
      exit 1
    fi
    if [ "$3" = ${JSON.stringify(missingPane ?? "")} ]; then
      printf '%s\n' '{"error":{"code":"pane_not_found","message":"pane missing"}}' >&2
      exit 1
    fi
    if [ "$3" = "origin-pane" ]; then
      if ${originLive ? "true" : "false"}; then
        printf '%s\n' '{"result":{"pane":{"workspace_id":"origin-workspace","tab_id":"origin-tab","pane_id":"origin-pane"}}}'
      else
        printf '%s\n' '{"error":{"code":"pane_not_found","message":"pane missing"}}' >&2
        exit 1
      fi
    else
      printf '%s\n' '{"result":{"pane":{"workspace_id":"w1","tab_id":"t1","pane_id":"p1"}}}'
    fi ;;
  "agent start")
    if ${busyOnce ? "true" : "false"} && [ ! -f ${JSON.stringify(busyMarker)} ]; then
      touch ${JSON.stringify(busyMarker)}
      printf '%s\n' '{ "error": { "code": "agent_pane_busy", "message": "agent target pane is not an available shell" } }' >&2
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
  "agent get")
    if [ "$3" = "origin-pane" ]; then
      printf '%s\n' '{"result":{"agent":{"agent_session":{"agent":"codex","kind":"id","source":"herdr:codex","value":"origin-session"}}}}'
    else
      if [ -f ${JSON.stringify(claudeMarker)} ]; then
        printf '%s\n' '${
          reportSession
            ? '{"result":{"agent":{"agent_status":"working","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"session-1"}}}}'
            : '{"result":{"agent":{}}}'
        }'
      else
        printf '%s\n' '${
          reportSession
            ? '{"result":{"agent":{"agent_status":"working","agent_session":{"agent":"codex","kind":"id","source":"herdr:codex","value":"session-1"}}}}'
            : '{"result":{"agent":{}}}'
        }'
      fi
    fi ;;
  *) printf '%s\n' '{"result":{"type":"ok"}}' ;;
esac
`
  const shim = path.join(shimDirectory, "herdr")
  await writeFile(shim, body)
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
    const log = await readFile(logPath, "utf8")
    expect(observation.pane.workspaceId).toBe("origin-workspace")
    expect(log).toContain("pane get origin-pane")
    expect(log).toContain("tab create --workspace origin-workspace")
    expect(log).not.toContain("workspace create")
  })

  test("uses a dedicated run workspace even when a live origin exists", async () => {
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
    const log = await readFile(logPath, "utf8")
    expect(log).toContain("workspace create")
    expect(log).toContain("tab create --workspace w1")
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
    const log = await readFile(logPath, "utf8")
    expect(observation.pane.workspaceId).toBe("w1")
    expect(log).toContain("pane get origin-pane")
    expect(log).toContain("workspace create")
    expect(log).toContain("tab create --workspace w1")
    expect(log).not.toContain("pane split --pane old-pane")
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
    const log = await readFile(logPath, "utf8")
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
    expect(log).toContain("agent start review --kind codex --pane p1")
    const submissionDirectory = path.dirname(state(node.id).nodes[node.id]!.attempts[0]!.resultPath)
    const runDirectory = path.join(process.env.ORCHESTRATE_STATE_DIR!, "runs", state(node.id).id)
    const profileDocument = await readFile(profileCapturePath, "utf8")
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
    expect(log.indexOf("agent prompt p1")).toBeLessThan(log.indexOf("agent get p1"))
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
    const log = await readFile(logPath, "utf8")
    expect(observation.providerSessionId).toBeNull()
    expect(log).toContain("agent prompt p1 Run without preserving this session.")
    expect(log).not.toContain("agent get p1")
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
    const log = await readFile(logPath, "utf8")
    const submissionDirectory = path.dirname(runState.nodes[node.id]!.attempts[0]!.resultPath)
    const authoritativeRunDirectory = path.join(
      process.env.ORCHESTRATE_STATE_DIR!,
      "runs",
      runState.id
    )
    const canonicalTemporaryRoot = await realpath(temporaryRoot)
    const canonicalAllowedRoot = path.join(canonicalTemporaryRoot, "allowed")
    const canonicalSubmissionsRoot = `${canonicalTemporaryRoot}-state-submissions`
    const profileDocument = await readFile(profileCapturePath, "utf8")
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
    expect(await readFile(logPath, "utf8").catch(() => "")).not.toContain("tab create")
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
    expect(await readFile(logPath, "utf8").catch(() => "")).toBe("")
  })

  test("rejects a protected-root symlink swap after the last preparation check without touching herdr", async () => {
    const safeTarget = path.join(temporaryRoot, "safe-target")
    const providerLink = path.join(temporaryRoot, "provider-root")
    const protectedRoot = process.env.ORCHESTRATE_STATE_DIR as string
    await mkdir(safeTarget)
    await mkdir(protectedRoot)
    await writeFile(path.join(protectedRoot, "state-marker"), "untouched\n")
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
    expect(await readFile(logPath, "utf8").catch(() => "")).toBe("")
    expect(await readFile(path.join(protectedRoot, "state-marker"), "utf8")).toBe("untouched\n")
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
    expect(await readFile(logPath, "utf8").catch(() => "")).toBe("")
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
    const log = await readFile(logPath, "utf8")
    const submissionDirectory = path.dirname(runState.nodes[node.id]!.attempts[0]!.resultPath)
    const canonicalSubmissionDirectory = await realpath(submissionDirectory)
    const canonicalTemporaryRoot = await realpath(temporaryRoot)
    const canonicalSubmissionsRoot = `${canonicalTemporaryRoot}-state-submissions`
    const authoritativeRunDirectory = path.join(
      process.env.ORCHESTRATE_STATE_DIR!,
      "runs",
      runState.id
    )
    expect(log).toContain("--safe-mode --settings")
    expect(log).toContain('"failIfUnavailable":true')
    expect(log).toContain('"allowUnsandboxedCommands":false')
    expect(log).toContain(`"allowRead":[${JSON.stringify(submissionDirectory)}]`)
    expect(log).toContain(JSON.stringify(canonicalSubmissionsRoot))
    expect(log).toContain("--permission-mode dontAsk")
    expect(log).toContain("--tools Bash")
    expect(log).not.toContain(`--add-dir ${submissionDirectory}`)
    expect(log).toContain(`--cwd ${canonicalSubmissionDirectory}`)
    expect(log).not.toContain(`Edit(${submissionDirectory}/**)`)
    expect(log).not.toContain(`--add-dir ${authoritativeRunDirectory}`)
    expect(log).toContain(
      `Bash('/tmp/orchestrate' 'node-done' '${runState.id}' '${node.id}' '--token' 'token-1' '--outcome' 'completed')`
    )
    expect(log).toContain(
      `Bash('/tmp/orchestrate' 'node-done' '${runState.id}' '${node.id}' '--token' 'token-1' '--outcome' 'failed')`
    )
    expect(log).toContain(
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
    const log = await readFile(logPath, "utf8")
    const profileDocument = await readFile(profileCapturePath, "utf8")
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
    const log = await readFile(logPath, "utf8")
    expect(log.match(/agent start review/g)).toHaveLength(2)
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
    const log = await readFile(logPath, "utf8")
    expect(log).toContain("agent get origin-pane")
    expect(log).toContain("agent prompt origin-pane The workflow completed.")
  })

  test("distinguishes a non-agent origin from invalid or failed Herdr observation", async () => {
    const shim = path.join(shimDirectory, "herdr")
    await writeFile(
      shim,
      `#!/bin/sh\nprintf '%s\\n' '{"result":{"pane":{"agent":null,"agent_session":null,"workspace_id":"w1","tab_id":"t1","pane_id":"p1"}}}'\n`
    )
    await chmod(shim, 0o755)
    expect(await new HerdrSurface().captureOrigin()).toBeNull()

    await writeFile(shim, "#!/bin/sh\nprintf '%s\\n' 'not-json'\n")
    await expect(new HerdrSurface().captureOrigin()).rejects.toThrow(
      "invalid current-pane response"
    )

    await writeFile(
      shim,
      `#!/bin/sh\nprintf '%s\\n' '{ "error": { "code": "server_unavailable", "message": "outage" } }' >&2\nexit 1\n`
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
    const log = await readFile(logPath, "utf8")
    expect(observation.providerSessionId).toBeNull()
    expect(log).toContain("pane run p1 /bin/bash -c")
    expect(log).toContain("node-exit")
    expect(log).toContain("/usr/bin/printf ok")
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
    const log = await readFile(logPath, "utf8")
    expect(log).toContain("pane split --pane anchor --direction down")
    expect(log).toContain("--no-focus")
    expect(log).toContain("pane close old-slot")
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
      const log = await readFile(logPath, "utf8")
      expect(log).toContain("pane get stale-anchor")
      expect(log).toContain(`tab create --workspace ${expectedWorkspace}`)
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
    const log = await readFile(logPath, "utf8")
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
    const log = await readFile(logPath, "utf8")
    expect(log.match(/pane get anchor/g)).toHaveLength(1)
    expect(log.match(/pane split --pane anchor/g)).toHaveLength(1)
    expect(log.match(/tab create --workspace w1/g)).toHaveLength(1)
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
    const log = await readFile(logPath, "utf8")
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
    const log = await readFile(logPath, "utf8")
    expect(log.match(/tab create/g)).toHaveLength(1)
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
      await writeFile(attempt.resultPath, '{"clean":true}\n')
      await writeFile(
        path.join(path.dirname(attempt.resultPath), "completion.json"),
        `${JSON.stringify({
          runId: runState.id,
          nodeId: node.id,
          token: activeIntent.token,
          outcome: "completed",
          hold: false
        })}\n`
      )
      throw new Error("injected crash after prompt acceptance")
    })
    await expect(new HerdrSurface().spawn(request)).rejects.toBeInstanceOf(HerdrObservationError)
    const recovered = await new HerdrSurface().recoverOrSpawn(request)
    expect(recovered.pane.paneId).toBe("p1")
    expect(await readFile(path.join(path.dirname(attempt.outputPath), "prompt.txt"), "utf8")).toBe(
      "Execute exactly once."
    )
    const log = await readFile(logPath, "utf8")
    expect(log.match(/tab create/g)).toHaveLength(1)
    expect(log.match(/agent start review/g)).toHaveLength(1)
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
    const before = await readFile(receipt, "utf8")
    await writeShim(true, false, true, "transport")

    const failure = await new HerdrSurface()
      .recoverOrSpawn(request)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HerdrObservationError)
    expect((failure as Error).message).toContain("Could not verify receipt pane")
    expect(await readFile(receipt, "utf8")).toBe(before)
    const log = await readFile(logPath, "utf8")
    expect(log.match(/tab create/g)).toHaveLength(1)
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
    const value = JSON.parse(await readFile(receipt, "utf8")) as Record<string, unknown>
    await writeFile(receipt, `${JSON.stringify({ ...value, status: "created" })}\n`)
    await expect(new HerdrSurface().recoverOrSpawn(request)).rejects.toThrow(
      'Spawn for node "check" is created; inspect pane "p1" and resume explicitly.'
    )
    const log = await readFile(logPath, "utf8")
    expect(log).not.toContain("pane close p1")
    expect(log.match(/tab create/g)).toHaveLength(1)
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
    const log = await readFile(logPath, "utf8")
    expect(log).toContain("pane close p1")
    expect(log.match(/tab create/g)).toHaveLength(1)
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
    expect(await readFile(logPath, "utf8").catch(() => "")).toBe("")
    Bun.spawnSync(["git", "worktree", "remove", "--force", target], {
      cwd: temporaryRoot
    })
  })

  test("fails a lineage-requiring spawn when herdr reports no session", async () => {
    await writeShim(false)
    const node = agent()
    const surface = new HerdrSurface()
    const failure = await surface
      .spawn({
        workflow: workflow(node),
        state: state(node.id),
        intent: intent(node.id),
        prompt: "Prompt",
        placement: placement(node.id)
      })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(HerdrObservationError)
    expect((failure as Error).message).toContain("Prompt delivery")
    expect((failure as Error).cause).toBeInstanceOf(Error)
    expect(((failure as Error).cause as Error).message).toContain("session.saveAs")
    const log = await readFile(logPath, "utf8")
    expect(log.indexOf("agent prompt p1 Prompt")).toBeLessThan(log.indexOf("agent get p1"))
    expect(log).not.toContain("pane close p1")
  })
})
