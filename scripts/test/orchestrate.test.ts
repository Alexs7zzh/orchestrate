import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"

import type {
  AgentNode,
  CommandNode,
  SupervisorDecision,
  SupervisorNode,
  WorkflowSpec
} from "../src/types.js"

import { previewText } from "../src/cli.js"
import { gateApprovalDigest, runWorker } from "../src/engine.js"
import { runProcessEffect, terminateRecordedProcessTree } from "../src/process.js"
import { selectRunnableBatch } from "../src/runtime/scheduler.js"
import {
  acquireWorkerLock,
  createRun,
  eventsPath,
  pauseRequestPath,
  readRunState,
  resolveRunDirectory,
  stopRequestPath,
  workflowPath,
  writeRunState
} from "../src/state.js"
import { validateWorkflow, workflowDigest } from "../src/validation.js"

process.env.ORCHESTRATE_ENABLE_MOCK_PROVIDER = "1"

let temporaryRoot = ""

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-test-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
})

afterEach(async () => {
  delete process.env.ORCHESTRATE_STATE_DIR
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
    permissions: {
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
    output: { format: "text", schema: null },
    interactive: false,
    ...overrides
  } as AgentNode
}

function workflow(nodes: readonly WorkflowSpec["nodes"][number][]): WorkflowSpec {
  return {
    version: 1,
    name: "test-workflow",
    objective: "Exercise the workflow engine.",
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

function supervisor(
  decisions: readonly SupervisorDecision[],
  overrides: Partial<SupervisorNode> = {}
): SupervisorNode {
  return {
    id: "supervise",
    type: "supervisor",
    title: "Supervise",
    needs: ["seed"],
    cwd: null,
    workspace: workspace(),
    inputs: [{ from: "seed", as: "Initial result", include: "path" }],
    timeoutMinutes: null,
    retry: { maxAttempts: 1, delaySeconds: 0 },
    gate: "none",
    provider: "mock",
    model: "mock",
    effort: null,
    prompt: JSON.stringify(decisions),
    session: session({
      saveAs: "supervisor",
      retain: true,
      reuseOnRepeat: true
    }),
    permissions: {
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
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
      maxRounds: null,
      maxWallTimeMinutes: null
    },
    ...overrides
  } as SupervisorNode
}

describe("workflow validation", () => {
  test("accepts explicit unbounded decisions and computes a stable digest", () => {
    const spec = workflow([mockAgent("implement", "implementation")])
    const first = validateWorkflow(spec)
    const second = validateWorkflow(JSON.parse(JSON.stringify(spec)))
    expect(first.issues).toEqual([])
    expect(first.digest).toBe(workflowDigest(spec))
    expect(second.digest).toBe(first.digest)
  })

  test("digest is independent of object key insertion order", () => {
    const forwardEnv: Record<string, string> = { ZEBRA: "1", alpha: "2", Alpha: "3", _x: "4" }
    const reverseEnv: Record<string, string> = { _x: "4", Alpha: "3", alpha: "2", ZEBRA: "1" }
    const nodeWith = (env: Record<string, string>) =>
      mockAgent("implement", "implementation", {
        permissions: {
          extraArgs: [],
          inheritEnv: [],
          env
        }
      })
    expect(workflowDigest(workflow([nodeWith(forwardEnv)]))).toBe(
      workflowDigest(workflow([nodeWith(reverseEnv)]))
    )
  })

  test("rejects zero timeouts that would kill processes immediately", () => {
    const zeroNode = mockAgent("implement", "implementation", { timeoutMinutes: 0 })
    const nodeResult = validateWorkflow(workflow([zeroNode]))
    expect(nodeResult.workflow).toBeNull()
    expect(nodeResult.issues[0]?.code).toBe("schema")

    const base = workflow([mockAgent("implement", "implementation")])
    const limitResult = validateWorkflow({
      ...base,
      limits: { ...base.limits, nodeWallTimeMinutes: 0 }
    })
    expect(limitResult.workflow).toBeNull()
    expect(limitResult.issues[0]?.code).toBe("schema")
  })

  test("rejects a misspelled provider-default sentinel", () => {
    const typo = mockAgent("implement", "implementation", { model: "provider-defualt" })
    const result = validateWorkflow(workflow([typo]))
    expect(
      result.issues.some((issue) => issue.code === "model" && issue.message.includes("sentinel"))
    ).toBe(true)
  })

  test("rejects an existing workspace without an explicit path", () => {
    const spec = JSON.parse(
      JSON.stringify(workflow([mockAgent("implement", "implementation")]))
    ) as { nodes: { workspace: { mode: string } }[] }
    const node = spec.nodes[0] as { workspace: { mode: string } }
    node.workspace.mode = "existing"
    const result = validateWorkflow(spec)
    expect(result.workflow).toBeNull()
    expect(result.issues[0]?.code).toBe("schema")
  })

  test("accepts a null shared path and reports only the matching workspace branch", () => {
    const node = mockAgent("implement", "implementation", {
      provider: "codex",
      model: "provider-default",
      permissions: {
        sandbox: "read-only",
        extraArgs: [],
        inheritEnv: [],
        env: {}
      }
    })
    const spec = workflow([node])
    const valid = validateWorkflow(spec)
    expect(valid.issues).toEqual([])
    expect(valid.workflow?.nodes[0]?.workspace.path).toBeNull()

    const raw = JSON.parse(JSON.stringify(spec)) as {
      nodes: { workspace: { vcs?: string } }[]
    }
    delete raw.nodes[0]?.workspace.vcs
    const invalid = validateWorkflow(raw)
    expect(invalid.workflow).toBeNull()
    expect(invalid.issues[0]?.message).toContain("required property 'vcs'")
    expect(invalid.issues[0]?.message).not.toContain("path must be string")
    expect(invalid.issues[0]?.message).not.toContain("required property 'git'")
    expect(invalid.issues[0]?.message).not.toContain("must match a schema in anyOf")
    expect(invalid.issues[0]?.message).not.toContain("permissionMode")
    expect(invalid.issues[0]?.message).not.toContain("additional properties")
  })

  test("read-only commands are warning-free; mutating declarations must be consistent", () => {
    const command = (id: string, mutates: boolean, writes: readonly string[]): CommandNode => ({
      id,
      type: "command",
      title: id,
      needs: [],
      cwd: null,
      workspace: workspace(writes),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates,
      argv: [process.execPath, "--version"],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    })
    const readOnly = validateWorkflow(workflow([command("check", false, [])]))
    expect(readOnly.issues).toEqual([])

    const undeclared = validateWorkflow(workflow([command("mutating", true, [])]))
    expect(undeclared.issues.some((issue) => issue.code === "unknown-writes")).toBe(true)

    const contradictory = validateWorkflow(workflow([command("liar", false, ["src/**"])]))
    expect(contradictory.issues.some((issue) => issue.code === "command-writes")).toBe(true)
  })

  test("rejects provider arguments that reconfigure permissions indirectly", () => {
    const viaSettings = mockAgent("via-settings", "bypass", {
      provider: "claude",
      model: "provider-default",
      permissions: {
        permissionMode: "plan",
        extraArgs: ["--settings", '{"permissions":{"allow":["Bash(*:*)"]}}'],
        inheritEnv: [],
        env: {}
      }
    })
    const viaProfile = mockAgent("via-profile", "bypass", {
      provider: "codex",
      model: "provider-default",
      permissions: {
        sandbox: "read-only",
        extraArgs: ["--profile", "unrestricted"],
        inheritEnv: [],
        env: {}
      }
    })
    const result = validateWorkflow(workflow([viaSettings, viaProfile]))
    const reserved = result.issues.filter((issue) => issue.code === "reserved-provider-argument")
    expect(reserved.some((issue) => issue.message.includes("via-settings"))).toBe(true)
    expect(reserved.some((issue) => issue.message.includes("via-profile"))).toBe(true)
  })

  test("rejects missing semantic fields instead of inventing defaults", () => {
    const raw = workflow([mockAgent("implement", "implementation")]) as unknown as Record<
      string,
      unknown
    >
    delete (raw.heartbeat as Record<string, unknown>).intervalMinutes
    const result = validateWorkflow(raw)
    expect(result.workflow).toBeNull()
    expect(result.issues[0]?.code).toBe("schema")
  })

  test("rejects unknown fields and unsafe run identifiers", async () => {
    const raw = {
      ...workflow([mockAgent("implement", "implementation")]),
      unexpected: true
    }
    const result = validateWorkflow(raw)
    expect(result.workflow).toBeNull()
    expect(result.issues[0]?.message).toContain("additional properties")
    await expect(resolveRunDirectory("../../tmp")).rejects.toThrow("Invalid run id")
  })

  test("warns about parallel write overlap and rejects unsupported Codex forks", () => {
    const left = mockAgent("left", "left", {
      workspace: workspace(["src/**"])
    })
    const right = mockAgent("right", "right", {
      workspace: workspace(["./src/file.ts"])
    })
    const codexFork = mockAgent("codex-fork", "fork", {
      provider: "codex",
      model: "provider-default",
      permissions: {
        sandbox: "read-only",
        extraArgs: [],
        inheritEnv: [],
        env: {}
      },
      session: session({
        mode: "fork",
        from: "missing",
        retain: true
      })
    })
    const result = validateWorkflow(workflow([left, right, codexFork]))
    expect(result.issues.some((issue) => issue.code === "write-conflict")).toBe(true)
    expect(result.issues.some((issue) => issue.code === "unsupported-fork")).toBe(true)
  })

  test("warns when mutating permissions have no declared write set", () => {
    const mutating = mockAgent("mutating", "mutate", {
      provider: "codex",
      model: "provider-default",
      permissions: {
        sandbox: "workspace-write",
        extraArgs: [],
        inheritEnv: [],
        env: {}
      }
    })
    const result = validateWorkflow(workflow([mutating]))
    expect(result.issues.some((issue) => issue.code === "unknown-writes")).toBe(true)
  })

  test("reserves plastic-scm only for nodes with mutation authority", () => {
    const plasticWorkspace = {
      ...workspace(["Saved/**"]),
      vcs: "plastic" as const
    }
    const readOnly = mockAgent("read-only", "review", {
      provider: "codex",
      model: "provider-default",
      workspace: plasticWorkspace,
      permissions: {
        sandbox: "read-only",
        extraArgs: [],
        inheritEnv: [],
        env: {}
      }
    })
    const plan = mockAgent("plan", "review", {
      provider: "claude",
      model: "provider-default",
      workspace: plasticWorkspace,
      permissions: {
        permissionMode: "plan",
        extraArgs: [],
        inheritEnv: [],
        env: {}
      }
    })
    for (const node of [readOnly, plan]) {
      const result = validateWorkflow(workflow([node]))
      expect(result.issues.some((issue) => issue.code === "plastic-resource")).toBe(false)
    }

    const mutating = mockAgent("mutating", "mutate", {
      provider: "codex",
      model: "provider-default",
      workspace: plasticWorkspace,
      permissions: {
        sandbox: "workspace-write",
        extraArgs: [],
        inheritEnv: [],
        env: {}
      }
    })
    const unreserved = validateWorkflow(workflow([mutating]))
    expect(unreserved.issues.some((issue) => issue.code === "plastic-resource")).toBe(true)

    const reserved = validateWorkflow(
      workflow([
        {
          ...mutating,
          workspace: { ...plasticWorkspace, exclusiveResources: ["plastic-scm"] }
        }
      ])
    )
    expect(reserved.issues.some((issue) => issue.code === "plastic-resource")).toBe(false)
  })

  test("rejects provider arguments that override semantic permissions", () => {
    const bypass = mockAgent("bypass", "bypass", {
      provider: "codex",
      model: "provider-default",
      permissions: {
        sandbox: "read-only",
        extraArgs: ["--dangerously-bypass-approvals-and-sandbox"],
        inheritEnv: [],
        env: {}
      }
    })
    const result = validateWorkflow(workflow([bypass]))
    expect(result.issues.some((issue) => issue.code === "reserved-provider-argument")).toBe(true)
  })

  test("treats separate implicit Git worktrees as isolated", () => {
    const left = mockAgent("left", "left", {
      workspace: {
        mode: "git-worktree",
        path: null,
        vcs: "git",
        writes: ["src/**"],
        exclusiveResources: [],
        git: { branch: "left-{{runId}}", startPoint: "HEAD", removeOnClean: false }
      }
    })
    const right = mockAgent("right", "right", {
      workspace: {
        mode: "git-worktree",
        path: null,
        vcs: "git",
        writes: ["src/**"],
        exclusiveResources: [],
        git: { branch: "right-{{runId}}", startPoint: "HEAD", removeOnClean: false }
      }
    })
    const result = validateWorkflow(workflow([left, right]))
    expect(result.issues.some((issue) => issue.code === "write-conflict")).toBe(false)
  })

  test("rejects unordered fan-out from a mutable resumed session", () => {
    const source = mockAgent("source", "source", {
      session: session({ saveAs: "shared", retain: true })
    })
    const left = mockAgent("left", "left", {
      needs: ["source"],
      session: session({ mode: "resume", from: "shared", retain: true })
    })
    const right = mockAgent("right", "right", {
      needs: ["source"],
      session: session({ mode: "resume", from: "shared", retain: true })
    })
    const result = validateWorkflow(workflow([source, left, right]))
    expect(result.issues.some((issue) => issue.code === "session-fanout")).toBe(true)
  })

  test("reports duplicate session aliases without rebinding their producer", () => {
    const source = mockAgent("source", "source", {
      session: session({ saveAs: "impl", retain: true })
    })
    const continueOne = mockAgent("continue-one", "continue", {
      needs: ["source"],
      session: session({
        mode: "resume",
        from: "impl",
        saveAs: "impl",
        retain: true
      })
    })
    const continueTwo = mockAgent("continue-two", "continue", {
      needs: ["continue-one"],
      session: session({
        mode: "resume",
        from: "impl",
        saveAs: "impl",
        retain: true
      })
    })
    const result = validateWorkflow(workflow([source, continueOne, continueTwo]))
    const duplicates = result.issues.filter((issue) => issue.code === "duplicate-session-alias")
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]?.nodes).toEqual(["source", "continue-one", "continue-two"])
    expect(result.issues.some((issue) => issue.code === "session-order")).toBe(false)
    expect(result.digest).toBeNull()
  })

  test("accepts a linear resume chain without re-saving its alias", () => {
    const source = mockAgent("source", "source", {
      session: session({ saveAs: "impl", retain: true })
    })
    const continueOne = mockAgent("continue-one", "continue", {
      needs: ["source"],
      session: session({ mode: "resume", from: "impl", retain: true })
    })
    const continueTwo = mockAgent("continue-two", "continue", {
      needs: ["continue-one"],
      session: session({ mode: "resume", from: "impl", retain: true })
    })
    const result = validateWorkflow(workflow([source, continueOne, continueTwo]))
    expect(result.issues).toEqual([])
    expect(result.digest).not.toBeNull()
  })

  test("does not compute an approval digest for semantic validation errors", () => {
    const result = validateWorkflow({
      ...workflow([mockAgent("implement", "implementation")]),
      cwd: "relative/path"
    })
    expect(result.workflow).not.toBeNull()
    expect(result.issues.some((issue) => issue.code === "workflow-cwd")).toBe(true)
    expect(result.digest).toBeNull()
  })

  test("tracks mutable session lineage across renamed aliases", () => {
    const source = mockAgent("source", "source", {
      session: session({ saveAs: "first", retain: true })
    })
    const bridge = mockAgent("bridge", "bridge", {
      needs: ["source"],
      session: session({
        mode: "resume",
        from: "first",
        saveAs: "renamed",
        retain: true
      })
    })
    const left = mockAgent("left", "left", {
      needs: ["bridge"],
      session: session({ mode: "resume", from: "first", retain: true })
    })
    const right = mockAgent("right", "right", {
      needs: ["bridge"],
      session: session({ mode: "resume", from: "renamed", retain: true })
    })
    const result = validateWorkflow(workflow([source, bridge, left, right]))
    expect(result.issues.some((issue) => issue.code === "session-fanout")).toBe(true)
  })

  test("rejects an empty adaptive command prefix", () => {
    const invalid = supervisor([{ status: "complete", reason: "Done.", addNodes: [] }], {
      envelope: {
        ...supervisor([{ status: "complete", reason: "Done.", addNodes: [] }]).envelope,
        allowCommands: true,
        commandArgvPrefixes: [[]],
        allowedCommandEnv: [{}]
      }
    })
    const result = validateWorkflow(workflow([mockAgent("seed", "seed"), invalid]))
    expect(result.workflow).toBeNull()
    expect(result.issues[0]?.code).toBe("schema")
  })

  test("rejects reserved short options with attached values", () => {
    const codexModel = mockAgent("codex-model", "model", {
      provider: "codex",
      model: "provider-default",
      permissions: {
        sandbox: "read-only",
        extraArgs: ["-mgpt-5"],
        inheritEnv: [],
        env: {}
      }
    })
    const codexConfig = mockAgent("codex-config", "config", {
      provider: "codex",
      model: "provider-default",
      permissions: {
        sandbox: "read-only",
        extraArgs: ["-csandbox_mode=danger-full-access"],
        inheritEnv: [],
        env: {}
      }
    })
    const claudeResume = mockAgent("claude-resume", "resume", {
      provider: "claude",
      model: "provider-default",
      permissions: {
        permissionMode: "plan",
        extraArgs: ["-rabc123"],
        inheritEnv: [],
        env: {}
      }
    })
    const result = validateWorkflow(workflow([codexModel, codexConfig, claudeResume]))
    const reserved = result.issues.filter((issue) => issue.code === "reserved-provider-argument")
    expect(reserved.some((issue) => issue.message.includes("codex-model"))).toBe(true)
    expect(reserved.some((issue) => issue.message.includes("codex-config"))).toBe(true)
    expect(reserved.some((issue) => issue.message.includes("claude-resume"))).toBe(true)
  })

  test("requires an absolute command executable unless PATH is provided", () => {
    const command = (
      id: string,
      inheritEnv: readonly string[],
      env: Record<string, string>
    ): CommandNode => ({
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
      mutates: false,
      argv: ["npm", "test"],
      inheritEnv,
      env,
      allowedExitCodes: [0]
    })
    const noPath = validateWorkflow(workflow([command("no-path", [], {})]))
    expect(noPath.issues.some((issue) => issue.code === "command-path")).toBe(true)

    const inherited = validateWorkflow(workflow([command("inherited", ["PATH"], {})]))
    expect(inherited.issues.some((issue) => issue.code === "command-path")).toBe(false)

    const declared = validateWorkflow(workflow([command("declared", [], { PATH: "/usr/bin" })]))
    expect(declared.issues.some((issue) => issue.code === "command-path")).toBe(false)

    const blank = validateWorkflow(workflow([{ ...command("blank", ["PATH"], {}), argv: [""] }]))
    expect(blank.issues.some((issue) => issue.code === "command-argv")).toBe(true)
  })

  test("rejects empty envelope prefix entries that would grant everything", () => {
    const decisions = [{ status: "complete", reason: "Done.", addNodes: [] } as const]
    const base = supervisor(decisions).envelope
    const emptyBranchPrefix = supervisor(decisions, {
      envelope: {
        ...base,
        workspaceModes: ["shared", "git-worktree"],
        vcs: ["none", "git"],
        gitWorktree: {
          allowed: true,
          branchPrefixes: [""],
          startPoints: ["HEAD"],
          allowRemoveOnClean: false
        }
      }
    })
    const emptyAliasPrefix = supervisor(decisions, {
      envelope: { ...base, newSessionAliasPrefixes: [""] }
    })
    const emptyArgvElement = supervisor(decisions, {
      envelope: {
        ...base,
        allowCommands: true,
        commandArgvPrefixes: [["npm", ""]],
        allowedCommandEnv: []
      }
    })
    for (const invalid of [emptyBranchPrefix, emptyAliasPrefix, emptyArgvElement]) {
      const result = validateWorkflow(workflow([mockAgent("seed", "seed"), invalid]))
      expect(result.workflow).toBeNull()
      expect(result.issues[0]?.code).toBe("schema")
    }
  })

  test("rejects a blank callback command", () => {
    const base = workflow([mockAgent("implement", "implementation")])
    const emptyElement = validateWorkflow({
      ...base,
      heartbeat: {
        intervalMinutes: 5,
        milestones: false,
        callback: { type: "command", argv: [""], timeoutSeconds: 10 }
      }
    })
    expect(emptyElement.workflow).toBeNull()
    expect(emptyElement.issues[0]?.code).toBe("schema")

    const whitespace = validateWorkflow({
      ...base,
      heartbeat: {
        intervalMinutes: 5,
        milestones: false,
        callback: { type: "command", argv: ["   "], timeoutSeconds: 10 }
      }
    })
    expect(whitespace.issues.some((issue) => issue.code === "callback-command")).toBe(true)
  })

  test("rejects case-variant provider-default sentinels as likely typos", () => {
    for (const model of ["Provider-default", "PROVIDER-DEFAULT"]) {
      const result = validateWorkflow(
        workflow([mockAgent("implement", "implementation", { model })])
      )
      expect(
        result.issues.some((issue) => issue.code === "model" && issue.message.includes("sentinel"))
      ).toBe(true)
    }
  })

  test("rejects malformed environment variable names in env records", () => {
    for (const env of [{ "A=B": "x" }, { "": "x" }]) {
      const agent = mockAgent("agent-env", "env", {
        permissions: { extraArgs: [], inheritEnv: [], env }
      })
      const agentResult = validateWorkflow(workflow([agent]))
      expect(agentResult.issues.some((issue) => issue.code === "provider-environment")).toBe(true)

      const command: CommandNode = {
        id: "command-env",
        type: "command",
        title: "command-env",
        needs: [],
        cwd: null,
        workspace: workspace(),
        inputs: [],
        timeoutMinutes: null,
        retry: { maxAttempts: 1, delaySeconds: 0 },
        gate: "none",
        mutates: false,
        argv: ["/usr/bin/true"],
        inheritEnv: [],
        env,
        allowedExitCodes: [0]
      }
      const commandResult = validateWorkflow(workflow([command]))
      expect(commandResult.issues.some((issue) => issue.code === "provider-environment")).toBe(true)
    }

    const decisions = [{ status: "complete", reason: "Done.", addNodes: [] } as const]
    const base = supervisor(decisions).envelope
    const envelopeProviderEnv = supervisor(decisions, {
      envelope: { ...base, allowedProviderEnv: [{ "A=B": "x" }] }
    })
    const envelopeCommandEnv = supervisor(decisions, {
      envelope: {
        ...base,
        allowCommands: true,
        commandArgvPrefixes: [["/usr/bin/true"]],
        allowedCommandEnv: [{ "": "x" }]
      }
    })
    for (const invalid of [envelopeProviderEnv, envelopeCommandEnv]) {
      const result = validateWorkflow(workflow([mockAgent("seed", "seed"), invalid]))
      expect(result.issues.some((issue) => issue.code === "provider-environment")).toBe(true)
    }
  })

  test("rejects empty and duplicate input labels", () => {
    const seed = mockAgent("seed", "seed")
    const emptyLabel = mockAgent("empty-label", "consume", {
      needs: ["seed"],
      inputs: [{ from: "seed", as: "", include: "path" }]
    })
    const emptyResult = validateWorkflow(workflow([seed, emptyLabel]))
    expect(emptyResult.workflow).toBeNull()
    expect(emptyResult.issues[0]?.code).toBe("schema")

    const duplicate = mockAgent("duplicate-label", "consume", {
      needs: ["seed"],
      inputs: [
        { from: "seed", as: "Result", include: "path" },
        { from: "seed", as: "Result", include: "content" }
      ]
    })
    const duplicateResult = validateWorkflow(workflow([seed, duplicate]))
    expect(duplicateResult.issues.some((issue) => issue.code === "input-label")).toBe(true)
  })

  test("preview shows permissions while redacting provider environment values", () => {
    const node = mockAgent("review", "review", {
      provider: "codex",
      model: "provider-default",
      permissions: {
        sandbox: "read-only",
        extraArgs: ["--skip-git-repo-check"],
        inheritEnv: ["PATH"],
        env: { REVIEW_TOKEN: "secret-value" }
      }
    })
    const spec = workflow([node])
    const preview = previewText(spec, workflowDigest(spec), [])
    expect(preview).toContain("permission: read-only")
    expect(preview).toContain('inheritEnv=["PATH"]')
    expect(preview).toContain("<redacted>")
    expect(preview).not.toContain("secret-value")
  })
})

function worktreeWorkspace(branch: string): AgentNode["workspace"] {
  return {
    mode: "git-worktree",
    path: null,
    vcs: "git",
    writes: ["src/**"],
    exclusiveResources: [],
    git: { branch, startPoint: "HEAD", removeOnClean: false }
  }
}

describe("scheduler batch selection", () => {
  test("selects parallel git-worktree nodes off the same repo in one batch", async () => {
    const left = mockAgent("left", "left", { workspace: worktreeWorkspace("left-{{runId}}") })
    const right = mockAgent("right", "right", { workspace: worktreeWorkspace("right-{{runId}}") })
    const spec = { ...workflow([left, right]), concurrency: 2 }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const batch = selectRunnableBatch(spec.nodes, created.state, 2, new Set())
    expect(batch.map((node) => node.id)).toEqual(["left", "right"])
  })

  test("a reuseOnRepeat producer and an unordered resumer of its alias never share a batch", async () => {
    const producer = mockAgent("producer", "produce", {
      session: session({ saveAs: "shared", retain: true, reuseOnRepeat: true })
    })
    const resumer = mockAgent("resumer", "resume", {
      session: session({ mode: "resume", from: "shared", retain: true })
    })
    const spec = { ...workflow([producer, resumer]), concurrency: 2 }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const batch = selectRunnableBatch(spec.nodes, created.state, 2, new Set())
    expect(batch.map((node) => node.id)).toEqual(["producer"])
    const whileProducerActive = selectRunnableBatch(
      spec.nodes,
      created.state,
      2,
      new Set(["producer"])
    )
    expect(whileProducerActive).toEqual([])
  })
})

describe("workflow execution", () => {
  test("delivers command callbacks and gates node milestones", async () => {
    const callbackEventsPath = path.join(temporaryRoot, "callback-events.jsonl")
    const callback = {
      type: "command" as const,
      argv: [
        process.execPath,
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], JSON.stringify({ runId: process.argv[3], event: JSON.parse(process.argv[2]) }) + '\\n')",
        callbackEventsPath,
        "{{event}}",
        "{{runId}}"
      ],
      timeoutSeconds: 5
    }

    const milestoneBase = workflow([mockAgent("implement", "implementation")])
    const milestoneSpec: WorkflowSpec = {
      ...milestoneBase,
      heartbeat: { ...milestoneBase.heartbeat, milestones: true, callback }
    }
    const milestoneRun = await createRun(milestoneSpec, workflowDigest(milestoneSpec), false, false)
    await runWorker(milestoneRun.runDir)

    const milestoneEvents = (await readFile(callbackEventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { runId: string; event: { type: string; runId: string } })
    expect(milestoneEvents.map(({ event }) => event.type)).toEqual([
      "run.started",
      "node.started",
      "node.completed",
      "run.completed"
    ])
    expect(new Set(milestoneEvents.map(({ runId }) => runId))).toEqual(
      new Set([milestoneRun.state.id])
    )
    expect(new Set(milestoneEvents.map(({ event }) => event.runId))).toEqual(
      new Set([milestoneRun.state.id])
    )

    await writeFile(callbackEventsPath, "")
    const boundaryBase = workflow([mockAgent("implement", "implementation")])
    const boundarySpec: WorkflowSpec = {
      ...boundaryBase,
      heartbeat: { ...boundaryBase.heartbeat, callback }
    }
    const boundaryRun = await createRun(boundarySpec, workflowDigest(boundarySpec), false, false)
    await runWorker(boundaryRun.runDir)

    const boundaryEvents = (await readFile(callbackEventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: { type: string } })
    expect(boundaryEvents.map(({ event }) => event.type)).toEqual(["run.started", "run.completed"])

    await writeFile(callbackEventsPath, "")
    const failingNode: CommandNode = {
      id: "fail",
      type: "command",
      title: "Fail",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      argv: [process.execPath, "-e", "process.exit(3)"],
      mutates: false,
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const failingBase = workflow([failingNode])
    const failingSpec: WorkflowSpec = {
      ...failingBase,
      heartbeat: { ...failingBase.heartbeat, callback }
    }
    const failingRun = await createRun(failingSpec, workflowDigest(failingSpec), false, false)
    await runWorker(failingRun.runDir)

    const failingEvents = (await readFile(callbackEventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: { type: string } })
    expect(failingEvents.map(({ event }) => event.type)).toEqual([
      "run.started",
      "node.failed",
      "run.failed"
    ])
    expect((await readRunState(failingRun.runDir)).status).toBe("failed")
  })

  test("posts callback events to a local webhook and records HTTP failures", async () => {
    const requests: Array<{
      headers: Readonly<Record<string, string | string[] | undefined>>
      method: string | undefined
      url: string | undefined
      body: string
    }> = []
    let responseStatus = 204
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        requests.push({
          headers: request.headers,
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString("utf8")
        })
        response.writeHead(responseStatus)
        response.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    try {
      const address = server.address()
      if (address === null || typeof address === "string") {
        throw new Error("Expected the callback test server to have a TCP address.")
      }
      const base = workflow([mockAgent("implement", "implementation")])
      const spec: WorkflowSpec = {
        ...base,
        heartbeat: {
          ...base.heartbeat,
          callback: {
            type: "webhook",
            url: `http://127.0.0.1:${address.port}/callback`,
            headers: { "x-orchestrate-test": "callback-secret" },
            timeoutSeconds: 5
          }
        }
      }
      const created = await createRun(spec, workflowDigest(spec), false, false)
      await runWorker(created.runDir)

      expect(requests).toHaveLength(2)
      const payloads = requests.map(
        ({ body }) => JSON.parse(body) as { type: string; runId: string }
      )
      expect(payloads.map(({ type }) => type)).toEqual(["run.started", "run.completed"])
      expect(requests.every(({ method, url }) => method === "POST" && url === "/callback")).toBe(
        true
      )
      expect(payloads.every(({ runId }) => runId === created.state.id)).toBe(true)
      expect(
        requests.every(({ headers }) => headers["x-orchestrate-test"] === "callback-secret")
      ).toBe(true)
      expect(requests.every(({ headers }) => headers["content-type"] === "application/json")).toBe(
        true
      )

      requests.length = 0
      responseStatus = 503
      const failedCallbackRun = await createRun(spec, workflowDigest(spec), false, false)
      await runWorker(failedCallbackRun.runDir)
      expect((await readRunState(failedCallbackRun.runDir)).status).toBe("completed")
      const failedCallbackEvents = (await readFile(eventsPath(failedCallbackRun.runDir), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; message: string })
      expect(failedCallbackEvents.map(({ type }) => type)).toEqual([
        "run.created",
        "run.started",
        "callback.failed",
        "node.started",
        "node.completed",
        "run.completed",
        "callback.failed"
      ])
      expect(
        failedCallbackEvents
          .filter(({ type }) => type === "callback.failed")
          .map(({ message }) => message)
      ).toEqual(["Callback webhook returned HTTP 503.", "Callback webhook returned HTTP 503."])
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  test("records callback failures without failing the workflow", async () => {
    const base = workflow([mockAgent("implement", "implementation")])
    const spec: WorkflowSpec = {
      ...base,
      heartbeat: {
        ...base.heartbeat,
        callback: {
          type: "command",
          argv: [process.execPath, "-e", "process.exit(7)"],
          timeoutSeconds: 5
        }
      }
    }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)

    const state = await readRunState(created.runDir)
    expect(state.status).toBe("completed")
    const events = (await readFile(eventsPath(created.runDir), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message: string })
    const callbackFailures = events.filter((event) => event.type === "callback.failed")
    expect(callbackFailures).toHaveLength(2)
    expect(callbackFailures.map(({ message }) => message)).toEqual([
      "Callback command exited with 7.",
      "Callback command exited with 7."
    ])
    expect(events.map(({ type }) => type)).toEqual([
      "run.created",
      "run.started",
      "callback.failed",
      "node.started",
      "node.completed",
      "run.completed",
      "callback.failed"
    ])
  })

  test("fails closed if the approved workflow is changed before execution", async () => {
    const spec = workflow([mockAgent("implement", "implementation")])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await writeFile(
      workflowPath(created.runDir),
      `${JSON.stringify({ ...spec, objective: "tampered" }, null, 2)}\n`
    )
    await expect(runWorker(created.runDir)).rejects.toThrow("approved digest")
    const state = await readRunState(created.runDir)
    expect(state.status).toBe("failed")
    expect(state.nodes.implement?.attempts).toBe(0)
  })

  test("passes artifacts and resumes the original implementer session", async () => {
    const implement = mockAgent("implement", "implementation result", {
      session: session({
        saveAs: "implementer",
        retain: true
      })
    })
    const review = mockAgent("review", "review result", {
      needs: ["implement"],
      inputs: [{ from: "implement", as: "Implementation", include: "content" }]
    })
    const adjudicate = mockAgent("adjudicate", "adjudication", {
      needs: ["review"],
      inputs: [{ from: "review", as: "Review", include: "content" }],
      session: session({
        mode: "resume",
        from: "implementer",
        saveAs: "implementer-after-review",
        retain: true
      })
    })
    const spec = workflow([implement, review, adjudicate])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)

    expect(state.status).toBe("completed")
    const implementerSession = state.sessions.implementer?.sessionId
    expect(implementerSession).toBeTruthy()
    expect(state.sessions["implementer-after-review"]?.sessionId).toBe(implementerSession as string)
    const resultPath = state.nodes.adjudicate?.resultPath
    expect(resultPath).toBeTruthy()
    expect(await readFile(resultPath as string, "utf8")).toContain("review result")
  })

  test("expands an adaptive goal and reuses its supervisor session", async () => {
    const added = mockAgent("cold-review", "clean")
    const decisions: SupervisorDecision[] = [
      {
        status: "continue",
        reason: "Run one cold review.",
        addNodes: [added]
      },
      {
        status: "complete",
        reason: "The cold review is clean.",
        addNodes: []
      }
    ]
    const spec = workflow([mockAgent("seed", "seed"), supervisor(decisions)])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)

    expect(state.status).toBe("completed")
    expect(state.goalRounds.supervise).toBe(1)
    expect(state.nodes["cold-review"]?.status).toBe("completed")
    expect(state.sessions.supervisor?.sessionId).toBeTruthy()
  })

  test("pauses an out-of-envelope patch and applies only the approved proposal", async () => {
    const command: CommandNode = {
      id: "outside-command",
      type: "command",
      title: "Outside command",
      needs: ["seed"],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: [process.execPath, "-e", "process.stdout.write('done')"],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const decisions: SupervisorDecision[] = [
      {
        status: "continue",
        reason: "Request a command.",
        addNodes: [command]
      },
      {
        status: "complete",
        reason: "Command completed.",
        addNodes: []
      }
    ]
    const spec = workflow([mockAgent("seed", "seed"), supervisor(decisions)])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    let state = await readRunState(created.runDir)

    expect(state.status).toBe("paused")
    expect(state.pendingPatch?.reasons.join(" ")).toContain("unapproved command")

    state = {
      ...state,
      status: "starting",
      approvedPendingPatch: true,
      pauseReason: null
    }
    await writeRunState(created.runDir, state)
    await runWorker(created.runDir)
    state = await readRunState(created.runDir)

    expect(state.status).toBe("completed")
    expect(state.nodes["outside-command"]?.status).toBe("completed")
    expect(state.pendingPatch).toBeNull()
  })

  test("worker refuses an approved patch whose decision no longer matches its digest", async () => {
    const decision: SupervisorDecision = {
      status: "continue",
      reason: "Add an outside model.",
      addNodes: [
        mockAgent("outside-model", "done", {
          needs: ["seed"],
          model: "outside"
        })
      ]
    }
    const spec = workflow([mockAgent("seed", "seed"), supervisor([decision])])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const paused = await readRunState(created.runDir)
    expect(paused.status).toBe("paused")
    expect(paused.pendingPatch).not.toBeNull()
    await writeRunState(created.runDir, {
      ...paused,
      status: "starting",
      approvedPendingPatch: true,
      pauseReason: null,
      pendingPatch:
        paused.pendingPatch === null
          ? null
          : {
              ...paused.pendingPatch,
              decision: { ...paused.pendingPatch.decision, reason: "Tampered decision." }
            }
    })
    await runWorker(created.runDir)
    const failed = await readRunState(created.runDir)
    expect(failed.status).toBe("failed")
    expect(failed.error).toContain("no longer matches its digest")
    expect(failed.nodes["outside-model"]).toBeUndefined()
  })

  test("command nodes receive only their declared inherited environment", async () => {
    process.env.ORCHESTRATE_TEST_SECRET = "must-not-leak"
    process.env.ORCHESTRATE_TEST_KEEP = "kept"
    try {
      const command: CommandNode = {
        id: "env-check",
        type: "command",
        title: "Environment check",
        needs: [],
        cwd: null,
        workspace: workspace(),
        inputs: [],
        timeoutMinutes: null,
        retry: { maxAttempts: 1, delaySeconds: 0 },
        gate: "none",
        mutates: false,
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write((process.env.ORCHESTRATE_TEST_SECRET ?? 'absent') + ':' + (process.env.ORCHESTRATE_TEST_KEEP ?? 'missing'))"
        ],
        inheritEnv: ["ORCHESTRATE_TEST_KEEP"],
        env: {},
        allowedExitCodes: [0]
      }
      const spec = workflow([command])
      const created = await createRun(spec, workflowDigest(spec), false, false)
      await runWorker(created.runDir)
      const state = await readRunState(created.runDir)
      expect(state.status).toBe("completed")
      const resultPath = state.nodes["env-check"]?.resultPath
      expect(await readFile(resultPath as string, "utf8")).toBe("absent:kept")
    } finally {
      delete process.env.ORCHESTRATE_TEST_SECRET
      delete process.env.ORCHESTRATE_TEST_KEEP
    }
  })

  test("pauses an adaptive command that asks to inherit controller environment", async () => {
    const command: CommandNode = {
      id: "inheriting-command",
      type: "command",
      title: "Inheriting command",
      needs: ["seed"],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: [process.execPath, "-e", "process.stdout.write('done')"],
      inheritEnv: ["PATH"],
      env: {},
      allowedExitCodes: [0]
    }
    const base = supervisor([
      { status: "continue", reason: "Request an inheriting command.", addNodes: [command] }
    ])
    const guarded = supervisor(
      [{ status: "continue", reason: "Request an inheriting command.", addNodes: [command] }],
      {
        envelope: {
          ...base.envelope,
          allowCommands: true,
          commandArgvPrefixes: [[process.execPath]],
          allowedCommandEnv: []
        }
      }
    )
    const spec = workflow([mockAgent("seed", "seed"), guarded])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)
    expect(state.status).toBe("paused")
    expect(state.pendingPatch?.reasons.join(" ")).toContain("may not inherit")
  })

  test("pauses a dynamically escalated sandbox outside the approved envelope", async () => {
    const escalated = mockAgent("escalated", "unsafe", {
      provider: "codex",
      model: "provider-default",
      permissions: {
        sandbox: "danger-full-access",
        extraArgs: ["--skip-git-repo-check"],
        inheritEnv: [],
        env: {}
      }
    })
    const decision: SupervisorDecision = {
      status: "continue",
      reason: "Escalate.",
      addNodes: [escalated]
    }
    const guarded = supervisor([decision], {
      envelope: {
        providers: ["codex"],
        models: ["provider-default"],
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
        codexSandboxes: ["read-only"],
        claudePermissionModes: [],
        allowedExtraArgs: [],
        allowedInheritedEnv: [],
        allowedProviderEnv: [],
        resumableSessionAliases: [],
        newSessionAliasPrefixes: [],
        maxAddedNodesPerRound: null
      }
    })
    const spec = workflow([mockAgent("seed", "seed"), guarded])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)

    expect(state.status).toBe("paused")
    expect(state.pendingPatch?.reasons.join(" ")).toContain("unapproved Codex sandbox")
    expect(state.pendingPatch?.reasons.join(" ")).toContain("unapproved provider CLI arguments")
  })

  test("rejects an adaptive node that depends on its own supervisor barrier", async () => {
    const cyclic = mockAgent("cyclic", "cyclic", {
      needs: ["supervise"]
    })
    const spec = workflow([
      mockAgent("seed", "seed"),
      supervisor([
        {
          status: "continue",
          reason: "Invalid synthetic cycle.",
          addNodes: [cyclic]
        }
      ])
    ])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)
    expect(state.status).toBe("paused")
    expect(state.pauseCode).toBe("invalid-patch:supervise")
    expect(state.dynamicNodes).toHaveLength(0)
  })

  test("pauses an unapproved adaptive Git worktree mutation", async () => {
    const worktreeNode = mockAgent("worktree-node", "work", {
      workspace: {
        mode: "git-worktree",
        path: path.join(temporaryRoot, "worktree"),
        vcs: "git",
        writes: ["src/**"],
        exclusiveResources: [],
        git: {
          branch: "adaptive-branch",
          startPoint: "HEAD",
          removeOnClean: false
        }
      }
    })
    const spec = workflow([
      mockAgent("seed", "seed"),
      supervisor([
        {
          status: "continue",
          reason: "Create an unapproved worktree.",
          addNodes: [worktreeNode]
        }
      ])
    ])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)
    expect(state.status).toBe("paused")
    expect(state.pendingPatch?.reasons.join(" ")).toContain("workspace mode")
    await expect(access(path.join(temporaryRoot, "worktree"))).rejects.toThrow()
  })

  test("counts a failed worktree setup as the configured single attempt", async () => {
    const node = mockAgent("worktree", "never runs", {
      workspace: {
        mode: "git-worktree",
        path: null,
        vcs: "git",
        writes: ["src/**"],
        exclusiveResources: [],
        git: { branch: "test-{{runId}}", startPoint: "HEAD", removeOnClean: false }
      }
    })
    const spec = workflow([node])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)

    expect(state.status).toBe("failed")
    expect(state.nodes.worktree?.attempts).toBe(1)
  })

  test("runs git-worktree nodes off the same repo concurrently after setup", async () => {
    const repo = path.join(temporaryRoot, "repo")
    await mkdir(repo, { recursive: true })
    execFileSync("git", ["init", "-q", repo])
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "-m",
      "init",
      "-q"
    ])
    const barrierNode = (id: string, marker: string, otherMarker: string): CommandNode => ({
      id,
      type: "command",
      title: id,
      needs: [],
      cwd: repo,
      workspace: {
        mode: "git-worktree",
        path: null,
        vcs: "git",
        writes: [],
        exclusiveResources: [],
        git: { branch: `${id}-{{runId}}`, startPoint: "HEAD", removeOnClean: false }
      },
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: [
        process.execPath,
        "-e",
        `const fs=require("fs");fs.writeFileSync(${JSON.stringify(marker)},"here");const deadline=Date.now()+8000;(function wait(){if(fs.existsSync(${JSON.stringify(otherMarker)}))process.exit(0);if(Date.now()>deadline)process.exit(9);setTimeout(wait,25)})()`
      ],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    })
    const leftMarker = path.join(temporaryRoot, "left-marker")
    const rightMarker = path.join(temporaryRoot, "right-marker")
    const spec = {
      ...workflow([
        barrierNode("left", leftMarker, rightMarker),
        barrierNode("right", rightMarker, leftMarker)
      ]),
      concurrency: 2
    }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)
    expect(state.status).toBe("completed")
    expect(state.nodes.left?.status).toBe("completed")
    expect(state.nodes.right?.status).toBe("completed")
  }, 20_000)

  test("a missing executable fails the node and settles the run without killing the worker", async () => {
    const command: CommandNode = {
      id: "missing-binary",
      type: "command",
      title: "Missing binary",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: ["/nonexistent-orchestrate-test/binary"],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const spec = workflow([command])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)
    expect(state.status).toBe("failed")
    expect(state.nodes["missing-binary"]?.status).toBe("failed")
    expect(state.nodes["missing-binary"]?.error).toContain("ENOENT")
  })

  test("stop preempts a failure drain and cancels the surviving node promptly", async () => {
    const failing: CommandNode = {
      id: "fail-fast",
      type: "command",
      title: "Fail fast",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: [process.execPath, "-e", "process.exit(3)"],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const slow: CommandNode = {
      ...failing,
      id: "slow",
      title: "Slow survivor",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"]
    }
    const spec = { ...workflow([failing, slow]), concurrency: 2 }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    const live = await waitForRunState(
      created.runDir,
      (state) =>
        state.nodes["fail-fast"]?.status === "failed" && state.nodes.slow?.status === "running"
    )
    await writeFile(
      stopRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: live.workerToken })}\n`,
      { mode: 0o600 }
    )
    await running
    const stopped = await readRunState(created.runDir)
    expect(stopped.status).toBe("stopped")
    expect(stopped.nodes["fail-fast"]?.status).toBe("failed")
    expect(stopped.nodes.slow?.status).toBe("cancelled")
  })

  test("reserves the agent-start budget at schedule time so concurrency cannot overshoot", async () => {
    const first = mockAgent("first", "first")
    const second = mockAgent("second", "second")
    const base = { ...workflow([first, second]), concurrency: 2 }
    const spec: WorkflowSpec = {
      ...base,
      limits: { ...base.limits, maxAgentStarts: 1 }
    }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)
    expect(state.status).toBe("paused")
    expect(state.pauseCode).toBe("max-agent-starts")
    expect(state.agentStarts).toBe(1)
    expect(Object.values(state.nodes).filter((node) => node.status === "completed")).toHaveLength(1)
  })

  test("a node timeout bounds the whole attempt and fails it", async () => {
    const command: CommandNode = {
      id: "slow-timeout",
      type: "command",
      title: "Slow timeout",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: 0.002,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const spec = workflow([command])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)
    expect(state.status).toBe("failed")
    expect(state.nodes["slow-timeout"]?.error).toContain("timed out")
  })

  test("validates draft 2020-12 agent output schemas", async () => {
    const node = mockAgent("json", JSON.stringify({ ok: true }), {
      output: {
        format: "json",
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["ok"],
          properties: { ok: { const: true } },
          additionalProperties: false
        }
      }
    })
    const spec = workflow([node])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    expect((await readRunState(created.runDir)).status).toBe("completed")
  })

  test("continues past an explicitly overridden workflow limit", async () => {
    const first = mockAgent("first", "first")
    const second = mockAgent("second", "second", { needs: ["first"] })
    const base = workflow([first, second])
    const spec: WorkflowSpec = {
      ...base,
      limits: { ...base.limits, maxAgentStarts: 1 }
    }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    let state = await readRunState(created.runDir)
    expect(state.status).toBe("paused")
    expect(state.pauseCode).toBe("max-agent-starts")

    state = {
      ...state,
      status: "starting",
      pauseReason: null,
      pauseCode: null,
      overriddenLimits: ["max-agent-starts"]
    }
    await writeRunState(created.runDir, state)
    await runWorker(created.runDir)
    expect((await readRunState(created.runDir)).status).toBe("completed")
  })

  test("retries on the fixed Effect schedule while retaining the active resource lease", async () => {
    const counter = path.join(temporaryRoot, "retry-counter")
    const firstDone = path.join(temporaryRoot, "first-done")
    const secondStarted = path.join(temporaryRoot, "second-started")
    const retrying: CommandNode = {
      id: "retrying",
      type: "command",
      title: "Retrying command",
      needs: [],
      cwd: null,
      workspace: { ...workspace(), exclusiveResources: ["shared-retry-resource"] },
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 2, delaySeconds: 0.08 },
      gate: "none",
      mutates: false,
      argv: [
        process.execPath,
        "-e",
        `const fs=require("fs");const p=${JSON.stringify(counter)};const n=fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0;fs.writeFileSync(p,String(n+1));if(n===0)process.exit(7);fs.writeFileSync(${JSON.stringify(firstDone)},String(Date.now()));process.stdout.write("ok")`
      ],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const waiting: CommandNode = {
      ...retrying,
      id: "waiting",
      title: "Waiting command",
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      argv: [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(secondStarted)},String(Date.now()))`
      ]
    }
    const spec = { ...workflow([retrying, waiting]), concurrency: 2 }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const startedAt = Date.now()
    await runWorker(created.runDir)
    const state = await readRunState(created.runDir)

    expect(state.status).toBe("completed")
    expect(state.nodes.retrying?.attempts).toBe(2)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(70)
    expect(Number(await readFile(secondStarted, "utf8"))).toBeGreaterThanOrEqual(
      Number(await readFile(firstDone, "utf8"))
    )
    const eventTypes = (await readFile(eventsPath(created.runDir), "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type)
    expect(eventTypes.filter((type) => type === "node.retrying")).toHaveLength(1)
  })

  test("ignores a stale stop token, then structurally cancels and releases the live worker", async () => {
    const command: CommandNode = {
      id: "long-running",
      type: "command",
      title: "Long running command",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const spec = workflow([command])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    let live = await readRunState(created.runDir)
    for (
      let attempt = 0;
      attempt < 40 && live.nodes[command.id]?.status !== "running";
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      live = await readRunState(created.runDir)
    }
    expect(live.workerToken).toBeTruthy()
    expect(live.nodes[command.id]?.status).toBe("running")

    await writeFile(
      stopRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: "stale-token" })}\n`,
      { mode: 0o600 }
    )
    await new Promise((resolve) => setTimeout(resolve, 650))
    expect((await readRunState(created.runDir)).status).toBe("running")

    await writeFile(
      stopRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: live.workerToken })}\n`,
      { mode: 0o600 }
    )
    await running
    const stopped = await readRunState(created.runDir)
    expect(stopped.status).toBe("stopped")
    expect(stopped.pid).toBeNull()
    expect(stopped.workerToken).toBeNull()
    expect(stopped.nodes[command.id]?.status).toBe("cancelled")
    await expect(access(stopRequestPath(created.runDir))).rejects.toThrow()

    const release = await acquireWorkerLock(created.runDir, "post-stop-test", "cli")
    await release()
    const eventTypes = (await readFile(eventsPath(created.runDir), "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type)
    expect(eventTypes).toContain("node.cancelled")
    expect(eventTypes.at(-1)).toBe("run.stopped")
  })

  test("pauses at a node boundary, suppresses later scheduling, and resumes without replay", async () => {
    const firstStarted = path.join(temporaryRoot, "pause-first-started")
    const firstFinished = path.join(temporaryRoot, "pause-first-finished")
    const secondStarted = path.join(temporaryRoot, "pause-second-started")
    const callbackEvents = path.join(temporaryRoot, "pause-callbacks.jsonl")
    const first: CommandNode = {
      id: "first",
      type: "command",
      title: "First boundary node",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(firstStarted)},"started");setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(firstFinished)},"finished"),1000)`
      ],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const second: CommandNode = {
      ...first,
      id: "second",
      title: "Second boundary node",
      needs: [],
      argv: [
        process.execPath,
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(secondStarted)},"started")`
      ]
    }
    const base = { ...workflow([first, second]), concurrency: 1 }
    const spec: WorkflowSpec = {
      ...base,
      heartbeat: {
        ...base.heartbeat,
        callback: {
          type: "command",
          argv: [
            process.execPath,
            "-e",
            `require("fs").appendFileSync(${JSON.stringify(callbackEvents)},JSON.parse(process.argv[1]).type+"\\n")`,
            "{{event}}"
          ],
          timeoutSeconds: 5
        }
      }
    }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    let live = await waitForRunState(
      created.runDir,
      (state) => state.nodes.first?.status === "running"
    )

    await writeFile(
      pauseRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: "stale-token" })}\n`
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect((await readRunState(created.runDir)).status).toBe("running")
    expect((await readRunState(created.runDir)).nodes.second?.status).toBe("pending")

    live = await readRunState(created.runDir)
    await writeFile(
      pauseRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: live.workerToken })}\n`
    )
    await running

    const paused = await readRunState(created.runDir)
    expect(paused.status).toBe("paused")
    expect(paused.pauseCode).toBe("user-request")
    expect(paused.pid).toBeNull()
    expect(paused.workerToken).toBeNull()
    expect(paused.stopRequested).toBe(false)
    expect(paused.finishedAt).toBeNull()
    expect(paused.nodes.first?.status).toBe("completed")
    expect(paused.nodes.first?.attempts).toBe(1)
    expect(paused.nodes.second?.status).toBe("pending")
    expect(await readFile(firstFinished, "utf8")).toBe("finished")
    await expect(access(secondStarted)).rejects.toThrow()
    await expect(access(pauseRequestPath(created.runDir))).rejects.toThrow()

    await runWorker(created.runDir)
    const completed = await readRunState(created.runDir)
    expect(completed.status).toBe("completed")
    expect(completed.nodes.first?.attempts).toBe(1)
    expect(completed.nodes.second?.attempts).toBe(1)
    expect(await readFile(secondStarted, "utf8")).toBe("started")
    const callbackTypes = (await readFile(callbackEvents, "utf8")).trim().split("\n")
    expect(callbackTypes).toContain("run.pausing")
    expect(callbackTypes).toContain("run.paused")
    expect(callbackTypes).not.toContain("callback.failed")
  })

  test("stop preempts a pause drain and delivers cancellation before the terminal callback", async () => {
    const callbackEvents = path.join(temporaryRoot, "stop-during-pause-callbacks.jsonl")
    const command: CommandNode = {
      id: "long-running",
      type: "command",
      title: "Long running command",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const base = workflow([command])
    const spec: WorkflowSpec = {
      ...base,
      heartbeat: {
        ...base.heartbeat,
        callback: {
          type: "command",
          argv: [
            process.execPath,
            "-e",
            `setTimeout(()=>require("fs").appendFileSync(${JSON.stringify(callbackEvents)},JSON.parse(process.argv[1]).type+"\\n"),40)`,
            "{{event}}"
          ],
          timeoutSeconds: 5
        }
      }
    }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    let live = await waitForRunState(
      created.runDir,
      (state) => state.nodes[command.id]?.status === "running"
    )
    await writeFile(
      pauseRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: live.workerToken })}\n`
    )
    live = await waitForRunState(created.runDir, (state) => state.status === "pausing")
    await writeFile(
      stopRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: live.workerToken })}\n`
    )
    await running

    const stopped = await readRunState(created.runDir)
    expect(stopped.status).toBe("stopped")
    expect(stopped.nodes[command.id]?.status).toBe("cancelled")
    const callbacks = (await readFile(callbackEvents, "utf8")).trim().split("\n")
    expect(callbacks.indexOf("node.cancelled")).toBeGreaterThan(-1)
    expect(callbacks.indexOf("run.stopped")).toBeGreaterThan(callbacks.indexOf("node.cancelled"))
    const journal = await readFile(eventsPath(created.runDir), "utf8")
    expect(journal).not.toContain("callback.failed")
  })

  test("stop cannot rewrite a node that completed before its milestone callback was interrupted", async () => {
    const callbackEntered = path.join(temporaryRoot, "completed-callback-entered")
    const command: CommandNode = {
      id: "complete-before-stop",
      type: "command",
      title: "Complete before stop",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: [process.execPath, "-e", "process.stdout.write('done')"],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const base = workflow([command])
    const spec: WorkflowSpec = {
      ...base,
      heartbeat: {
        ...base.heartbeat,
        milestones: true,
        callback: {
          type: "command",
          argv: [
            process.execPath,
            "-e",
            `const e=JSON.parse(process.argv[1]);if(e.type==="node.completed"){require("fs").writeFileSync(${JSON.stringify(callbackEntered)},"entered");setTimeout(()=>{},5000)}`,
            "{{event}}"
          ],
          timeoutSeconds: 10
        }
      }
    }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    await waitForRunState(
      created.runDir,
      (state) => state.nodes[command.id]?.status === "completed"
    )
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (
        await access(callbackEntered)
          .then(() => true)
          .catch(() => false)
      ) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(await readFile(callbackEntered, "utf8")).toBe("entered")
    const live = await readRunState(created.runDir)
    await writeFile(
      stopRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: live.workerToken })}\n`
    )
    await running

    const stopped = await readRunState(created.runDir)
    expect(stopped.status).toBe("stopped")
    expect(stopped.nodes[command.id]?.status).toBe("completed")
    const journal = await readFile(eventsPath(created.runDir), "utf8")
    expect(journal).not.toContain("node.cancelled")
  })

  test("completion wins when the last active node reaches the requested pause boundary", async () => {
    const command: CommandNode = {
      id: "last-node",
      type: "command",
      title: "Last node",
      needs: [],
      cwd: null,
      workspace: workspace(),
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      mutates: false,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 700)"],
      inheritEnv: [],
      env: {},
      allowedExitCodes: [0]
    }
    const spec = workflow([command])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    const running = runWorker(created.runDir)
    const live = await waitForRunState(
      created.runDir,
      (state) => state.nodes[command.id]?.status === "running"
    )
    await writeFile(
      pauseRequestPath(created.runDir),
      `${JSON.stringify({ requestedAt: new Date().toISOString(), workerToken: live.workerToken })}\n`
    )
    await running
    const completed = await readRunState(created.runDir)
    expect(completed.status).toBe("completed")
    const events = await readFile(eventsPath(created.runDir), "utf8")
    expect(events).toContain("run.pausing")
    expect(events).toContain("run.completed")
    expect(events).not.toContain("run.paused")
  })

  test("a gated node pauses before any attempt and completes after digest-bound approval", async () => {
    const callbackEvents = path.join(temporaryRoot, "gate-callbacks.jsonl")
    const seed = mockAgent("seed", "planner output")
    const gated = mockAgent("consume", "Fixed prompt frame.", {
      needs: ["seed"],
      inputs: [{ from: "seed", as: "Generated task", include: "content" }],
      gate: "approval"
    })
    const base = workflow([seed, gated])
    const spec: WorkflowSpec = {
      ...base,
      heartbeat: {
        ...base.heartbeat,
        callback: {
          type: "command",
          argv: [
            process.execPath,
            "-e",
            `require("fs").appendFileSync(${JSON.stringify(callbackEvents)},JSON.parse(process.argv[1]).type+"\\n")`,
            "{{event}}"
          ],
          timeoutSeconds: 5
        }
      }
    }
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const paused = await readRunState(created.runDir)

    expect(paused.status).toBe("paused")
    expect(paused.pauseCode).toBe("gate:consume")
    expect(paused.nodes.seed?.status).toBe("completed")
    expect(paused.nodes.consume?.status).toBe("pending")
    expect(paused.nodes.consume?.attempts).toBe(0)
    expect(paused.nodes.consume?.resultPath).toBeNull()
    // Only the ungated seed consumed an agent start; the gate pauses before
    // the scheduler reserves anything for the gated node.
    expect(paused.agentStarts).toBe(1)
    expect(paused.pendingGate?.nodeId).toBe("consume")
    expect(paused.pendingGate?.title).toBe("consume")
    expect(paused.pendingGate?.content).toBe(
      "Fixed prompt frame.\n\n# Workflow inputs\n\n## Generated task\nplanner output"
    )
    expect(paused.pendingGate?.digest).toBe(
      gateApprovalDigest(paused.id, "consume", paused.pendingGate?.content as string)
    )
    const callbackTypes = (await readFile(callbackEvents, "utf8")).trim().split("\n")
    expect(callbackTypes).toContain("run.pausing")
    expect(callbackTypes).toContain("run.paused")

    await writeRunState(created.runDir, {
      ...paused,
      status: "starting",
      approvedPendingGate: true,
      pauseReason: null,
      pauseCode: null
    })
    await runWorker(created.runDir)
    const completed = await readRunState(created.runDir)
    expect(completed.status).toBe("completed")
    expect(completed.pendingGate).toBeNull()
    expect(completed.satisfiedGates).toEqual(["consume"])
    expect(completed.nodes.consume?.attempts).toBe(1)
    // The mock provider echoes its rendered prompt, so the executed content
    // is provably the approved content.
    expect(await readFile(completed.nodes.consume?.resultPath as string, "utf8")).toBe(
      paused.pendingGate?.content as string
    )
    const eventTypes = (await readFile(eventsPath(created.runDir), "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type)
    expect(eventTypes).toContain("gate.approved")
  })

  test("worker refuses an approved gate whose content or digest changed", async () => {
    const seed = mockAgent("seed", "planner output")
    const gated = mockAgent("consume", "Fixed prompt frame.", {
      needs: ["seed"],
      inputs: [{ from: "seed", as: "Generated task", include: "content" }],
      gate: "approval"
    })
    const spec = workflow([seed, gated])

    // Tampered stored gate content no longer matches the approval digest.
    const tamperedDigest = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(tamperedDigest.runDir)
    let paused = await readRunState(tamperedDigest.runDir)
    expect(paused.pendingGate).not.toBeNull()
    await writeRunState(tamperedDigest.runDir, {
      ...paused,
      status: "starting",
      approvedPendingGate: true,
      pauseReason: null,
      pauseCode: null,
      pendingGate:
        paused.pendingGate === null
          ? null
          : { ...paused.pendingGate, content: `${paused.pendingGate.content} tampered` }
    })
    await runWorker(tamperedDigest.runDir)
    const failedDigest = await readRunState(tamperedDigest.runDir)
    expect(failedDigest.status).toBe("failed")
    expect(failedDigest.error).toContain("no longer matches its digest")
    expect(failedDigest.nodes.consume?.attempts).toBe(0)

    // An upstream result that changed after approval re-renders differently
    // and is refused even though the stored digest is internally consistent.
    const tamperedUpstream = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(tamperedUpstream.runDir)
    paused = await readRunState(tamperedUpstream.runDir)
    expect(paused.pendingGate).not.toBeNull()
    await writeFile(paused.nodes.seed?.resultPath as string, "replaced upstream result")
    await writeRunState(tamperedUpstream.runDir, {
      ...paused,
      status: "starting",
      approvedPendingGate: true,
      pauseReason: null,
      pauseCode: null
    })
    await runWorker(tamperedUpstream.runDir)
    const failedUpstream = await readRunState(tamperedUpstream.runDir)
    expect(failedUpstream.status).toBe("failed")
    expect(failedUpstream.error).toContain("approved rendered content")
    expect(failedUpstream.nodes.consume?.attempts).toBe(0)
  })

  test("a gated node added by a supervisor patch pauses before it runs", async () => {
    const added = mockAgent("round-fix", "apply the generated fix", { gate: "approval" })
    const decisions: SupervisorDecision[] = [
      { status: "continue", reason: "Run a gated fix round.", addNodes: [added] },
      { status: "complete", reason: "The gated fix completed.", addNodes: [] }
    ]
    const spec = workflow([mockAgent("seed", "seed"), supervisor(decisions)])
    const created = await createRun(spec, workflowDigest(spec), false, false)
    await runWorker(created.runDir)
    const paused = await readRunState(created.runDir)

    expect(paused.status).toBe("paused")
    expect(paused.pauseCode).toBe("gate:round-fix")
    expect(paused.pendingGate?.nodeId).toBe("round-fix")
    expect(paused.nodes["round-fix"]?.attempts).toBe(0)

    await writeRunState(created.runDir, {
      ...paused,
      status: "starting",
      approvedPendingGate: true,
      pauseReason: null,
      pauseCode: null
    })
    await runWorker(created.runDir)
    const completed = await readRunState(created.runDir)
    expect(completed.status).toBe("completed")
    expect(completed.satisfiedGates).toEqual(["round-fix"])
    expect(completed.nodes["round-fix"]?.status).toBe("completed")
    expect(completed.goalRounds.supervise).toBe(1)
  })

  test("recovery identity refuses a live process whose fingerprint differs", async () => {
    const verification: { value: string | null } = { value: null }
    await Effect.runPromise(
      runProcessEffect({
        argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 250)"],
        cwd: temporaryRoot,
        stdoutPath: path.join(temporaryRoot, "identity-out.log"),
        stderrPath: path.join(temporaryRoot, "identity-error.log"),
        timeoutMinutes: null,
        onSpawn: (pid, identity) =>
          Effect.tryPromise({
            try: async () => {
              expect(identity).not.toBeNull()
              expect(await terminateRecordedProcessTree(pid, null)).toBe("unverified")
              verification.value = await terminateRecordedProcessTree(
                pid,
                identity === null
                  ? null
                  : { ...identity, commandDigest: "0".repeat(identity.commandDigest.length) }
              )
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error)))
          })
      })
    )
    expect(verification.value).toBe("unverified")
  })

  test("recovery confirms a forced process-tree termination before returning", async () => {
    const termination: { value: string | null } = { value: null }
    await Effect.runPromise(
      runProcessEffect({
        argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        cwd: temporaryRoot,
        stdoutPath: path.join(temporaryRoot, "force-out.log"),
        stderrPath: path.join(temporaryRoot, "force-error.log"),
        timeoutMinutes: null,
        onSpawn: (pid, identity) =>
          Effect.tryPromise({
            try: async () => {
              expect(identity).not.toBeNull()
              await new Promise((resolve) => setTimeout(resolve, 100))
              termination.value = await terminateRecordedProcessTree(pid, identity)
            },
            catch: (error) => (error instanceof Error ? error : new Error(String(error)))
          })
      })
    )
    expect(termination.value).toBe("terminated")
  })

  test("a timed-out process fails even if it handles SIGTERM with exit zero", async () => {
    await expect(
      Effect.runPromise(
        runProcessEffect({
          argv: [
            process.execPath,
            "-e",
            "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"
          ],
          cwd: temporaryRoot,
          stdoutPath: path.join(temporaryRoot, "timeout-out.log"),
          stderrPath: path.join(temporaryRoot, "timeout-error.log"),
          timeoutMinutes: 0.001
        })
      )
    ).rejects.toThrow("timed out")
  })
})
