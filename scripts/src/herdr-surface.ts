import { Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { access, mkdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { PlacementResolution } from "./placement.js"
import type {
  AgentNode,
  AttemptState,
  PaneReference,
  RunOrigin,
  RunState,
  SessionSpec,
  SpawnIntent,
  UiPreferences,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

import {
  decodeHerdrAgentInfoResponse,
  decodeHerdrErrorResponse,
  decodeHerdrPaneCurrentResponse,
  decodeHerdrPaneInfoResponse,
  decodeHerdrPaneListResponse,
  decodeHerdrTabCreatedResponse,
  decodeHerdrTabListResponse,
  decodeHerdrWorkspaceCreatedResponse,
  decodeHerdrWorkspaceListResponse
} from "./herdr-api.generated.js"
import { HERDR_SCHEMA_BASELINE_VERSION, MINIMUM_HERDR_VERSION } from "./herdr-contract.js"
import { NodeDoneSubmissionSchema, SpawnReceiptSchema } from "./schema.js"
import {
  atomicWriteFile,
  atomicWriteJson,
  completionSubmissionPath,
  readRunState,
  readWorkflow,
  runDirectory,
  stateRoot,
  submissionRunDirectory,
  submissionsRoot
} from "./state.js"
import {
  assertProviderAuthorityIsolation,
  isMutatingProviderNode,
  normalizedStaticPrefix,
  orchestrateAuthorityPaths,
  resolveThroughExistingAncestor
} from "./validation.js"
import { seatSpecFor, templateForRuntimeNode } from "./workflow-lookup.js"

declare const ORCHESTRATE_BUILD_EMBEDDED: string

const STDERR_LIMIT = 8_192
const AGENT_PANE_READY_TIMEOUT_MS = 5_000
const AGENT_PANE_READY_POLL_MS = 50
const AGENT_START_TIMEOUT_MS = 120_000
const AGENT_SESSION_TIMEOUT_MS = 30_000
const AGENT_SESSION_POLL_MS = 50
// Claude's interactive boot can hold the welcome screen well past 15s; the
// prompt wait must outlast it or a healthy launch records an ambiguous spawn.
const AGENT_PROMPT_ACCEPT_TIMEOUT_MS = 60_000

const decodeNodeDoneSubmission = Schema.decodeUnknownOption(NodeDoneSubmissionSchema)
const decodeSpawnReceipt = Schema.decodeUnknownOption(SpawnReceiptSchema)

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class HerdrCommandError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "HerdrCommandError"
    this.code = code
  }
}

function decodeHerdrFailure(
  stderr: string
): { readonly code: string; readonly message: string } | null {
  for (const line of stderr.trim().split("\n").toReversed()) {
    try {
      const decoded = Option.getOrNull(decodeHerdrErrorResponse(JSON.parse(line) as unknown))
      if (decoded !== null) {
        return decoded.error
      }
    } catch {
      // Continue through any diagnostic lines surrounding the JSON envelope.
    }
  }
  return null
}

function isHerdrErrorCode(error: unknown, code: string): boolean {
  return error instanceof HerdrCommandError && error.code === code
}

function isPaneNotFound(error: unknown): boolean {
  return isHerdrErrorCode(error, "pane_not_found")
}

export class HerdrObservationError extends Error {
  readonly requiresAttention: boolean

  constructor(message: string, cause: unknown, requiresAttention = false) {
    super(message, { cause })
    this.name = "HerdrObservationError"
    this.requiresAttention = requiresAttention
  }
}

export async function runHerdr(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("herdr", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-STDERR_LIMIT)
    })
    child.on("error", (error) => {
      reject(error)
    })
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      const trimmed = stderr.trim()
      const decoded = decodeHerdrFailure(trimmed)
      const detail = trimmed.length > 0 ? `: ${trimmed}` : ""
      reject(
        new HerdrCommandError(
          `herdr ${args.slice(0, 2).join(" ")} ${signal === null ? `exited ${code}` : `was killed by ${signal}`}${detail}`,
          decoded?.code ?? null
        )
      )
    })
  })
}

function decodeHerdrJson<A>(
  stdout: string,
  operation: string,
  decode: (value: unknown) => Option.Option<A>
): A {
  try {
    const decoded = Option.getOrNull(decode(JSON.parse(stdout) as unknown))
    if (decoded !== null) {
      return decoded
    }
  } catch {
    // Report one bounded error below.
  }
  throw new Error(`herdr ${operation} returned invalid JSON.`)
}

function semverParts(value: string): readonly [number, number, number] | null {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/)
  return match === null ? null : ([Number(match[1]), Number(match[2]), Number(match[3])] as const)
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number]
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if ((actual[index] as number) > (minimum[index] as number)) {
      return true
    }
    if ((actual[index] as number) < (minimum[index] as number)) {
      return false
    }
  }
  return true
}

export async function requireHerdr(): Promise<string> {
  const output = (await runHerdr(["--version"])).trim()
  const parsed = semverParts(output)
  if (parsed === null || !versionAtLeast(parsed, MINIMUM_HERDR_VERSION)) {
    throw new Error(
      `orchestrate requires herdr ${HERDR_SCHEMA_BASELINE_VERSION} or newer; found "${output}".`
    )
  }
  return output
}

function inheritedEnvironment(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    })
  )
}

function nodeEnvironment(node: WorkflowNode): Record<string, string> {
  return node.type === "agent"
    ? {
        ...inheritedEnvironment(node.permissions.inheritEnv),
        ...node.permissions.env
      }
    : { ...inheritedEnvironment(node.inheritEnv), ...node.env }
}

function workspacePath(workflow: WorkflowSpec, node: WorkflowNode): string {
  return node.workspace.path ?? node.cwd ?? workflow.cwd
}

async function runProcess(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    let spawnError: Error | null = null
    child.once("error", (error) => {
      spawnError = error
    })
    child.once("close", (code) => {
      if (spawnError !== null) {
        reject(spawnError)
      } else if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr.trim()}`))
      }
    })
  })
}

function expandWorktreeValue(value: string, state: RunState, runtimeId: string): string {
  return value.replaceAll("{{runId}}", state.id).replaceAll("{{nodeId}}", runtimeId)
}

export function workflowWorktreePath(
  state: RunState,
  runtimeId: string,
  node: WorkflowNode
): string {
  return node.workspace.mode === "git-worktree" && node.workspace.path !== null
    ? expandWorktreeValue(node.workspace.path, state, runtimeId)
    : path.join(
        os.tmpdir(),
        "orchestrate-worktrees",
        state.id,
        runtimeId.replaceAll(/[^A-Za-z0-9._-]/g, "-")
      )
}

async function prepareWorkspace(
  workflow: WorkflowSpec,
  state: RunState,
  runtimeId: string,
  node: WorkflowNode
): Promise<string> {
  if (node.workspace.mode !== "git-worktree") {
    return realpathSync.native(workspacePath(workflow, node))
  }
  const target = workflowWorktreePath(state, runtimeId, node)
  const branch = expandWorktreeValue(node.workspace.git.branch, state, runtimeId)
  if (
    await access(target).then(
      () => true,
      () => false
    )
  ) {
    return verifyExistingWorktree(workflow.cwd, target, branch)
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const exists = await runProcess("git", [
    "-C",
    workflow.cwd,
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`
  ]).then(
    () => true,
    () => false
  )
  await runProcess(
    "git",
    exists
      ? ["-C", workflow.cwd, "worktree", "add", target, branch]
      : ["-C", workflow.cwd, "worktree", "add", "-b", branch, target, node.workspace.git.startPoint]
  )
  return verifyExistingWorktree(workflow.cwd, target, branch)
}

async function gitPath(cwd: string, ...args: readonly string[]): Promise<string> {
  return path.resolve((await runProcess("git", ["-C", cwd, ...args])).trim())
}

