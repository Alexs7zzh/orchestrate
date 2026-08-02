import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type {
  AgentNode,
  AgentPermissions,
  ClaudeAgentNode,
  ClaudeSupervisorNode,
  CodexAgentNode,
  CodexSupervisorNode,
  InputSpec,
  SessionState,
  ProcessIdentity,
  SupervisorNode,
  WorkflowNode
} from "./types.js"

import { readTextIfPresent, runProcessEffect } from "./process.js"

export interface AgentExecutionRequest {
  readonly node: AgentNode | SupervisorNode
  readonly cwd: string
  readonly nodeDir: string
  readonly runDir: string
  readonly sessions: Readonly<Record<string, SessionState>>
  readonly resultPaths: Readonly<Record<string, string>>
  readonly timeoutMinutes: number | null
  readonly onSpawn: (pid: number, identity: ProcessIdentity | null) => Effect.Effect<void, Error>
  readonly supervisorSchema?: Readonly<Record<string, unknown>>
  readonly supervisorContext?: string
}

export interface AgentExecutionResult {
  readonly exitCode: number
  readonly resultText: string
  readonly sessionId: string | null
}

function quoteToml(value: string): string {
  return JSON.stringify(value)
}

// Quotes one token for a POSIX shell command line (herdr "pane run" types the
// given tokens into the pane's shell joined by spaces).
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

export function providerEnvironment(
  permissions: AgentPermissions
): Readonly<Record<string, string>> {
  const inherited = Object.fromEntries(
    permissions.inheritEnv.flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    })
  )
  return { ...inherited, ...permissions.env }
}

async function renderInputs(
  inputs: readonly InputSpec[],
  resultPaths: Readonly<Record<string, string>>
): Promise<string> {
  const sections: string[] = []
  for (const input of inputs) {
    const resultPath = resultPaths[input.from]
    if (resultPath === undefined) {
      throw new Error(`Input result for "${input.from}" is unavailable.`)
    }
    if (input.include === "path") {
      sections.push(`## ${input.as}\n${resultPath}`)
    } else {
      sections.push(`## ${input.as}\n${await readFile(resultPath, "utf8")}`)
    }
  }
  return sections.length === 0 ? "" : `\n\n# Workflow inputs\n\n${sections.join("\n\n")}`
}

// The single source of truth for what an agent-like node is sent: prompt
// frame + resolved input sections + optional supervisor context. Approval
// gates render and digest exactly this text, so it must stay shared with
// execution.
export async function renderAgentPromptText(
  node: AgentNode | SupervisorNode,
  resultPaths: Readonly<Record<string, string>>,
  supervisorContext?: string
): Promise<string> {
  const inputs = await renderInputs(node.inputs, resultPaths)
  const supervisor =
    supervisorContext === undefined
      ? ""
      : `\n\n# Adaptive supervisor context\n\n${supervisorContext}`
  return `${node.prompt}${inputs}${supervisor}`
}

async function renderPrompt(request: AgentExecutionRequest): Promise<string> {
  return renderAgentPromptText(request.node, request.resultPaths, request.supervisorContext)
}

// The fixed done-contract template appended to an interactive node's rendered
// prompt (documented verbatim in workflow-format.md). It is runtime plumbing,
// not workflow content: digests and gate approvals bind renderAgentPromptText
// output only, never this text or its one-time token.
export function interactiveContractText(args: {
  readonly runId: string
  readonly nodeId: string
  readonly resultPath: string
  readonly doneCommand: string
}): string {
  return [
    "# Orchestrate interactive-node contract",
    "",
    `This session is node "${args.nodeId}" of orchestrated workflow run ${args.runId}. It runs`,
    "interactively: a human may watch this terminal and participate at any time, and the session",
    "stays open until you signal completion as described below.",
    "",
    "When the task is complete you MUST, in this order:",
    "",
    "1. Write a concise result/handoff report for downstream workflow nodes to exactly this file:",
    `   ${args.resultPath}`,
    "2. Run exactly this command:",
    `   ${args.doneCommand} --outcome completed`,
    "",
    "If the task cannot be completed, write a report explaining why to the same file, then run the",
    "same command with --outcome failed instead.",
    "",
    "The command is rejected until the report file exists and is non-empty. Until it succeeds, the",
    "workflow keeps waiting on this node."
  ].join("\n")
}

