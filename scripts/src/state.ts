import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  appendFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import type { EventRecord, ProcessIdentity, RunState, WorkflowSpec } from "./types.js"

import { captureProcessIdentity } from "./process.js"

// Version of the on-disk run contract (state layout plus worker semantics).
// A worker refuses to schedule runs stamped with a different version.
export const CONTRACT_VERSION = 1

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

export function runDirectory(runId: string): string {
  return path.join(stateRoot(), "runs", runId)
}

const RUN_ID = /^\d{14}-[0-9a-f]{8}$/
const RUN_PREFIX = /^[0-9a-f-]+$/

export function runStatePath(runDir: string): string {
  return path.join(runDir, "state.json")
}

export function workflowPath(runDir: string): string {
  return path.join(runDir, "workflow.json")
}

export function eventsPath(runDir: string): string {
  return path.join(runDir, "events.jsonl")
}

export function stopRequestPath(runDir: string): string {
  return path.join(runDir, "stop.request")
}

export function pauseRequestPath(runDir: string): string {
  return path.join(runDir, "pause.request")
}

export async function ensureStateDirectories(): Promise<void> {
  await mkdir(path.join(stateRoot(), "runs"), { recursive: true })
  await mkdir(path.join(stateRoot(), "drafts"), { recursive: true })
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  // The temporary file is fsynced before the rename so a power loss cannot
  // leave the destination pointing at an empty or truncated file.
  try {
    const handle = await open(temporary, "w", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, filePath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  try {
    const directory = await open(path.dirname(filePath), "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch {
    // Directory fsync is best-effort; some platforms refuse it.
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T
}

export async function readRunState(runDir: string): Promise<RunState> {
  return readJson<RunState>(runStatePath(runDir))
}

export async function writeRunState(runDir: string, state: RunState): Promise<void> {
  await atomicWriteJson(runStatePath(runDir), state)
}

export async function appendEvent(runDir: string, event: EventRecord): Promise<void> {
  await appendFile(eventsPath(runDir), `${JSON.stringify(event)}\n`, { mode: 0o600 })
}

export async function createRun(
  workflow: WorkflowSpec,
  digest: string,
  allowWriteConflicts: boolean,
  emergencyFuseOverride: boolean,
  mirror: "herdr" | null = null
): Promise<{ readonly runDir: string; readonly state: RunState }> {
  await ensureStateDirectories()
  const runId = `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().replaceAll("-", "").slice(0, 8)}`
  const runDir = runDirectory(runId)
  await mkdir(path.join(runDir, "nodes"), { recursive: true, mode: 0o700 })
  const now = new Date().toISOString()
  const state: RunState = {
    id: runId,
    contractVersion: CONTRACT_VERSION,
    workflowName: workflow.name,
    objective: workflow.objective,
    digest,
    status: "starting",
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    pid: null,
    workerToken: null,
    error: null,
    pauseReason: null,
    pauseCode: null,
    allowWriteConflicts,
    emergencyFuseOverride,
    mirror,
    stopRequested: false,
    agentStarts: 0,
    goalRounds: {},
    supervisorStartedAt: {},
    supervisorBarriers: {},
    overriddenLimits: [],
    pendingPatch: null,
    pendingInput: null,
    pendingRevision: null,
    pendingGate: null,
    approvedPendingGate: false,
    satisfiedGates: [],
    supervisorResponses: {},
    approvedPendingPatch: false,
    nodes: Object.fromEntries(
      workflow.nodes.map((node) => [
        node.id,
        {
          id: node.id,
          status: "pending",
          attempts: 0,
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          error: null,
          resultPath: null,
          sessionId: null,
          workspacePath: null,
          processPid: null,
          processIdentity: null
        }
      ])
    ),
    sessions: {},
    dynamicNodes: []
  }
  await atomicWriteJson(workflowPath(runDir), workflow)
  await writeRunState(runDir, state)
  await appendEvent(runDir, {
    timestamp: now,
    runId,
    type: "run.created",
    message: `Created workflow run ${runId}.`
  })
  return { runDir, state }
}

const execFileAsync = promisify(execFile)

export async function isExpectedWorker(pid: number | null, runDir: string): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
      ])
      return stdout.includes("__worker") && stdout.includes(runDir)
    } catch {
      return false
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="])
    return stdout.includes("__worker") && stdout.includes(runDir)
  } catch {
    return false
  }
}

export type LockKind = "worker" | "cli"

interface LockOwner {
  readonly pid?: number
  readonly kind?: string
  readonly token?: string
  readonly identity?: ProcessIdentity | null
}

function identityMatches(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return (
    left.startedAt === right.startedAt &&
    left.executable === right.executable &&
    left.commandDigest === right.commandDigest
  )
}