async function verifyExistingWorktree(
  repositoryCwd: string,
  target: string,
  expectedBranch: string
): Promise<string> {
  const resolvedTarget = realpathSync.native(target)
  let repositoryCommon: string
  let targetCommon: string
  let targetTop: string
  let targetBranch: string
  try {
    ;[repositoryCommon, targetCommon, targetTop, targetBranch] = await Promise.all([
      gitPath(repositoryCwd, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      gitPath(resolvedTarget, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      gitPath(resolvedTarget, "rev-parse", "--show-toplevel"),
      runProcess("git", ["-C", resolvedTarget, "branch", "--show-current"]).then((value) =>
        value.trim()
      )
    ])
  } catch (error) {
    throw new Error(`Existing worktree target "${target}" is not a valid Git worktree.`, {
      cause: error
    })
  }
  if (realpathSync.native(targetTop) !== resolvedTarget) {
    throw new Error(`Existing worktree target "${target}" is not its Git worktree root.`)
  }
  if (realpathSync.native(repositoryCommon) !== realpathSync.native(targetCommon)) {
    throw new Error(`Existing worktree target "${target}" belongs to a different repository.`)
  }
  if (targetBranch !== expectedBranch) {
    throw new Error(
      `Existing worktree target "${target}" is on branch "${targetBranch}", expected "${expectedBranch}".`
    )
  }
  return resolvedTarget
}

function providerWriteRoots(node: WorkflowNode, sourceRoot: string): readonly string[] {
  if (!isMutatingProviderNode(node)) {
    return []
  }
  return node.workspace.writes.map((pattern) => {
    const unresolved = path.resolve(sourceRoot, normalizedStaticPrefix(pattern))
    const resolved = resolveThroughExistingAncestor(unresolved)
    if (resolved !== unresolved) {
      throw new Error(
        `Mutating provider node "${node.id}" write prefix ${JSON.stringify(pattern)} contains a symlink component; use the canonical target.`
      )
    }
    return resolved
  })
}

function stableProviderRoot(workflow: WorkflowSpec, node: WorkflowNode, candidate: string): string {
  const resolved = realpathSync.native(candidate)
  if (isMutatingProviderNode(node)) {
    for (let cursor = resolved; ; cursor = path.dirname(cursor)) {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(
          `Mutating provider node "${node.id}" root "${resolved}" contains a symlink component.`
        )
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) {
        break
      }
    }
    providerWriteRoots(node, resolved)
  }
  assertProviderAuthorityIsolation(workflow, node, resolved)
  return resolved
}

let beforeProviderBoundaryForTests: (() => void | Promise<void>) | null = null
let afterAgentPromptForTests: (() => void | Promise<void>) | null = null

export function injectBeforeProviderBoundaryForTests(
  hook: (() => void | Promise<void>) | null
): void {
  if (typeof ORCHESTRATE_BUILD_EMBEDDED === "string") {
    throw new TypeError("Provider-boundary injection is unavailable in embedded production builds.")
  }
  beforeProviderBoundaryForTests = hook
}

export function injectAfterAgentPromptForTests(hook: (() => void | Promise<void>) | null): void {
  if (typeof ORCHESTRATE_BUILD_EMBEDDED === "string") {
    throw new TypeError("Prompt-delivery injection is unavailable in embedded production builds.")
  }
  afterAgentPromptForTests = hook
}

export async function removeWorkflowWorktrees(
  workflow: WorkflowSpec,
  state: RunState
): Promise<readonly string[]> {
  const removed: string[] = []
  for (const runtime of Object.values(state.nodes)) {
    const node = templateForRuntimeNode(workflow, state, runtime.id)
    if (node.workspace.mode !== "git-worktree" || !node.workspace.git.removeOnClean) {
      continue
    }
    const target = workflowWorktreePath(state, runtime.id, node)
    if (
      !(await access(target).then(
        () => true,
        () => false
      ))
    ) {
      continue
    }
    const expectedBranch = expandWorktreeValue(node.workspace.git.branch, state, runtime.id)
    const verifiedTarget = await verifyExistingWorktree(workflow.cwd, target, expectedBranch)
    await runProcess("git", ["-C", workflow.cwd, "worktree", "remove", verifiedTarget])
    removed.push(verifiedTarget)
  }
  return removed
}

export function orchestrateExecutable(): string {
  const invoked = process.argv[1]
  if (invoked !== undefined && path.basename(invoked).startsWith("orchestrate")) {
    return path.resolve(invoked)
  }
  if (path.basename(process.execPath).startsWith("orchestrate")) {
    return path.resolve(process.execPath)
  }
  const explicit = process.env.ORCHESTRATE_BIN?.trim()
  if (explicit !== undefined && explicit.length > 0) {
    return path.resolve(explicit)
  }
  return path.resolve(new URL("../orchestrate.mjs", import.meta.url).pathname)
}

function attemptFor(state: RunState, intent: SpawnIntent): AttemptState {
  const node = state.nodes[intent.nodeId]
  const attempt = node?.attempts.find((candidate) => candidate.attempt === intent.attempt)
  if (attempt === undefined) {
    throw new Error(`Spawn intent "${intent.id}" has no matching attempt state.`)
  }
  return attempt
}

function sourceSession(node: AgentNode, state: RunState): string | null {
  if (node.session.mode === "fresh") {
    return null
  }
  const alias = node.session.from
  const source = alias === null ? undefined : state.sessions[alias]
  if (source === undefined) {
    throw new Error(`Node "${node.id}" cannot resolve session alias "${alias ?? ""}".`)
  }
  if (source.provider !== node.provider) {
    throw new Error(`Node "${node.id}" session provider does not match its source alias.`)
  }
  return source.sessionId
}

function sessionLaunchMode(
  node: AgentNode,
  state: RunState,
  intent: SpawnIntent
): SessionSpec["mode"] {
  const runtimeNode = state.nodes[intent.nodeId]
  return runtimeNode !== undefined &&
    runtimeNode.repeatId !== null &&
    node.session.mode === "resume"
    ? "fork"
    : node.session.mode
}

function capturesProviderSession(node: AgentNode, state: RunState, intent: SpawnIntent): boolean {
  return node.session.saveAs !== null || sessionLaunchMode(node, state, intent) === "fork"
}

function codexControlProfile(paneId: string): string {
  const suffix = createHash("sha256").update(paneId).digest("hex").slice(0, 24)
  return `orchestrate-control-${suffix}`
}

function codexControlProfileDocument(
  profile: string,
  submissionDirectory: string,
  writeRoots: readonly string[]
): string {
  const filesystem = [
    [submissionsRoot(), "deny"],
    [submissionDirectory, "write"],
    ...writeRoots.map((writeRoot) => [writeRoot, "write"] as const),
    ...orchestrateAuthorityPaths()
      .filter((protectedPath) => protectedPath !== submissionsRoot())
      .map((protectedPath) => [protectedPath, "deny"] as const)
  ].map(([candidate, permission]) => `${JSON.stringify(candidate)}=${JSON.stringify(permission)}`)
  return [
    `default_permissions=${JSON.stringify(profile)}`,
    "",
    `[permissions.${JSON.stringify(profile)}]`,
    'extends=":read-only"',
    "",
    `[permissions.${JSON.stringify(profile)}.filesystem]`,
    ...filesystem,
    ""
  ].join("\n")
}

function codexProfilePath(profile: string): string {
  const configuredHome = process.env.CODEX_HOME?.trim()
  const codexHome =
    configuredHome === undefined || configuredHome.length === 0
      ? path.join(os.homedir(), ".codex")
      : path.resolve(configuredHome)
  return path.join(codexHome, `${profile}.config.toml`)
}

function claudeAbsolutePattern(directory: string): string {
  return `${path.resolve(directory)}/**`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function claudeNodeDoneRule(
  state: RunState,
  intent: SpawnIntent,
  outcome: "completed" | "failed",
  hold = false
): string {
  const command = [
    orchestrateExecutable(),
    "node-done",
    state.id,
    intent.nodeId,
    "--token",
    intent.token,
    "--outcome",
    outcome
  ]
  if (hold) {
    command.push("--hold")
  }
  return `Bash(${command.map(shellQuote).join(" ")})`
}

function codexArguments(
  node: Extract<AgentNode, { readonly provider: "codex" }>,
  source: string | null,
  profile: string,
  sessionMode: SessionSpec["mode"]
) {
  const approval = node.permissions.escalation === "deny" ? "never" : "on-request"
  const args: string[] = ["--ask-for-approval", approval, "--profile", profile]
  if (node.permissions.escalation === "auto-review") {
    args.push("--config", 'approvals_reviewer="auto_review"')
  }
  if (node.model !== "provider-default") {
    args.push("--model", node.model)
  }
  if (node.effort !== null) {
    args.push("--config", `model_reasoning_effort=${JSON.stringify(node.effort)}`)
  }
  args.push(...node.permissions.extraArgs)
  if (sessionMode === "resume") {
    args.push("resume", source as string)
  }
  if (sessionMode === "fork") {
    args.push("fork", source as string)
  }
  return args
}

// Claude sessions are project-scoped by launch directory, so every node of a
// session lineage must start from the same cwd or --resume cannot find the
// saved session. The run-shared directory lives beside the token-addressed
// submission dirs and grants no access to authoritative state or other
// completion channels.
function claudeSessionLineage(node: Extract<AgentNode, { readonly provider: "claude" }>): boolean {
  return node.session.saveAs !== null || node.session.mode !== "fresh"
}

async function claudeLineageDirectory(runId: string): Promise<string> {
  const directory = path.join(submissionRunDirectory(runId), "claude-sessions")
  await mkdir(directory, { recursive: true, mode: 0o755 })
  return realpathSync.native(directory)
}

function claudeSettingsDocument(
  node: Extract<AgentNode, { readonly provider: "claude" }>,
  state: RunState,
  intent: SpawnIntent,
  submissionDirectory: string,
  sourceRoot: string,
  lineageDirectory: string | null
): string {
  const writeRoots = providerWriteRoots(node, sourceRoot)
  const protectedPaths = orchestrateAuthorityPaths()
  const protectedWritePaths = protectedPaths.filter((candidate) => candidate !== submissionsRoot())
  const lineage = lineageDirectory === null ? [] : [lineageDirectory]
  return JSON.stringify({
    permissions: {
      allow: [
        claudeNodeDoneRule(state, intent, "completed"),
        claudeNodeDoneRule(state, intent, "completed", true),
        claudeNodeDoneRule(state, intent, "failed")
      ],
      deny: protectedWritePaths.map((candidate) => `Edit(${claudeAbsolutePattern(candidate)})`)
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowRead: [submissionDirectory, ...lineage],
        allowWrite: [...writeRoots, submissionDirectory, ...lineage],
        denyRead: protectedPaths,
        denyWrite: protectedWritePaths
      }
    }
  })
}

// The launch command is typed into a PTY whose canonical-mode input buffer
// caps a line at 1024 bytes, so all provider configuration must live in
// files; only short flags may appear on the command line itself.
function claudeArguments(
  node: Extract<AgentNode, { readonly provider: "claude" }>,
  source: string | null,
  settingsPath: string,
  sessionId: string | null,
  sessionMode: SessionSpec["mode"]
) {
  const args: string[] = [
    "--safe-mode",
    "--settings",
    settingsPath,
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Bash"
  ]
  // --safe-mode disables user hooks, including the herdr hook that reports
  // Claude session ids, so a saveAs lineage must be launcher-chosen: fresh
  // and forked sessions get an explicit id, and resume keeps the source id.
  if (sessionId !== null && sessionMode !== "resume") {
    args.push("--session-id", sessionId)
  }
  if (node.model !== "provider-default") {
    args.push("--model", node.model)
  }
  if (node.effort !== null) {
    args.push("--effort", node.effort)
  }
  if (source !== null) {
    args.push("--resume", source)
  }
  if (sessionMode === "fork") {
    args.push("--fork-session")
  }
  return args
}

async function prepareProviderLaunch(
  node: AgentNode,
  state: RunState,
  intent: SpawnIntent,
  sourceRoot: string,
  paneId: string
): Promise<{
  readonly args: readonly string[]
  readonly providerSessionId: string | null
}> {
  const source = sourceSession(node, state)
  const sessionMode = sessionLaunchMode(node, state, intent)
  const captureSession = capturesProviderSession(node, state, intent)
  const transportDirectory = path.dirname(attemptFor(state, intent).resultPath)
  if (node.provider === "claude") {
    const settingsPath = path.join(transportDirectory, "claude-settings.json")
    const lineageDirectory = claudeSessionLineage(node)
      ? await claudeLineageDirectory(state.id)
      : null
    await atomicWriteFile(
      settingsPath,
      claudeSettingsDocument(node, state, intent, transportDirectory, sourceRoot, lineageDirectory)
    )
    const sessionId = !captureSession
      ? null
      : sessionMode === "resume"
        ? (source as string)
        : randomUUID()
    return {
      args: claudeArguments(node, source, settingsPath, sessionId, sessionMode),
      providerSessionId: sessionId
    }
  }
  const profile = codexControlProfile(paneId)
  const profilePath = codexProfilePath(profile)
  await atomicWriteFile(
    profilePath,
    codexControlProfileDocument(profile, transportDirectory, providerWriteRoots(node, sourceRoot))
  )
  return {
    args: codexArguments(node, source, profile, sessionMode),
    providerSessionId: null
  }
}

const AGENT_INTERACTIVE_READY_TIMEOUT_MS = 60_000
const AGENT_INTERACTIVE_READY_POLL_MS = 250
// Prompts are pasted into the provider's ready TUI composer (raw mode, after
// waitForInteractiveReady), not the canonical-mode shell buffer, so multi-KB
// prompts deliver intact; 1.6KB+ frames are field-verified. Inline delivery
// also avoids the pointer message below, whose opaque follow-this-file shape
// can trip provider safety classifiers into a silent model downgrade.
const PROMPT_INLINE_LIMIT_BYTES = 4000
const AGENT_PROMPT_VISIBLE_TIMEOUT_MS = 6_000
const AGENT_PROMPT_VISIBLE_POLL_MS = 400

// A booting provider swallows input typed before its composer is ready, and
// boot activity can register as a working state, so a prompt can be observed
// as taken that the TUI never received. Herdr's interactive_ready flag is the
// input-readiness signal; a herdr without the field skips the wait.
async function waitForInteractiveReady(paneId: string): Promise<void> {
  const deadline = Date.now() + AGENT_INTERACTIVE_READY_TIMEOUT_MS
  for (;;) {
    const raw = JSON.parse(await runHerdr(["agent", "get", paneId])) as {
      readonly result?: { readonly agent?: { readonly interactive_ready?: unknown } }
    }
    const ready = raw.result?.agent?.interactive_ready
    if (ready !== false) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Agent pane "${paneId}" did not become interactive within ${AGENT_INTERACTIVE_READY_TIMEOUT_MS} ms.`
      )
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, AGENT_INTERACTIVE_READY_POLL_MS)
    })
  }
}

function normalizeForScreenMatch(value: string): string {
  return value.replaceAll(/\s+/g, "")
}

// The pane transcript is the only delivery proof: a provider whose composer
// is not yet listening silently drops typed input while its boot activity
// can still be observed as a working state.
async function promptVisible(paneId: string, marker: string): Promise<boolean> {
  const deadline = Date.now() + AGENT_PROMPT_VISIBLE_TIMEOUT_MS
  for (;;) {
    const screen = await runHerdr(["agent", "read", paneId, "--format", "text"]).catch(() => "")
    if (normalizeForScreenMatch(screen).includes(marker)) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, AGENT_PROMPT_VISIBLE_POLL_MS)
    })
  }
}

// --wait confirms herdr observed the agent take the prompt. Terse directives
// can finish before the launcher samples `working`, so terminal `done` and
// `blocked` states are also acceptance evidence. The state transition alone
// can still be a boot flicker, and herdr's internal stall detector fires after
// 5s of no state change regardless of the requested timeout. Delivery
// therefore counts only when this attempt's unique delivery marker appears in
// the pane transcript. A stalled call may have left a visible prompt in the
// provider composer without submitting it. Nudge that exact prompt with Enter
// and require a live state before deciding that delivery succeeded; only an
// invisible marker permits re-prompting the full text.
async function promptUntilWorking(
  paneId: string,
  prompt: string,
  deliveryMarker: string
): Promise<void> {
  const deadline = Date.now() + AGENT_PROMPT_ACCEPT_TIMEOUT_MS
  const marker = normalizeForScreenMatch(deliveryMarker)
  for (;;) {
    const remaining = Math.max(1_000, deadline - Date.now())
    try {
      await runHerdr([
        "agent",
        "prompt",
        paneId,
        prompt,
        "--wait",
        "--until",
        "working",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        String(remaining)
      ])
    } catch (error) {
      if (!isHerdrErrorCode(error, "agent_prompt_stalled") || Date.now() >= deadline) {
        throw error
      }
      if (await promptVisible(paneId, marker)) {
        await runHerdr(["agent", "send-keys", paneId, "enter"])
        await runHerdr([
          "agent",
          "wait",
          paneId,
          "--until",
          "working",
          "--until",
          "done",
          "--until",
          "blocked",
          "--timeout",
          String(Math.max(1_000, deadline - Date.now()))
        ])
        return
      }
      continue
    }
    if (await promptVisible(paneId, marker)) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`Agent pane "${paneId}" reported the prompt taken but never displayed it.`)
    }
  }
}

async function startAgentWhenShellReady(args: readonly string[]): Promise<void> {
  const deadline = Date.now() + AGENT_PANE_READY_TIMEOUT_MS
  for (;;) {
    try {
      await runHerdr(args)
      return
    } catch (error) {
      if (!isHerdrErrorCode(error, "agent_pane_busy") || Date.now() >= deadline) {
        throw error
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, AGENT_PANE_READY_POLL_MS)
      })
    }
  }
}

function providerSession(value: unknown, provider: AgentNode["provider"]): string | null {
  const details = Option.getOrNull(decodeHerdrAgentInfoResponse(value))
  const session = details?.result.agent.agent_session
  return session?.agent === provider && session.kind === "id" ? session.value : null
}

function runScopedAgentName(runId: string, nodeId: string): string {
  const scope = createHash("sha256")
    .update(runId)
    .update("\0")
    .update(nodeId)
    .digest("hex")
    .slice(0, 16)
  return `o-${nodeId.slice(0, 12)}-${scope}`
}

let agentSessionTimeoutForTests: number | null = null

export function setAgentSessionTimeoutForTests(timeoutMs: number | null): void {
  if (typeof ORCHESTRATE_BUILD_EMBEDDED === "string") {
    throw new TypeError(
      "Agent-session timeout injection is unavailable in embedded production builds."
    )
  }
  agentSessionTimeoutForTests = timeoutMs
}

async function waitForProviderSession(
  paneId: string,
  provider: AgentNode["provider"],
  nodeId: string
): Promise<string> {
  const deadline = Date.now() + (agentSessionTimeoutForTests ?? AGENT_SESSION_TIMEOUT_MS)
  for (;;) {
    const details = decodeHerdrJson(
      await runHerdr(["agent", "get", paneId]),
      "agent get",
      decodeHerdrAgentInfoResponse
    )
    const sessionId = providerSession(details, provider)
    if (sessionId !== null) {
      return sessionId
    }
    // Some providers report their session id only after they begin working
    // (Codex does), and the spawn path prompts with --until working, so a
    // live agent status must keep the poll going until the deadline.
    if (Date.now() >= deadline) {
      throw new Error(
        `herdr did not report the ${provider} session id required by session.saveAs for node "${nodeId}".`
      )
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, AGENT_SESSION_POLL_MS)
    })
  }
}

async function existingWorkspace(state: RunState): Promise<string | null> {
  for (const node of Object.values(state.nodes)) {
    for (const attempt of node.attempts.toReversed()) {
      const workspaceId = attempt.pane?.workspaceId
      if (
        workspaceId !== undefined &&
        (await runHerdr(["workspace", "get", workspaceId]).then(
          () => true,
          () => false
        ))
      ) {
        return workspaceId
      }
    }
  }
  return null
}

async function liveOriginWorkspace(state: RunState): Promise<string | null> {
  if (state.origin === null) {
    return null
  }
  return runHerdr(["pane", "get", state.origin.paneId])
    .then((raw) => {
      const workspaceId = decodeHerdrJson(raw, "pane get", decodeHerdrPaneInfoResponse).result.pane
        .workspace_id
      return workspaceId === state.origin?.workspaceId ? workspaceId : null
    })
    .catch((error: unknown) => {
      if (isPaneNotFound(error)) {
        return null
      }
      throw new HerdrObservationError("Could not verify the recorded origin pane.", error)
    })
}

function workspaceLabel(workflow: WorkflowSpec, runId: string): string {
  return `${workflow.name} ${runId}`
}

async function findWorkspace(workflow: WorkflowSpec, runId: string): Promise<string | null> {
  const listed = decodeHerdrJson(
    await runHerdr(["workspace", "list"]),
    "workspace list",
    decodeHerdrWorkspaceListResponse
  )
  for (const workspace of listed.result.workspaces) {
    if (workspace.label === workspaceLabel(workflow, runId)) {
      return workspace.workspace_id
    }
  }
  return null
}

interface CreatedWorkspace {
  readonly workspaceId: string
  readonly rootPane: PaneReference
}

async function createWorkspace(
  workflow: WorkflowSpec,
  runId: string,
  cwd: string,
  environment: Readonly<Record<string, string>>
): Promise<CreatedWorkspace> {
  const created = decodeHerdrJson(
    await runHerdr([
      "workspace",
      "create",
      "--cwd",
      cwd,
      "--label",
      workspaceLabel(workflow, runId),
      "--no-focus",
      ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`])
    ]),
    "workspace create",
    decodeHerdrWorkspaceCreatedResponse
  )
  const workspaceId = created.result.workspace.workspace_id
  return {
    workspaceId,
    rootPane: {
      workspaceId,
      tabId: created.result.tab.tab_id,
      paneId: created.result.root_pane.pane_id,
      group: workspaceLabel(workflow, runId),
      surface: "tab"
    }
  }
}