// The absolute invocation of the orchestrate entrypoint this worker itself is
// running from, pre-quoted for a shell, so the contract never relies on PATH.
// ORCHESTRATE_BIN overrides it (tests point it at a wrapper script).
export function orchestrateBinShellTokens(): readonly string[] {
  const explicit = process.env.ORCHESTRATE_BIN
  if (explicit !== undefined && explicit.trim().length > 0) {
    return [shellQuote(explicit)]
  }
  return [process.execPath, process.argv[1] ?? ""].filter((part) => part.length > 0).map(shellQuote)
}

export interface InteractiveProviderCommand {
  // Shell-ready tokens for `herdr pane run`; the final token substitutes the
  // prompt file's content as the TUI's initial prompt argument.
  readonly tokens: readonly string[]
  // The native session id to record for session.saveAs, known at spawn time
  // (a pinned fresh Claude UUID or the resumed source id), or null.
  readonly sessionId: string | null
}

// Maps an interactive agent node to the provider's real TUI command line,
// following the same model/effort/permission mapping the headless adapters
// use where the interactive CLIs support it. Flags that exist only headless
// (codex --ephemeral, claude --no-session-persistence and structured-output
// flags) are deliberately absent.
export function interactiveProviderCommand(
  node: AgentNode,
  promptPath: string,
  sessions: Readonly<Record<string, SessionState>>
): InteractiveProviderCommand {
  const source = sourceSession(node, sessions)
  const promptToken = `"$(cat ${shellQuote(promptPath)})"`
  if (node.provider === "codex") {
    const args: string[] =
      node.session.mode === "fresh"
        ? ["codex", "--sandbox", node.permissions.sandbox]
        : ["codex", "resume", source?.sessionId as string, "--sandbox", node.permissions.sandbox]
    // A human is present at an interactive node by definition, so escalation
    // requests must reach them even when user config sets approval_policy
    // "never" (which is correct for headless exec). extraArgs come later and
    // can still override this.
    args.push("-c", `approval_policy=${quoteToml("on-request")}`)
    if (node.model !== "provider-default") {
      args.push("--model", node.model)
    }
    if (node.effort !== null) {
      args.push("-c", `model_reasoning_effort=${quoteToml(node.effort)}`)
    }
    args.push(...node.permissions.extraArgs)
    // Interactive codex exposes no reliable native session id to record;
    // validation already rejects saveAs on interactive codex nodes.
    return { tokens: [...args.map(shellQuote), promptToken], sessionId: null }
  }
  if (node.provider === "claude") {
    const freshSessionId = randomUUID()
    const args = ["claude"]
    if (node.session.mode === "fresh") {
      args.push("--session-id", freshSessionId)
    } else if (node.session.mode === "resume") {
      args.push("--resume", source?.sessionId as string)
    } else {
      args.push("--resume", source?.sessionId as string, "--fork-session")
    }
    if (node.model !== "provider-default") {
      args.push("--model", node.model)
    }
    if (node.effort !== null) {
      args.push("--effort", node.effort)
    }
    args.push("--permission-mode", node.permissions.permissionMode)
    args.push(...node.permissions.extraArgs)
    const sessionId =
      node.session.mode === "fresh"
        ? freshSessionId
        : node.session.mode === "resume"
          ? (source?.sessionId ?? null)
          : null
    return {
      tokens: [...args.map(shellQuote), promptToken],
      sessionId: node.session.retain ? sessionId : null
    }
  }
  throw new Error(`Provider "${node.provider}" cannot run interactively.`)
}

