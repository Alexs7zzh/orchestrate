import { Option, Schema } from "effect"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { access, chmod, lstat, mkdir, readFile, rm } from "node:fs/promises"
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
  compileAttemptCapabilityManifest,
  ensureAttemptTrustIdentities,
  loadExistingAttemptCapabilityManifest,
  verifyAttemptTrustIdentities,
  type AttemptCapabilityManifest,
  type ProjectedInputCapability
} from "./attempt-capability.js"
import {
  projectResultBytes,
  readAuthenticatedCompletionEvidence,
  readBoundedRegularFileEvidence
} from "./completion-evidence.js"
import { resolveHandoffs } from "./handoffs.js"
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
import {
  compileWorkflowProviderLaunchIdentities,
  materializeProviderRelay,
  revalidateProviderLaunchIdentity
} from "./provider-launch.js"
import {
  compileClaudeProviderArguments,
  compileClaudeProviderPolicy,
  compileCodexProviderArguments,
  compileCodexProviderPolicy
} from "./provider-policy.js"
import { SpawnReceiptSchema } from "./schema.js"
import { claudeSessionLineageId } from "./session-lineage.js"
import {
  atomicWriteFile,
  atomicWriteJson,
  attemptCapabilityManifestPath,
  readRunState,
  readWorkflow,
  providerSessionsRoot,
  runDirectory,
  stateRoot,
  submissionInboxArtifactPath,
  submissionsRoot
} from "./state.js"
import {
  assertProviderAuthorityIsolation,
  assertWorkflowProviderLaunchIsolation,
  DeclaredPathInspectionError,
  isLauncherOwnedAgentEnvironment,
  isMutatingProviderNode,
  normalizedStaticPrefix,
  orchestrateAuthorityPolicy,
  PathInspectionError,
  launcherHomePath,
  providerControlRoot,
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

function assertAgentEnvironmentAuthority(node: AgentNode): void {
  const inherited = node.permissions.inheritEnv.find(isLauncherOwnedAgentEnvironment)
  const explicit = Object.keys(node.permissions.env).find(isLauncherOwnedAgentEnvironment)
  const reserved = inherited ?? explicit
  if (reserved !== undefined) {
    throw new Error(
      `Agent node "${node.id}" persisted launcher-owned environment variable "${reserved}"; revalidate the workflow before spawning.`
    )
  }
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
    let resolved: string
    try {
      resolved = resolveThroughExistingAncestor(unresolved)
    } catch (error) {
      if (error instanceof PathInspectionError) {
        throw new DeclaredPathInspectionError(node.id, pattern, unresolved, error)
      }
      throw error
    }
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
      let symbolic = false
      try {
        inspectProviderAncestorForTests?.(node.id, cursor)
        symbolic = lstatSync(cursor).isSymbolicLink()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          `Mutating provider node "${node.id}" could not inspect root ancestor "${cursor}"${code === undefined ? "" : ` (${code})`}: ${message}`,
          { cause: error }
        )
      }
      if (symbolic) {
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
let inspectProviderAncestorForTests: ((nodeId: string, ancestor: string) => void) | null = null
const codexProfileAdaptersByPane = new Map<string, string>()

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

export function injectProviderAncestorInspectionForTests(
  hook: ((nodeId: string, ancestor: string) => void) | null
): void {
  if (typeof ORCHESTRATE_BUILD_EMBEDDED === "string") {
    throw new TypeError("Provider-ancestor injection is unavailable in embedded production builds.")
  }
  inspectProviderAncestorForTests = hook
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
    return realpathSync.native(path.resolve(invoked))
  }
  if (path.basename(process.execPath).startsWith("orchestrate")) {
    return realpathSync.native(path.resolve(process.execPath))
  }
  const explicit = process.env.ORCHESTRATE_BIN?.trim()
  if (explicit !== undefined && explicit.length > 0) {
    return realpathSync.native(path.resolve(explicit))
  }
  return realpathSync.native(path.resolve(new URL("../orchestrate.mjs", import.meta.url).pathname))
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

function codexControlProfile(token: string): string {
  return `orchestrate-attempt-${token}`
}

export async function projectAttemptPathInputs(
  workflow: WorkflowSpec,
  state: RunState,
  runtimeNodeId: string,
  node: AgentNode,
  token: string
): Promise<readonly ProjectedInputCapability[]> {
  const projected: ProjectedInputCapability[] = []
  for (const handoff of resolveHandoffs(workflow, state, runtimeNodeId, node.inputs)) {
    const { input, inputIndex, sourceRuntimeId: sourceNodeId } = handoff
    if (input.include !== "path") {
      continue
    }
    const source = state.nodes[sourceNodeId]
    if (source?.status === "skipped") {
      throw new Error(
        `Input "${input.from}" for node "${runtimeNodeId}" requests a path from a skipped node.`
      )
    }
    if (source === undefined || source.resultPath === null) {
      throw new Error(`Input "${input.from}" for node "${runtimeNodeId}" has no completed result.`)
    }
    let evidence: Awaited<ReturnType<typeof readBoundedRegularFileEvidence>>
    if (source.type === "agent") {
      const sourceAttempt = source.attempts
        .toReversed()
        .find((candidate) => candidate.resultPath === source.resultPath)
      if (sourceAttempt === undefined) {
        throw new Error(
          `Input "${input.from}" for node "${runtimeNodeId}" has no authenticated producer attempt.`
        )
      }
      const authenticated = await readAuthenticatedCompletionEvidence({
        runId: state.id,
        nodeId: sourceNodeId,
        token: sourceAttempt.token,
        resultPath: source.resultPath
      })
      const bytes = authenticated.declaredResultBytes
      const hasher = new Bun.CryptoHasher("sha256")
      hasher.update(bytes)
      evidence = {
        bytes,
        text: authenticated.declaredResult,
        sha256: hasher.digest("hex"),
        byteLength: bytes.byteLength
      }
    } else {
      evidence = await readBoundedRegularFileEvidence(
        source.resultPath,
        `Path input from command node "${sourceNodeId}"`
      )
      if (typeof source.result !== "string" || evidence.text !== source.result) {
        throw new Error(
          `Path input from command node "${sourceNodeId}" changed after its result was committed.`
        )
      }
    }
    const destination = submissionInboxArtifactPath(
      state.id,
      runtimeNodeId,
      token,
      inputIndex,
      sourceNodeId
    )
    const copied = await projectResultBytes(
      destination,
      evidence.bytes,
      `Projected path input from node "${sourceNodeId}"`
    )
    await chmod(destination, 0o400)
    projected.push({
      inputIndex,
      sourceNodeId,
      path: destination,
      sha256: copied.sha256,
      byteLength: copied.byteLength
    })
  }
  return projected
}

function codexProfilePath(profile: string, codexHome = providerControlRoot("codex")): string {
  return path.join(codexHome, `${profile}.config.toml`)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

// Claude sessions are project-scoped by launch directory. Each canonical
// lineage therefore gets one launcher-owned project outside node submission
// transport, while resume and fork launches reuse that exact directory.
async function claudeLineageDirectory(runId: string, lineageId: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(lineageId)) {
    throw new Error(`Invalid Claude session lineage id for run "${runId}".`)
  }
  const directory = path.join(providerSessionsRoot(), runId, "claude", lineageId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  return realpathSync.native(directory)
}

export interface PreparedAttemptLaunchCapabilities {
  readonly manifest: AttemptCapabilityManifest
  readonly profile: string | null
  readonly profileAdapterPath: string | null
  readonly environment: Readonly<Record<string, string>>
}

export async function prepareAttemptLaunchCapabilities(
  workflow: WorkflowSpec,
  node: AgentNode,
  state: RunState,
  intent: SpawnIntent,
  sourceRoot: string,
  lineageDirectory: string | null
): Promise<PreparedAttemptLaunchCapabilities> {
  await Promise.all(
    [submissionsRoot(), providerSessionsRoot()].map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
    })
  )
  const trust = await ensureAttemptTrustIdentities(state.id, intent.nodeId, intent.token)
  const providerRoot = providerControlRoot(node.provider)
  const sourceRoots = [sourceRoot, ...(lineageDirectory === null ? [] : [lineageDirectory])]
  const declaredWriteRoots = [
    ...providerWriteRoots(node, sourceRoot),
    ...(lineageDirectory === null ? [] : [lineageDirectory])
  ]
  const profile = node.provider === "codex" ? codexControlProfile(intent.token) : null
  const manifestPath = attemptCapabilityManifestPath(state.id, intent.nodeId, intent.token)
  const existingManifest = await access(manifestPath).then(
    () => true,
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false
      }
      throw error
    }
  )
  if (existingManifest) {
    const loaded = await loadExistingAttemptCapabilityManifest(
      state.id,
      intent.nodeId,
      intent.token
    )
    const manifest = loaded.manifest
    if (
      manifest.attempt.attempt !== intent.attempt ||
      manifest.attempt.provider !== node.provider ||
      manifest.accessIntent !== node.permissions.access ||
      manifest.providerControlRoot !== providerRoot ||
      manifest.lineageRoot !== lineageDirectory ||
      JSON.stringify(manifest.sourceRoots) !== JSON.stringify(sourceRoots) ||
      JSON.stringify(manifest.declaredWriteRoots) !== JSON.stringify(declaredWriteRoots)
    ) {
      throw new Error("Existing attempt capability does not match the planned provider launch.")
    }
    await revalidateProviderLaunchIdentity(manifest.providerLaunch, manifest.providerRelay)
    const profileAdapterPath =
      profile === null ? null : codexProfilePath(profile, manifest.providerControlRoot)
    if (profileAdapterPath !== null) {
      const asset = manifest.policyAssets.find((candidate) => candidate.kind === "codex-profile")
      if (asset === undefined) {
        throw new Error("Codex attempt capability has no policy profile asset.")
      }
      await atomicWriteFile(profileAdapterPath, await readFile(asset.path, "utf8"), 0o600)
      await chmod(profileAdapterPath, 0o600)
    }
    return {
      manifest,
      profile,
      profileAdapterPath,
      environment: {
        PATH: manifest.providerRelay.environmentPath,
        HOME: launcherHomePath(),
        ...(node.provider === "codex"
          ? { CODEX_HOME: manifest.providerControlRoot }
          : { CLAUDE_CONFIG_DIR: manifest.providerControlRoot }),
        TMPDIR: manifest.trust.scratch.path,
        TMP: manifest.trust.scratch.path,
        TEMP: manifest.trust.scratch.path,
        ORCHESTRATE_COMPLETION_CONTRACT: manifest.completion.contractPath
      }
    }
  }
  const launchIdentities = await compileWorkflowProviderLaunchIdentities(workflow)
  assertWorkflowProviderLaunchIsolation(workflow, launchIdentities)
  const providerLaunch = launchIdentities.find((candidate) => candidate.provider === node.provider)
  if (providerLaunch === undefined) {
    throw new Error(`Provider executable "${node.provider}" is not on the launcher-owned PATH.`)
  }
  const providerRelay = await materializeProviderRelay(
    providerLaunch,
    path.join(trust.control.path, "provider-launcher")
  )
  const projectedInputs = await projectAttemptPathInputs(
    workflow,
    state,
    intent.nodeId,
    node,
    intent.token
  )
  const authority = orchestrateAuthorityPolicy()
  const manifest = await compileAttemptCapabilityManifest(
    {
      runId: state.id,
      nodeId: intent.nodeId,
      attempt: intent.attempt,
      token: intent.token,
      provider: node.provider,
      accessIntent: node.permissions.access,
      sourceRoots,
      declaredWriteRoots,
      providerControlRoot: providerRoot,
      lineageRoot: lineageDirectory,
      providerLaunch,
      providerRelay,
      unreadableRoots: authority.denyReadRoots,
      immutableRoots: authority.denyWriteRoots,
      completionExecutablePath: orchestrateExecutable(),
      projectedInputs,
      output: node.output
    },
    async (draft) =>
      node.provider === "codex"
        ? [
            {
              kind: "codex-profile" as const,
              path: path.join(draft.trust.control.path, "codex-profile.toml"),
              content: compileCodexProviderPolicy(node.permissions.access, profile as string, draft)
            }
          ]
        : [
            {
              kind: "claude-settings" as const,
              path: draft.assets.claudeSettingsPath,
              content: compileClaudeProviderPolicy(node.permissions.access, draft)
            }
          ]
  )
  const profileAdapterPath =
    profile === null ? null : codexProfilePath(profile, manifest.providerControlRoot)
  if (profileAdapterPath !== null) {
    const asset = manifest.policyAssets.find((candidate) => candidate.kind === "codex-profile")
    if (asset === undefined) {
      throw new Error("Codex attempt capability has no policy profile asset.")
    }
    await atomicWriteFile(profileAdapterPath, await readFile(asset.path, "utf8"), 0o600)
    await chmod(profileAdapterPath, 0o600)
  }
  await verifyAttemptTrustIdentities(manifest.trust)
  return {
    manifest,
    profile,
    profileAdapterPath,
    environment: {
      PATH: manifest.providerRelay.environmentPath,
      HOME: launcherHomePath(),
      ...(node.provider === "codex"
        ? { CODEX_HOME: manifest.providerControlRoot }
        : { CLAUDE_CONFIG_DIR: manifest.providerControlRoot }),
      TMPDIR: manifest.trust.scratch.path,
      TMP: manifest.trust.scratch.path,
      TEMP: manifest.trust.scratch.path,
      ORCHESTRATE_COMPLETION_CONTRACT: manifest.completion.contractPath
    }
  }
}