async function createTab(
  workspaceId: string,
  label: string,
  cwd: string,
  environment: Readonly<Record<string, string>>
): Promise<PaneReference> {
  const created = decodeHerdrJson(
    await runHerdr([
      "tab",
      "create",
      "--workspace",
      workspaceId,
      "--cwd",
      cwd,
      "--label",
      label,
      "--no-focus",
      ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`])
    ]),
    "tab create",
    decodeHerdrTabCreatedResponse
  )
  const paneId = created.result.root_pane.pane_id
  const tabId = created.result.tab.tab_id
  return { workspaceId, tabId, paneId, group: label, surface: "tab" }
}

async function createSplit(
  anchor: PaneReference,
  cwd: string,
  environment: Readonly<Record<string, string>>,
  group: string,
  direction: "right" | "down",
  ratio: number | null = null
): Promise<PaneReference> {
  const created = decodeHerdrJson(
    await runHerdr([
      "pane",
      "split",
      "--pane",
      anchor.paneId,
      "--direction",
      direction,
      ...(ratio === null ? [] : ["--ratio", String(ratio)]),
      "--cwd",
      cwd,
      "--no-focus",
      ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`])
    ]),
    "pane split",
    decodeHerdrPaneInfoResponse
  )
  const paneId = created.result.pane.pane_id
  const tabId = created.result.pane.tab_id
  return {
    workspaceId: anchor.workspaceId,
    tabId,
    paneId,
    group,
    surface: "split"
  }
}

