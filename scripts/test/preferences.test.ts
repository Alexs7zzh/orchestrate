import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  AgentNode,
  ClaudePermissionMode,
  CodexSandbox,
  DynamicNode,
  WorkflowNode,
  WorkflowSpec
} from "../src/types.js"

import { runCli } from "../src/cli.js"
import {
  captureApprovedPatch,
  captureApprovedWorkflow,
  capturePreferencesSafely,
  mergedPreferences,
  preferencesPath,
  type PreferencesFile
} from "../src/preferences.js"

let temporaryRoot = ""

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-preferences-test-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
  delete process.env.ORCHESTRATE_DISABLE_PREFS
})

afterEach(async () => {
  delete process.env.ORCHESTRATE_STATE_DIR
  delete process.env.ORCHESTRATE_DISABLE_PREFS
  await rm(temporaryRoot, { recursive: true, force: true })
})

function workspace(writes: readonly string[] = []) {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "git" as const,
    writes,
    exclusiveResources: []
  }
}

function common(id: string, writes: readonly string[] = []) {
  return {
    id,
    title: `secret title ${id}`,
    needs: [],
    cwd: null,
    workspace: workspace(writes),
    inputs: [],
    timeoutMinutes: null,
    retry: { maxAttempts: 1, delaySeconds: 0 },
    gate: "none" as const
  }
}

function codexAgent(
  id: string,
  model: string,
  sandbox: CodexSandbox,
  inheritEnv: readonly string[] = []
): AgentNode {
  return {
    ...common(id, sandbox === "read-only" ? [] : ["src/**"]),
    type: "agent",
    provider: "codex",
    model,
    effort: sandbox === "read-only" ? "low" : "high",
    prompt: `secret prompt ${id}`,
    session: {
      mode: "fresh",
      from: null,
      saveAs: null,
      retain: false,
      reuseOnRepeat: false
    },
    permissions: {
      sandbox,
      extraArgs: [],
      inheritEnv,
      env: { SECRET_VALUE: `secret-${id}` }
    },
    output: { format: "text", schema: null },
    interactive: false
  }
}

function claudeAgent(
  id: string,
  model: string,
  permissionMode: ClaudePermissionMode,
  inheritEnv: readonly string[] = []
): AgentNode {
  return {
    ...common(id, permissionMode === "plan" ? [] : ["src/**"]),
    type: "agent",
    provider: "claude",
    model,
    effort: null,
    prompt: `secret prompt ${id}`,
    session: {
      mode: "fresh",
      from: null,
      saveAs: null,
      retain: false,
      reuseOnRepeat: false
    },
    permissions: {
      permissionMode,
      extraArgs: [],
      inheritEnv,
      env: { SECRET_VALUE: `secret-${id}` }
    },
    output: { format: "text", schema: null },
    interactive: false
  }
}

function verifyCommand(id: string, argv: readonly string[]): WorkflowNode {
  return {
    ...common(id),
    type: "command",
    argv,
    mutates: false,
    inheritEnv: ["PATH"],
    env: { COMMAND_SECRET: "do-not-store" },
    allowedExitCodes: [0]
  }
}

