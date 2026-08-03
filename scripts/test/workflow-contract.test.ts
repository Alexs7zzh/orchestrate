import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

import type { AgentNode, CommandNode, WorkflowSpec } from "../src/types.js"

import { stateRoot, submissionsRoot } from "../src/state.js"
import { validateWorkflow } from "../src/validation.js"

function workspace() {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "none" as const,
    writes: [],
    exclusiveResources: []
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
    argv: ["/usr/bin/true"],
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
    prompt: `Work on ${id}.`,
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

function workflow(nodes: readonly WorkflowSpec["nodes"][number][]): WorkflowSpec {
  return {
    name: "contract-test",
    objective: "Exercise the replacement workflow contract.",
    cwd: "/tmp",
    concurrency: 3,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes,
    repeats: []
  }
}

describe("workflow contract", () => {
  test("keeps the documented JSON workflow example valid", async () => {
    const document = await readFile(
      new URL("../../references/examples.md", import.meta.url),
      "utf8"
    )
    const block = document.match(/```json\n([\s\S]*?)\n```/)?.[1]
    expect(block).toBeDefined()
    expect(
      validateWorkflow(JSON.parse(block as string) as unknown).issues.filter(
        (issue) => issue.severity === "error"
      )
    ).toEqual([])
  })

  test("accepts the contract and rejects unknown fields", () => {
    expect(validateWorkflow(workflow([command("check")])).workflow).not.toBeNull()

    for (const unknown of [
      { unexpectedRoot: true },
      { unexpectedNode: true },
      { extraNodeSetting: 5 }
    ]) {
      const raw = structuredClone(workflow([command("check")])) as unknown as Record<
        string,
        unknown
      >
      if ("unexpectedNode" in unknown || "extraNodeSetting" in unknown) {
        Object.assign(
          (raw.nodes as Record<string, unknown>[])[0] as Record<string, unknown>,
          unknown
        )
      } else {
        Object.assign(raw, unknown)
      }
      const result = validateWorkflow(raw)
      expect(result.workflow).toBeNull()
      expect(result.digest).toBeNull()
    }
  })

  test("rejects malformed and unsupported webhook callback URLs before approval", () => {
    for (const url of ["not a url", "file:///tmp/callback", "ftp://example.invalid/hook"]) {
      const result = validateWorkflow({
        ...workflow([command("check")]),
        callback: { type: "webhook", url, headers: {}, timeoutSeconds: 10 }
      })
      expect(result.workflow).toBeNull()
      expect(result.issues.some((issue) => issue.code === "callback-url")).toBe(true)
    }
  })

  test("reports every independent Effect schema problem in one validation pass", () => {
    const result = validateWorkflow({})
    expect(result.workflow).toBeNull()
    expect(result.issues.length).toBeGreaterThan(5)
    const messages = result.issues.map((issue) => issue.message).join("\n")
    expect(messages).toContain("name")
    expect(messages).toContain("objective")
    expect(messages).toContain("nodes")
  })

  test("enforces public node-id, path, pointer, and environment-name constraints in Effect Schema", () => {
    const invalid = workflow([
      command("Bad_ID", {
        cwd: "relative/path",
        inheritEnv: ["INVALID-NAME"]
      })
    ])
    const result = validateWorkflow(invalid)
    expect(result.workflow).toBeNull()
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["node-id", "node-cwd", "environment-name"])
    )
    const pointer = validateWorkflow({
      ...workflow([command("check")]),
      repeats: [
        {
          id: "loop",
          members: ["check"],
          until: { type: "agent-output", node: "check", pointer: "not-a-pointer", equals: true },
          maxRounds: 2
        }
      ]
    })
    expect(pointer.issues.map((issue) => issue.code)).toContain("repeat-until")
  })

  test("supports captured Codex resume and fork lineage", () => {
    const source = agent("source", {
      session: { mode: "fresh", from: null, saveAs: "source-session" }
    })
    const resumed = agent("resume", {
      needs: ["source"],
      session: { mode: "resume", from: "source-session", saveAs: "resumed-session" }
    })
    const forked = agent("fork", {
      needs: ["resume"],
      session: { mode: "fork", from: "resumed-session", saveAs: "forked-session" }
    })
    expect(validateWorkflow(workflow([source, resumed, forked])).issues).toEqual([])
  })

  test("separates execution from escalation and rejects incoherent Claude modes", () => {
    const claude = {
      ...agent("claude-review"),
      provider: "claude" as const,
      workspace: { ...workspace(), writes: ["review-result/**"] },
      permissions: {
        execution: { permissionMode: "dontAsk" as const },
        escalation: "deny" as const,
        extraArgs: [],
        inheritEnv: [],
        env: {}
      }
    }
    expect(validateWorkflow(workflow([claude])).issues).toEqual([])
    const invalid = {
      ...claude,
      permissions: { ...claude.permissions, escalation: "ask-user" as const }
    }
    expect(validateWorkflow(workflow([invalid])).issues.map((issue) => issue.code)).toContain(
      "permission-escalation"
    )
  })

  test("rejects unconfined Claude modes and every caller-controlled permission surface", () => {
    const base = {
      ...agent("claude-review"),
      provider: "claude" as const,
      workspace: { ...workspace(), writes: ["src/**"] },
      permissions: {
        execution: { permissionMode: "dontAsk" as const },
        escalation: "deny" as const,
        extraArgs: [],
        inheritEnv: [],
        env: {}
      }
    }
    const bypass = {
      ...base,
      permissions: {
        ...base.permissions,
        execution: { permissionMode: "bypassPermissions" as const }
      }
    }
    expect(validateWorkflow(workflow([bypass])).issues.map((issue) => issue.code)).toContain(
      "unsupported-permission-mode"
    )
    for (const extraArgs of [
      ["--allowedTools", "Edit(/**)"],
      ["--disallowedTools", "Read"],
      ["--tools", "default"],
      ["--settings", '{"sandbox":{"enabled":false}}'],
      ["--add-dir", "/"]
    ]) {
      const adversary = {
        ...base,
        permissions: { ...base.permissions, extraArgs }
      }
      expect(validateWorkflow(workflow([adversary])).issues.map((issue) => issue.code)).toContain(
        "reserved-provider-argument"
      )
    }
  })

  test("rejects mutating Codex and Claude authority overlap through every effective root and write prefix", () => {
    const saved = {
      home: process.env.HOME,
      state: process.env.ORCHESTRATE_STATE_DIR,
      xdg: process.env.XDG_STATE_HOME,
      bin: process.env.ORCHESTRATE_BIN
    }
    process.env.HOME = "/tmp/orchestrate-authority-home"
    delete process.env.XDG_STATE_HOME
    delete process.env.ORCHESTRATE_STATE_DIR
    process.env.ORCHESTRATE_BIN =
      "/tmp/orchestrate-authority-home/.local/share/orchestrate/current/bin/orchestrate"
    try {
      const codex = agent("codex-write", {
        workspace: { ...workspace(), writes: ["src/**"] },
        permissions: {
          execution: { sandbox: "workspace-write" },
          escalation: "deny",
          extraArgs: [],
          inheritEnv: [],
          env: {}
        }
      })
      const claude = {
        ...agent("claude-write"),
        provider: "claude" as const,
        workspace: { ...workspace(), writes: ["src/**"] },
        permissions: {
          execution: { permissionMode: "bypassPermissions" as const },
          escalation: "deny" as const,
          extraArgs: [],
          inheritEnv: [],
          env: {}
        }
      }
      const claudeDontAsk = {
        ...claude,
        permissions: {
          ...claude.permissions,
          execution: { permissionMode: "dontAsk" as const }
        }
      }
      const protectedPaths = [
        stateRoot(),
        path.dirname(stateRoot()),
        path.join(stateRoot(), "runs", "20260803000000-aaaaaaaa"),
        "/tmp/orchestrate-authority-home/.local/share/orchestrate/current",
        "/tmp/orchestrate-authority-home/.codex/skills/orchestrate"
      ]
      for (const root of protectedPaths) {
        expect(
          validateWorkflow({ ...workflow([{ ...codex, cwd: root }]), cwd: "/tmp/safe" }).issues.map(
            (issue) => issue.code
          )
        ).toContain("protected-path")
        expect(
          validateWorkflow({
            ...workflow([{ ...claude, workspace: { ...claude.workspace, path: root } }]),
            cwd: "/tmp/safe"
          }).issues.map((issue) => issue.code)
        ).toContain("protected-path")
        expect(
          validateWorkflow({
            ...workflow([
              { ...claudeDontAsk, workspace: { ...claudeDontAsk.workspace, path: root } }
            ]),
            cwd: "/tmp/safe"
          }).issues.map((issue) => issue.code)
        ).toContain("protected-path")
      }
      expect(
        validateWorkflow({
          ...workflow([codex]),
          cwd: stateRoot()
        }).issues.map((issue) => issue.code)
      ).toContain("protected-path")

      process.env.ORCHESTRATE_STATE_DIR = "/tmp/custom-orchestrate-state"
      expect(
        validateWorkflow({
          ...workflow([
            {
              ...codex,
              workspace: {
                ...codex.workspace,
                path: "/tmp/safe-workspace",
                writes: [path.join(submissionsRoot(), "*", "**")]
              }
            }
          ]),
          cwd: "/tmp/safe"
        }).issues.map((issue) => issue.code)
      ).toContain("protected-path")

      const readOnly = agent("read-only", {
        cwd: "/tmp/custom-orchestrate-state",
        workspace: { ...workspace(), writes: [] }
      })
      expect(validateWorkflow({ ...workflow([readOnly]), cwd: "/tmp/safe" }).issues).toEqual([])
    } finally {
      if (saved.home === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = saved.home
      }
      if (saved.state === undefined) {
        delete process.env.ORCHESTRATE_STATE_DIR
      } else {
        process.env.ORCHESTRATE_STATE_DIR = saved.state
      }
      if (saved.xdg === undefined) {
        delete process.env.XDG_STATE_HOME
      } else {
        process.env.XDG_STATE_HOME = saved.xdg
      }
      if (saved.bin === undefined) {
        delete process.env.ORCHESTRATE_BIN
      } else {
        process.env.ORCHESTRATE_BIN = saved.bin
      }
    }
  })

  test("rejects empty aliases and unordered mutable session fanout", () => {
    const emptyAlias = structuredClone(workflow([agent("empty")])) as unknown as {
      nodes: Array<{ session: { saveAs: string } }>
    }
    emptyAlias.nodes[0]!.session.saveAs = ""
    expect(validateWorkflow(emptyAlias).digest).toBeNull()

    const source = agent("source", {
      session: { mode: "fresh", from: null, saveAs: "shared-session" }
    })
    const left = agent("left", {
      needs: ["source"],
      session: { mode: "resume", from: "shared-session", saveAs: null }
    })
    const right = agent("right", {
      needs: ["source"],
      session: { mode: "resume", from: "shared-session", saveAs: null }
    })
    expect(
      validateWorkflow(workflow([source, left, right])).issues.map((issue) => issue.code)
    ).toContain("session-fanout")
  })

  test("reports a cyclic session graph without recursing", () => {
    const left = agent("left", {
      needs: ["right"],
      session: { mode: "resume", from: "right-session", saveAs: "left-session" }
    })
    const right = agent("right", {
      needs: ["left"],
      session: { mode: "resume", from: "left-session", saveAs: "right-session" }
    })
    const result = validateWorkflow(workflow([left, right]))
    expect(result.digest).toBeNull()
    expect(result.issues.map((issue) => issue.code)).toContain("cycle")
  })

  test("reserves the runtime round suffix", () => {
    const result = validateWorkflow(workflow([command("review--r2")]))
    expect(result.issues.map((issue) => issue.code)).toContain("node-id")
    expect(result.digest).toBeNull()
  })

  test("accepts a fixed repeat with explicit previous-round input", () => {
    const implement = agent("implement", {
      inputs: [{ from: "review", as: "Previous review", include: "content", round: "previous" }]
    })
    const review = agent("review", {
      needs: ["implement"],
      gate: "approval",
      output: {
        format: "json",
        schema: {
          type: "object",
          properties: { clean: { type: "boolean" } },
          required: ["clean"],
          additionalProperties: false
        }
      }
    })
    const spec = {
      ...workflow([implement, review]),
      repeats: [
        {
          id: "review-loop",
          members: ["implement", "review"],
          until: { type: "agent-output" as const, node: "review", pointer: "/clean", equals: true },
          maxRounds: 4
        }
      ]
    }
    expect(validateWorkflow(spec).issues).toEqual([])
  })

  test("allows an outside consumer to bind the final repeat result", () => {
    const check = command("check", { allowedExitCodes: [2] })
    const summarize = agent("summarize", {
      needs: ["check"],
      inputs: [{ from: "check", as: "Final check", include: "content", round: "current" }]
    })
    const spec = {
      ...workflow([check, summarize]),
      repeats: [
        {
          id: "check-loop",
          members: ["check"],
          until: { type: "command-success" as const, node: "check" },
          maxRounds: 3
        }
      ]
    }
    expect(validateWorkflow(spec).issues).toEqual([])
  })

  test("rejects cross-loop previous inputs and non-fresh loop sessions", () => {
    const first = agent("first", {
      session: { mode: "resume", from: "outside-session", saveAs: null },
      inputs: [{ from: "other", as: "Other", include: "content", round: "previous" }]
    })
    const other = agent("other")
    const spec = {
      ...workflow([first, other]),
      repeats: [
        {
          id: "first-loop",
          members: ["first"],
          until: { type: "agent-output" as const, node: "first", pointer: "/clean", equals: true },
          maxRounds: 2
        },
        {
          id: "other-loop",
          members: ["other"],
          until: { type: "agent-output" as const, node: "other", pointer: "/clean", equals: true },
          maxRounds: 2
        }
      ]
    }
    const codes = validateWorkflow(spec).issues.map((issue) => issue.code)
    expect(codes).toContain("repeat-session")
    expect(codes).toContain("input-round")
  })

  test("accepts composed verdict schemas and rejects an invalid JSON pointer", () => {
    const review = agent("review", {
      output: {
        format: "json",
        schema: {
          allOf: [
            {
              type: "object",
              properties: { clean: { type: "boolean" } },
              required: ["clean"]
            }
          ]
        }
      }
    })
    const base = workflow([review])
    const repeat = {
      id: "review-loop",
      members: ["review"],
      until: { type: "agent-output" as const, node: "review", pointer: "/clean", equals: true },
      maxRounds: 2
    }
    expect(validateWorkflow({ ...base, repeats: [repeat] }).issues).toEqual([])
    expect(
      validateWorkflow({
        ...base,
        repeats: [{ ...repeat, until: { ...repeat.until, pointer: "/bad~2escape" } }]
      }).issues.map((issue) => issue.code)
    ).toContain("repeat-until")
  })

  test("rejects a two-round Git worktree repeat without a per-instance branch token", () => {
    const check = command("check", {
      workspace: {
        mode: "git-worktree",
        path: null,
        vcs: "git",
        writes: [],
        exclusiveResources: [],
        git: {
          branch: "review/{{runId}}",
          startPoint: "HEAD",
          removeOnClean: true
        }
      }
    })
    const repeat = {
      id: "check-loop",
      members: ["check"],
      until: { type: "command-success" as const, node: "check" },
      maxRounds: 2
    }
    const invalid = validateWorkflow({ ...workflow([check]), repeats: [repeat] })
    expect(invalid.digest).toBeNull()
    expect(invalid.issues.map((issue) => issue.code)).toContain("repeat-worktree-branch")

    const fixedPath = validateWorkflow({
      ...workflow([
        command("check", {
          workspace: {
            mode: "git-worktree",
            path: "/tmp/fixed-repeat-worktree",
            vcs: "git",
            writes: [],
            exclusiveResources: [],
            git: {
              branch: "review/{{runId}}/{{nodeId}}",
              startPoint: "HEAD",
              removeOnClean: true
            }
          }
        })
      ]),
      repeats: [repeat]
    })
    expect(fixedPath.issues.map((issue) => issue.code)).toContain("repeat-worktree-path")

    const validCheck = command("check", {
      workspace: {
        mode: "git-worktree",
        path: "/tmp/check-{{nodeId}}",
        vcs: "git",
        writes: [],
        exclusiveResources: [],
        git: {
          branch: "review/{{runId}}/{{nodeId}}",
          startPoint: "HEAD",
          removeOnClean: true
        }
      }
    })
    const valid = validateWorkflow({
      ...workflow([validCheck]),
      repeats: [repeat]
    })
    expect(valid.issues).toEqual([])
  })
})