// herdr `pane run` types its words into the pane's interactive shell without
// quoting, so any multi-word argument (the old inline `bash -c` trampoline,
// or a command node's own argv) is re-split by whatever shell the pane runs.
// The trampoline therefore lives in a per-attempt script file — bash parses
// the file, and the typed line stays two plain unquoted-safe tokens.
function commandFile(argv: readonly string[]): string {
  return [
    "#!/bin/bash",
    "set -o pipefail",
    `${argv.map(shellQuote).join(" ")} 2>&1 | tee "$ORCHESTRATE_OUTPUT_PATH"`,
    ["code=", "{PIPESTATUS[0]}"].join("$"),
    '"$ORCHESTRATE_BIN" node-exit "$ORCHESTRATE_RUN_ID" "$ORCHESTRATE_NODE_ID" --token "$ORCHESTRATE_NODE_TOKEN" --code "$code"',
    'exit "$code"',
    ""
  ].join("\n")
}

export interface SpawnRequest {
  readonly workflow: WorkflowSpec
  readonly state: RunState
  readonly intent: SpawnIntent
  readonly prompt: string | null
  readonly placement: PlacementResolution
}

export interface SpawnObservation {
  readonly pane: PaneReference
  readonly providerSessionId: string | null
}

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "unknown" | "done"

