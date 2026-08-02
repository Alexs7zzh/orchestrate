import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ClaudeAgentNode, CodexAgentNode, SessionState } from "../src/types.js"

import { executeAgentEffect, type AgentExecutionRequest } from "../src/providers.js"

interface FakeCapture {
  readonly executable: string
  readonly argv: readonly string[]
  readonly stdin: string
  readonly environment: {
    readonly inherited: string | null
    readonly allowed: string | null
    readonly leaked: string | null
  }
}

let temporaryRoot = ""
let fakeBin = ""
let executionSequence = 0

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-provider-test-"))
  fakeBin = path.join(temporaryRoot, "bin")
  await mkdir(fakeBin)
  const fakeProvider = `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const argv = process.argv.slice(2)
const stdin = readFileSync(0, "utf8")
writeFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({
  executable: path.basename(process.argv[1]),
  argv,
  stdin,
  environment: {
    inherited: process.env.PROVIDER_INHERITED ?? null,
    allowed: process.env.PROVIDER_ALLOWED ?? null,
    leaked: process.env.ORCHESTRATE_PROVIDER_TEST_LEAK ?? null
  }
}))

if (path.basename(process.argv[1]) === "codex") {
  const outputIndex = argv.indexOf("-o")
  if (outputIndex < 0 || argv[outputIndex + 1] === undefined) {
    process.exit(64)
  }
  writeFileSync(argv[outputIndex + 1], process.env.FAKE_RESULT ?? "codex-result")
  process.stdout.write(JSON.stringify({ thread_id: "fake-codex-session" }) + "\\n")
} else {
  process.stdout.write(JSON.stringify({ session_id: "fake-claude-session" }) + "\\n")
  const result = process.env.FAKE_STRUCTURED === "1"
    ? { type: "result", structured_output: { status: "clean" }, result: "ignored" }
    : { type: "result", result: process.env.FAKE_RESULT ?? "claude-result" }
  process.stdout.write(JSON.stringify(result) + "\\n")
}
`
  for (const executable of ["codex", "claude"]) {
    const executablePath = path.join(fakeBin, executable)
    await writeFile(executablePath, fakeProvider)
    await chmod(executablePath, 0o755)
  }
  process.env.PROVIDER_INHERITED = "controller-value"
  process.env.ORCHESTRATE_PROVIDER_TEST_LEAK = "must-not-leak"
  executionSequence = 0
})

afterEach(async () => {
  delete process.env.PROVIDER_INHERITED
  delete process.env.ORCHESTRATE_PROVIDER_TEST_LEAK
  await rm(temporaryRoot, { recursive: true, force: true })
})

function workspace() {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "none" as const,
    writes: [],
    exclusiveResources: []
  }
}

function codexNode(overrides: Partial<CodexAgentNode> = {}): CodexAgentNode {
  return {
    id: "codex-agent",
    type: "agent",
    title: "Codex agent",
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    timeoutMinutes: null,
    retry: { maxAttempts: 1, delaySeconds: 0 },
    gate: "none",
    provider: "codex",
    model: "provider-default",
    effort: null,
    prompt: "Run the Codex task.",
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
    output: { format: "text", schema: null },
    interactive: false,
    ...overrides
  }
}

