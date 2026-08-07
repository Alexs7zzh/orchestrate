import { describe, expect, test } from "bun:test"

import type {
  AgentNode,
  AttemptState,
  EventRecord,
  NodeRunState,
  NodeStatus,
  RunState,
  WorkflowNode,
  WorkflowSpec
} from "../src/types.js"

import {
  buildBoardModel,
  gateApprovalCommand,
  mapBoardInput,
  revisionApprovalCommand,
  runtimeDependencyIds,
  stalledInspectionCommand
} from "../src/board-model.js"
import { classifyLivePane, renderBoardFrame, startClockRefresh } from "../src/board.js"
import { workflowProvenance } from "./workflow-provenance-fixture.js"

const START = "2026-08-02T12:00:00.000Z"
const NOW = "2026-08-02T12:00:30.000Z"

function attempt(overrides: Partial<AttemptState> = {}): AttemptState {
  return {
    attempt: 1,
    status: "running",
    token: "token-1",
    pane: {
      workspaceId: "workspace-1",
      tabId: "tab-1",
      paneId: "pane-1",
      group: "run-1",
      surface: "tab"
    },
    providerSessionId: null,
    startedAt: START,
    finishedAt: null,
    exitCode: null,
    error: null,
    resultPath: "nodes/work/result.txt",
    outputPath: "nodes/work/output.txt",
    ...overrides
  }
}

function node(id: string, status: NodeStatus, overrides: Partial<NodeRunState> = {}): NodeRunState {
  const terminal = ["completed", "skipped", "failed", "cancelled"].includes(status)
  return {
    id,
    templateId: id,
    title: id,
    type: "agent",
    provider: "codex",
    needs: [],
    origin: "initial",
    repeatId: null,
    round: null,
    status,
    attempts:
      status === "pending" ||
      status === "ready" ||
      status === "awaiting-approval" ||
      status === "skipped"
        ? []
        : [
            attempt({
              status: terminal
                ? status === "failed"
                  ? "failed"
                  : status === "cancelled"
                    ? "cancelled"
                    : "completed"
                : "running",
              finishedAt: terminal ? NOW : null
            })
          ],
    resultPath: terminal && status !== "skipped" ? `nodes/${id}/result.txt` : null,
    result: null,
    error: status === "failed" ? "failed" : null,
    ...overrides
  }
}