type SpawnReceipt = Schema.Schema.Type<typeof SpawnReceiptSchema>

function receiptPath(attempt: AttemptState): string {
  return path.join(path.dirname(attempt.outputPath), "spawn.json")
}

function promptPath(attempt: AttemptState): string {
  return path.join(path.dirname(attempt.outputPath), "prompt.txt")
}

function isSpawnReceipt(value: unknown): value is SpawnReceipt {
  return Option.isSome(decodeSpawnReceipt(value))
}

async function hasTokenValidSubmission(
  state: RunState,
  intent: SpawnIntent,
  attempt: AttemptState
): Promise<boolean> {
  const value = await readFile(completionSubmissionPath(attempt.resultPath), "utf8")
    .then((raw) => JSON.parse(raw) as unknown)
    .catch(() => null)
  const submission = Option.getOrNull(decodeNodeDoneSubmission(value))
  if (submission === null) {
    return false
  }
  return (
    submission.runId === state.id &&
    submission.nodeId === intent.nodeId &&
    submission.token === intent.token
  )
}

export class HerdrSurface {
  private workspaceId: string | null = null
  private bootstrapPane: PaneReference | null = null
  private boardCurrent: PaneReference | null | undefined

  async connect(): Promise<void> {
    await requireHerdr()
  }

  async captureOrigin(): Promise<RunOrigin | null> {
    const raw = await runHerdr(["pane", "current"])
    let decoded
    try {
      decoded = decodeHerdrJson(raw, "pane current", decodeHerdrPaneCurrentResponse)
    } catch {
      throw new HerdrObservationError("Herdr returned an invalid current-pane response.", raw)
    }
    const pane = decoded.result.pane
    if (
      (pane.agent === null || pane.agent === undefined) &&
      (pane.agent_session === null || pane.agent_session === undefined)
    ) {
      return null
    }
    if (
      (pane.agent !== "codex" && pane.agent !== "claude") ||
      pane.agent_session === null ||
      pane.agent_session === undefined ||
      pane.agent_session.kind !== "id" ||
      pane.agent_session.agent !== pane.agent
    ) {
      throw new HerdrObservationError(
        "Herdr current-pane agent and session providers do not match.",
        raw
      )
    }
    return {
      workspaceId: pane.workspace_id,
      tabId: pane.tab_id,
      paneId: pane.pane_id,
      provider: pane.agent,
      sessionId: pane.agent_session.value
    }
  }

  async promptOrigin(origin: RunOrigin, prompt: string): Promise<void> {
    const details = decodeHerdrJson(
      await runHerdr(["agent", "get", origin.paneId]),
      "agent get",
      decodeHerdrAgentInfoResponse
    )
    const sessionId = providerSession(details, origin.provider)
    if (sessionId !== origin.sessionId) {
      throw new Error("The originating herdr pane no longer hosts the launching agent session.")
    }
    await runHerdr(["agent", "prompt", origin.paneId, prompt])
  }

  private async createRunWorkspace(
    workflow: WorkflowSpec,
    runId: string,
    cwd: string,
    environment: Readonly<Record<string, string>>
  ): Promise<string> {
    const created = await createWorkspace(workflow, runId, cwd, environment)
    this.workspaceId = created.workspaceId
    this.bootstrapPane = created.rootPane
    return created.workspaceId
  }

  private async freshTab(
    workspaceId: string,
    label: string,
    cwd: string,
    environment: Readonly<Record<string, string>>,
    group: string
  ): Promise<PaneReference> {
    const bootstrap = this.bootstrapPane
    if (bootstrap !== null && bootstrap.workspaceId === workspaceId) {
      await runHerdr(["tab", "rename", bootstrap.tabId, label])
      this.bootstrapPane = null
      return { ...bootstrap, group, surface: "tab" }
    }
    return { ...(await createTab(workspaceId, label, cwd, environment)), group, surface: "tab" }
  }

  private async nodeWorkspace(
    request: SpawnRequest,
    create: boolean,
    cwd = request.workflow.cwd,
    environment: Readonly<Record<string, string>> = {}
  ): Promise<string | null> {
    if (request.placement.workspace === "origin") {
      const origin = await liveOriginWorkspace(request.state)
      if (origin !== null) {
        return origin
      }
      // A stale durable origin must never strand new panes in an abandoned
      // workspace. Fall back to the run-owned workspace instead.
      this.workspaceId ??= await findWorkspace(request.workflow, request.state.id)
    } else {
      this.workspaceId ??=
        (await existingWorkspace(request.state)) ??
        (await findWorkspace(request.workflow, request.state.id))
    }
    if (this.workspaceId === null && create) {
      return this.createRunWorkspace(request.workflow, request.state.id, cwd, environment)
    }
    return this.workspaceId
  }