export async function prepareProviderLaunchArguments(
  node: AgentNode,
  state: RunState,
  intent: SpawnIntent,
  capabilities: PreparedAttemptLaunchCapabilities
): Promise<{
  readonly args: readonly string[]
  readonly providerSessionId: string | null
}> {
  const source = sourceSession(node, state)
  const sessionMode = sessionLaunchMode(node, state, intent)
  const captureSession = capturesProviderSession(node, state, intent)
  if (node.provider === "claude") {
    const sessionId = !captureSession
      ? null
      : sessionMode === "resume"
        ? (source as string)
        : randomUUID()
    return {
      args: compileClaudeProviderArguments(
        node,
        source,
        capabilities.manifest.assets.claudeSettingsPath,
        sessionId,
        sessionMode
      ),
      providerSessionId: sessionId
    }
  }
  const profile = capabilities.profile
  if (profile === null) {
    throw new TypeError("Codex attempt capability has no profile identity.")
  }
  return {
    args: compileCodexProviderArguments(node, source, profile, sessionMode),
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

async function hasValidCompletionEvidence(
  state: RunState,
  intent: SpawnIntent,
  attempt: AttemptState
): Promise<boolean> {
  return readAuthenticatedCompletionEvidence({
    runId: state.id,
    nodeId: intent.nodeId,
    token: intent.token,
    resultPath: attempt.resultPath
  }).then(
    () => true,
    () => false
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

  async inspectAgentAttempt(
    pane: PaneReference,
    provider: AgentNode["provider"],
    expectedSessionId: string | null
  ): Promise<string> {
    const observedPane = decodeHerdrJson(
      await runHerdr(["pane", "get", pane.paneId]),
      "pane get",
      decodeHerdrPaneInfoResponse
    ).result.pane
    if (
      observedPane.pane_id !== pane.paneId ||
      observedPane.workspace_id !== pane.workspaceId ||
      observedPane.tab_id !== pane.tabId
    ) {
      throw new Error("The steering target pane no longer matches the active attempt.")
    }
    const details = decodeHerdrJson(
      await runHerdr(["agent", "get", pane.paneId]),
      "agent get",
      decodeHerdrAgentInfoResponse
    )
    const sessionId = providerSession(details, provider)
    if (sessionId === null || (expectedSessionId !== null && sessionId !== expectedSessionId)) {
      throw new Error("The steering target pane no longer hosts the active provider session.")
    }
    return sessionId
  }

  async promptAgentAttempt(
    pane: PaneReference,
    provider: AgentNode["provider"],
    providerSessionId: string,
    prompt: string
  ): Promise<void> {
    await this.inspectAgentAttempt(pane, provider, providerSessionId)
    await runHerdr(["agent", "prompt", pane.paneId, prompt])
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
      node.permissions.extraArgs.length > 0
    ) {
      throw new Error(`Claude node "${intent.nodeId}" must use launcher-owned arguments.`)
    }
    if (node.type === "agent") {
      assertAgentEnvironmentAuthority(node)
    }
    const preparedCwd = await prepareWorkspace(workflow, state, intent.nodeId, node)
    assertProviderAuthorityIsolation(workflow, node, preparedCwd)
    await mkdir(path.dirname(attempt.outputPath), {
      recursive: true,
      mode: 0o700
    })
    const hook = beforeProviderBoundaryForTests
    beforeProviderBoundaryForTests = null
    const sourceRoot = stableProviderRoot(workflow, node, preparedCwd)
    const claudeLineageId =
      node.type === "agent" && node.provider === "claude"
        ? claudeSessionLineageId(node, state)
        : null
    const lineageDirectory =
      claudeLineageId === null ? null : await claudeLineageDirectory(state.id, claudeLineageId)
    const capabilities =
      node.type === "agent"
        ? await prepareAttemptLaunchCapabilities(
            workflow,
            node,
            state,
            intent,
            sourceRoot,
            lineageDirectory
          )
        : null
    const providerCwd =
      node.type === "agent" && node.provider === "claude"
        ? (lineageDirectory ?? capabilities?.manifest.trust.inbox.path ?? sourceRoot)
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
      ...capabilities?.environment,
      ORCHESTRATE_BIN: orchestrateExecutable(),
      ORCHESTRATE_STATE_DIR: stateRoot(),
      ORCHESTRATE_RUN_ID: state.id,
      ORCHESTRATE_NODE_ID: intent.nodeId,
      ORCHESTRATE_NODE_TOKEN: intent.token,
      ORCHESTRATE_OUTPUT_PATH: attempt.outputPath,
      ORCHESTRATE_RESULT_PATH:
        capabilities?.manifest.completion === undefined
          ? attempt.resultPath
          : path.join(capabilities.manifest.trust.outbox.path, "result.txt"),
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
      if (capabilities === null) {
        throw new TypeError(`Agent node "${intent.nodeId}" has no attempt capability manifest.`)
      }

      const launch = await prepareProviderLaunchArguments(node, state, intent, capabilities)
      launchSessionId = launch.providerSessionId
      if (capabilities.profileAdapterPath !== null) {
        codexProfileAdaptersByPane.set(pane.paneId, capabilities.profileAdapterPath)
      }
      await hook?.()
      const currentIntendedCwd = realpathSync.native(intendedCwd)
      if (currentIntendedCwd !== preparedCwd) {
        throw new Error(
          `Provider root for node "${intent.nodeId}" changed during launch; refusing pathname reuse.`
        )
      }
      await verifyAttemptTrustIdentities(capabilities.manifest.trust)
      const reloadedCapability = await loadExistingAttemptCapabilityManifest(
        state.id,
        intent.nodeId,
        intent.token
      )
      if (reloadedCapability.manifest.capabilityDigest !== capabilities.manifest.capabilityDigest) {
        throw new Error("Attempt capability manifest changed before provider start.")
      }
      for (const projected of capabilities.manifest.projectedInputs) {
        const current = await readBoundedRegularFileEvidence(
          projected.path,
          `Projected input ${projected.inputIndex}`
        )
        if (
          current.sha256 !== projected.sha256 ||
          current.byteLength !== projected.byteLength ||
          ((await lstat(projected.path)).mode & 0o777) !== 0o400
        ) {
          throw new Error(`Projected input ${projected.inputIndex} changed before provider start.`)
        }
      }
      if (capabilities.profileAdapterPath !== null) {
        const asset = capabilities.manifest.policyAssets.find(
          (candidate) => candidate.kind === "codex-profile"
        )
        const adapter = await readBoundedRegularFileEvidence(
          capabilities.profileAdapterPath,
          "Codex policy profile adapter"
        )
        if (asset === undefined || adapter.sha256 !== asset.sha256) {
          throw new Error("Codex policy profile adapter changed before provider start.")
        }
      }
      await revalidateProviderLaunchIdentity(
        capabilities.manifest.providerLaunch,
        capabilities.manifest.providerRelay
      )
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
        const deliveredPromptPath = path.join(capabilities.manifest.trust.inbox.path, "prompt.txt")
        await atomicWriteFile(deliveredPromptPath, request.prompt)
        await chmod(deliveredPromptPath, 0o400)
        // Provenance and visible intent matter here: a bare "read this file
        // and follow it exactly" pointing at an opaque token path matches the
        // prompt-injection silhouette and can trip provider safety classifiers
        // (observed: Fable 5 flagging the message and downgrading the model).
        prompt = `${
          node.provider === "claude" ? `Source workspace: ${sourceRoot}\n\n` : ""
        }You are the sole completion owner for this workflow node, started by this machine's orchestrate launcher. Your task briefing and completion contract were too large to deliver inline, so the launcher saved it to ${deliveredPromptPath} (inside this attempt's own readable transport directory). Read that file and carry out the task it describes. Delegated workers must never write the result or invoke node-done; you must write the declared result and successfully invoke node-done yourself before your final response.`
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
          (await hasValidCompletionEvidence(request.state, request.intent, attempt))
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
        const submitted = await hasValidCompletionEvidence(request.state, request.intent, attempt)
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
        if (node.type === "agent" && node.provider === "codex") {
          await rm(
            codexProfilePath(
              codexControlProfile(request.intent.token),
              providerControlRoot("codex")
            ),
            { force: true }
          ).catch(() => undefined)
        }
        throw new Error(
          `Spawn for node "${request.intent.nodeId}" lost pane "${recorded.pane.paneId}" after launch; failing this attempt instead of reusing its completion token.`
        )
      }
      if (node.type === "agent" && node.provider === "codex") {
        await rm(
          codexProfilePath(codexControlProfile(request.intent.token), providerControlRoot("codex")),
          { force: true }
        ).catch(() => undefined)
      }
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
    const profileAdapter = codexProfileAdaptersByPane.get(paneId)
    if (profileAdapter !== undefined) {
      codexProfileAdaptersByPane.delete(paneId)
      await rm(profileAdapter, { force: true }).catch(() => undefined)
    }
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