function workflowAgent(
  id: string,
  needs: readonly string[] = [],
  output: AgentNode["output"] = { format: "text", schema: null }
): WorkflowNode {
  return {
    id,
    type: "agent",
    title: id,
    needs,
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
    provider: "codex",
    model: "provider-default",
    effort: null,
    prompt: `Work on ${id}.`,
    session: { mode: "fresh", from: null, saveAs: null },
    permissions: {
      execution: { sandbox: "read-only" },
      escalation: "deny",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
    output
  }
}

function state(nodes: readonly NodeRunState[], overrides: Partial<RunState> = {}): RunState {
  return {
    runtimeVersion: "test-build",
    sequence: 1,
    id: "run-1",
    workflowName: "Board test",
    objective: "Exercise the model",
    digest: "workflow-digest",
    status: "running",
    createdAt: START,
    startedAt: START,
    finishedAt: null,
    updatedAt: START,
    error: null,
    pause: null,
    origin: null,
    allowWriteConflicts: false,
    starts: 0,
    fuseOverride: false,
    repeatRoundExtensions: {},
    pendingRevision: null,
    nodes: Object.fromEntries(nodes.map((value) => [value.id, value])),
    sessions: {},
    gates: {},
    holds: {},
    repeats: {},
    workrooms: {},
    spawnIntents: {},
    ...overrides
  }
}

function event(
  sequence: number,
  type: EventRecord["type"],
  timestamp: string,
  nodeId?: string,
  data?: unknown
): EventRecord {
  return {
    runtimeVersion: "test-build",
    sequence,
    timestamp,
    runId: "run-1",
    type,
    message: type,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(data === undefined ? {} : { data }),
    patch: []
  }
}

describe("board view model", () => {
  test("represents every node state with a distinct glyph", () => {
    const statuses: readonly NodeStatus[] = [
      "pending",
      "ready",
      "running",
      "awaiting-approval",
      "completed",
      "skipped",
      "failed",
      "cancelled",
      "paused"
    ]
    const model = buildBoardModel(state(statuses.map((status) => node(status, status))), [], {
      now: NOW
    })

    expect(model.nodes.map((value) => value.status)).toEqual([...statuses])
    expect(new Set(model.nodes.map((value) => value.glyph)).size).toBe(statuses.length)
  })

  test("shows scheduler skip provenance and a held skipped release barrier", () => {
    const skipped = node("optional", "skipped", {
      skip: {
        reason: "condition-false",
        conditionNode: "verdict",
        pointer: "/done",
        skippedAt: NOW
      }
    })
    const model = buildBoardModel(
      state([skipped], {
        holds: { optional: { target: "optional", scope: "instance", setAt: NOW } }
      }),
      [],
      { now: NOW }
    )
    expect(model.nodes[0]).toMatchObject({
      id: "optional",
      status: "skipped",
      downstreamHeld: true,
      skip: {
        reason: "condition-false",
        conditionNode: "verdict",
        pointer: "/done"
      }
    })
    expect(model.needsYou[0]).toMatchObject({ kind: "downstream-held", nodeId: "optional" })
  })

  test("sorts by runtime dependencies and derives indentation", () => {
    const model = buildBoardModel(
      state([
        node("publish", "pending", { needs: ["review"] }),
        node("review", "pending", { needs: ["draft"] }),
        node("parallel", "pending"),
        node("draft", "pending")
      ]),
      [],
      { now: NOW }
    )

    expect(model.nodes.map((value) => value.id)).toEqual(["parallel", "draft", "review", "publish"])
    expect(Object.fromEntries(model.nodes.map((value) => [value.id, value.depth]))).toEqual({
      parallel: 0,
      draft: 0,
      review: 1,
      publish: 2
    })
  })

  test("places inserted revision nodes in stable dependency and declaration order", () => {
    const model = buildBoardModel(
      state([
        node("board-ui-fix", "completed"),
        node("quality-fix", "pending", { needs: ["board-live-placement-fix"] }),
        node("runtime-review", "pending", { needs: ["quality-fix"] }),
        node("surface-review", "pending", { needs: ["quality-fix"] }),
        node("contract-doc-review", "pending", { needs: ["quality-fix"] }),
        node("completion-control-fix", "pending", { needs: ["board-ui-fix"] }),
        node("board-live-placement-fix", "pending", { needs: ["completion-control-fix"] })
      ]),
      [],
      { now: NOW }
    )

    expect(model.nodes.map((value) => value.id)).toEqual([
      "board-ui-fix",
      "completion-control-fix",
      "board-live-placement-fix",
      "quality-fix",
      "runtime-review",
      "surface-review",
      "contract-doc-review"
    ])
  })

  test("orders needs-you items as gates, revision, maxRounds, held, workroom, then stalled", async () => {
    const gated = node("gated", "awaiting-approval")
    const held = node("held", "completed")
    const running = node("running", "running")
    const pendingWorkflow: WorkflowSpec = {
      name: "Revised",
      objective: "Revised",
      cwd: "/tmp",
      concurrency: 1,
      callback: { type: "none" },
      milestones: false,
      limits: { maxStarts: null },
      writeConflicts: "reject",
      nodes: [workflowAgent("revision")],
      repeats: []
    }
    const model = buildBoardModel(
      state([gated, held, running], {
        status: "paused",
        gates: {
          gated: {
            nodeId: "gated",
            title: "Gated node",
            content: "content",
            digest: "gate-digest",
            openedAt: START,
            approvedAt: null
          }
        },
        pendingRevision: {
          provenance: await workflowProvenance(pendingWorkflow),
          workflow: pendingWorkflow,
          digest: "revision-digest",
          summary: ["change one"],
          createdAt: START
        },
        pause: {
          kind: "max-rounds",
          message: "Repeat needs a decision.",
          repeatId: "review-loop",
          createdAt: START
        },
        holds: {
          held: { target: "held", scope: "instance", setAt: START }
        },
        workrooms: {
          "review-room": {
            id: "review-room",
            status: "active",
            workspaceId: null,
            tabId: null,
            seats: {
              reviewer: {
                id: "reviewer",
                status: "attention",
                nodeId: "running",
                pane: null
              }
            }
          }
        }
      }),
      [],
      {
        now: NOW,
        paneGarnish: { running: { condition: "gone", detail: null } }
      }
    )

    expect(model.needsYou.map((item) => item.kind)).toEqual([
      "gate",
      "revision",
      "max-rounds",
      "downstream-held",
      "workroom",
      "stalled-pane"
    ])
    expect(model.needsYou.map((item) => item.command)).toEqual([
      "orchestrate approve run-1 --gate gated --digest gate-digest",
      "orchestrate approve run-1 --revision revision-digest",
      "orchestrate resume run-1 --accept-repeat review-loop",
      "orchestrate release run-1 held",
      "orchestrate reconcile run-1",
      "orchestrate status run-1"
    ])
    expect(model.needsYou[0]).toMatchObject({
      kind: "gate",
      content: "content",
      detail: 'Content "content"\nDigest gate-digest'
    })
    expect(model.needsYou[1]).toMatchObject({
      kind: "revision",
      preview: { name: "Revised", objective: "Revised" }
    })
    expect(model.needsYou[4]).toMatchObject({
      workroomId: "review-room",
      seatId: "reviewer",
      title: "review-room: seat reviewer needs occupancy attention"
    })
  })

  test("surfaces persisted invalid revision provenance as non-approvable attention", async () => {
    const pendingWorkflow: WorkflowSpec = {
      name: "Revised",
      objective: "Revised",
      cwd: "/tmp",
      concurrency: 1,
      callback: { type: "none" },
      milestones: false,
      limits: { maxStarts: null },
      writeConflicts: "reject",
      nodes: [workflowAgent("revision")],
      repeats: []
    }
    const provenance = await workflowProvenance(pendingWorkflow)
    const invalid = { ...provenance, origins: { ...provenance.origins } }
    delete invalid.origins["/name"]
    const model = buildBoardModel(
      state([], {
        pendingRevision: {
          workflow: pendingWorkflow,
          provenance: invalid,
          digest: "revision-digest",
          summary: [],
          createdAt: START
        }
      }),
      [],
      { now: NOW }
    )
    expect(model.needsYou).toContainEqual(
      expect.objectContaining({
        kind: "revision",
        title: "Pending revision has invalid provenance",
        command: null,
        preview: null
      })
    )

    const invalidAnnotations = {
      ...provenance,
      inferredNeeds: { ghost: [] }
    }
    const annotationModel = buildBoardModel(
      state([], {
        pendingRevision: {
          workflow: pendingWorkflow,
          provenance: invalidAnnotations,
          digest: "revision-digest",
          summary: [],
          createdAt: START
        }
      }),
      [],
      { now: NOW }
    )
    expect(annotationModel.needsYou).toContainEqual(
      expect.objectContaining({
        kind: "revision",
        title: "Pending revision has invalid provenance",
        detail: expect.stringContaining('Unknown inferredNeeds node "ghost"'),
        command: null,
        preview: null
      })
    )
  })

  test("shows the explicit fuse override instead of offering ordinary resume", () => {
    const model = buildBoardModel(
      state([node("waiting", "ready")], {
        status: "paused",
        pause: {
          kind: "fuse",
          message: "The pane-start fuse was reached.",
          repeatId: null,
          createdAt: START
        }
      }),
      [],
      { now: NOW }
    )
    expect(model.needsYou).toMatchObject([
      {
        kind: "fuse",
        command: "orchestrate resume run-1 --override-fuse"
      }
    ])
    expect(mapBoardInput(model, null, { type: "key", key: "r" })).toEqual({ type: "none" })
  })

  test("does not offer active recovery commands for terminal runs", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      const model = buildBoardModel(
        state([node("failed", "failed")], {
          status,
          workrooms: {
            "review-room": {
              id: "review-room",
              status: "aborted",
              workspaceId: null,
              tabId: null,
              seats: {
                reviewer: {
                  id: "reviewer",
                  status: "attention",
                  nodeId: "failed",
                  pane: null
                }
              }
            }
          },
          holds: { failed: { target: "failed", scope: "instance", setAt: START } }
        }),
        [],
        { now: NOW }
      )
      expect(model.needsYou).toEqual([])
      expect(mapBoardInput(model, "failed", { type: "key", key: "h" })).toEqual({ type: "none" })
      expect(mapBoardInput(model, "failed", { type: "key", key: "s" })).toEqual({ type: "none" })
    }
  })

  test("derives elapsed time per attempt from journal events", () => {
    const work = node("work", "running", {
      attempts: [
        attempt({
          attempt: 1,
          status: "failed",
          startedAt: "2000-01-01T00:00:00.000Z",
          finishedAt: "2000-01-01T01:00:00.000Z"
        }),
        attempt({ attempt: 2, token: "token-2", startedAt: null })
      ]
    })
    const model = buildBoardModel(
      state([work]),
      [
        event(1, "run.started", START),
        event(2, "node.started", "2026-08-02T12:00:01.000Z", "work", { attempt: 1 }),
        event(3, "node.failed", "2026-08-02T12:00:04.000Z", "work", { attempt: 1 }),
        event(4, "node.started", "2026-08-02T12:00:10.000Z", "work", { attempt: 2 })
      ],
      { now: NOW }
    )

    expect(model.nodes[0]?.attempts.map((value) => value.elapsedMs)).toEqual([3_000, 20_000])
    expect(model.nodes[0]?.elapsedMs).toBe(20_000)
    expect(model.run.elapsedMs).toBe(30_000)
  })

  test("collapses repeat history and expands the current round with runtime dependencies", () => {
    const roundNode = (
      templateId: string,
      round: number,
      needs: readonly string[] = []
    ): NodeRunState =>
      node(`${templateId}--r${round}`, round === 1 ? "completed" : "pending", {
        templateId,
        needs,
        origin: "loop-round",
        repeatId: "loop",
        round
      })
    const loopState = state(
      [
        roundNode("draft", 1),
        roundNode("review", 1, ["draft"]),
        roundNode("draft", 2),
        roundNode("review", 2, ["draft"]),
        node("after", "pending", { needs: ["review"] })
      ],
      {
        repeats: {
          loop: {
            id: "loop",
            round: 2,
            status: "running",
            instanceIds: ["draft--r1", "review--r1", "draft--r2", "review--r2"],
            completedAt: null
          }
        }
      }
    )
    const model = buildBoardModel(loopState, [], {
      now: NOW,
      repeats: [
        {
          id: "loop",
          members: ["draft", "review"],
          until: { type: "agent-output", node: "review", pointer: "/agree", equals: true },
          maxRounds: 3
        }
      ]
    })

    expect(model.nodes.find((value) => value.id === "review--r2")?.needs).toEqual(["draft--r2"])
    expect(model.nodes.find((value) => value.id === "after")?.needs).toEqual(["review--r2"])
    expect(runtimeDependencyIds(loopState, loopState.nodes["review--r2"]!)).toEqual(["draft--r2"])
    expect(runtimeDependencyIds(loopState, loopState.nodes.after!)).toEqual(["review--r2"])
    expect(model.rows.map((row) => [row.kind, row.key])).toEqual([
      ["repeat-history", "loop:r1"],
      ["node", "draft--r2"],
      ["node", "review--r2"],
      ["repeat-round", "loop:round"],
      ["node", "after"]
    ])
    expect(model.rows[3]).toEqual({
      kind: "repeat-round",
      key: "loop:round",
      depth: 0,
      repeatId: "loop",
      round: 2,
      maxRounds: 3,
      until: "until review reports agree = true",
      backTo: ["draft"]
    })
    expect(model.selectableNodeIds).toEqual(["draft--r2", "review--r2", "after"])
    expect(renderBoardFrame(model, null).text).toContain(
      "↻ loop  round 2/3 — back to draft until review reports agree = true"
    )

    const commandUntil = buildBoardModel(loopState, [], {
      now: NOW,
      repeats: [
        {
          id: "loop",
          members: ["draft", "review"],
          until: { type: "command-success", node: "review" },
          maxRounds: 3
        }
      ]
    })
    expect(commandUntil.rows[3]).toMatchObject({ until: "until review succeeds" })

    const withoutSpec = buildBoardModel(loopState, [], { now: NOW })
    expect(withoutSpec.rows[3]).toMatchObject({ round: 2, maxRounds: null, until: null })
    expect(renderBoardFrame(withoutSpec, null).text).toContain("↻ loop  round 2 — back to draft\n")
  })

  test("folds hand-unrolled rounds into one body with an explicit return condition", () => {
    const authored: WorkflowNode[] = []
    const runtime: NodeRunState[] = []
    for (const round of [1, 2]) {
      const prefix = `s1r${round}`
      const previousBuild = round === 1 ? [] : [`s1r${round - 1}-build`]
      const definitions = [
        workflowAgent(`${prefix}-review-codex`, previousBuild),
        workflowAgent(`${prefix}-review-claude`, previousBuild),
        workflowAgent(`${prefix}-debate`, [`${prefix}-review-codex`, `${prefix}-review-claude`]),
        workflowAgent(`${prefix}-verdict`, [`${prefix}-debate`], {
          format: "json",
          schema: { type: "object", required: ["done"] }
        }),
        workflowAgent(`${prefix}-fix`, [`${prefix}-verdict`]),
        workflowAgent(`${prefix}-build`, [`${prefix}-fix`])
      ]
      authored.push(...definitions)
      runtime.push(
        ...definitions.map((definition) =>
          node(definition.id, "pending", { needs: definition.needs })
        )
      )
    }
    authored.push(workflowAgent("s1-gate", ["s1r2-build"]))
    runtime.push(node("s1-gate", "pending", { needs: ["s1r2-build"] }))

    const model = buildBoardModel(state(runtime), [], {
      now: NOW,
      workflowNodes: authored
    })
    expect(model.rows.map((row) => row.key)).toEqual([
      "s1r1-review-codex",
      "s1r1-review-claude",
      "s1r1-debate",
      "s1r1-verdict",
      "s1r1-fix",
      "s1r1-build",
      "s1r#-review-codex|s1r#-review-claude|s1r#-debate|s1r#-verdict|s1r#-fix|s1r#-build:loop",
      "s1-gate"
    ])
    expect(model.rows.at(-2)).toMatchObject({
      kind: "unrolled-repeat",
      label: "s1",
      round: 1,
      maxRounds: 2,
      backTo: ["s1r1-review-codex", "s1r1-review-claude"],
      until: "until s1r1-verdict reports done = true"
    })
    const frame = renderBoardFrame(model, null).text
    expect(frame).toContain(
      "↻ s1  round 1/2 — back to s1r1-review-codex + s1r1-review-claude until s1r1-verdict reports done = true"
    )
    expect(frame).not.toContain("s1r2-review-codex")
    expect(frame).not.toContain("s1r2-build")
    expect(frame).toContain("\n  ○ s1-gate")

    const advanced = buildBoardModel(
      state(
        runtime.map((runtimeNode) =>
          runtimeNode.id.startsWith("s1r1-")
            ? node(runtimeNode.id, "completed", { needs: runtimeNode.needs })
            : runtimeNode
        )
      ),
      [],
      { now: NOW, workflowNodes: authored }
    )
    const advancedFrame = renderBoardFrame(advanced, null).text
    expect(advancedFrame).toContain("s1r2-review-codex")
    expect(
      advanced.rows.some((row) => row.kind === "node" && row.node.id === "s1r1-review-codex")
    ).toBe(false)
    expect(advancedFrame).toContain("↻ s1  round 2/2")
  })

  test("treats stale-pane data as garnish and gives every stalled pane safe guidance", () => {
    const command = node("command", "running", {
      type: "command",
      provider: null
    })
    const model = buildBoardModel(state([node("agent", "running"), command]), [], {
      now: NOW,
      paneGarnish: {
        agent: { condition: "gone", detail: "Pane gone." },
        command: { condition: "gone", detail: null }
      }
    })

    expect(model.nodes.find((value) => value.id === "agent")?.status).toBe("running")
    expect(model.nodes.find((value) => value.id === "agent")?.stalledPane).toEqual({
      condition: "gone",
      detail:
        "Pane gone. Inspect status, restore the owning pane or resume its provider session, and let that same owner finish and submit completion.",
      guidanceCommand: "orchestrate status run-1"
    })
    expect(model.nodes.find((value) => value.id === "command")?.stalledPane).toMatchObject({
      guidanceCommand: "orchestrate status run-1",
      detail: expect.stringContaining("launcher-owned recovery")
    })
  })

  test("treats done, blocked, and gone samples as actionable while startup samples stay transient", () => {
    expect(classifyLivePane(true, "agent", "idle").condition).toBe("live")
    expect(classifyLivePane(true, "agent", "unknown").condition).toBe("live")
    expect(classifyLivePane(true, "agent", "working").condition).toBe("live")
    const done = classifyLivePane(true, "agent", "done")
    expect(done.condition).toBe("done")
    const blocked = classifyLivePane(true, "agent", "blocked")
    const gone = classifyLivePane(false, "agent", null)
    expect(blocked.condition).toBe("blocked")
    expect(gone.condition).toBe("gone")

    const blockedModel = buildBoardModel(state([node("agent", "running")]), [], {
      now: NOW,
      paneGarnish: {
        agent: { condition: "blocked", detail: blocked.detail }
      }
    })
    const blockedFrame = renderBoardFrame(blockedModel, "agent").text
    expect(blockedModel.needsYou).toHaveLength(1)
    expect(blockedModel.needsYou[0]).toMatchObject({
      kind: "stalled-pane",
      condition: "blocked",
      title: "agent: agent blocked"
    })
    expect(blockedModel.needsYou[0]?.title).not.toContain("pane idle")
    expect(blockedFrame).toContain("agent blocked")
    expect(blockedFrame).not.toContain("pane idle")

    const doneModel = buildBoardModel(state([node("agent", "running")]), [], {
      now: NOW,
      paneGarnish: { agent: { condition: "done", detail: done.detail } }
    })
    const doneFrame = renderBoardFrame(doneModel, "agent").text
    expect(doneModel.needsYou).toHaveLength(1)
    expect(doneModel.needsYou[0]?.title).toBe("agent: result missing")
    expect(doneModel.needsYou[0]?.command).toBe("orchestrate status run-1")
    expect(doneModel.needsYou[0]?.detail).toContain("restore or resume the owning provider session")
    expect(doneFrame.match(/result missing/g)).toHaveLength(2)
    expect(doneFrame).toContain("orchestrate status run-1")
    expect(doneFrame).not.toContain("--token")

    const submittedModel = buildBoardModel(state([node("agent", "running")]), [], {
      now: NOW,
      paneGarnish: {
        agent: {
          condition: "submitted",
          detail: "Authenticated completion submitted; pending reconcile."
        }
      }
    })
    const submittedFrame = renderBoardFrame(submittedModel, "agent").text
    expect(submittedModel.needsYou).toEqual([])
    expect(submittedModel.nodes[0]?.stalledPane).toMatchObject({
      condition: "submitted",
      guidanceCommand: "orchestrate reconcile run-1"
    })
    expect(submittedFrame).toContain("submitted; pending reconcile")
    expect(submittedFrame).not.toContain("result missing")

    const transientModel = buildBoardModel(state([node("agent", "running")]), [], {
      now: NOW,
      paneGarnish: { agent: { condition: "live", detail: null } }
    })
    expect(transientModel.needsYou).toEqual([])
  })

  test("clock refresh advances elapsed time without state writes and resamples status", async () => {
    type Timer = ReturnType<typeof setTimeout>
    const callbacks = new Map<Timer, () => void>()
    let nextTimer = 0
    const elapsed: number[] = []
    const statuses = ["unknown", "working"] as const
    let refreshes = 0
    const clock = startClockRefresh(
      async () => {
        const now = new Date(Date.parse(START) + (refreshes + 1) * 1_000).toISOString()
        elapsed.push(buildBoardModel(state([node("agent", "running")]), [], { now }).run.elapsedMs)
        expect(classifyLivePane(true, "agent", statuses[refreshes] ?? "working").condition).toBe(
          "live"
        )
        refreshes += 1
      },
      {
        intervalMs: 1,
        setTimer: (callback) => {
          const timer = ++nextTimer as unknown as Timer
          callbacks.set(timer, callback)
          return timer
        },
        clearTimer: (timer) => {
          callbacks.delete(timer)
        }
      }
    )
    const fire = async (): Promise<void> => {
      const entry = callbacks.entries().next().value as [Timer, () => void]
      callbacks.delete(entry[0])
      entry[1]()
      await Promise.resolve()
      await Promise.resolve()
    }
    await fire()
    await fire()
    clock.stop()

    expect(elapsed).toEqual([1_000, 2_000])
    expect(callbacks.size).toBe(0)
  })

  test("clock refresh never overlaps and cleanup suppresses later ticks", async () => {
    type Timer = ReturnType<typeof setTimeout>
    const callbacks = new Map<Timer, () => void>()
    let nextTimer = 0
    let resolveRefresh!: () => void
    let calls = 0
    const clock = startClockRefresh(
      () => {
        calls += 1
        return new Promise<void>((resolve) => {
          resolveRefresh = resolve
        })
      },
      {
        intervalMs: 1,
        setTimer: (callback) => {
          const timer = ++nextTimer as unknown as Timer
          callbacks.set(timer, callback)
          return timer
        },
        clearTimer: (timer) => {
          callbacks.delete(timer)
        }
      }
    )
    const first = callbacks.entries().next().value as [Timer, () => void]
    callbacks.delete(first[0])
    first[1]()
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(callbacks.size).toBe(0)

    clock.stop()
    resolveRefresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(callbacks.size).toBe(0)
    expect(calls).toBe(1)
  })

  test("formats digest-bound and stalled-inspection commands exactly", () => {
    expect(
      gateApprovalCommand("run-1", {
        nodeId: "review",
        title: "Review",
        content: "content",
        digest: "abc123",
        openedAt: START,
        approvedAt: null
      })
    ).toBe("orchestrate approve run-1 --gate review --digest abc123")
    expect(revisionApprovalCommand("run-1", "def456")).toBe(
      "orchestrate approve run-1 --revision def456"
    )
    expect(stalledInspectionCommand("run-1")).toBe("orchestrate status run-1")
  })
})