  private async observedWorkroomPlacement(request: SpawnRequest): Promise<{
    readonly replacementPane: PaneReference | null
    readonly anchorPane: PaneReference | null
  }> {
    const workroom = request.placement.workroom
    if (workroom === undefined) {
      return { replacementPane: null, anchorPane: null }
    }
    const seats = workroom.seats.map((seat) => ({
      ...seat,
      pane: seat.id === workroom.seatId ? request.placement.reusePane : seat.pane
    }))
    const referenced = seats.filter(
      (seat): seat is typeof seat & { readonly pane: PaneReference } => seat.pane !== null
    )
    if (referenced.length === 0 && (workroom.workspaceId === null || workroom.tabId === null)) {
      return { replacementPane: null, anchorPane: null }
    }

    const ownerByPane = new Map<string, string>()
    for (const seat of referenced) {
      const owner = ownerByPane.get(seat.pane.paneId)
      if (owner !== undefined && owner !== seat.id) {
        throw new HerdrObservationError(
          `Workroom "${workroom.id}" records pane "${seat.pane.paneId}" for both seats "${owner}" and "${seat.id}".`,
          new Error("contradictory workroom seat ownership"),
          true
        )
      }
      ownerByPane.set(seat.pane.paneId, seat.id)
    }

    let listed
    try {
      listed = decodeHerdrJson(
        await runHerdr(["pane", "list"]),
        "pane list",
        decodeHerdrPaneListResponse
      )
    } catch (error) {
      throw new HerdrObservationError(
        `Could not verify workroom "${workroom.id}" occupancy.`,
        error
      )
    }
    const observedById = new Map(listed.result.panes.map((pane) => [pane.pane_id, pane]))
    const live = referenced.flatMap((seat) => {
      const observed = observedById.get(seat.pane.paneId)
      if (observed === undefined) {
        return []
      }
      if (
        observed.workspace_id !== seat.pane.workspaceId ||
        observed.tab_id !== seat.pane.tabId ||
        (workroom.workspaceId !== null && observed.workspace_id !== workroom.workspaceId) ||
        (workroom.tabId !== null && observed.tab_id !== workroom.tabId)
      ) {
        throw new HerdrObservationError(
          `Workroom "${workroom.id}" has contradictory live placement for seat "${seat.id}".`,
          new Error("recorded and observed workroom locations differ"),
          true
        )
      }
      return [seat]
    })
    const liveLocations = new Set(
      live.map((seat) => `${seat.pane.workspaceId}\0${seat.pane.tabId}`)
    )
    if (liveLocations.size > 1) {
      throw new HerdrObservationError(
        `Workroom "${workroom.id}" has live seats in more than one Herdr tab.`,
        new Error("contradictory workroom occupancy"),
        true
      )
    }

    if (workroom.workspaceId !== null && workroom.tabId !== null) {
      const referencedPaneIds = new Set(referenced.map((seat) => seat.pane.paneId))
      const unknownOccupant = listed.result.panes.find(
        (pane) =>
          pane.workspace_id === workroom.workspaceId &&
          pane.tab_id === workroom.tabId &&
          !referencedPaneIds.has(pane.pane_id)
      )
      if (unknownOccupant !== undefined) {
        throw new HerdrObservationError(
          `Workroom "${workroom.id}" cannot restore seat "${workroom.seatId}" because tab "${workroom.tabId}" has unowned live occupants.`,
          new Error("ambiguous workroom occupancy"),
          true
        )
      }
    }
    const target = live.find((seat) => seat.id === workroom.seatId)?.pane ?? null
    if (target !== null) {
      return { replacementPane: target, anchorPane: target }
    }
    const anchor = live.find((seat) => seat.id !== workroom.seatId)?.pane ?? null
    if (anchor !== null) {
      return { replacementPane: null, anchorPane: anchor }
    }
    return { replacementPane: null, anchorPane: null }
  }

  async spawn(request: SpawnRequest): Promise<SpawnObservation> {
    const { workflow, state, intent } = request
    const runtimeNode = state.nodes[intent.nodeId]
    const node = templateForRuntimeNode(workflow, state, intent.nodeId)
    const attempt = attemptFor(state, intent)
    const intendedCwd =
      node.workspace.mode === "git-worktree"
        ? workflowWorktreePath(state, intent.nodeId, node)
        : workspacePath(workflow, node)
    assertProviderAuthorityIsolation(workflow, node, intendedCwd)
    if (
      node.type === "agent" &&
      node.provider === "claude" &&
      (node.permissions.execution.permissionMode !== "dontAsk" ||
        node.permissions.extraArgs.length > 0)
    ) {
      throw new Error(
        `Claude node "${intent.nodeId}" must use dontAsk and launcher-owned arguments.`
      )
    }
    const preparedCwd = await prepareWorkspace(workflow, state, intent.nodeId, node)
    assertProviderAuthorityIsolation(workflow, node, preparedCwd)
    await mkdir(path.dirname(attempt.outputPath), {
      recursive: true,
      mode: 0o700
    })
    if (node.type === "agent") {
      await mkdir(path.dirname(attempt.resultPath), {
        recursive: true,
        mode: 0o700
      })
    }
    const hook = beforeProviderBoundaryForTests
    beforeProviderBoundaryForTests = null
    await hook?.()
    const currentIntendedCwd = realpathSync.native(intendedCwd)
    if (currentIntendedCwd !== preparedCwd) {
      throw new Error(
        `Provider root for node "${intent.nodeId}" changed during launch; refusing pathname reuse.`
      )
    }
    const sourceRoot = stableProviderRoot(workflow, node, preparedCwd)
    const providerCwd =
      node.type === "agent" && node.provider === "claude"
        ? node.session.saveAs !== null || node.session.mode !== "fresh"
          ? await claudeLineageDirectory(state.id)
          : realpathSync.native(path.dirname(attempt.resultPath))
        : sourceRoot
    let replacementPane: PaneReference | null = null
    let observedWorkroomAnchor: PaneReference | null = null
    if (request.placement.workroom !== undefined) {
      const observed = await this.observedWorkroomPlacement(request)
      replacementPane = observed.replacementPane
      observedWorkroomAnchor = observed.anchorPane
    } else if (request.placement.reusePane !== null) {
      try {
        if (await this.paneExists(request.placement.reusePane.paneId)) {
          replacementPane = request.placement.reusePane
        }
      } catch (error) {
        throw new HerdrObservationError(
          `Could not verify reusable pane "${request.placement.reusePane.paneId}".`,
          error
        )
      }
    }
    const environment = {
      ...nodeEnvironment(node),
      ORCHESTRATE_BIN: orchestrateExecutable(),
      ORCHESTRATE_STATE_DIR: stateRoot(),
      ORCHESTRATE_RUN_ID: state.id,
      ORCHESTRATE_NODE_ID: intent.nodeId,
      ORCHESTRATE_NODE_TOKEN: intent.token,
      ORCHESTRATE_OUTPUT_PATH: attempt.outputPath,
      ORCHESTRATE_RESULT_PATH: attempt.resultPath,
      ORCHESTRATE_SOURCE_ROOT: sourceRoot
    }
    const workspaceId =
      replacementPane?.workspaceId ??
      observedWorkroomAnchor?.workspaceId ??
      (await this.nodeWorkspace(request, true, providerCwd, environment))
    if (workspaceId === null) {
      throw new Error(`Could not resolve a workspace for node "${intent.nodeId}".`)
    }
    const splitAnchor =
      replacementPane ??
      observedWorkroomAnchor ??
      (request.placement.surface === "split" &&
      request.placement.anchorPane !== null &&
      request.placement.anchorPane.workspaceId === workspaceId
        ? request.placement.anchorPane
        : null)
    let anchorIsLive = replacementPane !== null
    if (splitAnchor !== null && replacementPane === null) {
      try {
        anchorIsLive = await this.paneExists(splitAnchor.paneId)
      } catch (error) {
        throw new HerdrObservationError(
          `Could not verify split anchor "${splitAnchor.paneId}".`,
          error
        )
      }
    }
    const freshTab = async (): Promise<PaneReference> =>
      this.freshTab(
        workspaceId,
        request.placement.groupLabel,
        providerCwd,
        environment,
        request.placement.group
      )
    let pane: PaneReference
    if (!anchorIsLive) {
      pane = await freshTab()
    } else {
      try {
        const created = await createSplit(
          splitAnchor as PaneReference,
          providerCwd,
          environment,
          replacementPane?.group ?? request.placement.group,
          request.placement.splitDirection
        )
        pane =
          replacementPane === null
            ? created
            : {
                ...created,
                group: replacementPane.group,
                surface: replacementPane.surface
              }
      } catch (error) {
        if (isPaneNotFound(error) && request.placement.workroom === undefined) {
          pane = await freshTab()
        } else if (isPaneNotFound(error)) {
          throw new HerdrObservationError(
            `Workroom "${request.placement.workroom?.id ?? "unknown"}" changed after its occupancy was verified.`,
            error,
            true
          )
        } else {
          throw new HerdrObservationError(
            `Could not split from anchor "${(splitAnchor as PaneReference).paneId}".`,
            error
          )
        }
      }
    }
    await atomicWriteJson(receiptPath(attempt), {
      status: "created",
      pane,
      providerSessionId: null,
      detail: null
    } satisfies SpawnReceipt)
    if (replacementPane !== null) {
      try {
        await this.closePane(replacementPane.paneId)
      } catch (error) {
        throw new HerdrObservationError(
          `Could not retire reusable pane "${replacementPane.paneId}" before starting its replacement.`,
          error
        )
      }
    }
    let promptMayHaveBeenAccepted = false
    let promptDeliveryConfirmed = false
    let launchSessionId: string | null = null
    try {
      const seatLabel =
        node.workroom === undefined || node.seat === undefined
          ? null
          : (seatSpecFor(workflow, node.workroom, node.seat)?.label ?? node.seat)
      await runHerdr([
        "pane",
        "rename",
        pane.paneId,
        (seatLabel === null
          ? `${intent.nodeId}: ${runtimeNode?.title ?? node.title}`
          : `${seatLabel} · ${runtimeNode?.title ?? node.title}`
        ).slice(0, 80)
      ])
      if (node.type === "command") {
        const commandPath = path.join(path.dirname(attempt.resultPath), "command.sh")
        await atomicWriteFile(commandPath, commandFile(node.argv))
        await runHerdr(["pane", "run", pane.paneId, "/bin/bash", commandPath])
        const observation = { pane, providerSessionId: null }
        await atomicWriteJson(receiptPath(attempt), {
          status: "ready",
          ...observation,
          detail: null
        } satisfies SpawnReceipt)
        return observation
      }

      const launch = await prepareProviderLaunch(node, state, intent, sourceRoot, pane.paneId)
      launchSessionId = launch.providerSessionId
      await startAgentWhenShellReady([
        "agent",
        "start",
        runScopedAgentName(state.id, intent.nodeId),
        "--kind",
        node.provider,
        "--pane",
        pane.paneId,
        "--timeout",
        String(AGENT_START_TIMEOUT_MS),
        ...(launch.args.length === 0 ? [] : ["--", ...launch.args])
      ])
      if (request.prompt === null) {
        throw new Error(`Agent node "${intent.nodeId}" has no prompt.`)
      }
      await waitForInteractiveReady(pane.paneId)
      const fullPrompt =
        node.provider === "claude"
          ? `Source workspace: ${sourceRoot}\n\n${request.prompt}`
          : request.prompt
      // Herdr types the prompt into the provider's PTY, whose canonical-mode
      // input buffer silently drops everything past 1024 bytes while the
      // provider can still flicker into an observed working state. Anything
      // over the safe budget is delivered as a short pointer to a prompt copy
      // in the attempt submission directory — the one path both provider
      // sandboxes can already read; authoritative run state stays denied.
      let prompt = fullPrompt
      if (Buffer.byteLength(fullPrompt, "utf8") > PROMPT_INLINE_LIMIT_BYTES) {
        const deliveredPromptPath = path.join(path.dirname(attempt.resultPath), "prompt.txt")
        await atomicWriteFile(deliveredPromptPath, request.prompt)
        // Provenance and visible intent matter here: a bare "read this file
        // and follow it exactly" pointing at an opaque token path matches the
        // prompt-injection silhouette and can trip provider safety classifiers
        // (observed: Fable 5 flagging the message and downgrading the model).
        prompt = `${
          node.provider === "claude" ? `Source workspace: ${sourceRoot}\n\n` : ""
        }You are a workflow agent started by this machine's orchestrate launcher. Your task briefing was too large to deliver inline, so the launcher that started this session saved it to ${deliveredPromptPath} (inside this attempt's own readable transport directory). Read that file and carry out the task it describes.`
      }
      const deliveryMarker = `orchestrate-delivery:${intent.token}`
      prompt = `${prompt}\n\n[${deliveryMarker}]`
      promptMayHaveBeenAccepted = true
      await promptUntilWorking(pane.paneId, prompt, deliveryMarker)
      promptDeliveryConfirmed = true
      const sessionId = !capturesProviderSession(node, state, intent)
        ? null
        : (launchSessionId ??
          (await waitForProviderSession(pane.paneId, node.provider, intent.nodeId)))
      const promptHook = afterAgentPromptForTests
      afterAgentPromptForTests = null
      await promptHook?.()
      const observation = { pane, providerSessionId: sessionId }
      await atomicWriteJson(receiptPath(attempt), {
        status: "ready",
        ...observation,
        detail: null
      } satisfies SpawnReceipt)
      return observation
    } catch (error) {
      if (promptMayHaveBeenAccepted) {
        // A launcher-chosen session id survives into every failure receipt so
        // recovery never needs to observe it from herdr: the id was fixed at
        // agent start, before the prompt, so even an ambiguous delivery that
        // later produces a token-valid submission ran under that id.
        await atomicWriteJson(receiptPath(attempt), {
          status: promptDeliveryConfirmed ? "session-pending" : "ambiguous",
          pane,
          providerSessionId: launchSessionId,
          detail: herdrError(error)
        } satisfies SpawnReceipt)
        throw new HerdrObservationError(
          promptDeliveryConfirmed
            ? `Session capture for node "${intent.nodeId}" is pending; its prompt was taken and the pane is preserved for reconciliation.`
            : `Prompt delivery for node "${intent.nodeId}" is ambiguous; preserving its pane for reconciliation.`,
          error
        )
      }
      await this.closePane(pane.paneId).catch(() => undefined)
      await rm(receiptPath(attempt), { force: true })
      throw error
    }
  }