function sourceSession(
  node: AgentNode | SupervisorNode,
  sessions: Readonly<Record<string, SessionState>>
): SessionState | null {
  if (node.session.from === null) {
    return null
  }
  const session = sessions[node.session.from]
  if (session === undefined) {
    throw new Error(`Session alias "${node.session.from}" is unavailable.`)
  }
  if (session.provider !== node.provider) {
    throw new Error(
      `Session alias "${node.session.from}" belongs to ${session.provider}, not ${node.provider}.`
    )
  }
  return session
}

function selectedTimeout(node: WorkflowNode, workflowTimeout: number | null): number | null {
  if (node.timeoutMinutes === null) {
    return workflowTimeout
  }
  if (workflowTimeout === null) {
    return node.timeoutMinutes
  }
  return Math.min(node.timeoutMinutes, workflowTimeout)
}

export function effectiveNodeTimeout(
  node: WorkflowNode,
  workflowNodeTimeout: number | null
): number | null {
  return selectedTimeout(node, workflowNodeTimeout)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function promiseEffect<A>(operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: operation, catch: asError })
}

export function executeAgentEffect(
  request: AgentExecutionRequest
): Effect.Effect<AgentExecutionResult, Error> {
  return Effect.gen(function* () {
    yield* promiseEffect(() => mkdir(request.nodeDir, { recursive: true }))
    const node = request.node
    if (node.provider === "mock") {
      return yield* promiseEffect(() => executeMock(request))
    }
    if (node.provider === "codex") {
      return yield* executeCodexEffect(request, node)
    }
    return yield* executeClaudeEffect(request, node)
  })
}

async function executeMock(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
  const prompt = await renderPrompt(request)
  const source = sourceSession(request.node, request.sessions)
  const sessionId =
    request.node.session.retain || request.node.session.saveAs !== null
      ? (source?.sessionId ?? randomUUID())
      : null
  let resultText = request.supervisorContext === undefined ? prompt : request.node.prompt
  if (request.supervisorContext !== undefined) {
    try {
      const decisions = JSON.parse(request.node.prompt) as unknown
      if (Array.isArray(decisions) && decisions.length > 0) {
        const match = request.supervisorContext.match(/Completed adaptive rounds: (\d+)/)
        const round = Number(match?.[1] ?? "0")
        resultText = JSON.stringify(decisions[Math.min(round, decisions.length - 1)], null, 2)
      }
    } catch {
      // A mock supervisor may also provide one decision as its literal prompt.
    }
  }
  await writeFile(path.join(request.nodeDir, "stdout.log"), `${resultText}\n`, { mode: 0o600 })
  await writeFile(path.join(request.nodeDir, "stderr.log"), "", { mode: 0o600 })
  return { exitCode: 0, resultText, sessionId }
}

