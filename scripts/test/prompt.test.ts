import { afterEach, describe, expect, test } from "bun:test"

import type { AgentNode, NodeRunState, RunState, WorkflowSpec } from "../src/types.js"

import { prepareNode, renderAgentPrompt, renderInputs } from "../src/prompt.js"

function workspace() {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "none" as const,
    writes: [],
    exclusiveResources: []
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
    prompt: `Stable frame for ${id}.`,
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

function runtimeNode(
  id: string,
  templateId: string,
  repeatId: string | null,
  round: number | null,
  result: unknown = null
): NodeRunState {
  return {
    id,
    templateId,
    title: id,
    type: "agent",
    provider: "codex",
    needs: [],
    origin: repeatId === null ? "initial" : "loop-round",
    repeatId,
    round,
    status: result === null ? "ready" : "completed",
    attempts: [],
    resultPath: result === null ? null : `/tmp/${id}/result.txt`,
    result,
    error: null
  }
}

function workflow(): WorkflowSpec {
  return {
    name: "prompt-test",
    objective: "Test prompt frames and dynamic inputs.",
    cwd: "/tmp",
    concurrency: 2,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes: [
      agent("implement", {
        inputs: [{ from: "review", as: "Previous review", include: "content", round: "previous" }]
      }),
      agent("review", { needs: ["implement"], gate: "approval" }),
      agent("summarize", {
        needs: ["review"],
        inputs: [{ from: "review", as: "Final review", include: "content", round: "current" }]
      })
    ],
    repeats: [
      {
        id: "review-loop",
        members: ["implement", "review"],
        until: { type: "agent-output", node: "review", pointer: "/clean", equals: true },
        maxRounds: 3
      }
    ]
  }
}

function state(): RunState {
  return {
    runtimeVersion: "test-build",
    sequence: 4,
    id: "20260802120000-1234abcd",
    workflowName: "prompt-test",
    objective: "Test prompt frames and dynamic inputs.",
    digest: "a".repeat(64),
    status: "running",
    createdAt: "2026-08-02T12:00:00.000Z",
    startedAt: "2026-08-02T12:00:00.000Z",
    finishedAt: null,
    updatedAt: "2026-08-02T12:01:00.000Z",
    error: null,
    pause: null,
    origin: null,
    allowWriteConflicts: false,
    starts: 2,
    fuseOverride: false,
    repeatRoundExtensions: {},
    pendingRevision: null,
    nodes: {
      "implement--r2": runtimeNode("implement--r2", "implement", "review-loop", 2),
      "review--r1": runtimeNode("review--r1", "review", "review-loop", 1, "fix the edge case"),
      "review--r2": runtimeNode("review--r2", "review", "review-loop", 2, "clean"),
      summarize: runtimeNode("summarize", "summarize", null, null)
    },
    sessions: {},
    gates: {},
    holds: {},
    repeats: {
      "review-loop": {
        id: "review-loop",
        round: 2,
        status: "completed",
        instanceIds: ["implement--r2", "review--r2"],
        completedAt: "2026-08-02T12:01:00.000Z"
      }
    },
    spawnIntents: {}
  }
}

afterEach(() => {
  delete process.env.ORCHESTRATE_BIN
})

describe("prompt rendering", () => {
  test("resolves previous-round and final-repeat inputs", () => {
    const spec = workflow()
    const current = state()
    expect(renderInputs(spec, current, "implement--r2", spec.nodes[0]!.inputs)).toContain(
      "fix the edge case"
    )
    expect(renderInputs(spec, current, "summarize", spec.nodes[2]!.inputs)).toContain("clean")
  })

  test("keeps gate content separate from the operational completion contract", () => {
    process.env.ORCHESTRATE_BIN = "/opt/orchestrate"
    const spec = workflow()
    const current = state()
    const review = spec.nodes[1] as AgentNode
    const prepared = prepareNode(spec, current, "/tmp/run", "review--r2")
    const prompt = renderAgentPrompt(spec, current, "review--r2", review, prepared)

    expect(prepared.gate?.content).toBe("Stable frame for review.")
    expect(prepared.gate?.content).not.toContain("node-done")
    expect(prompt).toContain("/opt/orchestrate")
    expect(prompt).toContain("node-done")
    expect(prompt).toContain(prepared.resultPath)
    expect(prompt).toContain("'--hold'")
    expect(prompt).not.toContain("To stop dependents after you finish")
  })
})