  async recoverOrSpawn(request: SpawnRequest): Promise<SpawnObservation> {
    const attempt = attemptFor(request.state, request.intent)
    if (request.prompt !== null) {
      await atomicWriteFile(promptPath(attempt), request.prompt)
    }
    const recorded = await readFile(receiptPath(attempt), "utf8")
      .then((raw) => JSON.parse(raw) as unknown)
      .catch(() => null)
    if (isSpawnReceipt(recorded)) {
      let receiptPaneIsLive: boolean
      try {
        receiptPaneIsLive = await this.paneExists(recorded.pane.paneId)
      } catch (error) {
        throw new HerdrObservationError(
          `Could not verify receipt pane "${recorded.pane.paneId}".`,
          error
        )
      }
      if (receiptPaneIsLive) {
        if (recorded.status === "ready") {
          return {
            pane: recorded.pane,
            providerSessionId: recorded.providerSessionId
          }
        }
        const node = templateForRuntimeNode(request.workflow, request.state, request.intent.nodeId)
        if (
          node.type === "agent" &&
          (await hasTokenValidSubmission(request.state, request.intent, attempt))
        ) {
          // A launcher-chosen id recorded in the receipt was fixed before the
          // prompt, so a token-valid submission from that pane necessarily
          // ran under it; only Codex still observes the id from herdr.
          const sessionId = !capturesProviderSession(node, request.state, request.intent)
            ? null
            : (recorded.providerSessionId ??
              (await waitForProviderSession(
                recorded.pane.paneId,
                node.provider,
                request.intent.nodeId
              )))
          const observation = {
            pane: recorded.pane,
            providerSessionId: sessionId
          }
          await atomicWriteJson(receiptPath(attempt), {
            status: "ready",
            ...observation,
            detail: null
          } satisfies SpawnReceipt)
          return observation
        }
        if (recorded.status === "session-pending" && node.type === "agent") {
          // The receipt durably records that the prompt was observed taken;
          // only the session id capture is outstanding, so reconcile retries
          // that capture alone and never re-prompts. A launcher-chosen id in
          // the receipt promotes directly; a capture failure falls through to
          // the attention path below.
          const observation =
            !capturesProviderSession(node, request.state, request.intent) ||
            recorded.providerSessionId !== null
              ? { pane: recorded.pane, providerSessionId: recorded.providerSessionId }
              : await waitForProviderSession(
                  recorded.pane.paneId,
                  node.provider,
                  request.intent.nodeId
                ).then(
                  (sessionId) => ({ pane: recorded.pane, providerSessionId: sessionId }),
                  () => null
                )
          if (observation !== null) {
            await atomicWriteJson(receiptPath(attempt), {
              status: "ready",
              ...observation,
              detail: null
            } satisfies SpawnReceipt)
            return observation
          }
        }
        throw new HerdrObservationError(
          `Spawn for node "${request.intent.nodeId}" is ${recorded.status}; inspect pane "${recorded.pane.paneId}" and resume explicitly.`,
          new Error(recorded.detail ?? "incomplete spawn")
        )
      }
      const node = templateForRuntimeNode(request.workflow, request.state, request.intent.nodeId)
      const promptOrCommandMayHaveRun = recorded.status !== "created"
      if (promptOrCommandMayHaveRun) {
        const submitted = await hasTokenValidSubmission(request.state, request.intent, attempt)
        const hasExactSessionAttribution =
          node.type !== "agent" ||
          !capturesProviderSession(node, request.state, request.intent) ||
          recorded.providerSessionId !== null
        if (submitted && hasExactSessionAttribution) {
          return {
            pane: recorded.pane,
            providerSessionId: recorded.providerSessionId
          }
        }
        await rm(codexProfilePath(codexControlProfile(recorded.pane.paneId)), {
          force: true
        }).catch(() => undefined)
        throw new Error(
          `Spawn for node "${request.intent.nodeId}" lost pane "${recorded.pane.paneId}" after launch; failing this attempt instead of reusing its completion token.`
        )
      }
      await rm(codexProfilePath(codexControlProfile(recorded.pane.paneId)), { force: true }).catch(
        () => undefined
      )
      await rm(receiptPath(attempt), { force: true })
    }
    return this.spawn(request)
  }

