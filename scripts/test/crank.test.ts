import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  AgentNode,
  CommandNode,
  PaneReference,
  RunOrigin,
  UiPreferences,
  WorkflowNode,
  WorkflowSpec
} from "../src/types.js"

import {
  MAX_RESULT_BYTES,
  crankRun,
  handleHerdrAgentStatusEvent,
  originHandoffEvents,
  readBoundedResult,
  reconcileRun,
  startWorkflowRun,
  submitNodeDone,
  type CrankSurface
} from "../src/crank.js"
import { HerdrObservationError, type SpawnRequest } from "../src/herdr-surface.js"
import { DEFAULT_UI_PREFERENCES } from "../src/preferences.js"
import { prepareNode } from "../src/prompt.js"
import { replayEvents } from "../src/state-patch.js"
import {
  completionSubmissionPath,
  eventsPath,
  injectAtomicWriteFaultForTests,
  persistNewRun,
  readEvents,
  readRunState,
  runDirectory,
  runNeedsAttention,
  runStatePath,
  runtimeBuild
} from "../src/state.js"
import { createInitialRunState, transition } from "../src/transition.js"
import { validateWorkflow } from "../src/validation.js"

let temporaryRoot = ""

function workspace() {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "none" as const,
    writes: [],
    exclusiveResources: []
  }
}

function command(
  id: string,
  needs: readonly string[] = [],
  gate: CommandNode["gate"] = "none",
  overrides: Partial<CommandNode> = {}
): CommandNode {
  return {
    id,
    type: "command",
    title: id,
    needs,
    cwd: null,
    workspace: workspace(),
    inputs: [],
    retry: { maxAttempts: 1 },
    gate,
    argv: ["/usr/bin/true"],
    mutates: false,
    inheritEnv: [],
    env: {},
    allowedExitCodes: [0],
    ...overrides
  }
}

function agent(
  id: string,
  needs: readonly string[] = [],
  overrides: Partial<AgentNode> = {}
): AgentNode {
  return {
    id,
    type: "agent",
    title: id,
    needs,
    cwd: null,
    workspace: workspace(),
    inputs: [],
    retry: { maxAttempts: 1 },
    gate: "none",
    provider: "codex",
    model: "provider-default",
    effort: null,
    prompt: "Return a JSON verdict.",
    session: { mode: "fresh", from: null, saveAs: null },
    permissions: {
      execution: { sandbox: "read-only" },
      escalation: "deny",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
    output: {
      format: "json",
      schema: {
        type: "object",
        properties: { clean: { type: "boolean" } },
        required: ["clean"],
        additionalProperties: false
      }
    },
    ...overrides
  } as AgentNode
}

function workflow(nodes: readonly WorkflowNode[]): WorkflowSpec {
  return {
    name: "crank-test",
    objective: "Exercise the file-locked shell.",
    cwd: temporaryRoot,
    concurrency: 2,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes,
    repeats: []
  }
}

class FakeSurface implements CrankSurface {
  readonly spawns: string[] = []
  readonly requests: SpawnRequest[] = []
  readonly closed: string[] = []
  readonly renamed: Array<readonly [string, string]> = []
  readonly handoffs: string[] = []
  readonly notifications: Array<readonly [string, string, "none" | "done" | "request"]> = []
  waitForAgentStatus?: (paneId: string, status: string, timeoutMs: number) => Promise<boolean>
  readonly origin: RunOrigin = {
    workspaceId: "origin-workspace",
    tabId: "origin-tab",
    paneId: "origin-pane",
    provider: "codex",
    sessionId: "origin-session"
  }

  async connect(): Promise<void> {}

  async captureOrigin(): Promise<RunOrigin> {
    return this.origin
  }

  async recoverOrSpawn(
    request: SpawnRequest
  ): Promise<{ pane: PaneReference; providerSessionId: string | null }> {
    this.spawns.push(request.intent.id)
    this.requests.push(request)
    const attempt = request.state.nodes[request.intent.nodeId]?.attempts.at(-1)
    if (attempt !== undefined) {
      await mkdir(path.dirname(attempt.outputPath), { recursive: true })
      await Bun.write(attempt.outputPath, "", { createPath: false })
    }
    const pane: PaneReference = {
      workspaceId: "workspace",
      tabId: `tab:${request.intent.nodeId}`,
      paneId: `pane:${request.intent.id}`,
      group: request.placement.group,
      surface: request.placement.surface
    }
    return { pane, providerSessionId: null }
  }

  async closePane(paneId: string): Promise<void> {
    this.closed.push(paneId)
  }

  async renamePane(paneId: string, label: string): Promise<void> {
    this.renamed.push([paneId, label])
  }

  async notify(title: string, body: string, sound: "none" | "done" | "request"): Promise<void> {
    this.notifications.push([title, body, sound])
  }

  async promptOrigin(origin: RunOrigin, prompt: string): Promise<void> {
    expect(origin).toEqual(this.origin)
    this.handoffs.push(prompt)
  }
}

async function start(
  spec: WorkflowSpec,
  surface: FakeSurface,
  ui: UiPreferences = DEFAULT_UI_PREFERENCES
) {
  const digest = validateWorkflow(spec).digest
  if (digest === null) {
    throw new Error("invalid test workflow")
  }
  return startWorkflowRun(spec, ui, {
    runId: "20260802120000-1234abcd",
    digest,
    allowWriteConflicts: false,
    surface,
    now: () => "2026-08-02T12:00:00.000Z"
  })
}

async function persistPlanned(spec: WorkflowSpec) {
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
    origin: new FakeSurface().origin
  })
  const runDir = runDirectory(runId)
  const started = transition(initial, spec, { type: "run" }, initial.createdAt, {
    prepareNode: (state, workflowSpec, node) => prepareNode(workflowSpec, state, runDir, node.id)
  })
  await persistNewRun(spec, DEFAULT_UI_PREFERENCES, started.state, started.events)
  return { runDir, state: started.state, digest }
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-crank-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
})

