import { describe, expect, test } from "bun:test"

import type {
  AgentNode,
  CommandNode,
  CrankEvent,
  RunState,
  StatePatchOperation,
  WorkflowNode,
  WorkflowSpec
} from "../src/types.js"

import { reconcileApprovedRevisionState } from "../src/crank.js"
import {
  createInitialRunState,
  resolveInputSourceId,
  transition,
  type TransitionContext
} from "../src/transition.js"

const NOW = "2026-08-02T12:00:00.000Z"

function workspace(writes: readonly string[] = [], resources: readonly string[] = []) {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "none" as const,
    writes,
    exclusiveResources: resources
  }
}

function command(id: string, overrides: Partial<CommandNode> = {}): CommandNode {
  return {
    id,
    type: "command",
    title: id,
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    retry: { maxAttempts: 1 },
    gate: "none",
    argv: ["true"],
    mutates: false,
    inheritEnv: [],
    env: {},
    allowedExitCodes: [0],
    ...overrides
  }
}

function agent(id: string, overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    id,
    type: "agent",
    title: id,
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    retry: { maxAttempts: 1 },
    gate: "none",
    provider: "codex",
    model: "provider-default",
    effort: null,
    prompt: id,
    session: { mode: "fresh", from: null, saveAs: null },
    permissions: {
      execution: { sandbox: "read-only" },
      escalation: "deny",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
    output: { format: "text", schema: null },
    ...overrides
  } as AgentNode
}

function workflow(
  nodes: readonly WorkflowNode[],
  overrides: Partial<WorkflowSpec> = {}
): WorkflowSpec {
  return {
    name: "transition-test",
    objective: "Exercise pure crank transitions.",
    cwd: "/tmp",
    concurrency: 3,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes,
    repeats: [],
    ...overrides
  }
}

function context(...ids: readonly string[]): TransitionContext {
  const preparedNodes = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        token: `token:${id}`,
        resultPath: `nodes/${id}/result.json`,
        outputPath: `nodes/${id}/output.log`,
        gate: { content: `rendered:${id}`, digest: `digest:${id}` }
      }
    ])
  )
  return {
    prepareNode: (_state, _workflow, node) => {
      const prepared = preparedNodes[node.id]
      if (prepared === undefined) {
        throw new Error(`Unexpected prepared node ${node.id}`)
      }
      return prepared
    }
  }
}

function start(spec: WorkflowSpec, prepared?: TransitionContext) {
  const initial = createInitialRunState(spec, {
    id: "run-1",
    runtimeVersion: "test-build",
    digest: "workflow-digest",
    now: NOW,
    origin: null
  })
  return transition(initial, spec, { type: "run" }, NOW, prepared)
}

function token(state: RunState, id: string): string {
  const value = state.nodes[id]?.attempts.at(-1)?.token
  if (value === undefined) {
    throw new Error(`No token for ${id}`)
  }
  return value
}

function crank(
  state: RunState,
  spec: WorkflowSpec,
  event: CrankEvent,
  prepared?: TransitionContext
) {
  return transition(state, spec, event, NOW, prepared)
}

function observe(state: RunState, spec: WorkflowSpec, id: string) {
  const attempt = state.nodes[id]?.attempts.at(-1)
  if (attempt === undefined) {
    throw new Error(`No planned attempt for ${id}`)
  }
  return crank(state, spec, {
    type: "spawn-observed",
    nodeId: id,
    intentId: `${id}:a${attempt.attempt}`,
    pane: {
      workspaceId: "workspace",
      tabId: `tab:${id}`,
      paneId: `pane:${id}:${attempt.attempt}`,
      group: id,
      surface: "tab"
    },
    providerSessionId: null
  })
}

function decode(part: string): string {
  return part.replaceAll("~1", "/").replaceAll("~0", "~")
}

function applyPatch(document: unknown, patch: readonly StatePatchOperation[]): unknown {
  let result = structuredClone(document)
  for (const operation of patch) {
    if (operation.path === "") {
      if (operation.op === "remove") {
        result = undefined
      } else {
        result = structuredClone(operation.value)
      }
      continue
    }
    const parts = operation.path.slice(1).split("/").map(decode)
    const key = parts.pop()!
    let parent = result as Record<string, unknown>
    for (const part of parts) {
      parent = parent[part] as Record<string, unknown>
    }
    if (operation.op === "remove") {
      Reflect.deleteProperty(parent, key)
    } else {
      parent[key] = structuredClone(operation.value)
    }
  }
  return result
}

