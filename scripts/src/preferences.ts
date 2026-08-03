import { Schema } from "effect"
import { mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"

import type {
  PreferenceScope,
  PreferencesFile,
  ProjectPreference,
  UiPreferenceLayer,
  UiPreferences
} from "./types.js"

import { PreferencesSchema } from "./schema.js"
import { atomicWriteJson, stateRoot } from "./state.js"

const MAX_PROJECTS = 20
const LOCK_WAIT_MS = 10_000
const LOCK_POLL_MS = 25
const decodePreferences = Schema.decodeUnknownSync(PreferencesSchema, {
  onExcessProperty: "error"
})

const DEFAULT_MATCHER = {
  type: "any" as const,
  provider: "any" as const,
  level: "any" as const,
  origin: "any" as const,
  id: "*"
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  board: "split-right",
  placement: {
    workspace: "dedicated",
    rules: [{ match: DEFAULT_MATCHER, surface: "tab" }],
    grouping: { by: "root-ancestor" },
    maxSplitsPerTab: 4
  },
  completedPanes: { agent: "keep-open", command: "close-success" },
  focus: "attention",
  continuation: {
    rules: [{ match: DEFAULT_MATCHER, autoContinue: true }]
  },
  notifications: {
    attention: "herdr",
    milestone: "herdr",
    progress: "board"
  }
}

function emptyUiLayer(): UiPreferenceLayer {
  return {
    board: null,
    placement: null,
    completedPanes: { agent: null, command: null },
    focus: null,
    continuation: null,
    notifications: { attention: null, milestone: null, progress: null }
  }
}

function emptyScope(updatedAt: string): PreferenceScope {
  return {
    updatedAt,
    ui: emptyUiLayer()
  }
}

export function preferencesPath(): string {
  return path.join(stateRoot(), "preferences.json")
}

export function preferencesDisabled(): boolean {
  return process.env.ORCHESTRATE_DISABLE_PREFS === "1"
}

function assertPreferences(value: unknown): asserts value is PreferencesFile {
  try {
    decodePreferences(value)
  } catch (error) {
    throw new Error(`Invalid preferences at ${preferencesPath()}: ${String(error)}`, {
      cause: error
    })
  }
  const preferences = value as PreferencesFile
  if (Object.keys(preferences.projects).length > MAX_PROJECTS) {
    throw new Error(`Preferences may contain at most ${MAX_PROJECTS} project layers.`)
  }
  for (const [projectPath, project] of Object.entries(preferences.projects)) {
    if (project.cwd !== projectPath || !path.isAbsolute(projectPath)) {
      throw new Error(`Invalid project preference key "${projectPath}".`)
    }
  }
  for (const scope of [preferences.global, ...Object.values(preferences.projects)]) {
    if (scope.ui.placement !== null) {
      assertPlacementRules(scope.ui.placement.rules)
    }
    if (scope.ui.continuation !== null) {
      assertContinuationRules(scope.ui.continuation.rules)
    }
  }
}

function isDefaultMatcher(match: UiPreferences["placement"]["rules"][number]["match"]): boolean {
  return (
    match.type === "any" &&
    match.provider === "any" &&
    match.level === "any" &&
    match.origin === "any" &&
    match.id === "*"
  )
}

function assertPlacementRules(rules: UiPreferences["placement"]["rules"]): void {
  if (!isDefaultMatcher(rules.at(-1)?.match ?? DEFAULT_MATCHER) || rules.length === 0) {
    throw new Error("Placement rules must end with the mandatory match-all default rule.")
  }
  if (rules.slice(0, -1).some((rule) => isDefaultMatcher(rule.match))) {
    throw new Error("Only the final placement rule may be the match-all default.")
  }
}

function assertContinuationRules(rules: UiPreferences["continuation"]["rules"]): void {
  if (!isDefaultMatcher(rules.at(-1)?.match ?? DEFAULT_MATCHER) || rules.length === 0) {
    throw new Error("Continuation rules must end with the mandatory match-all default rule.")
  }
  if (rules.slice(0, -1).some((rule) => isDefaultMatcher(rule.match))) {
    throw new Error("Only the final continuation rule may be the match-all default.")
  }
}

export function assertUiPreferences(value: UiPreferences): void {
  assertPlacementRules(value.placement.rules)
  assertContinuationRules(value.continuation.rules)
}

async function newPreferences(now: Date): Promise<PreferencesFile> {
  const updatedAt = now.toISOString()
  return {
    updatedAt,
    global: emptyScope(updatedAt),
    projects: {}
  }
}

export async function readPreferences(now = new Date()): Promise<PreferencesFile> {
  if (preferencesDisabled()) {
    return newPreferences(now)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(preferencesPath(), "utf8")) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return newPreferences(now)
    }
    throw error
  }
  assertPreferences(parsed)
  return parsed
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