describe("board input mapping", () => {
  const model = buildBoardModel(
    state([node("running", "running"), node("held", "completed"), node("done", "completed")], {
      holds: { held: { target: "held", scope: "instance", setAt: START } }
    }),
    [],
    { now: NOW }
  )

  test("maps keyboard selection and activation without terminal state", () => {
    expect(mapBoardInput(model, null, { type: "key", key: "down" })).toEqual({
      type: "select-node",
      nodeId: "running"
    })
    expect(mapBoardInput(model, "running", { type: "key", key: "down" })).toEqual({
      type: "select-node",
      nodeId: "held"
    })
    expect(mapBoardInput(model, "running", { type: "key", key: "enter" })).toMatchObject({
      type: "focus-node",
      nodeId: "running"
    })
    expect(mapBoardInput(model, "done", { type: "key", key: "enter" })).toEqual({
      type: "show-result",
      nodeId: "done",
      resultPath: "nodes/done/result.txt"
    })
  })

  test("maps mouse rows and ignores non-click input", () => {
    expect(
      mapBoardInput(model, null, { type: "mouse", button: "left", action: "press", row: 0 })
    ).toMatchObject({ type: "focus-node", nodeId: "running" })
    expect(
      mapBoardInput(model, null, { type: "mouse", button: "other", action: "press", row: 0 })
    ).toEqual({ type: "none" })
    expect(
      mapBoardInput(model, null, { type: "mouse", button: "left", action: "release", row: 0 })
    ).toEqual({ type: "none" })
  })

  test("maps pause, resume, stop, and hold controls", () => {
    expect(mapBoardInput(model, null, { type: "key", key: "p" })).toEqual({
      type: "pause-run",
      runId: "run-1"
    })
    expect(mapBoardInput(model, null, { type: "key", key: "s" })).toEqual({
      type: "stop-run",
      runId: "run-1"
    })
    expect(mapBoardInput(model, "running", { type: "key", key: "h" })).toEqual({
      type: "hold-node",
      runId: "run-1",
      nodeId: "running"
    })
    expect(mapBoardInput(model, "held", { type: "key", key: "h" })).toEqual({
      type: "release-node",
      runId: "run-1",
      nodeId: "held"
    })
    const paused = {
      ...model,
      run: {
        ...model.run,
        status: "paused" as const,
        pause: {
          kind: "human" as const,
          message: "Paused by the user.",
          repeatId: null,
          createdAt: START
        }
      }
    }
    expect(mapBoardInput(paused, null, { type: "key", key: "p" })).toEqual({
      type: "resume-run",
      runId: "run-1"
    })
    expect(mapBoardInput(paused, null, { type: "key", key: "r" })).toEqual({
      type: "resume-run",
      runId: "run-1"
    })
    for (const kind of ["fuse", "max-rounds"] as const) {
      const decision = {
        ...paused,
        run: { ...paused.run, pause: { ...paused.run.pause, kind } }
      }
      expect(mapBoardInput(decision, null, { type: "key", key: "p" })).toEqual({ type: "none" })
      expect(mapBoardInput(decision, null, { type: "key", key: "r" })).toEqual({ type: "none" })
    }
  })

  test("renders a stable plain frame shared by the OpenTUI board", () => {
    expect(renderBoardFrame(model, "running").text).toBe(
      [
        "ORCHESTRATE  Board test  RUNNING  30s",
        "run-1  Exercise the model",
        "",
        "NEEDS YOU",
        "  ! held: completed; downstream held",
        "    Release the hold to allow dependents to proceed; the terminal outcome is unchanged.",
        "    orchestrate release run-1 held",
        "",
        "WORKFLOW",
        "> ● running  running ▸  30s",
        "  ✓ held  completed ⏸ downstream held  30s",
        "  ✓ done  completed ▸  30s",
        "",
        "↑/↓ select  enter open  p pause/resume  h hold/release  s stop  q quit"
      ].join("\n")
    )
  })
})
