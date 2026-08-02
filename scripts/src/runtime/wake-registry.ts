import { createHash } from "node:crypto"
import { readdir, rm } from "node:fs/promises"
import path from "node:path"

import type { RunState } from "../types.js"

import { atomicWriteJson, readJson, readRunState, runDirectory, stateRoot } from "../state.js"

export type WakeHarness = "codex" | "claude"

export interface WakeRegistration {
  readonly version: 1
  readonly harness: WakeHarness
  readonly sessionId: string
  readonly runId: string
  readonly cwd: string
  readonly registeredAt: string
}

export interface SettledRun {
  readonly registration: WakeRegistration
  readonly state: RunState
}

const SETTLED_STATUSES = new Set<RunState["status"]>(["completed", "failed", "paused", "stopped"])

function registrationDirectory(): string {
  return path.join(stateRoot(), "wake")
}

function registrationKey(harness: WakeHarness, sessionId: string, runId: string): string {
  return createHash("sha256").update(`${harness}\0${sessionId}\0${runId}`).digest("hex")
}

function registrationPath(harness: WakeHarness, sessionId: string, runId: string): string {
  return path.join(registrationDirectory(), `${registrationKey(harness, sessionId, runId)}.json`)
}

function isRegistration(value: unknown): value is WakeRegistration {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const candidate = value as Partial<WakeRegistration>
  return (
    candidate.version === 1 &&
    (candidate.harness === "codex" || candidate.harness === "claude") &&
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0 &&
    typeof candidate.runId === "string" &&
    candidate.runId.length > 0 &&
    typeof candidate.cwd === "string" &&
    typeof candidate.registeredAt === "string"
  )
}

export function detectedWakeOwner(): {
  readonly harness: WakeHarness
  readonly sessionId: string
} | null {
  const claudeSession = process.env.CLAUDE_CODE_SESSION_ID?.trim()
  if (claudeSession !== undefined && claudeSession.length > 0) {
    return { harness: "claude", sessionId: claudeSession }
  }
  const codexSession = process.env.CODEX_THREAD_ID?.trim()
  if (codexSession !== undefined && codexSession.length > 0) {
    return { harness: "codex", sessionId: codexSession }
  }
  return null
}

export async function registerWake(
  harness: WakeHarness,
  sessionId: string,
  runId: string,
  cwd = process.cwd()
): Promise<WakeRegistration> {
  if (sessionId.trim().length === 0) {
    throw new Error("A non-empty harness session id is required for wake registration.")
  }
  const state = await readRunState(runDirectory(runId))
  const registration: WakeRegistration = {
    version: 1,
    harness,
    sessionId,
    runId: state.id,
    cwd: path.resolve(cwd),
    registeredAt: new Date().toISOString()
  }
  await atomicWriteJson(registrationPath(harness, sessionId, state.id), registration)
  return registration
}

export async function clearWake(registration: WakeRegistration): Promise<void> {
  await rm(registrationPath(registration.harness, registration.sessionId, registration.runId), {
    force: true
  })
}

export async function listWakes(
  harness: WakeHarness,
  sessionId: string
): Promise<readonly WakeRegistration[]> {
  let names: readonly string[]
  try {
    names = await readdir(registrationDirectory())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }
    throw error
  }
  const registrations: WakeRegistration[] = []
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const filePath = path.join(registrationDirectory(), name)
    const registration = await readJson<unknown>(filePath).catch(() => null)
    if (!isRegistration(registration)) {
      continue
    }
    if (registration.harness === harness && registration.sessionId === sessionId) {
      registrations.push(registration)
    }
  }
  return registrations.toSorted((left, right) =>
    left.registeredAt.localeCompare(right.registeredAt)
  )
}

export function isSettled(state: RunState): boolean {
  return SETTLED_STATUSES.has(state.status)
}

export async function waitForRun(runDir: string, intervalMilliseconds = 500): Promise<RunState> {
  for (;;) {
    const state = await readRunState(runDir)
    if (isSettled(state)) {
      return state
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMilliseconds))
  }
}

export async function waitForOwnedRun(
  harness: WakeHarness,
  sessionId: string,
  intervalMilliseconds = 500
): Promise<SettledRun | null> {
  for (;;) {
    const registrations = await listWakes(harness, sessionId)
    if (registrations.length === 0) {
      return null
    }
    for (const registration of registrations) {
      // A run whose state is missing, unreadable, or unparseable can never
      // settle through this registration, so it is cleared like a removed run
      // and the wait continues on the session's other runs — one damaged
      // state.json must not wedge wake delivery for the whole session. The
      // damaged run itself remains inspectable via `orchestrate status`.
      const state = await readRunState(runDirectory(registration.runId)).catch(() => null)
      if (state === null || typeof state !== "object" || typeof state.status !== "string") {
        await clearWake(registration)
        continue
      }
      if (isSettled(state)) {
        await clearWake(registration)
        return { registration, state }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMilliseconds))
  }
}
