import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

import type { EventRecord, HoldState, RunState, UiPreferences, WorkflowSpec } from "./types.js"

import packageJson from "../package.json" with { type: "json" }
import { EventRecordSchema, RunStateSchema, UiPreferencesSchema, WorkflowSchema } from "./schema.js"
import { replayEvents } from "./state-patch.js"

declare const ORCHESTRATE_BUILD_EMBEDDED: string
declare const ORCHESTRATE_VERSION_EMBEDDED: string

const RUN_ID = /^\d{14}-[0-9a-f]{8}$/
const RUN_PREFIX = /^[0-9a-f-]+$/
const LOCK_WAIT_MS = 10_000
const LOCK_POLL_MS = 25
const ownedDataParseOptions = { onExcessProperty: "error" } as const
const decodeRunState = Schema.decodeUnknownSync(RunStateSchema, ownedDataParseOptions)
const decodeEvent = Schema.decodeUnknownSync(EventRecordSchema, ownedDataParseOptions)
const decodeWorkflow = Schema.decodeUnknownSync(WorkflowSchema, {
  ...ownedDataParseOptions,
  errors: "all"
})
const decodeUiPreferences = Schema.decodeUnknownSync(UiPreferencesSchema, {
  ...ownedDataParseOptions,
  errors: "all"
})

export function runtimeBuild(): string {
  if (runtimeBuildForTests !== null) {
    return runtimeBuildForTests
  }
  const exact =
    typeof ORCHESTRATE_BUILD_EMBEDDED === "string"
      ? `+${ORCHESTRATE_BUILD_EMBEDDED}`
      : "+development"
  const version =
    typeof ORCHESTRATE_VERSION_EMBEDDED === "string"
      ? ORCHESTRATE_VERSION_EMBEDDED
      : packageJson.version
  return `${packageJson.name}@${version}${exact}`
}

let runtimeBuildForTests: string | null = null

export function setRuntimeBuildForTests(build: string | null): void {
  if (typeof ORCHESTRATE_BUILD_EMBEDDED === "string") {
    throw new TypeError("Runtime build injection is unavailable in embedded production builds.")
  }
  runtimeBuildForTests = build
}

export function stateRoot(): string {
  const explicit = process.env.ORCHESTRATE_STATE_DIR
  if (explicit !== undefined && explicit.trim().length > 0) {
    return path.resolve(explicit)
  }
  const xdg = process.env.XDG_STATE_HOME
  return path.resolve(
    xdg !== undefined && xdg.trim().length > 0
      ? path.join(xdg, "orchestrate")
      : path.join(os.homedir(), ".local", "state", "orchestrate")
  )
}

export function runsRoot(): string {
  return path.join(stateRoot(), "runs")
}

export function runDirectory(runId: string): string {
  return path.join(runsRoot(), runId)
}

export function runStatePath(runDir: string): string {
  return path.join(runDir, "state.json")
}

export function workflowPath(runDir: string): string {
  return path.join(runDir, "workflow.json")
}

export function uiPath(runDir: string): string {
  return path.join(runDir, "ui.json")
}

export function eventsPath(runDir: string): string {
  return path.join(runDir, "events.json")
}

export interface NodeDoneSubmission {
  readonly runId: string
  readonly nodeId: string
  readonly token: string
  readonly outcome: "completed" | "failed"
  readonly hold: boolean
}

export function submissionsRoot(): string {
  const authoritativeRoot = stateRoot()
  return path.join(
    path.dirname(authoritativeRoot),
    `${path.basename(authoritativeRoot)}-submissions`
  )
}

export function submissionRunDirectory(runId: string): string {
  return path.join(submissionsRoot(), runId)
}

export function submissionDirectory(runId: string, nodeId: string, token: string): string {
  if (!RUN_ID.test(runId)) {
    throw new Error(`Invalid full run id "${runId}" for node submission.`)
  }
  if (!/^[a-z0-9][a-z0-9-]*(?:--r[1-9][0-9]*)?$/.test(nodeId)) {
    throw new Error(`Invalid runtime node id "${nodeId}" for node submission.`)
  }
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error("Invalid node submission token.")
  }
  return path.join(submissionRunDirectory(runId), nodeId, token)
}