function claudeNode(overrides: Partial<ClaudeAgentNode> = {}): ClaudeAgentNode {
  return {
    id: "claude-agent",
    type: "agent",
    title: "Claude agent",
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    timeoutMinutes: null,
    retry: { maxAttempts: 1, delaySeconds: 0 },
    gate: "none",
    provider: "claude",
    model: "provider-default",
    effort: null,
    prompt: "Run the Claude task.",
    session: {
      mode: "fresh",
      from: null,
      saveAs: null,
      retain: false,
      reuseOnRepeat: false
    },
    permissions: {
      permissionMode: "plan",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
    output: { format: "text", schema: null },
    interactive: false,
    ...overrides
  }
}

async function execute(
  node: CodexAgentNode | ClaudeAgentNode,
  capturePath: string,
  sessions: Readonly<Record<string, SessionState>> = {},
  resultPaths: Readonly<Record<string, string>> = {}
) {
  executionSequence += 1
  const nodeDir = path.join(temporaryRoot, `node-${executionSequence}`)
  const environment = {
    PATH: fakeBin,
    FAKE_CAPTURE_PATH: capturePath,
    PROVIDER_ALLOWED: "allowed-value"
  }
  const request: AgentExecutionRequest = {
    node: {
      ...node,
      permissions: {
        ...node.permissions,
        inheritEnv: ["PROVIDER_INHERITED"],
        env: { ...environment, ...node.permissions.env }
      }
    } as CodexAgentNode | ClaudeAgentNode,
    cwd: temporaryRoot,
    nodeDir,
    runDir: temporaryRoot,
    sessions,
    resultPaths,
    timeoutMinutes: 1,
    onSpawn: () => Effect.succeed(undefined)
  }
  return { result: await Effect.runPromise(executeAgentEffect(request)), nodeDir }
}

async function readCapture(capturePath: string): Promise<FakeCapture> {
  return JSON.parse(await readFile(capturePath, "utf8")) as FakeCapture
}

function expectArgument(argv: readonly string[], flag: string, value: string): void {
  expect(argv.some((argument, index) => argument === flag && argv[index + 1] === value)).toBe(true)
}

describe("provider adapters with fake executables", () => {
  test("maps a fresh retained Codex request to argv, stdin, env, schema, and result files", async () => {
    const inputPath = path.join(temporaryRoot, "input.txt")
    const capturePath = path.join(temporaryRoot, "codex-capture.json")
    await writeFile(inputPath, "review evidence")
    const outputSchema = {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
      additionalProperties: false
    }
    const node = codexNode({
      model: "gpt-test",
      effort: "high",
      inputs: [{ from: "review", as: "Review", include: "content" }],
      session: {
        mode: "fresh",
        from: null,
        saveAs: "implementer",
        retain: true,
        reuseOnRepeat: false
      },
      permissions: {
        sandbox: "read-only",
        extraArgs: ["--fake-extra"],
        inheritEnv: [],
        env: {
          PROVIDER_INHERITED: "explicit-override",
          FAKE_RESULT: "codex-file-result"
        }
      },
      output: { format: "json", schema: outputSchema }
    })
    const { result, nodeDir } = await execute(node, capturePath, {}, { review: inputPath })
    const capture = await readCapture(capturePath)

    expect(result).toEqual({
      exitCode: 0,
      resultText: "codex-file-result",
      sessionId: "fake-codex-session"
    })
    expect(capture.executable).toBe("codex")
    expect(capture.argv[0]).toBe("exec")
    expect(capture.argv).toContain("--json")
    expectArgument(capture.argv, "--model", "gpt-test")
    expectArgument(capture.argv, "-c", 'model_reasoning_effort="high"')
    expectArgument(capture.argv, "--sandbox", "read-only")
    expect(capture.argv).toContain("--fake-extra")
    expect(capture.argv.at(-1)).toBe("-")
    expect(capture.argv).not.toContain("--ephemeral")
    expect(capture.stdin).toBe(
      "Run the Codex task.\n\n# Workflow inputs\n\n## Review\nreview evidence"
    )
    expect(capture.environment).toEqual({
      inherited: "explicit-override",
      allowed: "allowed-value",
      leaked: null
    })
    const schemaIndex = capture.argv.indexOf("--output-schema")
    expect(schemaIndex).toBeGreaterThan(-1)
    expect(JSON.parse(await readFile(capture.argv[schemaIndex + 1] as string, "utf8"))).toEqual(
      outputSchema
    )
    expect(capture.argv).toContain(path.join(nodeDir, "last-message.txt"))
  })

  test("maps a disposable Codex resume to the source session and config sandbox", async () => {
    const capturePath = path.join(temporaryRoot, "codex-resume-capture.json")
    const node = codexNode({
      session: {
        mode: "resume",
        from: "implementer",
        saveAs: null,
        retain: false,
        reuseOnRepeat: false
      },
      permissions: {
        sandbox: "workspace-write",
        extraArgs: [],
        inheritEnv: [],
        env: { FAKE_RESULT: "resumed-result" }
      }
    })
    const { result } = await execute(node, capturePath, {
      implementer: {
        alias: "implementer",
        provider: "codex",
        sessionId: "source-codex-session"
      }
    })
    const capture = await readCapture(capturePath)

    expect(result).toEqual({ exitCode: 0, resultText: "resumed-result", sessionId: null })
    expect(capture.argv.slice(0, 3)).toEqual(["exec", "resume", "source-codex-session"])
    expectArgument(capture.argv, "-c", 'sandbox_mode="workspace-write"')
    expect(capture.argv).toContain("--ephemeral")
    expect(capture.argv).not.toContain("--sandbox")
    expect(capture.argv).not.toContain("--model")
  })

  test("maps a fresh retained Claude request and parses structured output", async () => {
    const capturePath = path.join(temporaryRoot, "claude-capture.json")
    const outputSchema = {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"]
    }
    const node = claudeNode({
      model: "claude-test",
      effort: "high",
      session: {
        mode: "fresh",
        from: null,
        saveAs: "reviewer",
        retain: true,
        reuseOnRepeat: false
      },
      permissions: {
        permissionMode: "acceptEdits",
        extraArgs: ["--fake-extra"],
        inheritEnv: [],
        env: { FAKE_STRUCTURED: "1" }
      },
      output: { format: "json", schema: outputSchema }
    })
    const { result } = await execute(node, capturePath)
    const capture = await readCapture(capturePath)

    expect(result).toEqual({
      exitCode: 0,
      resultText: JSON.stringify({ status: "clean" }, null, 2),
      sessionId: "fake-claude-session"
    })
    expect(capture.executable).toBe("claude")
    expect(capture.argv.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"])
    const sessionIndex = capture.argv.indexOf("--session-id")
    expect(capture.argv[sessionIndex + 1]).toMatch(/^[0-9a-f-]{36}$/)
    expectArgument(capture.argv, "--model", "claude-test")
    expectArgument(capture.argv, "--effort", "high")
    expectArgument(capture.argv, "--permission-mode", "acceptEdits")
    expect(capture.argv).toContain("--fake-extra")
    expect(capture.argv).not.toContain("--no-session-persistence")
    const schemaIndex = capture.argv.indexOf("--json-schema")
    expect(JSON.parse(capture.argv[schemaIndex + 1] as string)).toEqual(outputSchema)
  })

  test("maps a disposable Claude fork and discards the emitted session", async () => {
    const capturePath = path.join(temporaryRoot, "claude-fork-capture.json")
    const node = claudeNode({
      session: {
        mode: "fork",
        from: "reviewer",
        saveAs: null,
        retain: false,
        reuseOnRepeat: false
      },
      permissions: {
        permissionMode: "plan",
        extraArgs: [],
        inheritEnv: [],
        env: { FAKE_RESULT: "fork-result" }
      }
    })
    const { result } = await execute(node, capturePath, {
      reviewer: {
        alias: "reviewer",
        provider: "claude",
        sessionId: "source-claude-session"
      }
    })
    const capture = await readCapture(capturePath)

    expect(result).toEqual({ exitCode: 0, resultText: "fork-result", sessionId: null })
    const resumeIndex = capture.argv.indexOf("--resume")
    expect(capture.argv.slice(resumeIndex, resumeIndex + 3)).toEqual([
      "--resume",
      "source-claude-session",
      "--fork-session"
    ])
    expect(capture.argv).toContain("--no-session-persistence")
    expect(capture.argv).not.toContain("--session-id")
    expect(capture.argv).not.toContain("--model")
  })
})

describe("interactive provider commands", () => {
  test("interactive codex forces on-request approvals so escalations reach the human", async () => {
    const { interactiveProviderCommand } = await import("../src/providers.js")
    const fresh = interactiveProviderCommand(
      codexNode({
        interactive: true,
        permissions: { sandbox: "workspace-write", extraArgs: [], inheritEnv: [], env: {} }
      }),
      "/tmp/prompt.txt",
      {}
    )
    expect(fresh.tokens.join(" ")).toContain(`-c 'approval_policy="on-request"'`)

    const sessions: Record<string, SessionState> = {
      "codex-sess": { alias: "codex-sess", provider: "codex", sessionId: "thread-123" }
    }
    const resumed = interactiveProviderCommand(
      codexNode({
        interactive: true,
        session: {
          mode: "resume",
          from: "codex-sess",
          saveAs: null,
          retain: true,
          reuseOnRepeat: false
        }
      }),
      "/tmp/prompt.txt",
      sessions
    )
    const line = resumed.tokens.join(" ")
    expect(line).toContain("resume thread-123")
    expect(line).toContain(`-c 'approval_policy="on-request"'`)
  })
})