afterEach(async () => {
  delete process.env.ORCHESTRATE_STATE_DIR
  injectAtomicWriteFaultForTests(null)
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe("crank shell", () => {
  test("records and reports a board-open failure after the run is durable", async () => {
    class BrokenBoardSurface extends FakeSurface {
      async openBoard(): Promise<void> {
        throw new Error("board split failed")
      }
    }
    const surface = new BrokenBoardSurface()
    const started = await start(workflow([command("build")]), surface)

    expect(started.events).toContainEqual(
      expect.objectContaining({
        type: "ui.degraded",
        message: expect.stringContaining("board split failed")
      })
    )
    expect(surface.notifications).toContainEqual([
      "crank-test · board unavailable",
      expect.stringContaining(`orchestrate board ${started.state.id}`),
      "request"
    ])
    expect((await readEvents(runDirectory(started.state.id))).map((event) => event.type)).toContain(
      "ui.degraded"
    )
  })

  test("runs a two-command dependency chain and preserves replay", async () => {
    const surface = new FakeSurface()
    const spec = workflow([command("first"), command("second", ["first"])])
    const started = await start(spec, surface)
    expect(started.state.nodes.first?.status).toBe("running")
    expect(started.state.nodes.second?.status).toBe("pending")

    const firstToken = started.state.nodes.first?.attempts.at(-1)?.token as string
    const firstOutput = started.state.nodes.first?.attempts.at(-1)?.outputPath as string
    await Bun.write(firstOutput, "first output\n", { createPath: false })
    const afterFirst = await crankRun(
      runDirectory(started.state.id),
      {
        type: "node-exit",
        nodeId: "first",
        token: firstToken,
        code: 0,
        error: null
      },
      { surface }
    )
    expect(afterFirst.state.nodes.second?.status).toBe("running")
    expect(afterFirst.state.nodes.first?.resultPath).toBe(firstOutput)
    expect(afterFirst.state.nodes.first?.result).toBe("first output\n")
    const secondToken = afterFirst.state.nodes.second?.attempts.at(-1)?.token as string
    const finished = await crankRun(
      runDirectory(started.state.id),
      {
        type: "node-exit",
        nodeId: "second",
        token: secondToken,
        code: 0,
        error: null
      },
      { surface }
    )
    expect(finished.state.status).toBe("completed")
    const events = await readEvents(runDirectory(started.state.id))
    expect(replayEvents(events)).toEqual(await readRunState(runDirectory(started.state.id)))
    expect(surface.spawns).toEqual(["first:a1", "second:a1"])
    expect(surface.handoffs).toHaveLength(1)
    expect(surface.handoffs[0]).toContain(`Orchestrate run ${finished.state.id} completed.`)
  })

  test("persists revised graph order and schedules reviews only after quality", async () => {
    const surface = new FakeSurface()
    const base = workflow([
      command("board-ui-fix"),
      command("quality-fix", ["board-ui-fix"]),
      command("runtime-review", ["quality-fix"]),
      command("surface-review", ["quality-fix"]),
      command("contract-doc-review", ["quality-fix"])
    ])
    const started = await start(base, surface)
    const runDir = runDirectory(started.state.id)
    const revised = workflow([
      command("board-ui-fix"),
      command("completion-control-fix", ["board-ui-fix"]),
      command("board-live-placement-fix", ["completion-control-fix"]),
      command("quality-fix", ["board-live-placement-fix"]),
      command("runtime-review", ["quality-fix"]),
      command("surface-review", ["quality-fix"]),
      command("contract-doc-review", ["quality-fix"])
    ])
    const digest = validateWorkflow(revised).digest
    if (digest === null) {
      throw new Error("invalid revised workflow")
    }
    await crankRun(
      runDir,
      {
        type: "propose-revision",
        workflow: revised,
        digest,
        summary: ["insert completion and live fixes"]
      },
      { surface }
    )
    const approved = await crankRun(runDir, { type: "approve-revision", digest }, { surface })
    expect(Object.keys(approved.state.nodes)).toEqual(revised.nodes.map((node) => node.id))
    expect(approved.state.nodes["quality-fix"]?.needs).toEqual(["board-live-placement-fix"])
    expect(surface.spawns).toEqual(["board-ui-fix:a1"])
    const replayedApproval = replayEvents(await readEvents(runDir))
    expect(replayedApproval).toEqual(await readRunState(runDir))
    expect(Object.keys(replayedApproval.nodes)).toEqual(revised.nodes.map((node) => node.id))

    const complete = async (nodeId: string) => {
      const current = await readRunState(runDir)
      const attempt = current.nodes[nodeId]?.attempts.at(-1)
      if (attempt === undefined) {
        throw new Error(`missing attempt for ${nodeId}`)
      }
      return crankRun(
        runDir,
        {
          type: "node-exit",
          nodeId,
          token: attempt.token,
          code: 0,
          error: null
        },
        { surface }
      )
    }

    await complete("board-ui-fix")
    await complete("completion-control-fix")
    const beforeQuality = await complete("board-live-placement-fix")
    expect(beforeQuality.state.nodes["quality-fix"]?.status).toBe("running")
    expect(
      ["runtime-review", "surface-review", "contract-doc-review"].map(
        (id) => beforeQuality.state.nodes[id]?.status
      )
    ).toEqual(["pending", "pending", "pending"])

    const afterQuality = await complete("quality-fix")
    expect(
      ["runtime-review", "surface-review", "contract-doc-review"].map(
        (id) => afterQuality.state.nodes[id]?.status
      )
    ).toEqual(["running", "running", "ready"])
    expect(replayEvents(await readEvents(runDir))).toEqual(await readRunState(runDir))
  })

  test("returns terminal failures to the launching agent but keeps human stops silent", async () => {
    const failedSurface = new FakeSurface()
    const failed = await start(workflow([command("check")]), failedSurface)
    const failedToken = failed.state.nodes.check?.attempts.at(-1)?.token as string
    const settled = await crankRun(
      runDirectory(failed.state.id),
      {
        type: "node-exit",
        nodeId: "check",
        token: failedToken,
        code: 1,
        error: "check failed"
      },
      { surface: failedSurface }
    )
    expect(settled.state.status).toBe("failed")
    expect(failedSurface.handoffs).toHaveLength(1)
    expect(failedSurface.handoffs[0]).toContain("failed")
    expect(failedSurface.handoffs[0]).toContain("run.failed")

    await rm(runDirectory(failed.state.id), { recursive: true, force: true })
    const stoppedSurface = new FakeSurface()
    const running = await start(workflow([command("check")]), stoppedSurface)
    const stopped = await crankRun(
      runDirectory(running.state.id),
      { type: "stop" },
      { surface: stoppedSurface }
    )
    expect(stopped.state.status).toBe("stopped")
    expect(stoppedSurface.handoffs).toEqual([])
  })

  test("keeps a committed completion successful when origin handoff and fallback both fail", async () => {
    const surface = new FakeSurface()
    let fallbackAttempts = 0
    surface.promptOrigin = async () => {
      throw new Error("origin unavailable")
    }
    surface.notify = async (title) => {
      if (title.includes("origin handoff fallback")) {
        fallbackAttempts += 1
        throw new Error("notifications unavailable")
      }
    }
    const started = await start(workflow([command("check")]), surface)
    const token = started.state.nodes.check?.attempts.at(-1)?.token as string
    const runDir = runDirectory(started.state.id)

    const completed = await crankRun(
      runDir,
      { type: "node-exit", nodeId: "check", token, code: 0, error: null },
      { surface }
    )

    expect(completed.state.status).toBe("completed")
    expect((await readRunState(runDir)).status).toBe("completed")
    expect(fallbackAttempts).toBe(1)
  })

  test("reports an invalid submission path after consuming independent valid work", async () => {
    const surface = new FakeSurface()
    const started = await start(workflow([agent("review"), agent("independent")]), surface)
    const reviewAttempt = started.state.nodes.review?.attempts.at(-1)
    const independentAttempt = started.state.nodes.independent?.attempts.at(-1)
    if (reviewAttempt === undefined || independentAttempt === undefined) {
      throw new Error("missing attempts")
    }
    const runDir = runDirectory(started.state.id)
    await mkdir(path.dirname(reviewAttempt.resultPath), { recursive: true })
    await mkdir(path.dirname(independentAttempt.resultPath), { recursive: true })
    await Bun.write(reviewAttempt.resultPath, '{"clean":"not-boolean"}\n', { createPath: false })
    await Bun.write(independentAttempt.resultPath, '{"clean":true}\n', { createPath: false })
    await submitNodeDone(runDir, "review", reviewAttempt.token, "completed")
    await submitNodeDone(runDir, "independent", independentAttempt.token, "completed")
    await expect(reconcileRun(runDir, { surface })).rejects.toThrow(
      "Replace or remove the named completion envelope"
    )
    const partiallyReconciled = await readRunState(runDir)
    expect(partiallyReconciled.nodes.review?.status).toBe("running")
    expect(partiallyReconciled.nodes.independent?.status).toBe("completed")
    expect(
      await reconcileRun(runDir, { surface }).catch((error: unknown) => String(error))
    ).toContain(completionSubmissionPath(reviewAttempt.resultPath))

    await Bun.write(reviewAttempt.resultPath, '{"clean":true}\n', { createPath: false })
    const finished = await reconcileRun(runDir, { surface })
    expect(finished.state.status).toBe("completed")
    expect(finished.state.nodes.review?.result).toEqual({ clean: true })
  })

  test("rejects an oversized provider result before reading or journaling it", async () => {
    const surface = new FakeSurface()
    const started = await start(workflow([agent("review")]), surface)
    const attempt = started.state.nodes.review?.attempts.at(-1)
    if (attempt === undefined) {
      throw new Error("missing attempt")
    }
    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(attempt.resultPath, "x".repeat(MAX_RESULT_BYTES + 1), { createPath: false })
    const runDir = runDirectory(started.state.id)
    await submitNodeDone(runDir, "review", attempt.token, "completed")
    await expect(reconcileRun(runDir, { surface })).rejects.toThrow(
      `${MAX_RESULT_BYTES}-byte result limit`
    )
    expect((await readRunState(runDir)).nodes.review?.status).toBe("running")
  })

  test("rejects a provider result symlink without reading its target", async () => {
    const secret = path.join(temporaryRoot, "outside-secret.txt")
    const result = path.join(temporaryRoot, "submission", "result.txt")
    await Bun.write(secret, "must not escape", { createPath: false })
    await mkdir(path.dirname(result), { recursive: true })
    await symlink(secret, result)

    await expect(readBoundedResult(result, "Provider result")).rejects.toThrow(
      "not a symbolic link"
    )
  })

  test("rejects non-regular provider result files", async () => {
    const result = path.join(temporaryRoot, "submission-directory")
    await mkdir(result)

    await expect(readBoundedResult(result, "Provider result")).rejects.toThrow(
      "must be a regular file"
    )
  })

  test("serializes simultaneous cranks without losing either hold", async () => {
    const surface = new FakeSurface()
    const started = await start(
      workflow([command("left", [], "approval"), command("right", [], "approval")]),
      surface
    )
    const runDir = runDirectory(started.state.id)
    await Promise.all([
      crankRun(runDir, { type: "hold", nodeId: "left" }, { surface }),
      crankRun(runDir, { type: "hold", nodeId: "right" }, { surface })
    ])
    const state = await readRunState(runDir)
    expect(Object.keys(state.holds).toSorted()).toEqual(["left", "right"])
    expect(state.sequence).toBe((await readEvents(runDir)).length)
  })

  test("applies continuation policy as holds before panes can complete", async () => {
    const surface = new FakeSurface()
    const ui: UiPreferences = {
      ...DEFAULT_UI_PREFERENCES,
      continuation: {
        rules: [
          {
            match: {
              type: "agent",
              provider: "any",
              level: "any",
              origin: "any",
              id: "*"
            },
            autoContinue: false
          },
          {
            match: {
              type: "any",
              provider: "any",
              level: "any",
              origin: "any",
              id: "*"
            },
            autoContinue: true
          }
        ]
      }
    }
    const started = await start(workflow([agent("review")]), surface, ui)
    expect(started.state.holds.review?.scope).toBe("instance")
    expect(started.events.map((event) => event.type)).toContain("hold.set")
    expect(runNeedsAttention(started.state)).toBe(false)
    const attempt = started.state.nodes.review?.attempts.at(-1)
    if (attempt === undefined) {
      throw new Error("missing review attempt")
    }
    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(attempt.resultPath, '{"clean":true}\n', { createPath: false })
    await submitNodeDone(runDirectory(started.state.id), "review", attempt.token, "completed")
    const completed = await reconcileRun(runDirectory(started.state.id), { surface })
    expect(completed.state.nodes.review?.status).toBe("completed")
    expect(completed.state.status).toBe("running")
    expect(runNeedsAttention(completed.state)).toBe(true)
  })

  test("spawns the start within maxStarts before pausing later candidates", async () => {
    const surface = new FakeSurface()
    const spec = {
      ...workflow([command("first"), command("later")]),
      concurrency: 2,
      limits: { maxStarts: 1 }
    }
    const started = await start(spec, surface)
    expect(surface.spawns).toEqual(["first:a1"])
    expect(started.state.starts).toBe(1)
    expect(started.state.status).toBe("paused")
    expect(started.state.pause?.kind).toBe("fuse")
    expect(started.state.nodes.first?.status).toBe("running")
    expect(started.state.nodes.later?.status).toBe("ready")
  })

  test("repairs a same-sequence malicious snapshot without spawning or presenting", async () => {
    const launchSurface = new FakeSurface()
    const started = await start(
      workflow([agent("provider"), agent("dependent", ["provider"])]),
      launchSurface
    )
    const runDir = runDirectory(started.state.id)
    const authoritative = await readRunState(runDir)
    const provider = authoritative.nodes.provider!
    const attempt = provider.attempts.at(-1)!
    const tampered = {
      ...authoritative,
      nodes: {
        ...authoritative.nodes,
        provider: {
          ...provider,
          status: "completed" as const,
          attempts: [
            ...provider.attempts.slice(0, -1),
            {
              ...attempt,
              status: "completed" as const,
              finishedAt: authoritative.updatedAt
            }
          ],
          resultPath: attempt.resultPath,
          result: { clean: true }
        }
      }
    }
    await Bun.write(runStatePath(runDir), `${JSON.stringify(tampered, null, 2)}\n`, {
      createPath: false
    })

    const restarted = new FakeSurface()
    const drained = await reconcileRun(runDir, {
      surface: restarted
    })
    expect(drained.state).toEqual(authoritative)
    expect(restarted.spawns).toEqual([])
    expect(restarted.handoffs).toEqual([])
    expect(JSON.parse(await Bun.file(runStatePath(runDir)).text())).toEqual(authoritative)
  })

  test("commits completed and hold records atomically before trusted reconciliation can race", async () => {
    const surface = new FakeSurface()
    const started = await start(
      workflow([agent("provider"), agent("dependent", ["provider"])]),
      surface
    )
    const runDir = runDirectory(started.state.id)
    const attempt = started.state.nodes.provider?.attempts.at(-1)
    if (attempt === undefined) {
      throw new Error("missing provider attempt")
    }
    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(attempt.resultPath, '{"clean":true}\n', { createPath: false })
    await submitNodeDone(runDir, "provider", attempt.token, "completed", true)
    const beforeFailedCommit = await readRunState(runDir)
    const beforeJournal = await Bun.file(eventsPath(runDir)).text()
    injectAtomicWriteFaultForTests({
      targetPath: eventsPath(runDir),
      afterBytes: 41,
      preserveTemporary: true,
      error: Object.assign(new Error("injected completion-plus-hold ENOSPC"), { code: "ENOSPC" })
    })
    await expect(reconcileRun(runDir, { surface })).rejects.toThrow("completion-plus-hold ENOSPC")
    expect(await Bun.file(eventsPath(runDir)).text()).toBe(beforeJournal)
    expect(await readRunState(runDir)).toEqual(beforeFailedCommit)
    expect((await readRunState(runDir)).holds.provider).toBeUndefined()
    expect((await readRunState(runDir)).nodes.dependent?.status).toBe("pending")

    const held = await reconcileRun(runDir, { surface })
    expect(held.state.nodes.provider?.status).toBe("completed")
    expect(held.state.holds.provider?.scope).toBe("instance")
    expect(held.state.nodes.dependent?.status).toBe("pending")
    expect(surface.spawns).toEqual(["provider:a1"])

    const journal = await readEvents(runDir)
    const completionIndex = journal.findIndex(
      (event) => event.type === "node.completed" && event.nodeId === "provider"
    )
    expect(completionIndex).toBeGreaterThanOrEqual(0)
    expect(journal[completionIndex + 1]).toMatchObject({
      type: "hold.set",
      nodeId: "provider",
      data: { scope: "instance", source: "node-done" }
    })
    expect(
      journal
        .slice(completionIndex, completionIndex + 2)
        .some((event) => event.type === "node.spawn-planned" && event.nodeId === "dependent")
    ).toBe(false)
    expect(replayEvents(journal)).toEqual(held.state)

    const released = await crankRun(runDir, { type: "release", nodeId: "provider" }, { surface })
    expect(released.state.nodes.provider?.status).toBe("completed")
    expect(released.state.nodes.dependent?.status).toBe("running")
    expect(surface.spawns).toEqual(["provider:a1", "dependent:a1"])
  })

  test("preserves a validated failure result without injecting it into the master handoff", async () => {
    const surface = new FakeSurface()
    const textAgent: AgentNode = {
      ...agent("compile"),
      output: { format: "text", schema: null }
    }
    const started = await start(workflow([textAgent]), surface)
    const runDir = runDirectory(started.state.id)
    const attempt = started.state.nodes.compile?.attempts.at(-1)
    if (attempt === undefined) {
      throw new Error("missing compile attempt")
    }
    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(attempt.resultPath, "compiler failed at Source/Main.cpp:42\n", {
      createPath: false
    })
    await submitNodeDone(runDir, "compile", attempt.token, "failed")
    const failed = await reconcileRun(runDir, { surface })
    expect(failed.state.status).toBe("failed")
    expect(failed.state.nodes.compile?.resultPath).toBe(attempt.resultPath)
    expect(failed.state.nodes.compile?.result).toBe("compiler failed at Source/Main.cpp:42\n")
    expect(failed.state.nodes.compile?.error).toContain("Source/Main.cpp:42")
    expect(surface.handoffs.at(-1)).not.toContain("Source/Main.cpp:42")
    expect(surface.handoffs.at(-1)).toContain("inspect it through durable results")
    expect(surface.handoffs.at(-1)).toContain(`orchestrate result ${started.state.id} <node>`)
  })

  test("filters human and fuse pauses from a cursor gap using each event's kind", () => {
    const base = {
      runtimeVersion: runtimeBuild(),
      timestamp: "2026-08-02T12:00:00.000Z",
      runId: "20260802120000-1234abcd",
      message: "paused",
      patch: []
    }
    const gap = [
      {
        ...base,
        sequence: 8,
        type: "hold.set" as const,
        data: { scope: "instance", source: "manual" }
      },
      {
        ...base,
        sequence: 9,
        type: "hold.set" as const,
        data: { scope: "instance", source: "node-done" }
      },
      {
        ...base,
        sequence: 10,
        type: "run.paused" as const,
        data: { kind: "human" }
      },
      { ...base, sequence: 11, type: "run.resumed" as const },
      {
        ...base,
        sequence: 12,
        type: "run.paused" as const,
        data: { kind: "fuse" }
      }
    ]
    expect(originHandoffEvents(gap).map((event) => event.sequence)).toEqual([9, 12])
  })

  test("journals stop before best-effort cleanup failure", async () => {
    const spec = workflow([command("planned")])
    const persisted = await persistPlanned(spec)
    class FailingCleanupSurface extends FakeSurface {
      async abandonPlanned(): Promise<void> {
        throw new Error("herdr unavailable")
      }
    }
    const stopped = await crankRun(
      persisted.runDir,
      { type: "stop" },
      {
        surface: new FailingCleanupSurface()
      }
    )
    expect(stopped.state.status).toBe("stopped")
    expect((await readEvents(persisted.runDir)).at(-1)?.type).toBe("run.stopped")
  })

  test("leaves a planned intent untouched when pane observation transport fails", async () => {
    const persisted = await persistPlanned(workflow([command("planned")]))
    class ObservationFailureSurface extends FakeSurface {
      async recoverOrSpawn(): Promise<never> {
        throw new HerdrObservationError("Could not verify split anchor.", new Error("outage"))
      }
    }
    await expect(
      crankRun(
        persisted.runDir,
        { type: "reconcile" },
        { surface: new ObservationFailureSurface() }
      )
    ).rejects.toThrow("Could not verify split anchor")
    const state = await readRunState(persisted.runDir)
    expect(state.nodes.planned?.attempts).toHaveLength(1)
    expect(state.nodes.planned?.attempts[0]?.status).toBe("planned")
    expect(
      (await readEvents(persisted.runDir)).some((event) => event.type === "node.retrying")
    ).toBe(false)
  })

  test("journals ambiguous workroom occupancy as durable attention without consuming a retry", async () => {
    const planned = agent("planned", [], { workroom: "review-room", seat: "reviewer" })
    const spec: WorkflowSpec = {
      ...workflow([planned]),
      presentation: {
        workrooms: [
          {
            id: "review-room",
            label: "Review room",
            layout: "columns",
            seats: [{ id: "reviewer", label: "Reviewer" }],
            settlesOn: ["planned"]
          }
        ]
      }
    }
    const persisted = await persistPlanned(spec)
    class AmbiguousWorkroomSurface extends FakeSurface {
      async recoverOrSpawn(): Promise<never> {
        throw new HerdrObservationError(
          "Workroom occupancy is ambiguous.",
          new Error("duplicate candidates"),
          true
        )
      }
    }
    const surface = new AmbiguousWorkroomSurface()
    await expect(crankRun(persisted.runDir, { type: "reconcile" }, { surface })).rejects.toThrow(
      "ambiguous"
    )
    const state = await readRunState(persisted.runDir)
    expect(state.workrooms["review-room"]?.seats.reviewer?.status).toBe("attention")
    expect(state.spawnIntents["planned:a1"]?.status).toBe("planned")
    expect(state.nodes.planned?.attempts).toHaveLength(1)
    expect(runNeedsAttention(state)).toBe(true)
    expect(surface.handoffs.at(-1)).toContain("workroom.attention")
    expect(
      (await readEvents(persisted.runDir)).filter((event) => event.type === "workroom.attention")
    ).toHaveLength(1)

    await expect(crankRun(persisted.runDir, { type: "reconcile" }, { surface })).rejects.toThrow(
      "ambiguous"
    )
    expect(
      (await readEvents(persisted.runDir)).filter((event) => event.type === "workroom.attention")
    ).toHaveLength(1)
  })

  test("blocks sibling seats without durable attention on a transient workroom failure", async () => {
    const first = agent("first", [], { workroom: "review-room", seat: "first-seat" })
    const second = agent("second", [], { workroom: "review-room", seat: "second-seat" })
    const settle = command("settle", ["first", "second"], "none", {
      workroom: "review-room"
    })
    const spec: WorkflowSpec = {
      ...workflow([first, second, settle]),
      presentation: {
        workrooms: [
          {
            id: "review-room",
            label: "Review room",
            layout: "columns",
            seats: [
              { id: "first-seat", label: "First" },
              { id: "second-seat", label: "Second" }
            ],
            settlesOn: ["settle"]
          }
        ]
      }
    }
    const persisted = await persistPlanned(spec)
    class PartialWorkroomSurface extends FakeSurface {
      readonly attempted: string[] = []

      async recoverOrSpawn(request: SpawnRequest) {
        this.attempted.push(request.intent.id)
        if (request.intent.nodeId === "first") {
          throw new HerdrObservationError(
            'Spawn for seat "first-seat" is session-pending.',
            new Error("provider session unavailable")
          )
        }
        return super.recoverOrSpawn(request)
      }
    }
    const surface = new PartialWorkroomSurface()

    await expect(crankRun(persisted.runDir, { type: "reconcile" }, { surface })).rejects.toThrow(
      "session-pending"
    )

    expect(surface.attempted).toEqual(["first:a1"])
    const state = await readRunState(persisted.runDir)
    expect(state.workrooms["review-room"]?.seats["first-seat"]?.status).toBe("empty")
    expect(state.workrooms["review-room"]?.seats["second-seat"]?.status).toBe("empty")
    expect(state.spawnIntents["first:a1"]?.status).toBe("planned")
    expect(state.spawnIntents["second:a1"]?.status).toBe("planned")
    expect(state.nodes.first?.attempts).toHaveLength(1)
    expect(state.nodes.second?.attempts).toHaveLength(1)
    expect(runNeedsAttention(state)).toBe(false)
    expect(surface.handoffs).toEqual([])
    expect(
      (await readEvents(persisted.runDir)).some((event) => event.type === "node.retrying")
    ).toBe(false)
    expect(
      (await readEvents(persisted.runDir)).some((event) => event.type === "workroom.attention")
    ).toBe(false)
  })

  test("starts independent planned intents before surfacing an ambiguous spawn", async () => {
    const persisted = await persistPlanned(workflow([command("flaky"), command("solid")]))
    class PartialObservationSurface extends FakeSurface {
      async recoverOrSpawn(request: SpawnRequest) {
        if (request.intent.nodeId === "flaky") {
          throw new HerdrObservationError(
            'Spawn for node "flaky" is session-pending; inspect pane "p-flaky" and resume explicitly.',
            new Error("no session id")
          )
        }
        return super.recoverOrSpawn(request)
      }
    }
    const surface = new PartialObservationSurface()
    await expect(crankRun(persisted.runDir, { type: "reconcile" }, { surface })).rejects.toThrow(
      "session-pending"
    )
    expect(surface.spawns).toEqual(["solid:a1"])
    const state = await readRunState(persisted.runDir)
    expect(state.nodes.solid?.status).toBe("running")
    expect(state.spawnIntents["flaky:a1"]?.status).toBe("planned")
    expect(state.spawnIntents["solid:a1"]?.status).toBe("spawned")
  })

  test("consumes a prompt-accepted completion after restart without a duplicate start", async () => {
    const persisted = await persistPlanned(
      workflow([agent("planned"), command("dependent", ["planned"])])
    )
    const attempt = persisted.state.nodes.planned!.attempts[0]!
    class AcceptedPromptSurface extends FakeSurface {
      executions = 0

      async recoverOrSpawn(request: SpawnRequest) {
        this.executions += 1
        if (request.intent.nodeId === "planned") {
          await mkdir(path.dirname(attempt.resultPath), { recursive: true })
          await Bun.write(attempt.resultPath, '{"clean":true}\n', { createPath: false })
          await Bun.write(
            completionSubmissionPath(attempt.resultPath),
            `${JSON.stringify({
              runId: persisted.state.id,
              nodeId: "planned",
              token: attempt.token,
              outcome: "completed",
              hold: false
            })}\n`,
            { createPath: false }
          )
        }
        return super.recoverOrSpawn(request)
      }
    }
    const restarted = new AcceptedPromptSurface()
    const recovered = await reconcileRun(persisted.runDir, { surface: restarted })
    expect(restarted.executions).toBe(2)
    expect(restarted.spawns).toEqual(["planned:a1", "dependent:a1"])
    expect(recovered.state.nodes.planned?.status).toBe("completed")
    expect(recovered.state.nodes.dependent?.status).toBe("running")
    expect(recovered.state.starts).toBe(2)
    const events = await readEvents(persisted.runDir)
    expect(events.filter((event) => event.type === "node.started")).toHaveLength(2)
    expect(events.filter((event) => event.type === "node.completed")).toHaveLength(1)

    await reconcileRun(persisted.runDir, { surface: restarted })
    expect(restarted.executions).toBe(2)
    expect(restarted.spawns).toEqual(["planned:a1", "dependent:a1"])
  })

  test("pauses on a schema-valid missing condition pointer at the completion boundary", async () => {
    const decision = {
      ...agent("decision"),
      output: {
        format: "json" as const,
        schema: {
          type: "object",
          properties: { run: { type: "boolean" } },
          additionalProperties: false
        }
      }
    } satisfies AgentNode
    const optional = {
      ...command("optional", ["decision"]),
      when: { type: "agent-output" as const, node: "decision", pointer: "/run", equals: true }
    } satisfies CommandNode
    const surface = new FakeSurface()
    const started = await start(workflow([decision, optional]), surface)
    const runDir = runDirectory(started.state.id)
    const attempt = started.state.nodes.decision?.attempts.at(-1)
    if (attempt === undefined) {
      throw new Error("missing decision attempt")
    }
    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(attempt.resultPath, "{}\n", { createPath: false })
    await submitNodeDone(runDir, "decision", attempt.token, "completed")

    const paused = await reconcileRun(runDir, { surface })
    expect(paused.state.status).toBe("paused")
    expect(paused.state.pause).toMatchObject({
      kind: "condition",
      conditionNodeId: "optional",
      condition: { node: "decision", pointer: "/run", equals: true }
    })
    expect(paused.state.nodes.decision?.status).toBe("completed")
    expect(paused.state.nodes.optional?.attempts).toEqual([])
    await expect(
      crankRun(
        runDir,
        {
          type: "resume",
          overrideFuse: false,
          continueRounds: null,
          acceptRepeat: null
        },
        { surface }
      )
    ).rejects.toThrow("requires an approved revision")
  })

  test("keeps an outage-planned old-plan intent frozen throughout a pending revision", async () => {
    const original = workflow([command("planned")])
    const persisted = await persistPlanned(original)
    const revised = { ...original, objective: "Revised objective while pane readiness is unknown." }
    const digest = validateWorkflow(revised).digest
    if (digest === null) {
      throw new Error("invalid revised workflow")
    }
    class RevisionBarrierSurface extends FakeSurface {
      recoveries = 0

      async recoverOrSpawn(request: SpawnRequest) {
        this.recoveries += 1
        return super.recoverOrSpawn(request)
      }
    }
    const surface = new RevisionBarrierSurface()
    const proposed = await crankRun(
      persisted.runDir,
      {
        type: "propose-revision",
        workflow: revised,
        digest,
        summary: ["ready/planned outage race"]
      },
      { surface }
    )
    expect(proposed.state.pendingRevision?.digest).toBe(digest)
    expect(proposed.state.spawnIntents["planned:a1"]?.status).toBe("planned")
    expect(surface.recoveries).toBe(0)

    const drained = await reconcileRun(persisted.runDir, { surface })
    expect(drained.state.spawnIntents["planned:a1"]?.status).toBe("planned")
    expect(surface.recoveries).toBe(0)

    const discarded = await crankRun(persisted.runDir, { type: "discard-revision" }, { surface })
    expect(discarded.state.pendingRevision).toBeNull()
    expect(discarded.state.spawnIntents["planned:a1"]?.status).toBe("spawned")
    expect(surface.recoveries).toBe(1)
  })

  test("keeps a dormant submission durable until an explicit reconcile", async () => {
    const persisted = await persistPlanned(workflow([agent("planned")]))
    const paused = await crankRun(
      persisted.runDir,
      { type: "pause" },
      { surface: new FakeSurface() }
    )
    expect(paused.state.status).toBe("paused")
    expect(paused.events.at(-1)?.type).toBe("run.paused")

    const surface = new FakeSurface()
    const resumed = await crankRun(
      persisted.runDir,
      {
        type: "resume",
        overrideFuse: false,
        continueRounds: null,
        acceptRepeat: null
      },
      { surface }
    )
    expect(resumed.state.status).toBe("running")
    expect(surface.handoffs).toEqual([])

    const attempt = resumed.state.nodes.planned?.attempts.at(-1)
    if (attempt === undefined) {
      throw new Error("missing resumed agent attempt")
    }
    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(attempt.resultPath, '{"clean":false}\n', { createPath: false })
    await submitNodeDone(persisted.runDir, "planned", attempt.token, "failed")

    const dormant = await readRunState(persisted.runDir)
    expect(dormant.status).toBe("running")
    const reconciled = await reconcileRun(persisted.runDir, { surface })
    const failed = reconciled.state
    expect(failed.status).toBe("failed")
    expect(surface.handoffs).toHaveLength(1)
    expect(surface.handoffs[0]).toContain(`Orchestrate run ${failed.id} failed.`)
  })

  test("consumes finished submissions while paused without starting new work", async () => {
    const surface = new FakeSurface()
    const started = await start(workflow([agent("review"), agent("next", ["review"])]), surface)
    const runDir = runDirectory(started.state.id)
    const attempt = started.state.nodes.review?.attempts.at(-1)
    if (attempt === undefined) {
      throw new Error("missing review attempt")
    }
    const paused = await crankRun(runDir, { type: "pause" }, { surface })
    expect(paused.state.status).toBe("paused")

    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(attempt.resultPath, '{"clean":true}\n', { createPath: false })
    await submitNodeDone(runDir, "review", attempt.token, "completed")

    const reconciled = await reconcileRun(runDir, { surface })
    expect(reconciled.state.status).toBe("paused")
    expect(reconciled.state.nodes.review?.status).toBe("completed")
    // Pause still blocks new pane starts: the dependent stays unstarted.
    expect(reconciled.state.nodes.next?.status).toBe("pending")
    expect(reconciled.state.nodes.next?.attempts).toHaveLength(0)
  })

  test("routes trusted Herdr completion events to the captured master", async () => {
    const surface = new FakeSurface()
    const started = await start(workflow([agent("review")]), surface)
    const runDir = runDirectory(started.state.id)
    const attempt = started.state.nodes.review?.attempts.at(-1)
    if (attempt === undefined) {
      throw new Error("missing review attempt")
    }
    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(attempt.resultPath, '{"clean":true}\n', { createPath: false })
    await submitNodeDone(runDir, "review", attempt.token, "completed")
    const pane = attempt.pane
    if (pane === null) {
      throw new Error("missing review pane")
    }
    const event = JSON.stringify({
      event: "pane_agent_status_changed",
      data: {
        pane_id: pane.paneId,
        workspace_id: pane.workspaceId,
        agent_status: "done"
      }
    })

    expect(await handleHerdrAgentStatusEvent("pane.agent_status_changed", event, surface)).toEqual({
      status: "handled",
      matched: 1,
      prompted: 1
    })
    expect(surface.handoffs.at(-1)).toContain(`orchestrate reconcile ${started.state.id}`)
    await expect(handleHerdrAgentStatusEvent(undefined, event, surface)).rejects.toThrow(
      "requires a pane.agent_status_changed, pane.closed, or pane.exited plugin event"
    )
  })

  test("prompts for debugging when a Herdr agent settles without submitting", async () => {
    const surface = new FakeSurface()
    const started = await start(workflow([agent("review")]), surface)
    const pane = started.state.nodes.review?.attempts.at(-1)?.pane
    if (pane === null || pane === undefined) {
      throw new Error("missing review pane")
    }
    await handleHerdrAgentStatusEvent(
      "pane.agent_status_changed",
      JSON.stringify({
        event: "pane_agent_status_changed",
        data: {
          pane_id: pane.paneId,
          workspace_id: pane.workspaceId,
          agent_status: "done"
        }
      }),
      surface
    )
    expect(surface.handoffs.at(-1)).toContain("without a valid completion submission")
    expect(surface.handoffs.at(-1)).toContain(`herdr pane read ${pane.paneId}`)
  })

  test("suppresses a done wake when the agent is observed working again", async () => {
    const surface = new FakeSurface()
    surface.waitForAgentStatus = async () => true
    const started = await start(workflow([agent("review")]), surface)
    const pane = started.state.nodes.review?.attempts.at(-1)?.pane
    if (pane === null || pane === undefined) {
      throw new Error("missing review pane")
    }
    const before = surface.handoffs.length
    expect(
      await handleHerdrAgentStatusEvent(
        "pane.agent_status_changed",
        JSON.stringify({
          event: "pane_agent_status_changed",
          data: {
            pane_id: pane.paneId,
            workspace_id: pane.workspaceId,
            agent_status: "done"
          }
        }),
        surface
      )
    ).toEqual({ status: "handled", matched: 1, prompted: 0 })
    expect(surface.handoffs).toHaveLength(before)
  })

  test("prompts restore when a running node's pane closes without a submission", async () => {
    const surface = new FakeSurface()
    const started = await start(workflow([agent("review")]), surface)
    const pane = started.state.nodes.review?.attempts.at(-1)?.pane
    if (pane === null || pane === undefined) {
      throw new Error("missing review pane")
    }
    const event = JSON.stringify({
      event: "pane_closed",
      data: { pane_id: pane.paneId, workspace_id: pane.workspaceId }
    })
    expect(await handleHerdrAgentStatusEvent("pane.closed", event, surface)).toEqual({
      status: "handled",
      matched: 1,
      prompted: 1
    })
    expect(surface.handoffs.at(-1)).toContain("lost its Herdr pane")
    expect(surface.handoffs.at(-1)).toContain(`orchestrate ui restore ${started.state.id}`)
  })

  test("stays silent when a pane closes after a valid submission", async () => {
    const surface = new FakeSurface()
    const started = await start(workflow([agent("review")]), surface)
    const runDir = runDirectory(started.state.id)
    const attempt = started.state.nodes.review?.attempts.at(-1)
    if (attempt === undefined || attempt.pane === null) {
      throw new Error("missing review attempt")
    }
    await mkdir(path.dirname(attempt.resultPath), { recursive: true })
    await Bun.write(attempt.resultPath, '{"clean":true}\n', { createPath: false })
    await submitNodeDone(runDir, "review", attempt.token, "completed")
    const event = JSON.stringify({
      event: "pane_exited",
      data: { pane_id: attempt.pane.paneId, workspace_id: attempt.pane.workspaceId }
    })
    expect(await handleHerdrAgentStatusEvent("pane.exited", event, surface)).toEqual({
      status: "handled",
      matched: 1,
      prompted: 0
    })
  })

  test("submits without Herdr authority and explicit reconcile spawns downstream exactly once", async () => {
    const launchSurface = new FakeSurface()
    const spec = workflow([agent("submitter"), agent("dependent", ["submitter"])])
    const started = await start(spec, launchSurface)
    const runDir = runDirectory(started.state.id)
    const firstAttempt = started.state.nodes.submitter?.attempts.at(-1)
    if (firstAttempt === undefined) {
      throw new Error("missing submitting attempt")
    }
    await mkdir(path.dirname(firstAttempt.resultPath), { recursive: true })
    await Bun.write(firstAttempt.resultPath, '{"clean":true}\n', { createPath: false })

    const deniedBin = path.join(temporaryRoot, "denied-bin")
    await mkdir(deniedBin)
    await Bun.write(
      path.join(deniedBin, "herdr"),
      '#!/bin/sh\necho "herdr workspace list: EPERM" >&2\nexit 126\n',
      { createPath: false, mode: 0o755 }
    )
    await chmod(path.join(deniedBin, "herdr"), 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = deniedBin
    try {
      const submissions = await Promise.all([
        submitNodeDone(runDir, "submitter", firstAttempt.token, "completed"),
        submitNodeDone(runDir, "submitter", firstAttempt.token, "completed")
      ])
      expect(submissions).toEqual([submissions[0], submissions[0]])
    } finally {
      process.env.PATH = savedPath
    }

    const submitted = await readRunState(runDir)
    expect(submitted.nodes.submitter?.status).toBe("running")
    expect(submitted.nodes.dependent?.status).toBe("pending")
    expect(launchSurface.spawns).toEqual(["submitter:a1"])

    // A new surface represents the master explicitly reconciling the durable inbox.
    const restartedSurface = new FakeSurface()
    const continued = await reconcileRun(runDir, {
      surface: restartedSurface
    })
    expect(continued.state.nodes.dependent?.status).toBe("running")
    expect(restartedSurface.spawns).toEqual(["dependent:a1"])

    await reconcileRun(runDir, { surface: restartedSurface })
    expect(restartedSurface.spawns).toEqual(["dependent:a1"])

    const secondAttempt = (await readRunState(runDir)).nodes.dependent?.attempts.at(-1)
    if (secondAttempt === undefined) {
      throw new Error("missing dependent attempt")
    }
    await mkdir(path.dirname(secondAttempt.resultPath), { recursive: true })
    await Bun.write(secondAttempt.resultPath, '{"clean":true}\n', { createPath: false })
    await submitNodeDone(runDir, "dependent", secondAttempt.token, "completed")
    const finished = await reconcileRun(runDir, {
      surface: restartedSurface
    })
    expect(finished.state.status).toBe("completed")
    expect(restartedSurface.handoffs).toHaveLength(1)

    const events = await readEvents(runDir)
    expect(
      events.filter((event) => event.type === "node.completed" && event.nodeId === "submitter")
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === "node.spawn-planned" && event.nodeId === "dependent")
    ).toHaveLength(1)
    expect(replayEvents(events)).toEqual(await readRunState(runDir))
  })

  test("reuses and advances the live pane for a linear resumed session", async () => {
    class SessionSurface extends FakeSurface {
      async recoverOrSpawn(request: SpawnRequest) {
        const observation = await super.recoverOrSpawn(request)
        return {
          ...observation,
          providerSessionId: request.intent.nodeId === "source" ? "session-1" : null
        }
      }
    }
    const source = {
      ...agent("source"),
      session: { mode: "fresh", from: null, saveAs: "shared-session" }
    } satisfies AgentNode
    const first = {
      ...agent("first", ["source"]),
      session: { mode: "resume", from: "shared-session", saveAs: null }
    } satisfies AgentNode
    const second = {
      ...agent("second", ["first"]),
      session: { mode: "resume", from: "shared-session", saveAs: null }
    } satisfies AgentNode
    const surface = new SessionSurface()
    const started = await start(workflow([source, first, second]), surface)
    const runDir = runDirectory(started.state.id)

    const finish = async (nodeId: string) => {
      const attempt = (await readRunState(runDir)).nodes[nodeId]?.attempts.at(-1)
      if (attempt === undefined) {
        throw new Error(`missing ${nodeId} attempt`)
      }
      await mkdir(path.dirname(attempt.resultPath), { recursive: true })
      await Bun.write(attempt.resultPath, '{"clean":true}\n', { createPath: false })
      await submitNodeDone(runDir, nodeId, attempt.token, "completed")
      return reconcileRun(runDir, { surface })
    }

    await finish("source")
    expect(surface.requests.at(-1)?.intent.nodeId).toBe("first")
    expect(surface.requests.at(-1)?.placement.reusePane?.paneId).toBe("pane:source:a1")

    const afterFirst = await finish("first")
    expect(afterFirst.state.sessions["shared-session"]?.sourceNodeId).toBe("first")
    expect(surface.requests.at(-1)?.intent.nodeId).toBe("second")
    expect(surface.requests.at(-1)?.placement.reusePane?.paneId).toBe("pane:first:a1")
  })

  test("keeps active participant seats parked and applies close-success when the room settles", async () => {
    const first = agent("first", [], { workroom: "review-room", seat: "reviewer" })
    const second = agent("second", ["first"], {
      workroom: "review-room",
      seat: "reviewer"
    })
    const settle = command("settle", ["second"], "none", { workroom: "review-room" })
    const spec: WorkflowSpec = {
      ...workflow([first, second, settle]),
      presentation: {
        workrooms: [
          {
            id: "review-room",
            label: "Review room",
            layout: "columns",
            seats: [{ id: "reviewer", label: "Reviewer" }],
            settlesOn: ["settle"]
          }
        ]
      }
    }
    const surface = new FakeSurface()
    const ui: UiPreferences = {
      ...DEFAULT_UI_PREFERENCES,
      completedPanes: { ...DEFAULT_UI_PREFERENCES.completedPanes, agent: "close-success" }
    }
    const started = await start(spec, surface, ui)
    const runDir = runDirectory(started.state.id)

    const finishAgent = async (nodeId: string) => {
      const attempt = (await readRunState(runDir)).nodes[nodeId]?.attempts.at(-1)
      if (attempt === undefined) {
        throw new Error(`missing ${nodeId} attempt`)
      }
      await mkdir(path.dirname(attempt.resultPath), { recursive: true })
      await Bun.write(attempt.resultPath, '{"clean":true}\n', { createPath: false })
      await submitNodeDone(runDir, nodeId, attempt.token, "completed")
      return reconcileRun(runDir, { surface })
    }

    const afterFirst = await finishAgent("first")
    expect(afterFirst.state.workrooms["review-room"]?.seats.reviewer?.status).toBe("running")
    expect(surface.requests.at(-1)?.intent.nodeId).toBe("second")
    expect(surface.requests.at(-1)?.placement.reusePane?.paneId).toBe("pane:first:a1")
    expect(surface.closed).not.toContain("pane:first:a1")
    expect(surface.renamed).toContainEqual(["pane:first:a1", "Reviewer · parked · last: first"])

    const afterSecond = await finishAgent("second")
    expect(afterSecond.state.workrooms["review-room"]?.status).toBe("active")
    expect(afterSecond.state.nodes.settle?.status).toBe("running")
    expect(surface.closed).not.toContain("pane:second:a1")

    const settleAttempt = afterSecond.state.nodes.settle?.attempts.at(-1)
    if (settleAttempt === undefined) {
      throw new Error("missing settle attempt")
    }
    const finished = await crankRun(
      runDir,
      {
        type: "node-exit",
        nodeId: "settle",
        token: settleAttempt.token,
        code: 0,
        error: null
      },
      { surface }
    )
    expect(finished.state.status).toBe("completed")
    expect(finished.state.workrooms["review-room"]?.status).toBe("settled")
    expect(surface.closed).toContain("pane:second:a1")
  })

  test("retries settled-room presentation from durable state after a lost effect", async () => {
    class FlakySettlementSurface extends FakeSurface {
      seatRenameAttempts = 0

      async renamePane(paneId: string, label: string): Promise<void> {
        if (paneId === "pane:reviewer:a1" && label === "Reviewer · settled") {
          this.seatRenameAttempts += 1
          if (this.seatRenameAttempts === 1) {
            throw new Error("injected rename failure")
          }
        }
        await super.renamePane(paneId, label)
      }
    }
    const reviewer = agent("reviewer", [], {
      workroom: "review-room",
      seat: "reviewer-seat"
    })
    const settle = command("settle", ["reviewer"], "none", { workroom: "review-room" })
    const downstream = command("downstream", ["settle"])
    const spec: WorkflowSpec = {
      ...workflow([reviewer, settle, downstream]),
      presentation: {
        workrooms: [
          {
            id: "review-room",
            label: "Review room",
            layout: "columns",
            seats: [{ id: "reviewer-seat", label: "Reviewer" }],
            settlesOn: ["settle"]
          }
        ]
      }
    }
    const surface = new FlakySettlementSurface()
    const started = await start(spec, surface)
    const runDir = runDirectory(started.state.id)
    const reviewerAttempt = started.state.nodes.reviewer?.attempts.at(-1)
    if (reviewerAttempt === undefined) {
      throw new Error("missing reviewer attempt")
    }
    await mkdir(path.dirname(reviewerAttempt.resultPath), { recursive: true })
    await Bun.write(reviewerAttempt.resultPath, '{"clean":true}\n', { createPath: false })
    await submitNodeDone(runDir, "reviewer", reviewerAttempt.token, "completed")
    const afterReviewer = await reconcileRun(runDir, { surface })
    const settleAttempt = afterReviewer.state.nodes.settle?.attempts.at(-1)
    if (settleAttempt === undefined) {
      throw new Error("missing settle attempt")
    }

    const afterSettlement = await crankRun(
      runDir,
      {
        type: "node-exit",
        nodeId: "settle",
        token: settleAttempt.token,
        code: 0,
        error: null
      },
      { surface }
    )

    expect(afterSettlement.state.workrooms["review-room"]?.status).toBe("settled")
    expect(afterSettlement.state.nodes.downstream?.status).toBe("running")
    expect(surface.seatRenameAttempts).toBe(2)
    expect(surface.renamed).toContainEqual(["pane:reviewer:a1", "Reviewer · settled"])
    expect(surface.closed).not.toContain("pane:reviewer:a1")
  })

  test("inherits the committed session head and pane across persistent repeat rounds", async () => {
    class RepeatSessionSurface extends FakeSurface {
      async recoverOrSpawn(request: SpawnRequest) {
        const observation = await super.recoverOrSpawn(request)
        return {
          ...observation,
          providerSessionId: `session:${request.intent.nodeId}:a${request.intent.attempt}`
        }
      }
    }
    const seed = {
      ...agent("seed"),
      session: { mode: "fresh", from: null, saveAs: "reviewer" }
    } satisfies AgentNode
    const review = {
      ...agent("review", ["seed"]),
      session: { mode: "resume", from: "reviewer", saveAs: null }
    } satisfies AgentNode
    const verdict = {
      ...agent("verdict", ["review"]),
      session: { mode: "resume", from: "reviewer", saveAs: null }
    } satisfies AgentNode
    const spec: WorkflowSpec = {
      ...workflow([seed, review, verdict]),
      repeats: [
        {
          id: "review-loop",
          members: ["review", "verdict"],
          until: { type: "agent-output", node: "verdict", pointer: "/clean", equals: true },
          maxRounds: 2
        }
      ]
    }
    const surface = new RepeatSessionSurface()
    const started = await start(spec, surface)
    const runDir = runDirectory(started.state.id)

    const finish = async (nodeId: string, result: { readonly clean: boolean }) => {
      const attempt = (await readRunState(runDir)).nodes[nodeId]?.attempts.at(-1)
      if (attempt === undefined) {
        throw new Error(`missing ${nodeId} attempt`)
      }
      await mkdir(path.dirname(attempt.resultPath), { recursive: true })
      await Bun.write(attempt.resultPath, `${JSON.stringify(result)}\n`, { createPath: false })
      await submitNodeDone(runDir, nodeId, attempt.token, "completed")
      return reconcileRun(runDir, { surface })
    }

    await finish("seed", { clean: false })
    expect(surface.requests.at(-1)?.intent.nodeId).toBe("review--r1")
    expect(surface.requests.at(-1)?.state.sessions.reviewer?.sessionId).toBe("session:seed:a1")
    expect(surface.requests.at(-1)?.placement.reusePane?.paneId).toBe("pane:seed:a1")

    await finish("review--r1", { clean: false })
    expect(surface.requests.at(-1)?.intent.nodeId).toBe("verdict--r1")
    expect(surface.requests.at(-1)?.state.sessions.reviewer?.sessionId).toBe(
      "session:review--r1:a1"
    )
    expect(surface.requests.at(-1)?.placement.reusePane?.paneId).toBe("pane:review--r1:a1")

    const nextRound = await finish("verdict--r1", { clean: false })
    expect(nextRound.state.sessions.reviewer).toMatchObject({
      sessionId: "session:verdict--r1:a1",
      sourceNodeId: "verdict--r1"
    })
    expect(surface.requests.at(-1)?.intent.nodeId).toBe("review--r2")
    expect(surface.requests.at(-1)?.state.sessions.reviewer?.sessionId).toBe(
      "session:verdict--r1:a1"
    )
    expect(surface.requests.at(-1)?.placement.reusePane?.paneId).toBe("pane:verdict--r1:a1")
  })
})