function supervisor(): WorkflowNode {
  return {
    ...common("supervise"),
    type: "supervisor",
    provider: "codex",
    model: "supervisor-model",
    effort: "high",
    prompt: "secret supervisor prompt",
    session: {
      mode: "fresh",
      from: null,
      saveAs: null,
      retain: false,
      reuseOnRepeat: false
    },
    permissions: {
      sandbox: "read-only",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
    goal: "secret goal",
    termination: {
      success: "secret success",
      convergence: "secret convergence",
      maxRounds: 2,
      maxWallTimeMinutes: 20
    },
    envelope: {
      providers: ["codex", "claude"],
      models: ["*"],
      nodeTypes: ["agent", "command"],
      cwdRoots: [temporaryRoot],
      writeRoots: [temporaryRoot],
      workspaceModes: ["shared"],
      vcs: ["git"],
      gitWorktree: {
        allowed: false,
        branchPrefixes: [],
        startPoints: [],
        allowRemoveOnClean: false
      },
      allowCommands: false,
      commandArgvPrefixes: [],
      allowedCommandEnv: [],
      codexSandboxes: ["workspace-write", "danger-full-access"],
      claudePermissionModes: ["manual", "bypassPermissions"],
      allowedExtraArgs: [],
      allowedInheritedEnv: [["PATH", "HOME"]],
      allowedProviderEnv: [],
      resumableSessionAliases: [],
      newSessionAliasPrefixes: [],
      maxAddedNodesPerRound: 2
    }
  }
}

function workflow(cwd: string, nodes: readonly WorkflowNode[]): WorkflowSpec {
  return {
    version: 1,
    name: "secret workflow name",
    objective: "secret objective",
    cwd,
    concurrency: 4,
    heartbeat: {
      intervalMinutes: 10,
      milestones: true,
      callback: {
        type: "webhook",
        url: "https://secret.example/callback",
        headers: { Authorization: "secret-token" },
        timeoutSeconds: 5
      }
    },
    limits: {
      nodeWallTimeMinutes: 30,
      workflowWallTimeMinutes: null,
      maxAgentStarts: 12,
      maxGoalRounds: 3
    },
    writeConflicts: "allow-with-approval",
    nodes
  }
}

async function captureLogs<T>(action: () => Promise<T>): Promise<{
  readonly value: T
  readonly output: string
}> {
  const logs: string[] = []
  const original = console.log
  console.log = (...parts: unknown[]) => logs.push(parts.map(String).join(" "))
  try {
    return { value: await action(), output: logs.join("\n") }
  } finally {
    console.log = original
  }
}

async function runCaptureProcess(project: string, model: string): Promise<void> {
  const fixture = new URL("./fixtures/capture-preference.ts", import.meta.url).pathname
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, project, model], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"]
    })
    let errorOutput = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      errorOutput = `${errorOutput}${chunk.toString("utf8")}`.slice(-4_000)
    })
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Capture process exited ${code}: ${errorOutput}`))
      }
    })
  })
}

describe("approved workflow preferences", () => {
  test("captures bounded design defaults without task content or secret values", async () => {
    const commands = [
      verifyCommand("leaky", [
        "curl",
        "-H",
        "Authorization: Bearer ultra-secret",
        "https://secret.example/verify"
      ]),
      verifyCommand("verify-one", ["bun", "run", "verify"]),
      verifyCommand("verify-two", ["bun", "test"]),
      verifyCommand("verify-three", ["bun", "run", "check"]),
      verifyCommand("verify-four", ["bun", "run", "lint"]),
      verifyCommand("oversized", ["tool", "x".repeat(2_000)])
    ]
    await captureApprovedWorkflow(
      workflow(temporaryRoot, [
        codexAgent("review", "small-model", "read-only", ["PATH"]),
        codexAgent("implement-old", "old-model", "workspace-write", ["HOME"]),
        codexAgent("implement", "powerful-model", "workspace-write", ["PATH", "HOME"]),
        claudeAgent("claude-review", "review-model", "plan", ["PATH"]),
        claudeAgent("claude-write", "write-model", "acceptEdits", ["HOME"]),
        supervisor(),
        ...commands
      ])
    )

    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    const project = Object.values(stored.projects)[0]
    expect(project).toBeDefined()
    expect(project?.providers.codex?.mutating?.model).toBe("powerful-model")
    expect(project?.providers.codex?.readOnly?.model).toBe("supervisor-model")
    expect(project?.providers.codex?.permissionCeiling).toBe("danger-full-access")
    expect(project?.providers.codex?.inheritEnv).toEqual(["HOME", "PATH"])
    expect(project?.providers.claude?.mutating?.model).toBe("write-model")
    expect(project?.providers.claude?.readOnly?.model).toBe("review-model")
    expect(project?.providers.claude?.approvedPermissionModes).toEqual([
      "plan",
      "manual",
      "acceptEdits",
      "bypassPermissions"
    ])
    expect(project?.verifyCommands?.map((command) => command.argv)).toEqual([
      ["bun", "run", "verify"],
      ["bun", "test"],
      ["bun", "run", "check"]
    ])
    expect(project?.callback).toEqual({ type: "webhook", intervalMinutes: 10 })

    const serialized = JSON.stringify(stored)
    for (const forbidden of [
      "secret objective",
      "secret prompt",
      "secret title",
      "secret goal",
      "secret-token",
      "secret.example",
      "ultra-secret",
      "COMMAND_SECRET",
      "SECRET_VALUE",
      "do-not-store"
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test("uses last-approved values, monotonic authority, and field-level project fallback", async () => {
    const projectA = path.join(temporaryRoot, "a")
    const projectB = path.join(temporaryRoot, "b")
    await captureApprovedWorkflow(
      workflow(projectA, [codexAgent("a-write", "codex-a", "danger-full-access")])
    )
    await captureApprovedWorkflow(
      workflow(projectA, [codexAgent("a-write-new", "codex-a-new", "workspace-write")])
    )
    await captureApprovedWorkflow(workflow(projectB, [claudeAgent("b-review", "claude-b", "plan")]))
    const merged = await mergedPreferences(projectB)
    expect(merged.preferences.providers.codex?.mutating?.model).toBe("codex-a-new")
    expect(merged.preferences.providers.codex?.permissionCeiling).toBe("danger-full-access")
    expect(merged.preferences.providers.claude?.readOnly?.model).toBe("claude-b")
  })

  test("full approval clears stale verify commands and ignores inert envelope authority", async () => {
    const project = path.join(temporaryRoot, "project")
    await captureApprovedWorkflow(
      workflow(project, [verifyCommand("verify", ["bun", "run", "verify"])])
    )
    const restrictedSupervisor = supervisor()
    if (restrictedSupervisor.type !== "supervisor") {
      throw new Error("Expected a supervisor fixture.")
    }
    await captureApprovedWorkflow(
      workflow(project, [
        {
          ...restrictedSupervisor,
          envelope: { ...restrictedSupervisor.envelope, providers: ["claude"] }
        }
      ])
    )
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    const saved = Object.values(stored.projects)[0]
    expect(saved?.verifyCommands).toEqual([])
    expect(saved?.providers.codex?.permissionCeiling).toBe("read-only")
    expect(saved?.providers.claude?.approvedPermissionModes).toEqual([
      "manual",
      "bypassPermissions"
    ])
  })

  test("patch approval updates only observed fields and keeps recent distinct verification", async () => {
    const original = workflow(temporaryRoot, [
      codexAgent("review", "review-v1", "read-only"),
      verifyCommand("verify", ["bun", "run", "verify"])
    ])
    await captureApprovedWorkflow(original)
    const patchNodes: readonly DynamicNode[] = [
      codexAgent("implement", "write-v2", "danger-full-access"),
      verifyCommand("test", ["bun", "test"]) as DynamicNode
    ]
    await captureApprovedPatch(original, patchNodes)
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    const project = Object.values(stored.projects)[0]
    expect(project?.providers.codex?.mutating?.model).toBe("write-v2")
    expect(project?.providers.codex?.readOnly?.model).toBe("review-v1")
    expect(project?.callback).toEqual({ type: "webhook", intervalMinutes: 10 })
    expect(project?.verifyCommands?.map((command) => command.argv)).toEqual([
      ["bun", "test"],
      ["bun", "run", "verify"]
    ])
  })

  test("records the explicit cwd of a reusable Git worktree", async () => {
    const explicitWorktree = path.join(temporaryRoot, "prepared-worktree")
    const command = verifyCommand("verify", ["bun", "run", "verify"])
    await captureApprovedWorkflow(
      workflow(temporaryRoot, [
        {
          ...command,
          workspace: {
            mode: "git-worktree",
            path: explicitWorktree,
            vcs: "git",
            writes: [],
            exclusiveResources: [],
            git: {
              branch: "verify-{{runId}}",
              startPoint: "main",
              removeOnClean: false
            }
          }
        }
      ])
    )
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    expect(stored.global.verifyCommands?.[0]?.cwd).toBe(explicitWorktree)
  })

  test("serializes concurrent upserts and evicts projects to the fixed limit", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        captureApprovedWorkflow(
          workflow(path.join(temporaryRoot, `project-${index}`), [
            codexAgent(`node-${index}`, `model-${index}`, "read-only")
          ])
        )
      )
    )
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    expect(Object.keys(stored.projects)).toHaveLength(20)
  })

  test("serializes independent processes without losing project updates", async () => {
    const projects = Array.from({ length: 8 }, (_, index) => ({
      cwd: path.join(temporaryRoot, `process-project-${index}`),
      model: `process-model-${index}`
    }))
    await Promise.all(projects.map(({ cwd, model }) => runCaptureProcess(cwd, model)))
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    expect(Object.keys(stored.projects).toSorted()).toEqual(
      projects.map(({ cwd }) => cwd).toSorted()
    )
    for (const { cwd, model } of projects) {
      expect(stored.projects[cwd]?.providers.codex?.readOnly?.model).toBe(model)
    }
  })

  test("recovers a preference lock left by a dead process", async () => {
    const exited = spawnSync(process.execPath, ["--version"], { stdio: "ignore" })
    expect(exited.pid).toBeGreaterThan(0)
    const lockPath = path.join(path.dirname(preferencesPath()), "preferences.lock")
    await mkdir(path.dirname(lockPath), { recursive: true })
    await writeFile(lockPath, `${JSON.stringify({ pid: exited.pid, token: "abandoned-lock" })}\n`)
    await captureApprovedWorkflow(
      workflow(temporaryRoot, [codexAgent("review", "recovered-model", "read-only")])
    )
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    expect(stored.global.providers.codex?.readOnly?.model).toBe("recovered-model")
    expect(await readFile(lockPath, "utf8").catch(() => null)).toBeNull()
  })

  test("opt-out skips capture and makes prefs a non-writing no-op", async () => {
    process.env.ORCHESTRATE_DISABLE_PREFS = "1"
    await captureApprovedWorkflow(workflow(temporaryRoot, [codexAgent("review", "m", "read-only")]))
    expect(await readFile(preferencesPath(), "utf8").catch(() => null)).toBeNull()
    expect(await runCli(["prefs"], "/unused")).toBe(0)
    expect(await readFile(preferencesPath(), "utf8").catch(() => null)).toBeNull()
  })

  test("malformed files are quarantined without echoing their contents", async () => {
    await captureApprovedWorkflow(
      workflow(temporaryRoot, [codexAgent("seed", "seed-model", "read-only")])
    )
    await writeFile(preferencesPath(), "{ invalid secret-content")
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...parts: unknown[]) => warnings.push(parts.map(String).join(" "))
    try {
      await capturePreferencesSafely(() =>
        captureApprovedWorkflow(workflow(temporaryRoot, [codexAgent("review", "m", "read-only")]))
      )
    } finally {
      console.warn = originalWarn
    }
    const warning = warnings.join("\n")
    expect(warning).toContain("moved invalid preferences")
    expect(warning).not.toContain("secret-content")
    const damaged = `${preferencesPath()}.damaged`
    expect(await readFile(damaged, "utf8")).toBe("{ invalid secret-content")
    const rebuilt = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    expect(rebuilt.version).toBe(1)

    await writeFile(preferencesPath(), "{ replacement invalid content")
    await captureApprovedWorkflow(
      workflow(temporaryRoot, [codexAgent("replacement", "replacement-model", "read-only")])
    )
    expect(await readFile(damaged, "utf8")).toBe("{ replacement invalid content")
    const entries = await readdir(path.dirname(preferencesPath()))
    expect(entries.filter((entry) => entry.startsWith("preferences.json.damaged"))).toEqual([
      "preferences.json.damaged"
    ])
  })

  test("caches provider detection and refreshes a stale snapshot", async () => {
    await captureApprovedWorkflow(
      workflow(temporaryRoot, [codexAgent("review", "model", "read-only")])
    )
    const original = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    const cached = await mergedPreferences(temporaryRoot)
    expect(cached.file.providersAvailable.checkedAt).toBe(original.providersAvailable.checkedAt)
    await writeFile(
      preferencesPath(),
      `${JSON.stringify({
        ...original,
        providersAvailable: {
          ...original.providersAvailable,
          checkedAt: "2000-01-01T00:00:00.000Z"
        }
      })}\n`
    )
    const refreshed = await mergedPreferences(temporaryRoot)
    expect(refreshed.file.providersAvailable.checkedAt).not.toBe("2000-01-01T00:00:00.000Z")
  })

  test("detects provider executables without running them", async () => {
    const bin = path.join(temporaryRoot, "bin")
    const marker = path.join(temporaryRoot, "provider-ran")
    await mkdir(bin, { recursive: true })
    for (const provider of ["codex", "claude"]) {
      const executable = path.join(bin, provider)
      await writeFile(executable, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`)
      await chmod(executable, 0o755)
    }
    const originalPath = process.env.PATH
    process.env.PATH = bin
    try {
      await captureApprovedWorkflow(workflow(temporaryRoot, []))
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
    }
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as PreferencesFile
    expect(stored.providersAvailable.codex).toBe(true)
    expect(stored.providersAvailable.claude).toBe(true)
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull()
  })

  test("prefs prints a merged view and rejects a set subcommand", async () => {
    await captureApprovedWorkflow(
      workflow(temporaryRoot, [codexAgent("review", "review-model", "read-only")])
    )
    const printed = await captureLogs(() =>
      runCli(["prefs", "--project", temporaryRoot], "/unused")
    )
    expect(printed.value).toBe(0)
    expect(printed.output).toContain(`Project: ${await realpath(temporaryRoot)}`)
    expect(printed.output).toContain("read-only review-model (low)")
    expect(printed.output).toContain("Defaults only")
    expect(printed.output).not.toContain("secret-token")
    await expect(runCli(["prefs", "set"], "/unused")).rejects.toThrow(
      "unexpected positional arguments"
    )
  })
})