export function submissionResultPath(runId: string, nodeId: string, token: string): string {
  return path.join(submissionDirectory(runId, nodeId, token), "result.txt")
}

export function completionSubmissionPath(resultPath: string): string {
  return path.join(path.dirname(resultPath), "completion.json")
}

export function nodeDirectory(runDir: string, nodeId: string): string {
  return path.join(runDir, "nodes", nodeId)
}

export function attemptDirectory(runDir: string, nodeId: string, attempt: number): string {
  return path.join(nodeDirectory(runDir, nodeId), `attempt-${attempt}`)
}

export async function ensureStateDirectories(): Promise<void> {
  await mkdir(runsRoot(), { recursive: true, mode: 0o700 })
  await mkdir(submissionsRoot(), { recursive: true, mode: 0o700 })
}

export async function atomicWriteFile(
  filePath: string,
  content: string,
  mode = 0o600
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let preserveTemporaryOnFailure = false
  try {
    const handle = await open(temporary, "w", mode)
    try {
      const fault = atomicWriteFaultForTests
      if (
        fault !== null &&
        fault.phase !== "directory-sync" &&
        path.resolve(fault.targetPath) === path.resolve(filePath)
      ) {
        atomicWriteFaultForTests = null
        preserveTemporaryOnFailure = fault.preserveTemporary
        await handle.writeFile(Buffer.from(content).subarray(0, fault.afterBytes))
        await handle.sync()
        throw fault.error
      }
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, filePath)
  } catch (error) {
    if (!preserveTemporaryOnFailure) {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    throw error
  }
  try {
    const directory = await open(path.dirname(filePath), "r")
    try {
      const fault = atomicWriteFaultForTests
      if (
        fault !== null &&
        fault.phase === "directory-sync" &&
        path.resolve(fault.targetPath) === path.resolve(filePath)
      ) {
        atomicWriteFaultForTests = null
        throw fault.error
      }
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) {
      throw error
    }
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP"
}

interface AtomicWriteFaultForTests {
  readonly targetPath: string
  readonly phase?: "file-write" | "directory-sync"
  readonly afterBytes: number
  readonly preserveTemporary: boolean
  readonly error: Error
}

let atomicWriteFaultForTests: AtomicWriteFaultForTests | null = null

export function injectAtomicWriteFaultForTests(fault: AtomicWriteFaultForTests | null): void {
  if (typeof ORCHESTRATE_BUILD_EMBEDDED === "string") {
    throw new TypeError(
      "Atomic-write fault injection is unavailable in embedded production builds."
    )
  }
  atomicWriteFaultForTests = fault
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T
}

function assertRunState(value: unknown): asserts value is RunState {
  try {
    decodeRunState(value)
  } catch (error) {
    throw new Error(`Invalid run state: ${String(error)}.`, { cause: error })
  }
}

function assertEvent(value: unknown): asserts value is EventRecord {
  try {
    decodeEvent(value)
  } catch (error) {
    throw new Error(`Invalid journal event: ${String(error)}.`, { cause: error })
  }
}

function assertRuntimeBuild(recorded: string): void {
  const current = runtimeBuild()
  if (recorded !== current) {
    throw new Error(
      `Run was created by runtime build "${recorded}", but this CLI is "${current}". Use the matching CLI or clean the run.`
    )
  }
}

export async function readEvents(runDir: string): Promise<readonly EventRecord[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(eventsPath(runDir), "utf8")) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    if (error instanceof SyntaxError) {
      throw new TypeError("Invalid JSON in authoritative event journal.", { cause: error })
    }
    throw error
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("Authoritative event journal must be a JSON array.")
  }
  const events = parsed as unknown[]
  events.forEach(assertEvent)
  if (events.length > 0) {
    assertRuntimeBuild((events[0] as EventRecord).runtimeVersion)
  }
  return events as EventRecord[]
}

