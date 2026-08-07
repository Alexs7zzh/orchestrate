import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AttemptState, CommandNode, WorkflowSpec } from "../src/types.js"

import {
  COMMAND_COMPLETION_SHAPES,
  PUBLIC_COMMANDS,
  PUBLIC_COMMAND_HELP,
  jsonError,
  runCli,
  setWatchInstalledHookForTests,
  statusText,
  statusValue,
  structuralDiff,
  watchBeforeScan
} from "../src/cli.js"
import { injectDoctorReportHookForTests, injectLiveDoctorHookForTests } from "../src/doctor.js"
import { createInitialRunState } from "../src/transition.js"
import { injectPathInspectionForTests } from "../src/validation.js"
import { workflowProvenance } from "./workflow-provenance-fixture.js"
import { workflowSourceYaml } from "./workflow-source-fixture.js"

const COMMANDS = [
  "validate",
  "preview",
  "run",
  "status",
  "events",
  "board",
  "reconcile",
  "result",
  "runs",
  "approve",
  "pause",
  "resume",
  "stop",
  "hold",
  "release",
  "steer",
  "revise",
  "node-done",
  "node-exit",
  "herdr-event",
  "ui",
  "clean",
  "completion",
  "setup",
  "doctor"
] as const

async function capture(action: () => Promise<number>): Promise<{ code: number; output: string }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...values: readonly unknown[]) => {
    lines.push(values.map(String).join(" "))
  }
  try {
    return { code: await action(), output: lines.join("\n") }
  } finally {
    console.log = original
  }
}

function completionValues(raw: string): readonly string[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[0] as string)
    .toSorted()
}