async function lockOwnerStillHolds(owner: LockOwner): Promise<boolean> {
  if (!isProcessAlive(owner.pid ?? null)) {
    return false
  }
  if (owner.identity === undefined || owner.identity === null) {
    // No recorded identity (the owner was not a process-group leader, or ps
    // was unavailable): a live PID must conservatively be treated as the
    // owner, so takeover requires the PID to exit.
    return true
  }
  const current = await captureProcessIdentity(owner.pid as number)
  return current !== null && identityMatches(current, owner.identity)
}

export async function acquireWorkerLock(
  runDir: string,
  token: string,
  kind: LockKind = "worker"
): Promise<() => Promise<void>> {
  const lockPath = path.join(runDir, "worker.lock")
  const identity = await captureProcessIdentity(process.pid)
  const content = `${JSON.stringify({
    pid: process.pid,
    token,
    kind,
    identity,
    createdAt: new Date().toISOString()
  })}\n`
  const release = async (): Promise<void> => {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as LockOwner
      if (current.token === token) {
        await rm(lockPath, { force: true })
      }
    } catch {
      // A missing lock is already released; never remove an unverifiable replacement lock.
    }
  }
  // The lock is created by hard-linking a fully written temp file into place,
  // so contenders can never observe a partially written lock. A verified-stale
  // lock is taken over by atomically renaming it aside — never by deleting it
  // in place, which would let two contenders remove each other's fresh lock.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, content, { mode: 0o600 })
    try {
      await link(temporary, lockPath)
      await rm(temporary, { force: true })
      return release
    } catch (error) {
      await rm(temporary, { force: true })
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error
      }
    }
    const raw = await readFile(lockPath, "utf8").catch(() => null)
    if (raw === null) {
      continue
    }
    let owner: LockOwner = {}
    try {
      owner = JSON.parse(raw) as LockOwner
    } catch {
      // An unreadable lock has no verifiable live owner; treat it as stale.
    }
    if (await lockOwnerStillHolds(owner)) {
      if (owner.kind === "cli") {
        // CLI critical sections last milliseconds; wait for release.
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      throw new Error(`Run already has an active worker with PID ${owner.pid}.`)
    }
    const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`
    try {
      await rename(lockPath, aside)
    } catch {
      continue
    }
    const asideRaw = await readFile(aside, "utf8").catch(() => null)
    if (asideRaw !== raw) {
      // The lock changed between verification and takeover. Restore it only
      // into a vacant path (link is exclusive); if another lock arrived in
      // the meantime, the newer lock wins and this copy is dropped.
      try {
        await link(aside, lockPath)
      } catch {
        // The path is occupied again; leave the newer lock in place.
      }
      await rm(aside, { force: true })
      continue
    }
    await rm(aside, { force: true })
  }
  throw new Error(`Could not acquire the run lock for ${runDir} after repeated contention.`)
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

export interface RunListing {
  readonly states: readonly RunState[]
  readonly damaged: readonly string[]
}

// Screens the fields the run listing itself relies on, so one truncated or
// foreign JSON document cannot break the whole list.
function isListableRunState(value: unknown): value is RunState {
  if (value === null || typeof value !== "object") {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.id === "string" &&
    typeof record.workflowName === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    record.nodes !== null &&
    typeof record.nodes === "object"
  )
}

export async function listRunStates(): Promise<RunListing> {
  await ensureStateDirectories()
  const root = path.join(stateRoot(), "runs")
  const entries = await readdir(root, { withFileTypes: true })
  const states: RunState[] = []
  const damaged: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    try {
      const candidate = await readJson<unknown>(runStatePath(path.join(root, entry.name)))
      if (isListableRunState(candidate)) {
        states.push(candidate)
      } else {
        damaged.push(entry.name)
      }
    } catch {
      // A run directory with an unreadable state.json stays on disk and is
      // reported to callers instead of silently disappearing from the list.
      damaged.push(entry.name)
    }
  }
  return {
    states: states.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    damaged: damaged.toSorted()
  }
}

export async function resolveRunDirectory(runIdOrPrefix: string): Promise<string> {
  await ensureStateDirectories()
  if (!RUN_PREFIX.test(runIdOrPrefix)) {
    throw new Error(`Invalid run id or prefix "${runIdOrPrefix}".`)
  }
  const root = path.join(stateRoot(), "runs")
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() && RUN_ID.test(entry.name) && entry.name.startsWith(runIdOrPrefix)
    )
    .map((entry) => entry.name)
  if (entries.length === 0) {
    throw new Error(`No run matches "${runIdOrPrefix}".`)
  }
  if (entries.length > 1) {
    throw new Error(`Run prefix "${runIdOrPrefix}" is ambiguous: ${entries.join(", ")}`)
  }
  return path.join(root, entries[0] as string)
}

export async function removeRun(runIdOrPrefix: string): Promise<string> {
  const runDir = await resolveRunDirectory(runIdOrPrefix)
  const state = await readRunState(runDir)
  if (await isExpectedWorker(state.pid, runDir)) {
    throw new Error(`Run ${state.id} is still active; stop it before cleaning.`)
  }
  await rm(runDir, { recursive: true })
  return state.id
}
