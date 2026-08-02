import { Ajv2020 } from "ajv/dist/2020.js"
import { randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  access,
  link,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises"
import path from "node:path"

import type {
  ClaudePermissionMode,
  CodexSandbox,
  DynamicNode,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

import preferencesJsonSchema from "./generated/preferences.internal.schema.json" with { type: "json" }
import { atomicWriteJson, isProcessAlive, stateRoot } from "./state.js"

const MAX_PROJECTS = 20
const MAX_VERIFY_COMMANDS = 3
const MAX_VERIFY_COMMAND_BYTES = 1_024
const MAX_VERIFY_COMMAND_ARGS = 16
const MAX_ENV_NAMES = 32
const PROVIDER_CACHE_MS = 24 * 60 * 60 * 1000
const PREFERENCE_LOCK_WAIT_MS = 35_000
const PREFERENCE_LOCK_POLL_MS = 50

interface ModelPreference {
  readonly model: string
  readonly effort: string | null
}

interface CodexPreference {
  readonly mutating: ModelPreference | null
  readonly readOnly: ModelPreference | null
  readonly permissionCeiling: CodexSandbox
  readonly inheritEnv: readonly string[]
}

interface ClaudePreference {
  readonly mutating: ModelPreference | null
  readonly readOnly: ModelPreference | null
  readonly approvedPermissionModes: readonly ClaudePermissionMode[]
  readonly inheritEnv: readonly string[]
}

interface VerifyCommandPreference {
  readonly argv: readonly string[]
  readonly cwd: string
}

interface PreferenceScope {
  readonly updatedAt: string
  readonly providers: {
    readonly codex: CodexPreference | null
    readonly claude: ClaudePreference | null
  }
  readonly callback: {
    readonly type: WorkflowSpec["heartbeat"]["callback"]["type"]
    readonly intervalMinutes: number | null
  } | null
  readonly writeConflicts: WorkflowSpec["writeConflicts"] | null
  readonly concurrency: number | null
  readonly limits: WorkflowSpec["limits"] | null
  readonly worktrees: boolean | null
  readonly verifyCommands: readonly VerifyCommandPreference[] | null
}

interface ProjectPreference extends PreferenceScope {
  readonly cwd: string
}

export interface PreferencesFile {
  readonly version: 1
  readonly updatedAt: string
  readonly providersAvailable: {
    readonly checkedAt: string
    readonly codex: boolean
    readonly claude: boolean
  }
  readonly global: PreferenceScope
  readonly projects: Readonly<Record<string, ProjectPreference>>
}

interface ScopeUpdate {
  readonly providers?: {
    readonly codex?: CodexPreference
    readonly claude?: ClaudePreference
  }
  readonly callback?: NonNullable<PreferenceScope["callback"]>
  readonly writeConflicts?: WorkflowSpec["writeConflicts"]
  readonly concurrency?: number
  readonly limits?: WorkflowSpec["limits"]
  readonly worktrees?: boolean
  readonly verifyCommands?: readonly VerifyCommandPreference[]
}

const validatePreferences = new Ajv2020({ allErrors: true, strict: false }).compile(
  preferencesJsonSchema
)

const codexRank: Readonly<Record<CodexSandbox, number>> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2
}

const claudePermissionOrder: readonly ClaudePermissionMode[] = [
  "plan",
  "manual",
  "dontAsk",
  "acceptEdits",
  "auto",
  "bypassPermissions"
]

export function preferencesPath(): string {
  return path.join(stateRoot(), "preferences.json")
}

export function preferencesDisabled(): boolean {
  return process.env.ORCHESTRATE_DISABLE_PREFS === "1"
}

interface PreferenceLockOwner {
  readonly pid?: number
  readonly token?: string
}

async function withPreferencesLock<T>(action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(stateRoot(), "preferences.lock")
  const token = `${process.pid}-${randomUUID()}`
  const content = `${JSON.stringify({ pid: process.pid, token })}\n`
  await mkdir(path.dirname(lockPath), { recursive: true })
  const attempts = Math.ceil(PREFERENCE_LOCK_WAIT_MS / PREFERENCE_LOCK_POLL_MS)
  const release = async (): Promise<void> => {
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as PreferenceLockOwner
      if (owner.token === token) {
        await rm(lockPath, { force: true })
      }
    } catch {
      // A missing or replaced lock is not ours to remove.
    }
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, content, { mode: 0o600 })
    let acquired = false
    try {
      await link(temporary, lockPath)
      acquired = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error
      }
    } finally {
      await rm(temporary, { force: true })
    }
    if (acquired) {
      try {
        return await action()
      } finally {
        await release()
      }
    }
    const raw = await readFile(lockPath, "utf8").catch(() => null)
    if (raw === null) {
      continue
    }
    let owner: PreferenceLockOwner = {}
    try {
      owner = JSON.parse(raw) as PreferenceLockOwner
    } catch {
      const legacyPid = /^(\d+)-/.exec(raw)?.[1]
      owner = legacyPid === undefined ? {} : { pid: Number.parseInt(legacyPid, 10) }
    }
    if (isProcessAlive(owner.pid ?? null)) {
      await new Promise((resolve) => setTimeout(resolve, PREFERENCE_LOCK_POLL_MS))
      continue
    }
    const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`
    try {
      await rename(lockPath, aside)
    } catch {
      continue
    }
    const asideRaw = await readFile(aside, "utf8").catch(() => null)
    if (asideRaw !== raw) {
      try {
        await link(aside, lockPath)
      } catch {
        // A newer contender owns the live path; never overwrite it.
      }
      await rm(aside, { force: true })
      continue
    }
    await rm(aside, { force: true })
  }
  throw new Error("Timed out waiting for the preferences lock.")
}

function emptyScope(updatedAt: string): PreferenceScope {
  return {
    updatedAt,
    providers: { codex: null, claude: null },
    callback: null,
    writeConflicts: null,
    concurrency: null,
    limits: null,
    worktrees: null,
    verifyCommands: null
  }
}

async function providerAvailable(command: string): Promise<boolean> {
  const directories = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((directory) => directory.length > 0)
  for (const directory of directories) {
    try {
      const candidate = path.resolve(directory, command)
      if (!(await stat(candidate)).isFile()) {
        continue
      }
      await access(candidate, fsConstants.X_OK)
      return true
    } catch {
      // Keep looking; discovery never executes provider binaries.
    }
  }
  return false
}

async function detectProviders(checkedAt: string): Promise<PreferencesFile["providersAvailable"]> {
  return {
    checkedAt,
    codex: await providerAvailable("codex"),
    claude: await providerAvailable("claude")
  }
}

function providersAreFresh(value: PreferencesFile["providersAvailable"], now: Date): boolean {
  const checkedAt = Date.parse(value.checkedAt)
  return Number.isFinite(checkedAt) && now.getTime() - checkedAt < PROVIDER_CACHE_MS
}

function assertPreferences(value: unknown): asserts value is PreferencesFile {
  if (!validatePreferences(value)) {
    throw new Error(
      `Preferences failed schema validation: ${new Ajv2020().errorsText(
        validatePreferences.errors ?? [],
        { separator: "; " }
      )}`
    )
  }
  const preferences = value as unknown as PreferencesFile
  if (Object.keys(preferences.projects).length > MAX_PROJECTS) {
    throw new Error(`Preferences contain more than ${MAX_PROJECTS} projects.`)
  }
  for (const [projectPath, project] of Object.entries(preferences.projects)) {
    if (project.cwd !== projectPath || projectPath.length > 1_024) {
      throw new Error("Preferences contain an invalid project key.")
    }
  }
  for (const scope of [preferences.global, ...Object.values(preferences.projects)]) {
    for (const provider of [scope.providers.codex, scope.providers.claude]) {
      if (provider === null) {
        continue
      }
      if (
        provider.inheritEnv.length > MAX_ENV_NAMES ||
        provider.inheritEnv.some((name) => name.length > 128)
      ) {
        throw new Error("Preferences contain oversized inherited environment names.")
      }
      for (const selection of [provider.mutating, provider.readOnly]) {
        if (
          selection !== null &&
          (selection.model.length > 128 || (selection.effort?.length ?? 0) > 64)
        ) {
          throw new Error("Preferences contain an oversized model selection.")
        }
      }
    }
    if (
      scope.verifyCommands?.some(
        (command) => boundedCommand(command) === null || command.cwd.length > 1_024
      ) === true
    ) {
      throw new Error("Preferences contain an oversized verification command.")
    }
  }
}

async function readStoredPreferences(): Promise<PreferencesFile | null> {
  let raw: string
  try {
    raw = await readFile(preferencesPath(), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    assertPreferences(parsed)
    return parsed
  } catch {
    const damaged = `${preferencesPath()}.damaged`
    await rm(damaged, { force: true })
    await rename(preferencesPath(), damaged)
    console.warn(`Warning: moved invalid preferences to ${damaged}; starting with a fresh file.`)
    return null
  }
}

async function readOrCreatePreferences(now: Date): Promise<PreferencesFile> {
  const timestamp = now.toISOString()
  const stored = await readStoredPreferences()
  if (stored === null) {
    return {
      version: 1,
      updatedAt: timestamp,
      providersAvailable: await detectProviders(timestamp),
      global: emptyScope(timestamp),
      projects: {}
    }
  }
  if (providersAreFresh(stored.providersAvailable, now)) {
    return stored
  }
  return {
    ...stored,
    updatedAt: timestamp,
    providersAvailable: await detectProviders(timestamp)
  }
}

async function canonicalProject(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate)
  return realpath(absolute).catch(() => absolute)
}

function higherPermission<T extends string>(
  previous: T | null,
  candidate: T,
  ranks: Readonly<Record<T, number>>
): T {
  return previous === null || ranks[candidate] > ranks[previous] ? candidate : previous
}

function mergeCodex(previous: CodexPreference | null, candidate: CodexPreference): CodexPreference {
  return {
    mutating: candidate.mutating ?? previous?.mutating ?? null,
    readOnly: candidate.readOnly ?? previous?.readOnly ?? null,
    permissionCeiling: higherPermission(
      previous?.permissionCeiling ?? null,
      candidate.permissionCeiling,
      codexRank
    ),
    inheritEnv: candidate.inheritEnv
  }
}

function mergeClaude(
  previous: ClaudePreference | null,
  candidate: ClaudePreference
): ClaudePreference {
  return {
    mutating: candidate.mutating ?? previous?.mutating ?? null,
    readOnly: candidate.readOnly ?? previous?.readOnly ?? null,
    approvedPermissionModes: claudePermissionOrder.filter(
      (mode) =>
        candidate.approvedPermissionModes.includes(mode) ||
        previous?.approvedPermissionModes.includes(mode) === true
    ),
    inheritEnv: candidate.inheritEnv
  }
}

function distinctCommands(
  preferred: readonly VerifyCommandPreference[],
  fallback: readonly VerifyCommandPreference[] = []
): readonly VerifyCommandPreference[] {
  const seen = new Set<string>()
  return [...preferred, ...fallback]
    .filter((command) => {
      const key = JSON.stringify([command.cwd, command.argv])
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
    .slice(0, MAX_VERIFY_COMMANDS)
}

function isVerificationTask(value: string | undefined): boolean {
  return (
    value !== undefined &&
    ["test", "verify", "check", "lint", "typecheck", "validate", "ci"].includes(value)
  )
}

function recognizedVerificationArgv(argv: readonly string[]): boolean {
  const [tool, ...args] = argv
  if (tool === undefined || path.basename(tool) !== tool) {
    return false
  }
  if (["bun", "npm", "pnpm", "yarn"].includes(tool)) {
    return (
      (args.length === 1 && args[0] === "test") ||
      (args.length === 2 && args[0] === "run" && isVerificationTask(args[1]))
    )
  }
  if (tool === "cargo") {
    return (
      (args.length === 1 && ["test", "check", "clippy"].includes(args[0] as string)) ||
      (args.length === 2 && args[0] === "fmt" && args[1] === "--check")
    )
  }
  if (tool === "go") {
    return (
      (args.length === 1 && args[0] === "test") ||
      (args.length === 2 && args[0] === "test" && args[1] === "./...")
    )
  }
  if (tool === "make") {
    return args.length === 1 && isVerificationTask(args[0])
  }
  return (
    (tool === "pytest" && args.length === 0) ||
    (tool === "dotnet" && args.length === 1 && args[0] === "test") ||
    (tool === "tsc" && args.length === 1 && args[0] === "--noEmit")
  )
}

function boundedCommand(command: VerifyCommandPreference): VerifyCommandPreference | null {
  if (
    command.argv.length === 0 ||
    command.argv.length > MAX_VERIFY_COMMAND_ARGS ||
    Buffer.byteLength(JSON.stringify(command), "utf8") > MAX_VERIFY_COMMAND_BYTES ||
    !recognizedVerificationArgv(command.argv)
  ) {
    return null
  }
  return command
}

function boundedEnvironment(names: ReadonlySet<string>): readonly string[] {
  return [...names]
    .filter((name) => name.length <= 128)
    .toSorted()
    .slice(0, MAX_ENV_NAMES)
}

function boundedSelection(model: string, effort: string | null): ModelPreference | null {
  return model.length > 128 || (effort?.length ?? 0) > 64 ? null : { model, effort }
}

function mergeScope(
  previous: PreferenceScope,
  update: ScopeUpdate,
  updatedAt: string,
  appendVerifyCommands: boolean
): PreferenceScope {
  const verifyCommands =
    update.verifyCommands === undefined
      ? previous.verifyCommands
      : appendVerifyCommands
        ? distinctCommands(update.verifyCommands, previous.verifyCommands ?? [])
        : distinctCommands(update.verifyCommands)
  return {
    updatedAt,
    providers: {
      codex:
        update.providers?.codex === undefined
          ? previous.providers.codex
          : mergeCodex(previous.providers.codex, update.providers.codex),
      claude:
        update.providers?.claude === undefined
          ? previous.providers.claude
          : mergeClaude(previous.providers.claude, update.providers.claude)
    },
    callback: update.callback ?? previous.callback,
    writeConflicts: update.writeConflicts ?? previous.writeConflicts,
    concurrency: update.concurrency ?? previous.concurrency,
    limits: update.limits ?? previous.limits,
    worktrees: update.worktrees ?? previous.worktrees,
    verifyCommands
  }
}

function commandCwd(workflow: WorkflowSpec, node: WorkflowNode): string {
  if (node.workspace.path !== null) {
    return path.resolve(node.workspace.path)
  }
  return path.resolve(node.cwd ?? workflow.cwd)
}

function nodePreferences(
  workflow: WorkflowSpec,
  nodes: readonly WorkflowNode[],
  patch: boolean
): ScopeUpdate {
  let codex: CodexPreference | undefined
  let claude: ClaudePreference | undefined
  const codexEnv = new Set<string>()
  const claudeEnv = new Set<string>()
  const verifyCommands: VerifyCommandPreference[] = []
  let usesWorktree = false

  for (const node of nodes) {
    usesWorktree ||= node.workspace.mode === "git-worktree"
    if (node.type === "command") {
      if (!node.mutates) {
        const command = boundedCommand({ argv: [...node.argv], cwd: commandCwd(workflow, node) })
        if (command !== null) {
          verifyCommands.push(command)
        }
      }
      continue
    }
    const selection = boundedSelection(node.model, node.effort)
    if (node.provider === "codex") {
      node.permissions.inheritEnv.forEach((name) => codexEnv.add(name))
      const mutating = node.permissions.sandbox !== "read-only"
      codex = {
        mutating: mutating ? (selection ?? codex?.mutating ?? null) : (codex?.mutating ?? null),
        readOnly: mutating ? (codex?.readOnly ?? null) : (selection ?? codex?.readOnly ?? null),
        permissionCeiling: higherPermission(
          codex?.permissionCeiling ?? null,
          node.permissions.sandbox,
          codexRank
        ),
        inheritEnv: []
      }
    } else if (node.provider === "claude") {
      node.permissions.inheritEnv.forEach((name) => claudeEnv.add(name))
      const mutating = node.permissions.permissionMode !== "plan"
      claude = {
        mutating: mutating ? (selection ?? claude?.mutating ?? null) : (claude?.mutating ?? null),
        readOnly: mutating ? (claude?.readOnly ?? null) : (selection ?? claude?.readOnly ?? null),
        approvedPermissionModes: claudePermissionOrder.filter(
          (mode) =>
            mode === node.permissions.permissionMode ||
            claude?.approvedPermissionModes.includes(mode) === true
        ),
        inheritEnv: []
      }
    }
    if (node.type === "supervisor") {
      const envelopeCodex = node.envelope.codexSandboxes.reduce<CodexSandbox | null>(
        (ceiling, sandbox) => higherPermission(ceiling, sandbox, codexRank),
        null
      )
      if (envelopeCodex !== null && node.envelope.providers.includes("codex")) {
        codex = {
          mutating: codex?.mutating ?? null,
          readOnly: codex?.readOnly ?? null,
          permissionCeiling: higherPermission(
            codex?.permissionCeiling ?? null,
            envelopeCodex,
            codexRank
          ),
          inheritEnv: codex?.inheritEnv ?? []
        }
      }
      if (
        node.envelope.claudePermissionModes.length > 0 &&
        node.envelope.providers.includes("claude")
      ) {
        claude = {
          mutating: claude?.mutating ?? null,
          readOnly: claude?.readOnly ?? null,
          approvedPermissionModes: claudePermissionOrder.filter(
            (mode) =>
              node.envelope.claudePermissionModes.includes(mode) ||
              claude?.approvedPermissionModes.includes(mode) === true
          ),
          inheritEnv: claude?.inheritEnv ?? []
        }
      }
      for (const inherited of node.envelope.allowedInheritedEnv) {
        if (node.envelope.providers.includes("codex")) {
          inherited.forEach((name) => codexEnv.add(name))
        }
        if (node.envelope.providers.includes("claude")) {
          inherited.forEach((name) => claudeEnv.add(name))
        }
      }
    }
  }

  if (codex !== undefined) {
    codex = { ...codex, inheritEnv: boundedEnvironment(codexEnv) }
  }
  if (claude !== undefined) {
    claude = { ...claude, inheritEnv: boundedEnvironment(claudeEnv) }
  }

  return {
    ...(codex === undefined && claude === undefined
      ? {}
      : {
          providers: {
            ...(codex === undefined ? {} : { codex }),
            ...(claude === undefined ? {} : { claude })
          }
        }),
    ...(patch && !usesWorktree ? {} : { worktrees: usesWorktree }),
    ...(patch && verifyCommands.length === 0 ? {} : { verifyCommands })
  }
}

function workflowUpdate(workflow: WorkflowSpec): ScopeUpdate {
  return {
    ...nodePreferences(workflow, workflow.nodes, false),
    callback: {
      type: workflow.heartbeat.callback.type,
      intervalMinutes: workflow.heartbeat.intervalMinutes
    },
    writeConflicts: workflow.writeConflicts,
    concurrency: workflow.concurrency,
    limits: workflow.limits
  }
}

function trimProjects(
  projects: Readonly<Record<string, ProjectPreference>>
): Readonly<Record<string, ProjectPreference>> {
  return Object.fromEntries(
    Object.entries(projects)
      .toSorted(([leftPath, left], [rightPath, right]) => {
        const byTime = right.updatedAt.localeCompare(left.updatedAt)
        return byTime === 0 ? leftPath.localeCompare(rightPath) : byTime
      })
      .slice(0, MAX_PROJECTS)
  )
}

async function capture(
  workflow: WorkflowSpec,
  update: ScopeUpdate,
  appendVerifyCommands: boolean
): Promise<void> {
  if (preferencesDisabled()) {
    return
  }
  await withPreferencesLock(async () => {
    const now = new Date()
    const updatedAt = now.toISOString()
    const current = await readOrCreatePreferences(now)
    const cwd = await canonicalProject(workflow.cwd)
    if (cwd.length > 1_024) {
      throw new Error("Canonical project path is too long to store as a preference key.")
    }
    const existingProject = current.projects[cwd] ?? { cwd, ...emptyScope(updatedAt) }
    const project = {
      cwd,
      ...mergeScope(existingProject, update, updatedAt, appendVerifyCommands)
    }
    const next: PreferencesFile = {
      ...current,
      updatedAt,
      global: mergeScope(current.global, update, updatedAt, appendVerifyCommands),
      projects: trimProjects({ ...current.projects, [cwd]: project })
    }
    assertPreferences(next)
    await atomicWriteJson(preferencesPath(), next)
  })
}

export async function captureApprovedWorkflow(workflow: WorkflowSpec): Promise<void> {
  await capture(workflow, workflowUpdate(workflow), false)
}

export async function captureApprovedPatch(
  workflow: WorkflowSpec,
  nodes: readonly DynamicNode[]
): Promise<void> {
  await capture(workflow, nodePreferences(workflow, nodes, true), true)
}

export async function capturePreferencesSafely(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch (error) {
    console.warn(
      `Warning: could not update ${preferencesPath()}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function mergeProvider<T extends CodexPreference | ClaudePreference>(
  global: T | null,
  project: T | null
): T | null {
  if (global === null) {
    return project
  }
  if (project === null) {
    return global
  }
  return {
    ...global,
    ...project,
    mutating: project.mutating ?? global.mutating,
    readOnly: project.readOnly ?? global.readOnly
  }
}