function executeCodexEffect(
  request: AgentExecutionRequest,
  node: CodexAgentNode | CodexSupervisorNode
): Effect.Effect<AgentExecutionResult, Error> {
  return Effect.gen(function* () {
    const prompt = yield* promiseEffect(() => renderPrompt(request))
    const source = sourceSession(request.node, request.sessions)
    const resultPath = path.join(request.nodeDir, "last-message.txt")
    const outputSchema =
      request.supervisorSchema ??
      (request.node.type === "agent" && request.node.output.format === "json"
        ? request.node.output.schema
        : null)
    const schemaPath = path.join(request.nodeDir, "output-schema.json")
    if (outputSchema !== null) {
      yield* promiseEffect(() =>
        writeFile(schemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, { mode: 0o600 })
      )
    }

    const args: string[] =
      request.node.session.mode === "fresh"
        ? ["exec"]
        : ["exec", "resume", source?.sessionId as string]
    args.push("--json", "-o", resultPath)
    if (request.node.model !== "provider-default") {
      args.push("--model", request.node.model)
    }
    if (request.node.effort !== null) {
      args.push("-c", `model_reasoning_effort=${quoteToml(request.node.effort)}`)
    }
    if (node.session.mode === "fresh") {
      args.push("--sandbox", node.permissions.sandbox)
    } else {
      args.push("-c", `sandbox_mode=${quoteToml(node.permissions.sandbox)}`)
    }
    if (!request.node.session.retain) {
      args.push("--ephemeral")
    }
    if (outputSchema !== null) {
      args.push("--output-schema", schemaPath)
    }
    args.push(...request.node.permissions.extraArgs, "-")

    let sessionId = source?.sessionId ?? null
    const result = yield* runProcessEffect({
      argv: ["codex", ...args],
      cwd: request.cwd,
      stdoutPath: path.join(request.nodeDir, "stdout.log"),
      stderrPath: path.join(request.nodeDir, "stderr.log"),
      timeoutMinutes: request.timeoutMinutes,
      stdin: prompt,
      env: providerEnvironment(request.node.permissions),
      inheritEnv: false,
      onStdoutLine: (line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          const found =
            typeof event.thread_id === "string"
              ? event.thread_id
              : typeof event.session_id === "string"
                ? event.session_id
                : null
          if (found !== null) {
            sessionId = found
          }
        } catch {
          // Preserve non-JSON provider output in stdout.log; it is not a session event.
        }
      },
      onSpawn: request.onSpawn
    })
    return {
      exitCode: result.exitCode,
      resultText: yield* promiseEffect(() => readTextIfPresent(resultPath)),
      sessionId: request.node.session.retain ? sessionId : null
    }
  })
}

function executeClaudeEffect(
  request: AgentExecutionRequest,
  node: ClaudeAgentNode | ClaudeSupervisorNode
): Effect.Effect<AgentExecutionResult, Error> {
  return Effect.gen(function* () {
    const prompt = yield* promiseEffect(() => renderPrompt(request))
    const source = sourceSession(request.node, request.sessions)
    const freshSessionId = randomUUID()
    const args = ["-p", "--output-format", "stream-json", "--verbose"]
    if (request.node.session.mode === "fresh") {
      args.push("--session-id", freshSessionId)
    }
    if (request.node.session.mode === "resume") {
      args.push("--resume", source?.sessionId as string)
    } else if (request.node.session.mode === "fork") {
      args.push("--resume", source?.sessionId as string, "--fork-session")
    }
    if (request.node.model !== "provider-default") {
      args.push("--model", request.node.model)
    }
    if (request.node.effort !== null) {
      args.push("--effort", request.node.effort)
    }
    args.push("--permission-mode", node.permissions.permissionMode)
    if (!request.node.session.retain) {
      args.push("--no-session-persistence")
    }
    const outputSchema =
      request.supervisorSchema ??
      (request.node.type === "agent" && request.node.output.format === "json"
        ? request.node.output.schema
        : null)
    if (outputSchema !== null) {
      args.push("--json-schema", JSON.stringify(outputSchema))
    }
    args.push(...request.node.permissions.extraArgs)

    let sessionId: string | null = source?.sessionId ?? freshSessionId
    let resultText = ""
    const result = yield* runProcessEffect({
      argv: ["claude", ...args],
      cwd: request.cwd,
      stdoutPath: path.join(request.nodeDir, "stdout.log"),
      stderrPath: path.join(request.nodeDir, "stderr.log"),
      timeoutMinutes: request.timeoutMinutes,
      stdin: prompt,
      env: providerEnvironment(request.node.permissions),
      inheritEnv: false,
      onStdoutLine: (line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          if (typeof event.session_id === "string") {
            sessionId = event.session_id
          }
          if (event.type === "result") {
            if (typeof event.structured_output === "object" && event.structured_output !== null) {
              resultText = JSON.stringify(event.structured_output, null, 2)
            } else if (typeof event.result === "string") {
              resultText = event.result
            }
          }
        } catch {
          // Preserve non-JSON provider output in stdout.log; it is not a result event.
        }
      },
      onSpawn: request.onSpawn
    })
    return {
      exitCode: result.exitCode,
      resultText,
      sessionId: request.node.session.retain ? sessionId : null
    }
  })
}