async function tryAcquirePreferencesLock(lockPath: string): Promise<(() => Promise<void>) | null> {
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

async function withPreferencesLock<T>(action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(stateRoot(), "preferences.lock")
  await mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  while (Date.now() < deadline) {
    const release = await tryAcquirePreferencesLock(lockPath)
    if (release !== null) {
      try {
        return await action()
      } finally {
        await release()
      }
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }
  throw new Error("Timed out waiting for the preferences lock.")
}

async function writePreferences(value: PreferencesFile): Promise<void> {
  assertPreferences(value)
  await atomicWriteJson(preferencesPath(), value)
}

function projectScope(preferences: PreferencesFile, cwd: string): ProjectPreference | null {
  return preferences.projects[path.resolve(cwd)] ?? null
}

export interface UiPreferenceOrigins {
  readonly board: "default" | "global" | "project"
  readonly placement: "default" | "global" | "project"
  readonly completedPanes: {
    readonly agent: "default" | "global" | "project"
    readonly command: "default" | "global" | "project"
  }
  readonly focus: "default" | "global" | "project"
  readonly continuation: "default" | "global" | "project"
  readonly notifications: {
    readonly attention: "default" | "global" | "project"
    readonly milestone: "default" | "global" | "project"
    readonly progress: "default" | "global" | "project"
  }
}

type Origin = "default" | "global" | "project"

function resolveLayerValue<T>(
  project: T | null | undefined,
  global: T | null,
  fallback: T
): readonly [T, Origin] {
  if (project !== undefined && project !== null) {
    return [project, "project"]
  }
  if (global !== null) {
    return [global, "global"]
  }
  return [fallback, "default"]
}

export function mergeUiPreferences(
  global: UiPreferenceLayer,
  project: UiPreferenceLayer | null
): { readonly value: UiPreferences; readonly origins: UiPreferenceOrigins } {
  const board = resolveLayerValue(project?.board, global.board, DEFAULT_UI_PREFERENCES.board)
  const placement = resolveLayerValue(
    project?.placement,
    global.placement,
    DEFAULT_UI_PREFERENCES.placement
  )
  const agentPanes = resolveLayerValue(
    project?.completedPanes.agent,
    global.completedPanes.agent,
    DEFAULT_UI_PREFERENCES.completedPanes.agent
  )
  const commandPanes = resolveLayerValue(
    project?.completedPanes.command,
    global.completedPanes.command,
    DEFAULT_UI_PREFERENCES.completedPanes.command
  )
  const focus = resolveLayerValue(project?.focus, global.focus, DEFAULT_UI_PREFERENCES.focus)
  const continuation = resolveLayerValue(
    project?.continuation,
    global.continuation,
    DEFAULT_UI_PREFERENCES.continuation
  )
  const attention = resolveLayerValue(
    project?.notifications.attention,
    global.notifications.attention,
    DEFAULT_UI_PREFERENCES.notifications.attention
  )
  const milestone = resolveLayerValue(
    project?.notifications.milestone,
    global.notifications.milestone,
    DEFAULT_UI_PREFERENCES.notifications.milestone
  )
  const progress = resolveLayerValue(
    project?.notifications.progress,
    global.notifications.progress,
    DEFAULT_UI_PREFERENCES.notifications.progress
  )
  const value: UiPreferences = {
    board: board[0],
    placement: placement[0],
    completedPanes: { agent: agentPanes[0], command: commandPanes[0] },
    focus: focus[0],
    continuation: continuation[0],
    notifications: { attention: attention[0], milestone: milestone[0], progress: progress[0] }
  }
  assertUiPreferences(value)
  return {
    value,
    origins: {
      board: board[1],
      placement: placement[1],
      completedPanes: { agent: agentPanes[1], command: commandPanes[1] },
      focus: focus[1],
      continuation: continuation[1],
      notifications: { attention: attention[1], milestone: milestone[1], progress: progress[1] }
    }
  }
}

export async function uiPreferencesWithOrigins(cwd: string): Promise<{
  readonly value: UiPreferences
  readonly origins: UiPreferenceOrigins
}> {
  const preferences = await readPreferences()
  return mergeUiPreferences(preferences.global.ui, projectScope(preferences, cwd)?.ui ?? null)
}

function setNestedValue(target: unknown, segments: readonly string[], value: unknown): void {
  if (segments.length === 0) {
    throw new Error("UI preference path cannot be empty.")
  }
  let cursor = target as Record<string, unknown>
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment]
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      throw new Error(`UI preference path "${segments.join(".")}" does not exist.`)
    }
    cursor = next as Record<string, unknown>
  }
  const final = segments.at(-1) as string
  if (!Object.hasOwn(cursor, final)) {
    throw new Error(`UI preference path "${segments.join(".")}" does not exist.`)
  }
  cursor[final] = value
}