  async abandonPlanned(request: SpawnRequest): Promise<void> {
    const attempt = attemptFor(request.state, request.intent)
    const recorded = await readFile(receiptPath(attempt), "utf8")
      .then((raw) => JSON.parse(raw) as unknown)
      .catch(() => null)
    if (isSpawnReceipt(recorded)) {
      await this.closePane(recorded.pane.paneId).catch(() => undefined)
      return
    }
    const workspaceId = await this.nodeWorkspace(request, false)
    if (workspaceId === null) {
      return
    }
    const listed = decodeHerdrJson(
      await runHerdr(["tab", "list", "--workspace", workspaceId]),
      "tab list",
      decodeHerdrTabListResponse
    )
    for (const tab of listed.result.tabs) {
      if (
        tab.label === request.placement.groupLabel &&
        (request.placement.surface === "tab" || request.placement.anchorPane === null)
      ) {
        await runHerdr(["tab", "close", tab.tab_id]).catch(() => undefined)
      }
    }
  }

  private async currentPane(): Promise<PaneReference | null> {
    return runHerdr(["pane", "current"])
      .then((raw) => {
        const decoded = decodeHerdrJson(raw, "pane current", decodeHerdrPaneCurrentResponse)
        const pane = decoded.result.pane
        return {
          workspaceId: pane.workspace_id,
          tabId: pane.tab_id,
          paneId: pane.pane_id,
          group: "board-launch",
          surface: "split"
        } satisfies PaneReference
      })
      .catch(() => null)
  }

  async prepareBoard(preferences: UiPreferences): Promise<string | null> {
    if (preferences.board !== "split-right") {
      return null
    }
    this.boardCurrent = await this.currentPane()
    return this.boardCurrent === null
      ? "No current herdr pane was available; the board opened in the run workspace."
      : null
  }

  async openBoard(runId: string, preferences: UiPreferences): Promise<string | null> {
    const runDir = runDirectory(runId)
    const state = await readRunState(runDir)
    const workflow = await readWorkflow(runDir)
    const command = [orchestrateExecutable(), "board", state.id]
    const current = this.boardCurrent === undefined ? await this.currentPane() : this.boardCurrent
    let degraded: string | null = null

    const freshBoardTab = async (forceRunWorkspace = false): Promise<PaneReference> => {
      let workspaceId: string
      if (!forceRunWorkspace && preferences.board === "current-workspace" && current !== null) {
        workspaceId = current.workspaceId
      } else {
        this.workspaceId ??= await findWorkspace(workflow, state.id)
        workspaceId =
          this.workspaceId ?? (await this.createRunWorkspace(workflow, state.id, workflow.cwd, {}))
      }
      return this.freshTab(workspaceId, "Board", workflow.cwd, {}, "board")
    }

    let pane: PaneReference
    if (preferences.board === "split-right" && current !== null) {
      try {
        pane = await createSplit(current, workflow.cwd, {}, "board", "right", 0.35)
      } catch (error) {
        if (!isPaneNotFound(error)) {
          throw error
        }
        degraded =
          "The launching Herdr pane disappeared before the board split opened; the board opened in the run workspace."
        pane = await freshBoardTab()
      }
    } else {
      pane = await freshBoardTab()
    }
    const startBoard = async (target: PaneReference): Promise<void> => {
      await runHerdr(["pane", "rename", target.paneId, `${workflow.name}: board`])
      await runHerdr(["pane", "run", target.paneId, ...command])
    }
    try {
      await startBoard(pane)
    } catch (error) {
      if (!isPaneNotFound(error) || degraded !== null) {
        throw error
      }
      degraded =
        "The new board pane disappeared before the board command started; the board reopened in the run workspace."
      pane = await freshBoardTab(true)
      await startBoard(pane)
    }
    return degraded
  }

  async closePane(paneId: string): Promise<void> {
    try {
      await runHerdr(["pane", "close", paneId])
    } catch (error) {
      if (!isPaneNotFound(error)) {
        throw error
      }
    }
    await rm(codexProfilePath(codexControlProfile(paneId)), { force: true }).catch(() => undefined)
  }

  async renamePane(paneId: string, label: string): Promise<void> {
    await runHerdr(["pane", "rename", paneId, label])
  }

  async paneExists(paneId: string): Promise<boolean> {
    try {
      await runHerdr(["pane", "get", paneId])
      return true
    } catch (error) {
      if (isPaneNotFound(error)) {
        return false
      }
      throw error
    }
  }

  async agentStatus(paneId: string): Promise<HerdrAgentStatus | null> {
    return runHerdr(["agent", "get", paneId])
      .then((raw) => {
        const status = decodeHerdrJson(raw, "agent get", decodeHerdrAgentInfoResponse).result.agent
          .agent_status
        return status
      })
      .catch(() => null)
  }

  async waitForAgentStatus(paneId: string, status: string, timeoutMs: number): Promise<boolean> {
    try {
      await runHerdr(["agent", "wait", paneId, "--until", status, "--timeout", String(timeoutMs)])
      return true
    } catch {
      return false
    }
  }

  async paneSnapshot(): Promise<
    ReadonlyMap<string, { readonly agentStatus: HerdrAgentStatus | null }>
  > {
    const parsed = decodeHerdrJson(
      await runHerdr(["pane", "list"]),
      "pane list",
      decodeHerdrPaneListResponse
    )
    const snapshot = new Map<string, { readonly agentStatus: HerdrAgentStatus | null }>()
    for (const pane of parsed.result.panes) {
      snapshot.set(pane.pane_id, { agentStatus: pane.agent_status })
    }
    return snapshot
  }

  async focusRuntime(type: WorkflowNode["type"], pane: PaneReference): Promise<void> {
    if (type === "agent") {
      await runHerdr(["agent", "focus", pane.paneId])
    } else {
      await runHerdr(["tab", "focus", pane.tabId])
    }
  }

  async notify(title: string, body: string, sound: "none" | "done" | "request"): Promise<void> {
    await runHerdr(["notification", "show", title, "--body", body, "--sound", sound])
  }
}

export function herdrError(error: unknown): string {
  return asError(error).message
}