export async function mergedPreferences(projectPath: string): Promise<{
  readonly file: PreferencesFile
  readonly project: string
  readonly matchedProject: boolean
  readonly preferences: PreferenceScope
}> {
  if (preferencesDisabled()) {
    throw new Error("Preferences are disabled by ORCHESTRATE_DISABLE_PREFS=1.")
  }
  const now = new Date()
  const file = await withPreferencesLock(async () => {
    const original = await readStoredPreferences()
    const current = await readOrCreatePreferences(now)
    if (
      original === null ||
      current.providersAvailable.checkedAt !== original.providersAvailable.checkedAt
    ) {
      await atomicWriteJson(preferencesPath(), current)
    }
    return current
  })
  const project = await canonicalProject(projectPath)
  const local = file.projects[project] ?? null
  return {
    file,
    project,
    matchedProject: local !== null,
    preferences: {
      updatedAt: local?.updatedAt ?? file.global.updatedAt,
      providers: {
        codex: mergeProvider(file.global.providers.codex, local?.providers.codex ?? null),
        claude: mergeProvider(file.global.providers.claude, local?.providers.claude ?? null)
      },
      callback: local?.callback ?? file.global.callback,
      writeConflicts: local?.writeConflicts ?? file.global.writeConflicts,
      concurrency: local?.concurrency ?? file.global.concurrency,
      limits: local?.limits ?? file.global.limits,
      worktrees: local?.worktrees ?? file.global.worktrees,
      verifyCommands: local?.verifyCommands ?? file.global.verifyCommands
    }
  }
}