export async function readRunState(
  runDir: string,
  options: { readonly repair?: boolean } = {}
): Promise<RunState> {
  const events = await readEvents(runDir)
  if (events.length === 0) {
    throw new Error(`Run "${path.basename(runDir)}" has no authoritative journal.`)
  }
  const replayed = replayEvents(events)
  assertRunState(replayed)
  assertRuntimeBuild(replayed.runtimeVersion)

  let stored: RunState | null = null
  try {
    const candidate = await readJson<unknown>(runStatePath(runDir))
    assertRunState(candidate)
    assertRuntimeBuild(candidate.runtimeVersion)
    stored = candidate
  } catch {
    // A missing, torn, invalid, or stale snapshot is recovered below from the journal.
  }
  const lastSequence = events.at(-1)?.sequence ?? 0
  if (stored !== null && stored.sequence > lastSequence) {
    throw new Error(
      `Run state is at sequence ${stored.sequence}, but its journal ends at ${lastSequence}. The audit is incomplete.`
    )
  }
  if (stored !== null && isDeepStrictEqual(stored, replayed)) {
    return stored
  }
  if (options.repair !== true) {
    return replayed
  }
  const revision = events.findLast((event) => event.type === "revision.approved")
  if (revision !== undefined) {
    const data = revision.data
    const recoveredWorkflow =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>).workflow
        : undefined
    if (recoveredWorkflow === undefined) {
      throw new Error(
        `Journal event ${revision.sequence} cannot recover its approved workflow revision.`
      )
    }
    await atomicWriteJson(workflowPath(runDir), recoveredWorkflow)
  }
  await atomicWriteJson(runStatePath(runDir), replayed)
  return replayed
}

export async function readWorkflow(runDir: string): Promise<WorkflowSpec> {
  const value: unknown = await readJson(workflowPath(runDir))
  try {
    return decodeWorkflow(value)
  } catch (error) {
    throw new Error(`Invalid workflow snapshot: ${String(error)}.`, { cause: error })
  }
}

export async function readUiSnapshot(runDir: string): Promise<UiPreferences> {
  const value: unknown = await readJson(uiPath(runDir))
  try {
    return decodeUiPreferences(value)
  } catch (error) {
    throw new Error(`Invalid UI snapshot: ${String(error)}.`, { cause: error })
  }
}

export async function appendEvents(runDir: string, events: readonly EventRecord[]): Promise<void> {
  if (events.length === 0) {
    return
  }
  for (const event of events) {
    assertEvent(event)
  }
  const existing = await readEvents(runDir)
  await atomicWriteJson(eventsPath(runDir), [...existing, ...events])
}

export async function persistNewRun(
  workflow: WorkflowSpec,
  ui: UiPreferences,
  state: RunState,
  events: readonly EventRecord[]
): Promise<string> {
  assertRunState(state)
  assertRuntimeBuild(state.runtimeVersion)
  if (events.length === 0 || events.at(-1)?.sequence !== state.sequence) {
    throw new Error("A new run requires a complete initial journal.")
  }
  if (!isDeepStrictEqual(replayEvents(events), state)) {
    throw new Error("Initial journal replay does not reproduce state.json.")
  }
  await ensureStateDirectories()
  const runDir = runDirectory(state.id)
  await mkdir(runDir, { mode: 0o700 })
  await mkdir(path.join(runDir, "nodes"), { mode: 0o700 })
  await mkdir(submissionRunDirectory(state.id), { recursive: true, mode: 0o700 })
  await atomicWriteJson(workflowPath(runDir), workflow)
  await atomicWriteJson(uiPath(runDir), ui)
  await appendEvents(runDir, events)
  await atomicWriteJson(runStatePath(runDir), state)
  return runDir
}

export async function commitRun(
  runDir: string,
  workflow: WorkflowSpec,
  state: RunState,
  events: readonly EventRecord[]
): Promise<void> {
  assertRunState(state)
  assertRuntimeBuild(state.runtimeVersion)
  if (events.length > 0 && events.at(-1)?.sequence !== state.sequence) {
    throw new Error("Committed events do not end at the state sequence.")
  }
  await appendEvents(runDir, events)
  await atomicWriteJson(workflowPath(runDir), workflow)
  await atomicWriteJson(runStatePath(runDir), state)
}

export function createRunId(now = new Date()): string {
  return `${now
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().replaceAll("-", "").slice(0, 8)}`
}

export function isProcessAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

interface FlockLibrary {
  readonly symbols: {
    readonly flock: (fileDescriptor: number, operation: number) => number
  }
}

let flockLibrary: Promise<FlockLibrary> | null = null