export async function setUiPreference(
  dottedPath: string,
  value: unknown,
  projectCwd: string | null
): Promise<PreferencesFile> {
  if (preferencesDisabled()) {
    throw new Error("Preferences are disabled by ORCHESTRATE_DISABLE_PREFS=1.")
  }
  return withPreferencesLock(async () => {
    const now = new Date().toISOString()
    const current = await readPreferences(new Date(now))
    const cwd = projectCwd === null ? null : path.resolve(projectCwd)
    const baseScope =
      cwd === null ? current.global : (current.projects[cwd] ?? { cwd, ...emptyScope(now) })
    const ui = structuredClone(baseScope.ui)
    const segments = dottedPath.split(".")
    const top = segments[0] as keyof UiPreferenceLayer
    if (segments.length > 1 && ui[top] === null) {
      const merged = mergeUiPreferences(current.global.ui, cwd === null ? null : baseScope.ui).value
      ;(ui as unknown as Record<string, unknown>)[top] = structuredClone(
        merged[top as keyof UiPreferences]
      )
    }
    setNestedValue(ui, segments, value)
    const scope = { ...baseScope, updatedAt: now, ui }
    const next: PreferencesFile =
      cwd === null
        ? { ...current, updatedAt: now, global: scope }
        : {
            ...current,
            updatedAt: now,
            projects: { ...current.projects, [cwd]: { ...scope, cwd } }
          }
    await writePreferences(next)
    return next
  })
}

export async function replaceUiPreferenceLayer(
  layer: UiPreferenceLayer,
  projectCwd: string | null
): Promise<PreferencesFile> {
  if (preferencesDisabled()) {
    throw new Error("Preferences are disabled by ORCHESTRATE_DISABLE_PREFS=1.")
  }
  return withPreferencesLock(async () => {
    const now = new Date().toISOString()
    const current = await readPreferences(new Date(now))
    const cwd = projectCwd === null ? null : path.resolve(projectCwd)
    const baseScope =
      cwd === null ? current.global : (current.projects[cwd] ?? { cwd, ...emptyScope(now) })
    const scope = { ...baseScope, updatedAt: now, ui: layer }
    const next: PreferencesFile =
      cwd === null
        ? { ...current, updatedAt: now, global: scope }
        : {
            ...current,
            updatedAt: now,
            projects: { ...current.projects, [cwd]: { ...scope, cwd } }
          }
    await writePreferences(next)
    return next
  })
}