function modelText(preference: ModelPreference | null): string {
  return preference === null
    ? "—"
    : `${preference.model}${preference.effort === null ? "" : ` (${preference.effort})`}`
}

function providerText(
  name: "Codex" | "Claude",
  preference: CodexPreference | ClaudePreference | null
): string {
  if (preference === null) {
    return `${name}: —`
  }
  const authority =
    "permissionCeiling" in preference
      ? `ceiling ${preference.permissionCeiling}`
      : `approved modes ${preference.approvedPermissionModes.join(",") || "—"}`
  return `${name}: mutating ${modelText(preference.mutating)}; read-only ${modelText(
    preference.readOnly
  )}; ${authority}; env ${
    preference.inheritEnv.length === 0 ? "—" : preference.inheritEnv.join(",")
  }`
}

function limitsText(limits: WorkflowSpec["limits"] | null): string {
  if (limits === null) {
    return "—"
  }
  return Object.entries(limits)
    .map(([name, value]) => `${name}=${value ?? "∞"}`)
    .join(", ")
}

export function formatMergedPreferences(
  merged: Awaited<ReturnType<typeof mergedPreferences>>
): string {
  const value = merged.preferences
  const lines = [
    `Preferences: ${preferencesPath()}`,
    `Project: ${merged.project} (${merged.matchedProject ? "project + global" : "global only"})`,
    `Providers available: codex=${merged.file.providersAvailable.codex ? "yes" : "no"}, claude=${merged.file.providersAvailable.claude ? "yes" : "no"} (checked ${merged.file.providersAvailable.checkedAt})`,
    providerText("Codex", value.providers.codex),
    providerText("Claude", value.providers.claude),
    `Workflow: concurrency=${value.concurrency ?? "—"}; writeConflicts=${value.writeConflicts ?? "—"}; worktrees=${value.worktrees === null ? "—" : value.worktrees ? "yes" : "no"}`,
    `Heartbeat: ${
      value.callback === null
        ? "—"
        : `${value.callback.type}, interval=${value.callback.intervalMinutes ?? "none"}`
    }`,
    `Limits: ${limitsText(value.limits)}`,
    "Verify commands:"
  ]
  if (value.verifyCommands === null || value.verifyCommands.length === 0) {
    lines.push("  —")
  } else {
    value.verifyCommands.forEach((command) => {
      lines.push(`  ${JSON.stringify(command.argv)} (cwd ${command.cwd})`)
    })
  }
  lines.push("Defaults only: keep every workflow choice explicit and preview any escalation.")
  return lines.join("\n")
}