async function nativeFlock(fileDescriptor: number, operation: number): Promise<number> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Orchestrate advisory locks require supported macOS ARM64.")
  }
  flockLibrary ??= import("bun:ffi").then(({ dlopen }) =>
    dlopen("/usr/lib/libSystem.B.dylib", {
      flock: { args: ["i32", "i32"], returns: "i32" }
    })
  )
  return (await flockLibrary).symbols.flock(fileDescriptor, operation)
}

async function tryAcquireAdvisoryLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  const handle = await open(lockPath, "a+", 0o600)
  if ((await nativeFlock(handle.fd, LOCK_EX | LOCK_NB)) !== 0) {
    await handle.close()
    return null
  }
  try {
    await handle.truncate(0)
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, heldSince: new Date().toISOString() })}\n`
    )
    await handle.sync()
  } catch (error) {
    await handle.close()
    throw error
  }
  let released = false
  return async () => {
    if (released) {
      return
    }
    released = true
    try {
      if ((await nativeFlock(handle.fd, LOCK_UN)) !== 0) {
        throw new Error(`Could not release advisory lock "${lockPath}".`)
      }
    } finally {
      await handle.close()
    }
  }
}

export async function acquireRunLock(runDir: string): Promise<() => Promise<void>> {
  const lockPath = path.join(runDir, "crank.lock")
  const deadline = Date.now() + LOCK_WAIT_MS
  while (Date.now() < deadline) {
    const release = await tryAcquireAdvisoryLock(lockPath)
    if (release !== null) {
      return release
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }
  throw new Error(`Timed out waiting for the crank lock for ${path.basename(runDir)}.`)
}

export interface RunListing {
  readonly states: readonly RunState[]
  readonly damaged: readonly string[]
}

export async function listRunStates(): Promise<RunListing> {
  await ensureStateDirectories()
  const states: RunState[] = []
  const damaged: string[] = []
  for (const entry of await readdir(runsRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const runDir = runDirectory(entry.name)
    try {
      states.push(await readRunState(runDir))
    } catch {
      damaged.push(entry.name)
    }
  }
  states.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  damaged.sort()
  return { states, damaged }
}

export function holdBlocksDependencies(state: RunState, hold: HoldState): boolean {
  return Object.values(state.nodes).some(
    (node) =>
      (node.status === "completed" || node.status === "skipped") &&
      (hold.scope === "instance" ? node.id === hold.target : node.templateId === hold.target) &&
      (node.repeatId === null || node.round === state.repeats[node.repeatId]?.round)
  )
}

export function runNeedsAttention(state: RunState): boolean {
  return (
    state.status === "paused" ||
    state.status === "failed" ||
    state.pendingRevision !== null ||
    Object.values(state.nodes).some((node) => node.status === "awaiting-approval") ||
    Object.values(state.holds).some((hold) => holdBlocksDependencies(state, hold)) ||
    Object.values(state.repeats).some((repeat) => repeat.status === "max-rounds")
  )
}

export async function resolveRunDirectory(prefix: string): Promise<string> {
  if (RUN_ID.test(prefix)) {
    const exact = runDirectory(prefix)
    if (
      await stat(exact)
        .then((value) => value.isDirectory())
        .catch(() => false)
    ) {
      return exact
    }
  }
  if (!RUN_PREFIX.test(prefix)) {
    throw new Error(`Invalid run id or prefix "${prefix}".`)
  }
  await ensureStateDirectories()
  const matches = (await readdir(runsRoot(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .toSorted()
  if (matches.length === 0) {
    throw new Error(`No run matches "${prefix}".`)
  }
  if (matches.length > 1) {
    throw new Error(`Run prefix "${prefix}" is ambiguous: ${matches.join(", ")}.`)
  }
  return runDirectory(matches[0] as string)
}

export async function resolveDefaultRunDirectory(): Promise<string> {
  const { states } = await listRunStates()
  const selected = states.find(runNeedsAttention) ?? states[0]
  if (selected === undefined) {
    throw new Error("No runs exist.")
  }
  return runDirectory(selected.id)
}

export async function removeRun(runDir: string): Promise<void> {
  await rm(runDir, { recursive: true, force: true })
  const runId = path.basename(runDir)
  await rm(submissionRunDirectory(runId), { recursive: true, force: true })
}