describe("CLI contract", () => {
  test("classifies JSON errors without changing their messages", () => {
    const cases = [
      [new Error("Unknown flag --bad for run."), "usage"],
      [new Error("ERROR schema: Expected an object."), "validation"],
      [new Error('No run matches "missing".'), "not_found"],
      [new Error('Run prefix "2026" is ambiguous: a, b.'), "conflict"],
      [new Error("herdr pane get exited 1"), "herdr"],
      [Object.assign(new Error("permission denied"), { code: "EACCES" }), "io"],
      [new Error("Unexpected provider failure."), "command_failed"]
    ] as const

    for (const [error, code] of cases) {
      expect(jsonError(error)).toEqual({
        ok: false,
        error: { code, message: error.message }
      })
    }
  })

  test("structural workflow diffs ignore object key insertion order", () => {
    const before: WorkflowSpec = {
      name: "diff-test",
      objective: "Compare workflows semantically.",
      cwd: "/tmp",
      concurrency: 1,
      callback: { type: "none" },
      milestones: false,
      limits: { maxStarts: null },
      writeConflicts: "reject",
      repeats: [],
      nodes: [
        {
          id: "build",
          type: "command",
          title: "Build",
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
          retry: { maxAttempts: 1 },
          gate: "none",
          argv: ["true"],
          mutates: false,
          inheritEnv: [],
          env: { ALPHA: "1", BETA: "2" },
          allowedExitCodes: [0]
        }
      ]
    }
    const reorderedNode: CommandNode = {
      ...(before.nodes[0] as CommandNode),
      env: { BETA: "2", ALPHA: "1" }
    }
    const after: WorkflowSpec = {
      ...before,
      nodes: [reorderedNode]
    }

    expect(structuralDiff(before, after)).toEqual([])
    expect(
      structuralDiff(before, {
        ...after,
        nodes: [{ ...reorderedNode, env: { BETA: "changed", ALPHA: "1" } }]
      })
    ).toEqual(["~ node build"])
    expect(
      structuralDiff(before, {
        ...after,
        presentation: {
          workrooms: [
            {
              id: "delivery",
              label: "Delivery",
              layout: "columns",
              seats: [{ id: "builder", label: "Builder" }],
              settlesOn: ["build"]
            }
          ]
        }
      })
    ).toEqual(["~ presentation"])
  })

  test("terminal status text does not offer stale recovery commands", async () => {
    const workflow: WorkflowSpec = {
      name: "terminal-status",
      objective: "Do not offer terminal actions.",
      cwd: "/tmp",
      concurrency: 1,
      callback: { type: "none" },
      milestones: false,
      limits: { maxStarts: null },
      writeConflicts: "reject",
      presentation: {
        workrooms: [
          {
            id: "review",
            label: "Review",
            layout: "columns",
            seats: [{ id: "reviewer", label: "Reviewer" }],
            settlesOn: ["build"]
          }
        ]
      },
      repeats: [],
      nodes: [
        {
          id: "build",
          type: "agent",
          title: "Build",
          needs: [],
          workroom: "review",
          seat: "reviewer",
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
          prompt: "Build.",
          session: { mode: "fresh", from: null, saveAs: null },
          permissions: {
            access: "read-only",
            escalation: "deny",
            extraArgs: [],
            inheritEnv: [],
            env: {}
          },
          output: { format: "text", schema: null }
        }
      ]
    }
    const initial = createInitialRunState(workflow, {
      id: "terminal-run",
      runtimeVersion: "test-build",
      digest: "workflow-digest",
      now: "2026-08-05T00:00:00.000Z",
      origin: null
    })
    const build = initial.nodes.build
    const review = initial.workrooms.review
    const reviewer = review?.seats.reviewer
    if (build === undefined || review === undefined || reviewer === undefined) {
      throw new Error("Expected the test workflow state to contain its node and workroom seat.")
    }
    const activeAttempt: AttemptState = {
      attempt: 1,
      status: "running",
      token: "a".repeat(64),
      pane: null,
      providerSessionId: null,
      startedAt: initial.updatedAt,
      finishedAt: null,
      exitCode: null,
      error: null,
      resultPath: "/tmp/submission/result.txt",
      outputPath: "/tmp/run/output.txt"
    }
    const actionable = {
      ...initial,
      nodes: { build: { ...build, status: "running" as const, attempts: [activeAttempt] } },
      gates: {
        build: {
          nodeId: "build",
          title: "Build",
          content: "line one\nline two",
          digest: "gate-digest",
          openedAt: initial.updatedAt,
          approvedAt: null
        }
      },
      pendingRevision: {
        provenance: await workflowProvenance(workflow),
        workflow,
        digest: "revision-digest",
        summary: ["preview revision"],
        createdAt: initial.updatedAt
      }
    }
    const actionableText = statusText(actionable)
    expect(actionableText).toContain('gate build content: "line one\\nline two"\n  gate build:')
    expect(actionableText).toContain("revision preview:")
    expect(statusValue(actionable).pendingRevision?.preview).toMatchObject({
      name: "terminal-status",
      objective: "Do not offer terminal actions."
    })
    const activeToken = activeAttempt.token
    expect(actionableText).toContain("restore the owning pane or resume its provider session")
    expect(actionableText).not.toContain(activeToken)
    expect(actionableText).not.toContain("orchestrate node-done")
    expect(JSON.stringify(statusValue(actionable))).not.toContain(activeToken)
    const exact = await workflowProvenance(workflow)
    const invalid = { ...exact, origins: { ...exact.origins } }
    delete invalid.origins["/name"]
    const invalidRevision = {
      ...initial,
      pendingRevision: {
        provenance: invalid,
        workflow,
        digest: "revision-digest",
        summary: ["invalid provenance"],
        createdAt: initial.updatedAt
      }
    }
    expect(statusValue(invalidRevision)).toMatchObject({
      needsAttention: true,
      pendingRevision: {
        preview: null,
        provenanceError: expect.stringContaining("Missing final-IR origin /name")
      }
    })
    expect(statusText(invalidRevision)).toContain(
      "revision provenance: Invalid pending revision provenance"
    )
    expect(statusText(invalidRevision)).not.toContain("orchestrate approve terminal-run --revision")
    const typeOrigin = exact.origins["/nodes/0/type"]
    const nameOrigin = exact.origins["/name"]
    if (typeOrigin === undefined || nameOrigin === undefined) {
      throw new Error("expected real YAML provenance origins")
    }
    const structuralVariants = [
      {
        ...exact,
        origins: {
          ...exact.origins,
          "/nodes/0/type": {
            kind: "explicit" as const,
            sourcePath: "/nodes/0/type",
            location: typeOrigin.location
          }
        }
      },
      {
        ...exact,
        origins: {
          ...exact.origins,
          "/name": {
            ...nameOrigin,
            location: { ...nameOrigin.location, file: "/tmp/unrelated.yaml" }
          }
        }
      }
    ]
    for (const provenance of structuralVariants) {
      const structuralRevision = {
        ...initial,
        pendingRevision: {
          provenance,
          workflow,
          digest: "revision-digest",
          summary: ["invalid structural provenance"],
          createdAt: initial.updatedAt
        }
      }
      expect(statusValue(structuralRevision)).toMatchObject({
        needsAttention: true,
        pendingRevision: { preview: null, provenanceError: expect.any(String) }
      })
      expect(statusText(structuralRevision)).not.toContain(
        "orchestrate approve terminal-run --revision"
      )
    }
    const invalidAnnotationsRevision = {
      ...initial,
      pendingRevision: {
        provenance: { ...exact, inferredNeeds: { ghost: [] } },
        workflow,
        digest: "revision-digest",
        summary: ["invalid inferred annotations"],
        createdAt: initial.updatedAt
      }
    }
    expect(statusValue(invalidAnnotationsRevision)).toMatchObject({
      needsAttention: true,
      pendingRevision: {
        preview: null,
        provenanceError: expect.stringContaining('Unknown inferredNeeds node "ghost"')
      }
    })
    expect(statusText(invalidAnnotationsRevision)).not.toContain(
      "orchestrate approve terminal-run --revision"
    )
    const stopped = {
      ...initial,
      status: "stopped" as const,
      pause: {
        kind: "condition" as const,
        message: "A stale condition message.",
        repeatId: null,
        createdAt: initial.updatedAt
      },
      pendingRevision: {
        provenance: await workflowProvenance(workflow),
        workflow,
        digest: "revision-digest",
        summary: ["stale revision"],
        createdAt: initial.updatedAt
      },
      nodes: { build: { ...build, status: "completed" as const } },
      holds: { build: { target: "build", scope: "instance" as const, setAt: initial.updatedAt } },
      workrooms: {
        review: {
          ...review,
          status: "active" as const,
          seats: {
            reviewer: {
              ...reviewer,
              status: "attention" as const,
              nodeId: "build"
            }
          }
        }
      }
    }

    const text = statusText(stopped)
    expect(text).not.toContain("Needs you:")
    for (const command of [
      "orchestrate approve",
      "orchestrate resume",
      "orchestrate release",
      "orchestrate reconcile",
      "orchestrate node-done"
    ]) {
      expect(text).not.toContain(command)
    }
    expect(statusValue({ ...initial, status: "failed" }).needsAttention).toBe(true)
  })

  test("previews the workroom floor plan and authoritative seat assignments", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "orchestrate-preview-workrooms-"))
    const file = path.join(temporary, "workflow.yaml")
    const spec: WorkflowSpec = {
      name: "preview-workrooms",
      objective: "Preview presentation intent.",
      cwd: "/tmp",
      concurrency: 1,
      callback: { type: "none" },
      milestones: false,
      limits: { maxStarts: null },
      writeConflicts: "reject",
      presentation: {
        workrooms: [
          {
            id: "delivery",
            label: "Delivery\nforged room",
            layout: "columns",
            seats: [{ id: "builder", label: "Builder\nforged seat" }],
            settlesOn: ["build"]
          }
        ]
      },
      repeats: [],
      nodes: [
        {
          id: "build",
          type: "agent",
          title: "Build",
          needs: [],
          workroom: "delivery",
          seat: "builder",
          cwd: null,
          workspace: {
            mode: "shared",
            path: null,
            vcs: "none",
            writes: ["src/**"],
            exclusiveResources: ["release-slot"]
          },
          inputs: [],
          retry: { maxAttempts: 1 },
          gate: "none",
          provider: "codex",
          model: "provider-default",
          effort: null,
          prompt: "Build.\nforged node line",
          session: { mode: "fresh", from: null, saveAs: null },
          permissions: {
            access: "read-only",
            escalation: "deny",
            extraArgs: [],
            inheritEnv: [],
            env: { REVIEW_CHANNEL: "private-value" }
          },
          output: { format: "text", schema: null }
        }
      ]
    }
    try {
      await Bun.write(file, workflowSourceYaml(spec))
      const json = await capture(() => runCli(["preview", file, "--json"]))
      expect(json.code).toBe(0)
      const parsed = JSON.parse(json.output)
      expect(parsed.preview).toMatchObject({
        presentation: {
          workrooms: [
            {
              id: "delivery",
              layout: "columns",
              settlesOn: ["build"],
              seats: [{ id: "builder" }]
            }
          ]
        },
        nodes: [
          {
            id: "build",
            workroom: "delivery",
            seat: "builder",
            prompt: "Build.\nforged node line"
          }
        ]
      })
      expect(parsed.preview.nodes[0]).not.toHaveProperty("env")
      expect(json.output).not.toContain("private-value")
      const plain = await capture(() => runCli(["preview", file]))
      expect(plain.output).toContain("Presentation:")
      expect(plain.output).toContain('"label":"Delivery\\nforged room"')
      expect(plain.output).toContain('"label":"Builder\\nforged seat"')
      expect(plain.output).not.toContain("Delivery\nforged room")
      expect(plain.output).not.toContain("Builder\nforged seat")
      expect(plain.output).toContain('"workroom":"delivery"')
      expect(plain.output).toContain('"environmentKeys":["REVIEW_CHANNEL"]')
      expect(plain.output).toContain('"prompt":"Build.\\nforged node line"')
      expect(plain.output).not.toContain('"prompt":"\\"Build.')
      expect(plain.output).not.toContain("Build.\nforged node line")
      expect(plain.output).not.toContain("private-value")
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("redacts curl-style callback credentials in public JSON and plain previews", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "orchestrate-preview-callback-"))
    const file = path.join(temporary, "workflow.yaml")
    const callback = {
      type: "command" as const,
      argv: [
        "curl",
        "-H",
        "Authorization: Bearer short-adjacent-secret",
        "--header",
        "Proxy-Authorization: Basic long-adjacent-secret",
        "--header=Authorization: Bearer equals-header-secret",
        "--header",
        "X-Route: stable",
        "-u",
        "short-user:short-password",
        "--user=equals-user:equals-password",
        "--url",
        "https://adjacent:password@example.test/hook?action=publish&token=adjacent-query",
        "--url=https://equals:password@example.test/hook?action=rollback&secret=equals-query"
      ],
      timeoutSeconds: 30
    }
    const expected = {
      type: "command",
      argv: [
        "curl",
        "-H",
        "Authorization: [redacted]",
        "--header",
        "Proxy-Authorization: [redacted]",
        "--header=Authorization: [redacted]",
        "--header",
        "X-Route: stable",
        "-u",
        "[redacted]",
        "--user=[redacted]",
        "--url",
        "https://example.test/hook?action=publish&token=%5Bredacted%5D",
        "--url=https://example.test/hook?action=rollback&secret=%5Bredacted%5D"
      ],
      timeoutSeconds: 30
    }
    const spec: WorkflowSpec = {
      name: "callback-preview",
      objective: "Preview callback routing without credentials.",
      cwd: temporary,
      concurrency: 1,
      callback,
      milestones: false,
      limits: { maxStarts: null },
      writeConflicts: "reject",
      repeats: [],
      nodes: [
        {
          id: "done",
          type: "command",
          title: "Done",
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
          retry: { maxAttempts: 1 },
          gate: "none",
          argv: ["/usr/bin/true"],
          mutates: false,
          inheritEnv: [],
          env: {},
          allowedExitCodes: [0]
        }
      ]
    }
    const secrets = [
      "short-adjacent-secret",
      "long-adjacent-secret",
      "equals-header-secret",
      "short-user",
      "short-password",
      "equals-user",
      "equals-password",
      "adjacent-query",
      "equals-query"
    ]
    try {
      await Bun.write(file, workflowSourceYaml(spec))
      const json = await capture(() => runCli(["preview", file, "--json"]))
      if (json.code !== 0) {
        throw new Error(json.output)
      }
      expect(json.code).toBe(0)
      expect(JSON.parse(json.output).preview.callback).toEqual(expected)
      const plain = await capture(() => runCli(["preview", file]))
      expect(plain.code).toBe(0)
      expect(plain.output).toContain(`Callback: ${JSON.stringify(expected)}`)
      expect(plain.output).toContain("X-Route: stable")
      expect(plain.output).toContain("action=publish")
      expect(plain.output).toContain("action=rollback")
      for (const secret of secrets) {
        expect(json.output).not.toContain(secret)
        expect(plain.output).not.toContain(secret)
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("validates source once and returns an atomic workflow and digest", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "orchestrate-validate-once-"))
    const file = path.join(temporary, "workflow.yaml")
    const left = path.join(temporary, "left")
    const right = path.join(temporary, "right")
    let leftInspections = 0
    try {
      await Bun.write(
        file,
        `name: validate-once
objective: Keep validation output coherent.
cwd: ${JSON.stringify(temporary)}
limits:
  maxStarts: null
nodes:
  - id: left
    command: [/usr/bin/true]
    mutates: true
    workspace:
      mode: shared
      writes: [${JSON.stringify(left)}]
  - id: right
    command: [/usr/bin/true]
    mutates: true
    workspace:
      mode: shared
      writes: [${JSON.stringify(right)}]
`
      )
      injectPathInspectionForTests((ancestor) => {
        if (ancestor === left && ++leftInspections > 1) {
          throw Object.assign(new Error("path identity changed after validation"), { code: "EIO" })
        }
      })

      const result = await capture(() => runCli(["validate", file, "--json"]))
      const payload = JSON.parse(result.output) as {
        readonly ok: boolean
        readonly workflow: unknown
        readonly digest: unknown
        readonly diagnostics: readonly { readonly severity: string }[]
      }
      expect(leftInspections).toBe(1)
      expect(result.code).toBe(0)
      expect(payload.ok).toBe(true)
      expect(payload.workflow).not.toBeNull()
      expect(typeof payload.digest).toBe("string")
      expect(payload.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false)
    } finally {
      injectPathInspectionForTests(null)
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("publishes the command vocabulary and the global exit table", async () => {
    const result = await capture(() => runCli(["--help"]))
    expect(result.code).toBe(0)
    expect(result.output).toContain("2  the observed run needs human attention")
    for (const command of COMMANDS) {
      expect(result.output).toContain(command)
    }
  })

  test("keeps ordinary doctor non-live and runs the billed probe only with --live", async () => {
    let calls = 0
    injectDoctorReportHookForTests(async () => ({
      ok: true,
      build: "test-build",
      checks: [{ name: "herdr", ok: true, detail: "herdr 0.7.5" }]
    }))
    injectLiveDoctorHookForTests(async () => {
      calls += 1
      return {
        ok: true,
        warning: "provider billing warning",
        runId: "20260807000000-aaaaaaaa",
        checks: [{ name: "live-probe", ok: true, detail: "bounded" }],
        artifacts: null,
        cleaned: true
      }
    })
    try {
      await capture(() => runCli(["doctor", "--json"]))
      expect(calls).toBe(0)
      const live = await capture(() => runCli(["doctor", "--live", "--json"]))
      expect(calls).toBe(1)
      expect(JSON.parse(live.output).live).toMatchObject({
        warning: "provider billing warning",
        cleaned: true
      })
      const human = await capture(() => runCli(["doctor", "--live"]))
      expect(calls).toBe(2)
      expect(
        human.output.startsWith("WARNING: This opt-in diagnostic launches Codex and Claude")
      ).toBe(true)
    } finally {
      injectLiveDoctorHookForTests(null)
      injectDoctorReportHookForTests(null)
    }
  })

  test("skips the billed probe when read-only doctor checks already fail", async () => {
    let calls = 0
    injectDoctorReportHookForTests(async () => ({
      ok: false,
      build: "test-build",
      checks: [{ name: "installed-build", ok: false, detail: "rerun orchestrate setup" }]
    }))
    injectLiveDoctorHookForTests(async () => {
      calls += 1
      throw new Error("the billed probe must not launch in a known-unhealthy install")
    })
    try {
      const skipped = await capture(() => runCli(["doctor", "--live", "--json"]))
      expect(calls).toBe(0)
      expect(skipped.code).toBe(1)
      const payload = JSON.parse(skipped.output)
      expect(payload.ok).toBe(false)
      expect(payload.liveSkipped).toBe(true)
      expect(payload.live).toBeUndefined()
      const human = await capture(() => runCli(["doctor", "--live"]))
      expect(calls).toBe(0)
      expect(human.code).toBe(1)
      expect(human.output).not.toContain("WARNING:")
      expect(human.output).toContain(
        "SKIP live-diagnostic: read-only checks failed; no billed provider work was launched."
      )
    } finally {
      injectLiveDoctorHookForTests(null)
      injectDoctorReportHookForTests(null)
    }
  })

  test("rejects steering from an owning workflow-node environment before run lookup", async () => {
    const previousContract = process.env.ORCHESTRATE_COMPLETION_CONTRACT
    const previousToken = process.env.ORCHESTRATE_NODE_TOKEN
    try {
      process.env.ORCHESTRATE_COMPLETION_CONTRACT = "/attempt/control/completion.json"
      process.env.ORCHESTRATE_NODE_TOKEN = "secret-token"
      await expect(
        runCli(["steer", "missing-run", "review", "--message", "change scope", "--json"])
      ).rejects.toThrow(
        "Workflow nodes cannot invoke steer; steering is reserved for a human caller."
      )
    } finally {
      if (previousContract === undefined) {
        delete process.env.ORCHESTRATE_COMPLETION_CONTRACT
      } else {
        process.env.ORCHESTRATE_COMPLETION_CONTRACT = previousContract
      }
      if (previousToken === undefined) {
        delete process.env.ORCHESTRATE_NODE_TOKEN
      } else {
        process.env.ORCHESTRATE_NODE_TOKEN = previousToken
      }
    }
  })

  test("derives the exact public vocabulary from one source", () => {
    expect(PUBLIC_COMMANDS).toEqual([...COMMANDS])
    expect(Object.keys(PUBLIC_COMMAND_HELP)).toEqual([...COMMANDS])
  })

  test.each([...COMMANDS])("publishes exact side-effect-free help for %s", async (command) => {
    const result = await capture(() => runCli([command, "--help"]))
    expect(result.code).toBe(0)
    expect(result.output).toBe(PUBLIC_COMMAND_HELP[command])
  })

  test("emits the exact public command set for every shell", async () => {
    for (const shell of ["fish", "zsh", "bash"]) {
      const result = await capture(() => runCli(["completion", shell, "--json"]))
      expect(result.code).toBe(0)
      const value = JSON.parse(result.output) as { shell: string; script: string }
      expect(value).toMatchObject({ shell })
      const commandLine = value.script
        .split("\n")
        .find((line) => line.includes(PUBLIC_COMMANDS.join(" ")))
      expect(commandLine).toBeDefined()
      for (const command of PUBLIC_COMMANDS) {
        expect(value.script).toMatch(new RegExp(`(?:^|[ '(])${command}(?:$|[ )'])`))
      }
    }
  })

  test("every shell queries the exact run argument for hold, release, and result nodes", async () => {
    const scripts = Object.fromEntries(
      await Promise.all(
        (["fish", "zsh", "bash"] as const).map(async (shell) => {
          const result = await capture(() => runCli(["completion", shell, "--json"]))
          return [shell, (JSON.parse(result.output) as { script: string }).script] as const
        })
      )
    )
    expect(scripts.fish).toContain("orchestrate status $w[3]")
    expect(scripts.fish).toContain("__orchestrate_at_node")
    expect(scripts.fish).not.toContain("orchestrate status $w[2]")
    const zshRun = ["$", "{words[3]}"].join("")
    const zshCommand = ["$", "{words[2]}"].join("")
    const bashRun = ["$", "{COMP_WORDS[2]}"].join("")
    const bashCommand = ["$", "{COMP_WORDS[1]}"].join("")
    expect(scripts.zsh).toContain(`orchestrate status ${zshRun}`)
    expect(scripts.zsh).not.toContain(`orchestrate status ${zshCommand}`)
    expect(scripts.bash).toContain(`orchestrate status ${bashRun}`)
    expect(scripts.bash).not.toContain(`orchestrate status ${bashCommand}`)
  })

  test("routes live run and node candidates exclusively from every documented command shape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-completion-live-"))
    try {
      const bin = path.join(root, "bin")
      await mkdir(bin)
      await Bun.write(
        path.join(bin, "orchestrate"),
        `#!/bin/sh
if [ "$1" = runs ]; then printf 'runA  running  A\nrunB  running  B\n'; exit; fi
if [ "$1" = status ]; then printf 'Nodes:\n  nodeA  running\n  nodeB  pending\n'; exit; fi
exit 1
`,
        { createPath: false }
      )
      await chmod(path.join(bin, "orchestrate"), 0o755)
      const scripts = Object.fromEntries(
        await Promise.all(
          (["fish", "zsh", "bash"] as const).map(async (shell) => {
            const result = await capture(() => runCli(["completion", shell, "--json"]))
            const file = path.join(root, `completion.${shell}`)
            await Bun.write(file, (JSON.parse(result.output) as { script: string }).script, {
              createPath: false
            })
            return [shell, file] as const
          })
        )
      )
      const environment = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
      const fish = (line: string) =>
        completionValues(
          spawnSync(
            "fish",
            ["--no-config", "-c", `source ${scripts.fish}; complete -C ${JSON.stringify(line)}`],
            { encoding: "utf8", env: environment }
          ).stdout
        )
      const bash = (words: readonly string[]) =>
        completionValues(
          spawnSync(
            "bash",
            [
              "-c",
              `source ${JSON.stringify(scripts.bash)}; COMP_WORDS=(${words.map((word) => JSON.stringify(word)).join(" ")}); COMP_CWORD=$((${words.length} - 1)); _orchestrate_complete; printf '%s\\n' "\${COMPREPLY[@]}"`
            ],
            { encoding: "utf8", env: environment }
          ).stdout
        )
      const zsh = (words: readonly string[]) =>
        completionValues(
          spawnSync(
            "zsh",
            [
              "-f",
              "-c",
              `path=(${JSON.stringify(bin)} /usr/bin /bin); export PATH; function _arguments() { :; }; function compadd() { shift; printf '%s\\n' "$@"; }; words=(${words.map((word) => JSON.stringify(word)).join(" ")}); CURRENT=${words.length}; source ${JSON.stringify(scripts.zsh)}`
            ],
            { encoding: "utf8", env: environment }
          ).stdout
        )

      for (const shape of COMMAND_COMPLETION_SHAPES) {
        const prefix =
          "subcommand" in shape
            ? ["orchestrate", shape.command, shape.subcommand]
            : ["orchestrate", shape.command]
        expect(fish(`${prefix.join(" ")} `)).toEqual(["runA", "runB"])
        expect(bash([...prefix, ""])).toEqual(["runA", "runB"])
        expect(zsh([...prefix, ""])).toEqual(["runA", "runB"])
        if (shape.nodeWord === 4) {
          expect(fish(`${prefix.join(" ")} runA `)).toEqual(["nodeA", "nodeB"])
          expect(bash([...prefix, "runA", ""])).toEqual(["nodeA", "nodeB"])
          expect(zsh([...prefix, "runA", ""])).toEqual(["nodeA", "nodeB"])
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("watch-before-scan closes deterministic status and event interleavings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-watch-before-scan-"))
    try {
      const state = path.join(root, "state.json")
      await Bun.write(state, '{"status":"running"}\n', { createPath: false })
      setWatchInstalledHookForTests(async () => {
        await Bun.write(state, '{"status":"completed"}\n', { createPath: false })
      })
      const settled = await Promise.race([
        watchBeforeScan(state, async () => {
          const value = JSON.parse(await Bun.file(state).text()) as { status: string }
          return value.status === "running" ? null : value
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("lost wakeup")), 1_000)
        )
      ])
      expect(settled).toEqual({ status: "completed" })

      const events = path.join(root, "events.json")
      await Bun.write(events, "[]\n", { createPath: false })
      const emitted: number[] = []
      setWatchInstalledHookForTests(async () => {
        await Bun.write(events, '[{"sequence":1}]\n', { createPath: false })
      })
      await Promise.race([
        watchBeforeScan(events, async () => {
          const current = JSON.parse(await Bun.file(events).text()) as Array<{
            sequence: number
          }>
          emitted.push(...current.map((event) => event.sequence))
          return current.length === 0 ? null : true
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("lost wakeup")), 1_000)
        )
      ])
      expect(emitted).toEqual([1])
    } finally {
      setWatchInstalledHookForTests(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the CLI specification contains every exact live usage shape", async () => {
    const specification = await Bun.file(
      new URL("../../references/cli-spec.md", import.meta.url)
    ).text()
    for (const help of Object.values(PUBLIC_COMMAND_HELP)) {
      for (const line of help.split("\n")) {
        const shape = line
          .trim()
          .replace(/^Usage: orchestrate /, "")
          .replace(/^orchestrate /, "")
        expect(specification).toContain(shape.replaceAll("|", "\\|"))
      }
    }
  })
})