describe("pure crank transition", () => {
  test("initializes a versionless run and schedules only dependency-ready nodes up to concurrency", () => {
    const spec = workflow(
      [command("first"), command("dependent", { needs: ["first"] }), command("parallel")],
      { concurrency: 2 }
    )
    const result = start(spec, context("first", "parallel"))

    expect(result.state.sequence).toBeGreaterThan(0)
    expect(result.state.nodes.first?.status).toBe("running")
    expect(result.state.nodes.parallel?.status).toBe("running")
    expect(result.state.nodes.dependent?.status).toBe("pending")
    expect(result.state.starts).toBe(0)
    expect(result.state.nodes.first?.attempts.at(-1)?.status).toBe("planned")
    expect(Object.values(result.state.spawnIntents)).toHaveLength(2)
    expect(result.events[0]?.type).toBe("run.started")
    expect(result.events[0]?.patch[0]?.path).toBe("")
    const firstObserved = observe(result.state, spec, "first")
    const allObserved = observe(firstObserved.state, spec, "parallel")
    expect(allObserved.state.starts).toBe(2)
    expect(allObserved.state.nodes.first?.attempts.at(-1)?.pane?.paneId).toBe("pane:first:1")
  })

  test("refuses to plan a pane without caller-prepared durable paths and a random token", () => {
    const spec = workflow([command("work")])
    expect(() => start(spec)).toThrow('Prepared execution content is required for node "work"')
  })

  test("journals a board placement fallback without changing scheduling", () => {
    const spec = workflow([command("work")])
    const result = start(spec, {
      ...context("work"),
      uiDegraded: "No current pane; used the run workspace."
    })
    expect(result.events.map((event) => event.type)).toContain("ui.degraded")
    expect(result.state.nodes.work?.status).toBe("running")
  })

  test.each([
    {
      name: "write overlap",
      left: command("left", { workspace: workspace(["/tmp/tree"]) }),
      right: command("right", { workspace: workspace(["/tmp/tree/file"]) }),
      allow: false,
      expected: "ready"
    },
    {
      name: "approved write overlap",
      left: command("left", { workspace: workspace(["/tmp/tree"]) }),
      right: command("right", { workspace: workspace(["/tmp/tree/file"]) }),
      allow: true,
      expected: "running"
    },
    {
      name: "exclusive resource even with approved writes",
      left: command("left", { workspace: workspace([], ["device"]) }),
      right: command("right", { workspace: workspace([], ["device"]) }),
      allow: true,
      expected: "ready"
    }
  ] as const)("serializes $name", ({ left, right, allow, expected }) => {
    const spec = workflow([left, right])
    const initial = createInitialRunState(spec, {
      id: "run-1",
      runtimeVersion: "test-build",
      digest: "digest",
      now: NOW,
      origin: null,
      allowWriteConflicts: allow
    })
    const result = transition(initial, spec, { type: "run" }, NOW, context("left", "right"))
    expect(result.state.nodes.right?.status).toBe(expected)
  })

  test("opens a digest-bound gate, rejects the wrong digest, and schedules after approval", () => {
    const spec = workflow([agent("review", { gate: "approval" })])
    const opened = start(spec, context("review"))
    expect(opened.state.nodes.review?.status).toBe("awaiting-approval")
    expect(opened.state.gates.review?.content).toBe("rendered:review")
    const gateEvent = opened.events.find((event) => event.type === "gate.opened")
    expect(gateEvent?.message).toContain(
      `orchestrate approve ${opened.state.id} --gate review --digest ${opened.state.gates.review?.digest}`
    )
    expect(() =>
      crank(opened.state, spec, { type: "approve-gate", nodeId: "review", digest: "wrong" })
    ).toThrow("digest mismatch")

    const approved = crank(
      opened.state,
      spec,
      { type: "approve-gate", nodeId: "review", digest: "digest:review" },
      context("review")
    )
    expect(approved.state.nodes.review?.status).toBe("running")
    expect(approved.events.map((item) => item.type)).toContain("gate.approved")
  })

  test("keeps completed outcome orthogonal to a downstream hold and release", () => {
    const spec = workflow([agent("work"), command("after", { needs: ["work"] })])
    const running = start(spec, context("work"))
    const observed = observe(running.state, spec, "work")
    const held = crank(observed.state, spec, { type: "hold", nodeId: "work" })
    const done = crank(held.state, spec, {
      type: "node-done",
      nodeId: "work",
      token: token(held.state, "work"),
      outcome: "completed",
      hold: false,
      result: "done",
      error: null,
      providerSessionId: null
    })
    expect(done.state.nodes.work?.status).toBe("completed")
    expect(done.state.holds.work).toEqual({ target: "work", scope: "instance", setAt: NOW })
    expect(done.state.nodes.after?.status).toBe("pending")

    const released = crank(done.state, spec, { type: "release", nodeId: "work" }, context("after"))
    expect(released.state.nodes.work?.status).toBe("completed")
    expect(released.state.holds.work).toBeUndefined()
    expect(released.state.nodes.after?.status).toBe("running")
  })

  test("retries immediately, rejects stale tokens, and pauses at the max-start fuse", () => {
    const spec = workflow([agent("work", { retry: { maxAttempts: 3 } })], {
      limits: { maxStarts: 1 }
    })
    const planned = start(spec, context("work"))
    const running = observe(planned.state, spec, "work")
    expect(() =>
      crank(running.state, spec, {
        type: "node-done",
        nodeId: "work",
        token: "stale",
        outcome: "failed",
        hold: false,
        result: null,
        error: "bad",
        providerSessionId: null
      })
    ).toThrow("stale token")
    const failed = crank(running.state, spec, {
      type: "node-done",
      nodeId: "work",
      token: token(running.state, "work"),
      outcome: "failed",
      hold: false,
      result: null,
      error: "bad",
      providerSessionId: null
    })
    expect(failed.state.status).toBe("paused")
    expect(failed.state.pause?.kind).toBe("fuse")
    expect(failed.state.nodes.work?.attempts).toHaveLength(1)

    const resumed = crank(
      failed.state,
      spec,
      {
        type: "resume",
        overrideFuse: true,
        continueRounds: null,
        acceptRepeat: null
      },
      context("work")
    )
    expect(resumed.state.nodes.work?.attempts).toHaveLength(2)
    expect(resumed.state.nodes.work?.status).toBe("running")
  })

  test("persists spawn intents, records observed panes, and retries a failed spawn", () => {
    const spec = workflow([command("work", { retry: { maxAttempts: 2 } })])
    const planned = start(spec, context("work"))
    const intent = planned.state.spawnIntents["work:a1"]
    expect(intent?.status).toBe("planned")
    expect(planned.state.starts).toBe(0)

    const failed = crank(
      planned.state,
      spec,
      { type: "spawn-failed", nodeId: "work", intentId: "work:a1", error: "herdr unavailable" },
      {
        prepareNode: () => ({
          token: "token:work:retry",
          resultPath: "nodes/work/retry.result",
          outputPath: "nodes/work/retry.output",
          gate: null
        })
      }
    )
    expect(failed.state.spawnIntents["work:a1"]).toBeUndefined()
    expect(failed.state.spawnIntents["work:a2"]?.status).toBe("planned")
    expect(failed.state.nodes.work?.attempts.map((attempt) => attempt.status)).toEqual([
      "failed",
      "planned"
    ])

    const observed = observe(failed.state, spec, "work")
    expect(observed.state.spawnIntents["work:a2"]?.status).toBe("spawned")
    expect(observed.state.nodes.work?.attempts.at(-1)?.status).toBe("running")
    expect(observed.state.starts).toBe(1)
    expect(() => observe(observed.state, spec, "work")).toThrow("already observed")
  })

  test("a command repeat advances on a non-clean numeric exit and pauses at maxRounds", () => {
    const check = command("check", { allowedExitCodes: [0] })
    const spec = workflow([check], {
      repeats: [
        {
          id: "loop",
          members: ["check"],
          until: { type: "command-success", node: "check" },
          maxRounds: 2
        }
      ]
    })
    const firstPlanned = start(spec, context("check--r1"))
    const first = observe(firstPlanned.state, spec, "check--r1")
    expect(first.state.nodes.check).toBeUndefined()
    expect(first.state.nodes["check--r1"]?.status).toBe("running")
    const second = crank(
      first.state,
      spec,
      {
        type: "node-exit",
        nodeId: "check--r1",
        token: token(first.state, "check--r1"),
        code: 1,
        error: null
      },
      context("check--r2")
    )
    expect(second.state.nodes["check--r1"]?.status).toBe("completed")
    expect(second.state.nodes["check--r2"]?.status).toBe("running")
    const secondObserved = observe(second.state, spec, "check--r2")
    const paused = crank(secondObserved.state, spec, {
      type: "node-exit",
      nodeId: "check--r2",
      token: token(secondObserved.state, "check--r2"),
      code: 2,
      error: null
    })
    expect(paused.state.status).toBe("paused")
    expect(paused.state.repeats.loop?.status).toBe("max-rounds")
    expect(paused.state.pause?.kind).toBe("max-rounds")

    const continued = crank(
      paused.state,
      spec,
      { type: "resume", overrideFuse: false, continueRounds: 2, acceptRepeat: null },
      context("check--r3")
    )
    expect(continued.state.nodes["check--r3"]?.status).toBe("running")
    expect(continued.state.repeatRoundExtensions.loop).toBe(2)
    expect(
      resolveInputSourceId(continued.state, spec, "check--r3", {
        from: "check",
        as: "Previous check",
        include: "content",
        round: "previous"
      })
    ).toBe("check--r2")
  })

  test("accepting a maxRounds repeat releases an outside dependency to the final result", () => {
    const check = command("check")
    const after = command("after", { needs: ["check"] })
    const spec = workflow([check, after], {
      repeats: [
        {
          id: "loop",
          members: ["check"],
          until: { type: "command-success", node: "check" },
          maxRounds: 1
        }
      ]
    })
    const firstPlanned = start(spec, context("check--r1"))
    const first = observe(firstPlanned.state, spec, "check--r1")
    const paused = crank(first.state, spec, {
      type: "node-exit",
      nodeId: "check--r1",
      token: token(first.state, "check--r1"),
      code: 3,
      error: null,
      result: "check output\n"
    })
    const accepted = crank(
      paused.state,
      spec,
      { type: "resume", overrideFuse: false, continueRounds: null, acceptRepeat: "loop" },
      context("after")
    )
    expect(accepted.state.repeats.loop?.status).toBe("completed")
    expect(accepted.state.nodes.after?.status).toBe("running")
    expect(accepted.state.nodes["check--r1"]?.resultPath).toBe("nodes/check--r1/output.log")
    expect(accepted.state.nodes["check--r1"]?.result).toBe("check output\n")
    expect(
      resolveInputSourceId(accepted.state, spec, "after", {
        from: "check",
        as: "Final check",
        include: "path",
        round: "current"
      })
    ).toBe("check--r1")
  })

  test("evaluates an agent JSON-pointer verdict and stores fresh session lineage per instance", () => {
    const review = agent("review", {
      session: { mode: "fresh", from: null, saveAs: "review-session" },
      output: { format: "json", schema: { type: "object" } }
    })
    const spec = workflow([review], {
      repeats: [
        {
          id: "review-loop",
          members: ["review"],
          until: { type: "agent-output", node: "review", pointer: "/verdict/clean", equals: true },
          maxRounds: 2
        }
      ]
    })
    const planned = start(spec, context("review--r1"))
    const running = observe(planned.state, spec, "review--r1")
    const completed = crank(running.state, spec, {
      type: "node-done",
      nodeId: "review--r1",
      token: token(running.state, "review--r1"),
      outcome: "completed",
      hold: false,
      result: { verdict: { clean: true } },
      error: null,
      providerSessionId: "session-r1"
    })
    expect(completed.state.repeats["review-loop"]?.status).toBe("completed")
    expect(completed.state.nodes["review--r1"]?.result).toEqual({ verdict: { clean: true } })
    expect(completed.state.sessions["review-session"]?.sessionId).toBe("session-r1")
    expect(completed.state.status).toBe("completed")
  })

  test("treats reordered object keys as the same agent-output verdict", () => {
    const review = agent("review", {
      output: { format: "json", schema: { type: "object" } }
    })
    const spec = workflow([review], {
      repeats: [
        {
          id: "review-loop",
          members: ["review"],
          until: {
            type: "agent-output",
            node: "review",
            pointer: "/verdict",
            equals: { clean: true, reason: "verified" }
          },
          maxRounds: 2
        }
      ]
    })
    const planned = start(spec, context("review--r1"))
    const running = observe(planned.state, spec, "review--r1")
    const completed = crank(running.state, spec, {
      type: "node-done",
      nodeId: "review--r1",
      token: token(running.state, "review--r1"),
      outcome: "completed",
      hold: false,
      result: { verdict: { reason: "verified", clean: true } },
      error: null,
      providerSessionId: null
    })

    expect(completed.state.repeats["review-loop"]?.status).toBe("completed")
    expect(completed.state.nodes["review--r2"]).toBeUndefined()
    expect(completed.state.status).toBe("completed")
  })

  test("template holds and gates apply independently to every repeat instance", () => {
    const review = agent("review", {
      gate: "approval",
      output: { format: "json", schema: { type: "object" } }
    })
    const spec = workflow([review], {
      repeats: [
        {
          id: "loop",
          members: ["review"],
          until: { type: "agent-output", node: "review", pointer: "/clean", equals: true },
          maxRounds: 2
        }
      ]
    })
    const opened = start(spec, context("review--r1"))
    const held = crank(opened.state, spec, { type: "hold", nodeId: "review" })
    const approved = crank(
      held.state,
      spec,
      { type: "approve-gate", nodeId: "review--r1", digest: "digest:review--r1" },
      context("review--r1")
    )
    const observed = observe(approved.state, spec, "review--r1")
    const done = crank(observed.state, spec, {
      type: "node-done",
      nodeId: "review--r1",
      token: token(observed.state, "review--r1"),
      outcome: "completed",
      hold: false,
      result: { clean: false },
      error: null,
      providerSessionId: null
    })
    expect(done.state.nodes["review--r1"]?.status).toBe("completed")
    expect(done.state.repeats.loop?.round).toBe(1)
    expect(done.state.nodes["review--r2"]).toBeUndefined()
    const released = crank(
      done.state,
      spec,
      { type: "release", nodeId: "review" },
      context("review--r2")
    )
    expect(released.state.nodes["review--r2"]?.status).toBe("awaiting-approval")
    expect(released.state.gates["review--r2"]?.digest).toBe("digest:review--r2")
  })

  test("keeps an atomic repeat hold instance-scoped", () => {
    const spec = workflow([agent("review", { output: { format: "json", schema: {} } })], {
      repeats: [
        {
          id: "loop",
          members: ["review"],
          until: { type: "agent-output", node: "review", pointer: "/clean", equals: true },
          maxRounds: 2
        }
      ]
    })
    const planned = start(spec, context("review--r1"))
    const running = observe(planned.state, spec, "review--r1")
    const completed = crank(running.state, spec, {
      type: "node-done",
      nodeId: "review--r1",
      token: token(running.state, "review--r1"),
      outcome: "completed",
      hold: true,
      result: { clean: false },
      error: null,
      providerSessionId: null
    })

    expect(completed.state.nodes["review--r1"]?.status).toBe("completed")
    expect(completed.state.holds).toEqual({
      "review--r1": { target: "review--r1", scope: "instance", setAt: NOW }
    })
    expect(completed.state.nodes["review--r2"]).toBeUndefined()

    const released = crank(
      completed.state,
      spec,
      { type: "release", nodeId: "review--r1" },
      context("review--r2")
    )
    expect(released.state.nodes["review--r1"]?.status).toBe("completed")
    expect(released.state.nodes["review--r2"]?.status).toBe("running")
    expect(released.state.holds.review).toBeUndefined()
  })

  test("plain pause blocks new starts while live completion is recorded, resume continues, stop cancels", () => {
    const spec = workflow([agent("first"), command("after", { needs: ["first"] })])
    const planned = start(spec, context("first"))
    const running = observe(planned.state, spec, "first")
    const paused = crank(running.state, spec, { type: "pause" })
    const doneWhilePaused = crank(
      paused.state,
      spec,
      {
        type: "node-done",
        nodeId: "first",
        token: token(paused.state, "first"),
        outcome: "completed",
        hold: false,
        result: "ok",
        error: null,
        providerSessionId: null
      },
      context("after")
    )
    expect(doneWhilePaused.state.nodes.after?.status).toBe("pending")
    const resumed = crank(
      doneWhilePaused.state,
      spec,
      {
        type: "resume",
        overrideFuse: false,
        continueRounds: null,
        acceptRepeat: null
      },
      context("after")
    )
    expect(resumed.state.nodes.after?.status).toBe("running")
    const stopped = crank(resumed.state, spec, { type: "stop" })
    expect(stopped.state.status).toBe("stopped")
    expect(stopped.state.nodes.after?.status).toBe("cancelled")
  })

  test("proposes, digest-checks, approves, and discards safe remaining-plan revisions", () => {
    const base = workflow([command("first"), command("old", { needs: ["first"] })])
    const running = start(base, context("first"))
    const held = crank(running.state, base, { type: "hold", nodeId: "old" })
    const revised = workflow([command("first"), command("new", { needs: ["first"] })], {
      objective: "Revised objective"
    })
    const proposed = crank(held.state, base, {
      type: "propose-revision",
      workflow: revised,
      digest: "revision-digest",
      summary: ["old -> new"]
    })
    expect(() =>
      crank(proposed.state, base, { type: "approve-revision", digest: "wrong" })
    ).toThrow("digest mismatch")
    const approved = crank(proposed.state, base, {
      type: "approve-revision",
      digest: "revision-digest"
    })
    expect(approved.workflow).toEqual(revised)
    expect(approved.state.nodes.old).toBeUndefined()
    expect(approved.state.holds.old).toBeUndefined()
    expect(approved.state.nodes.new?.status).toBe("pending")
    expect(approved.state.objective).toBe("Revised objective")
    expect(approved.events.find((event) => event.type === "revision.approved")?.data).toEqual({
      digest: "revision-digest",
      workflow: revised
    })

    const reproposed = crank(approved.state, revised, {
      type: "propose-revision",
      workflow: revised,
      digest: "discard-me",
      summary: []
    })
    const discarded = crank(reproposed.state, revised, { type: "discard-revision" })
    expect(discarded.state.pendingRevision).toBeNull()
  })

  test("accepts a revision whose repeat contract only reorders object keys", () => {
    const review = agent("review", {
      output: { format: "json", schema: { type: "object" } }
    })
    const base = workflow([review], {
      repeats: [
        {
          id: "review-loop",
          members: ["review"],
          until: {
            type: "agent-output",
            node: "review",
            pointer: "/verdict",
            equals: { clean: true, reason: "verified" }
          },
          maxRounds: 2
        }
      ]
    })
    const revised = workflow([review], {
      repeats: [
        {
          id: "review-loop",
          members: ["review"],
          until: {
            type: "agent-output",
            node: "review",
            pointer: "/verdict",
            equals: { reason: "verified", clean: true }
          },
          maxRounds: 2
        }
      ]
    })
    const running = start(base, context("review--r1"))
    const proposed = crank(running.state, base, {
      type: "propose-revision",
      workflow: revised,
      digest: "revision-digest",
      summary: []
    })
    const approved = crank(proposed.state, base, {
      type: "approve-revision",
      digest: "revision-digest"
    })

    expect(approved.workflow).toEqual(revised)
    expect(approved.state.pendingRevision).toBeNull()
  })

  test("holds old-plan scheduling while a revision decision is pending", () => {
    const base = workflow([command("first"), command("after", { needs: ["first"] })], {
      concurrency: 1
    })
    const started = observe(start(base, context("first")).state, base, "first")
    const revised = workflow(
      [
        command("first"),
        command("barrier", { needs: ["first"] }),
        command("after", { needs: ["barrier"] })
      ],
      { concurrency: 1 }
    )
    const proposed = crank(started.state, base, {
      type: "propose-revision",
      workflow: revised,
      digest: "revision-digest",
      summary: ["+ node barrier", "~ node after"]
    })
    const completed = crank(proposed.state, base, {
      type: "node-exit",
      nodeId: "first",
      token: token(proposed.state, "first"),
      code: 0,
      error: null
    })
    expect(completed.state.nodes.first?.status).toBe("completed")
    expect(completed.state.nodes.after?.status).toBe("pending")
    expect(completed.events.some((event) => event.type === "node.spawn-planned")).toBe(false)

    const reconciled = reconcileApprovedRevisionState(completed.state, {
      type: "approve-revision",
      digest: "revision-digest"
    })
    const approved = crank(
      reconciled,
      base,
      { type: "approve-revision", digest: "revision-digest" },
      context("barrier")
    )
    expect(approved.state.nodes.barrier?.status).toBe("running")
    expect(approved.state.nodes.after?.status).toBe("pending")
  })

  test("reconciles changed dependencies and inserted nodes before revision scheduling", () => {
    const base = workflow([
      command("board-ui-fix"),
      command("quality-fix", { needs: ["board-ui-fix"] }),
      command("runtime-review", { needs: ["quality-fix"] }),
      command("surface-review", { needs: ["quality-fix"] }),
      command("contract-doc-review", { needs: ["quality-fix"] })
    ])
    const running = start(base, context("board-ui-fix"))
    const revised = workflow([
      command("board-ui-fix"),
      command("completion-control-fix", { needs: ["board-ui-fix"] }),
      command("board-live-placement-fix", { needs: ["completion-control-fix"] }),
      command("quality-fix", { needs: ["board-live-placement-fix"] }),
      command("runtime-review", { needs: ["quality-fix"] }),
      command("surface-review", { needs: ["quality-fix"] }),
      command("contract-doc-review", { needs: ["quality-fix"] })
    ])
    const proposed = crank(running.state, base, {
      type: "propose-revision",
      workflow: revised,
      digest: "revision-digest",
      summary: ["insert completion and live fixes"]
    })
    const reconciled = reconcileApprovedRevisionState(proposed.state, {
      type: "approve-revision",
      digest: "revision-digest"
    })

    expect(Object.keys(reconciled.nodes)).toEqual(revised.nodes.map((node) => node.id))
    const startedNode = proposed.state.nodes["board-ui-fix"]
    if (startedNode === undefined) {
      throw new Error("missing started node")
    }
    expect(reconciled.nodes["board-ui-fix"]).toBe(startedNode)
    expect(reconciled.nodes["quality-fix"]?.needs).toEqual(["board-live-placement-fix"])
    expect(reconciled.nodes["runtime-review"]?.needs).toEqual(["quality-fix"])

    const approved = crank(reconciled, base, {
      type: "approve-revision",
      digest: "revision-digest"
    })
    expect(approved.state.nodes["completion-control-fix"]?.status).toBe("pending")
    expect(approved.state.nodes["board-live-placement-fix"]?.status).toBe("pending")
    expect(approved.state.nodes["quality-fix"]?.status).toBe("pending")
    expect(
      ["runtime-review", "surface-review", "contract-doc-review"].map(
        (id) => approved.state.nodes[id]?.status
      )
    ).toEqual(["pending", "pending", "pending"])
    expect(Object.values(approved.state.spawnIntents)).toHaveLength(1)

    const unsafe = workflow([
      command("board-ui-fix", { title: "Rewritten started work" }),
      ...revised.nodes.slice(1)
    ])
    const unsafeProposal = crank(running.state, base, {
      type: "propose-revision",
      workflow: unsafe,
      digest: "unsafe-digest",
      summary: []
    })
    const unsafeState = reconcileApprovedRevisionState(unsafeProposal.state, {
      type: "approve-revision",
      digest: "unsafe-digest"
    })
    expect(() =>
      crank(unsafeState, base, { type: "approve-revision", digest: "unsafe-digest" })
    ).toThrow('changes already-started node template "board-ui-fix"')
  })

  test("rebuilds an unstarted repeat instance from the approved revision", () => {
    const originalMember = command("review", {
      title: "Old repeat review",
      needs: [],
      gate: "approval"
    })
    const base = workflow([originalMember], {
      repeats: [
        {
          id: "review-loop",
          members: ["review"],
          until: { type: "command-success", node: "review" },
          maxRounds: 2
        }
      ]
    })
    const started = start(base, context("review--r1"))
    expect(started.state.nodes["review--r1"]?.status).toBe("awaiting-approval")
    expect(started.state.nodes["review--r1"]?.attempts).toEqual([])

    const revisedMember = command("review", {
      title: "Revised repeat review",
      needs: [],
      gate: "none",
      argv: ["true", "--revised"]
    })
    const revised = workflow([revisedMember], { repeats: base.repeats })
    const pending: RunState = {
      ...started.state,
      pendingRevision: {
        workflow: revised,
        digest: "revision-digest",
        summary: ["~ node review"],
        createdAt: NOW
      }
    }
    const event = { type: "approve-revision", digest: "revision-digest" } as const
    const reconciled = reconcileApprovedRevisionState(pending, event)
    expect(reconciled.nodes["review--r1"]).toMatchObject({
      id: "review--r1",
      templateId: "review",
      title: "Revised repeat review",
      status: "pending",
      repeatId: "review-loop",
      round: 1
    })
    const approved = crank(reconciled, base, event, context("review--r1"))
    expect(approved.state.nodes["review--r1"]?.status).toBe("running")
    expect(approved.state.nodes["review--r1"]?.title).toBe("Revised repeat review")
    expect(approved.workflow).toEqual(revised)
  })

  test("fails exhausted nodes and rejects the wrong completion event kind", () => {
    const spec = workflow([command("command"), agent("agent")], { concurrency: 2 })
    const planned = start(spec, context("command", "agent"))
    const commandObserved = observe(planned.state, spec, "command")
    const running = observe(commandObserved.state, spec, "agent")
    expect(() =>
      crank(running.state, spec, {
        type: "node-done",
        nodeId: "command",
        token: token(running.state, "command"),
        outcome: "completed",
        hold: false,
        result: null,
        error: null,
        providerSessionId: null
      })
    ).toThrow("not an agent")
    const failed = crank(running.state, spec, {
      type: "node-exit",
      nodeId: "command",
      token: token(running.state, "command"),
      code: 9,
      error: "boom"
    })
    expect(failed.state.status).toBe("failed")
    expect(failed.state.nodes.command?.status).toBe("failed")
  })

  test("event patches replay exactly to the authoritative state across cranks", () => {
    const spec = workflow([agent("first"), command("after", { needs: ["first"] })])
    const planned = start(spec, context("first"))
    const started = observe(planned.state, spec, "first")
    const completed = crank(
      started.state,
      spec,
      {
        type: "node-done",
        nodeId: "first",
        token: token(started.state, "first"),
        outcome: "completed",
        hold: true,
        result: { answer: 42 },
        error: null,
        providerSessionId: null
      },
      undefined
    )
    expect(completed.events.map((item) => item.type)).toEqual(["node.completed", "hold.set"])
    expect(completed.state.nodes.first?.status).toBe("completed")
    expect(completed.state.nodes.after?.status).toBe("pending")
    const released = crank(
      completed.state,
      spec,
      { type: "release", nodeId: "first" },
      context("after")
    )
    expect(released.state.nodes.first?.status).toBe("completed")
    const afterObserved = observe(released.state, spec, "after")
    const final = crank(afterObserved.state, spec, {
      type: "node-exit",
      nodeId: "after",
      token: token(afterObserved.state, "after"),
      code: 0,
      error: null
    })
    const journal = [
      ...planned.events,
      ...started.events,
      ...completed.events,
      ...released.events,
      ...afterObserved.events,
      ...final.events
    ]
    expect(journal.map((item) => item.sequence)).toEqual(
      Array.from({ length: journal.length }, (_, index) => index + 1)
    )
    const replayed = journal.reduce<unknown>(
      (document, item) => applyPatch(document, item.patch),
      undefined
    )
    expect(replayed).toEqual(final.state)
  })

  test("later transition patches do not repeat an earlier large node result", () => {
    const spec = workflow([agent("first"), agent("second")], { concurrency: 2 })
    const planned = start(spec, context("first", "second"))
    const firstObserved = observe(planned.state, spec, "first")
    const bothObserved = observe(firstObserved.state, spec, "second")
    const largeResult = { payload: "x".repeat(100_000) }
    const firstCompleted = crank(bothObserved.state, spec, {
      type: "node-done",
      nodeId: "first",
      token: token(bothObserved.state, "first"),
      outcome: "completed",
      hold: false,
      result: largeResult,
      error: null,
      providerSessionId: null
    })
    const secondCompleted = crank(firstCompleted.state, spec, {
      type: "node-done",
      nodeId: "second",
      token: token(firstCompleted.state, "second"),
      outcome: "completed",
      hold: false,
      result: { payload: "small" },
      error: null,
      providerSessionId: null
    })
    const serialized = JSON.stringify(secondCompleted.events)

    expect(serialized).not.toContain(largeResult.payload)
    expect(serialized.length).toBeLessThan(10_000)
    expect(
      secondCompleted.events
        .flatMap((record) => record.patch)
        .some((operation) => operation.path.startsWith("/nodes/second/"))
    ).toBe(true)
    expect(
      secondCompleted.events
        .flatMap((record) => record.patch)
        .some((operation) => operation.path === "/nodes")
    ).toBe(false)
  })
})
