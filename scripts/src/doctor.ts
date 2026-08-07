import { access, mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { RunState, WorkflowSpec } from "./types.js"

import { crankRun, reconcileRun, startWorkflowRun, type CrankSurface } from "./crank.js"
import { HerdrSurface, requireHerdr } from "./herdr-surface.js"
import { DEFAULT_UI_PREFERENCES } from "./preferences.js"
import { compileProviderLaunchIdentity } from "./provider-launch.js"
import { herdrPluginHealth, installedBuild } from "./setup.js"
import {
  createRunId,
  readRunState,
  removeRun,
  runDirectory,
  runtimeBuild,
  stateRoot
} from "./state.js"
import { validateWorkflow } from "./validation.js"

declare const ORCHESTRATE_BUILD_EMBEDDED: string

export interface DoctorCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly build: string
  readonly checks: readonly DoctorCheck[]
}

export interface LiveDoctorReport {
  readonly ok: boolean
  readonly warning: string
  readonly runId: string
  readonly checks: readonly DoctorCheck[]
  readonly artifacts: { readonly workspace: string; readonly runDirectory: string } | null
  readonly cleaned: boolean
}

const LIVE_DOCTOR_TIMEOUT_MS = 180_000
const LIVE_DOCTOR_MAX_STARTS = 3
const LIVE_DOCTOR_CLOSE_ATTEMPTS = 3
export const LIVE_DOCTOR_WARNING =
  "This opt-in diagnostic launches Codex and Claude and may incur provider usage charges."

let liveDoctorHookForTests: (() => Promise<LiveDoctorReport>) | null = null

export function injectLiveDoctorHookForTests(hook: (() => Promise<LiveDoctorReport>) | null): void {
  if (typeof ORCHESTRATE_BUILD_EMBEDDED === "string") {
    throw new TypeError("Live-doctor injection is unavailable in embedded production builds.")
  }
  liveDoctorHookForTests = hook
}

let doctorReportHookForTests: (() => Promise<DoctorReport>) | null = null

export function injectDoctorReportHookForTests(hook: (() => Promise<DoctorReport>) | null): void {
  if (typeof ORCHESTRATE_BUILD_EMBEDDED === "string") {
    throw new TypeError("Doctor-report injection is unavailable in embedded production builds.")
  }
  doctorReportHookForTests = hook
}

export async function doctorReport(): Promise<DoctorReport> {
  if (doctorReportHookForTests !== null) {
    return doctorReportHookForTests()
  }
  const checks: DoctorCheck[] = []
  try {
    checks.push({ name: "herdr", ok: true, detail: await requireHerdr() })
  } catch (error) {
    checks.push({ name: "herdr", ok: false, detail: String(error) })
  }
  const plugin = await herdrPluginHealth()
  checks.push({ name: "herdr-plugin", ...plugin })
  for (const provider of ["codex", "claude"] as const) {
    try {
      const identity = await compileProviderLaunchIdentity(provider)
      checks.push({ name: provider, ok: true, detail: identity.entry.canonicalPath })
    } catch (error) {
      checks.push({
        name: provider,
        ok: false,
        detail: `${error instanceof Error ? error.message : String(error)} (optional until used)`
      })
    }
  }
  try {
    const state = await stat(stateRoot())
    if (!state.isDirectory()) {
      throw new Error(`${stateRoot()} is not a directory.`)
    }
    await access(stateRoot(), 2)
    checks.push({ name: "state", ok: true, detail: stateRoot() })
  } catch (error) {
    checks.push({ name: "state", ok: false, detail: String(error) })
  }
  const staged = await installedBuild()
  checks.push({
    name: "installed-build",
    ok: staged === runtimeBuild(),
    detail:
      staged === null
        ? "not installed; run orchestrate setup"
        : staged === runtimeBuild()
          ? staged
          : `installed ${staged}; CLI ${runtimeBuild()}; rerun orchestrate setup`
  })
  return {
    ok: checks
      .filter((check) => check.name !== "codex" && check.name !== "claude")
      .every((check) => check.ok),
    build: runtimeBuild(),
    checks
  }
}

function liveDoctorWorkflow(workspacePath: string): WorkflowSpec {
  const workspace = {
    mode: "existing" as const,
    path: workspacePath,
    vcs: "none" as const,
    writes: [],
    exclusiveResources: []
  }
  return {
    name: "orchestrate-live-doctor",
    objective:
      "Verify native provider launch, authenticated completion, durable handoff, scheduling, and terminal settlement.",
    cwd: workspacePath,
    concurrency: 1,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: LIVE_DOCTOR_MAX_STARTS },
    writeConflicts: "reject",
    nodes: [
      {
        id: "codex-probe",
        type: "agent",
        title: "Codex native probe",
        needs: [],
        cwd: null,
        workspace,
        inputs: [],
        retry: { maxAttempts: 1 },
        gate: "none",
        provider: "codex",
        model: "provider-default",
        effort: null,
        prompt:
          "This is an authorized live diagnostic. Do not edit files. Return exactly CODEX-LIVE-OK.",
        session: { mode: "fresh", from: null, saveAs: null },
        permissions: {
          access: "read-only",
          escalation: "deny",
          extraArgs: [],
          inheritEnv: [],
          env: {}
        },
        output: { format: "text", schema: null }
      },
      {
        id: "claude-probe",
        type: "agent",
        title: "Claude handoff probe",
        needs: ["codex-probe"],
        cwd: null,
        workspace,
        inputs: [
          {
            from: "codex-probe",
            as: "Codex diagnostic result",
            include: "content",
            round: "current"
          }
        ],
        retry: { maxAttempts: 1 },
        gate: "none",
        provider: "claude",
        model: "provider-default",
        effort: null,
        prompt:
          "This is an authorized live diagnostic. Do not edit files. Confirm the collaborator result is CODEX-LIVE-OK, then return exactly CLAUDE-LIVE-OK: CODEX-LIVE-OK.",
        session: { mode: "fresh", from: null, saveAs: null },
        permissions: {
          access: "read-only",
          escalation: "deny",
          extraArgs: [],
          inheritEnv: [],
          env: {}
        },
        output: { format: "text", schema: null }
      },
      {
        id: "terminal-probe",
        type: "command",
        title: "Terminal scheduling probe",
        needs: ["claude-probe"],
        cwd: null,
        workspace,
        inputs: [],
        retry: { maxAttempts: 1 },
        gate: "none",
        argv: ["/usr/bin/true"],
        mutates: false,
        inheritEnv: [],
        env: {},
        allowedExitCodes: [0]
      }
    ],
    repeats: []
  }
}

export interface LiveDoctorPaneSurface {
  closePane(paneId: string): Promise<void>
  paneExists(paneId: string): Promise<boolean>
}

export interface LiveDoctorSurface extends CrankSurface, LiveDoctorPaneSurface {}

export async function closeLiveDoctorPanes(
  paneIds: ReadonlySet<string>,
  surface: LiveDoctorPaneSurface
): Promise<void> {
  const failures: string[] = []
  for (const paneId of paneIds) {
    let lastError: unknown = null
    let closed = false
    for (let attempt = 1; attempt <= LIVE_DOCTOR_CLOSE_ATTEMPTS; attempt += 1) {
      try {
        await surface.closePane(paneId)
      } catch (error) {
        lastError = error
      }
      try {
        if (!(await surface.paneExists(paneId))) {
          closed = true
          break
        }
        lastError = new Error(`pane still exists after close attempt ${attempt}`)
      } catch (error) {
        lastError = error
      }
    }
    if (!closed) {
      failures.push(
        `${paneId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      )
    }
  }
  if (failures.length > 0) {
    throw new Error(`Could not stop live diagnostic pane(s): ${failures.join("; ")}`)
  }
}

function liveDoctorPaneIds(...states: readonly (RunState | null)[]): ReadonlySet<string> {
  return new Set(
    states.flatMap((state) =>
      state === null
        ? []
        : Object.values(state.nodes).flatMap((node) =>
            node.attempts.flatMap((attempt) => (attempt.pane === null ? [] : [attempt.pane.paneId]))
          )
    )
  )
}

function doctorErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === "string") {
    return error
  }
  try {
    return JSON.stringify(error) ?? "unknown error"
  } catch {
    return "unserializable error"
  }
}

export async function quiesceLiveDoctorRun(
  runDir: string,
  fallbackState: RunState | null,
  surface: LiveDoctorSurface
): Promise<RunState | null> {
  let current = fallbackState
  let stopError: unknown = null
  try {
    current = await readRunState(runDir, { repair: true })
  } catch {
    // If creation reached Herdr, durable run persistence preceded it. Keep any
    // fallback pane IDs when a run failed before a readable snapshot existed.
  }
  if (current !== null && (current.status === "running" || current.status === "paused")) {
    try {
      current = (await crankRun(runDir, { type: "stop" }, { surface })).state
    } catch (error) {
      stopError = error
    }
  }
  let latest = current
  try {
    latest = await readRunState(runDir, { repair: true })
  } catch {
    // Keep the last readable state for exact pane shutdown.
  }
  await closeLiveDoctorPanes(liveDoctorPaneIds(fallbackState, current, latest), surface)
  if (stopError !== null) {
    throw new Error(
      `Diagnostic panes were closed, but the retained run could not be marked stopped: ${doctorErrorMessage(stopError)}`
    )
  }
  return latest
}

export function matchesLiveDoctorResult(result: unknown, expected: string): boolean {
  return typeof result === "string" && result.trim() === expected
}

export async function runLiveDoctorDiagnostic(): Promise<LiveDoctorReport> {
  if (liveDoctorHookForTests !== null) {
    return liveDoctorHookForTests()
  }
  const workspace = await mkdtemp(path.join(os.tmpdir(), "orchestrate-live-doctor-"))
  const runId = createRunId()
  const runDir = runDirectory(runId)
  const checks: DoctorCheck[] = []
  const validated = validateWorkflow(liveDoctorWorkflow(workspace))
  const previousDisableUi = process.env.ORCHESTRATE_DISABLE_UI
  process.env.ORCHESTRATE_DISABLE_UI = "1"
  let finalState: RunState | null = null
  const surface = new HerdrSurface()
  try {
    if (validated.workflow === null || validated.digest === null) {
      throw new Error("The internal live diagnostic workflow failed validation.")
    }
    for (const provider of ["codex", "claude"] as const) {
      await compileProviderLaunchIdentity(provider)
    }
    const ui = {
      ...DEFAULT_UI_PREFERENCES,
      focus: "never" as const,
      notifications: { attention: "silent", milestone: "silent", progress: "silent" } as const
    }
    const started = await startWorkflowRun(validated.workflow, ui, {
      runId,
      digest: validated.digest,
      allowWriteConflicts: false,
      surface
    })
    finalState = started.state
    const deadline = Date.now() + LIVE_DOCTOR_TIMEOUT_MS
    while (
      !["completed", "failed", "stopped"].includes(finalState.status) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
      finalState = (await reconcileRun(runDir, { surface })).state
    }
    if (finalState.status !== "completed") {
      throw new Error(
        finalState.status === "failed"
          ? (finalState.error ?? "The live diagnostic workflow failed.")
          : `The live diagnostic did not finish within ${LIVE_DOCTOR_TIMEOUT_MS / 1_000} seconds.`
      )
    }
    const codexOk = matchesLiveDoctorResult(
      finalState.nodes["codex-probe"]?.result,
      "CODEX-LIVE-OK"
    )
    const claudeOk = matchesLiveDoctorResult(
      finalState.nodes["claude-probe"]?.result,
      "CLAUDE-LIVE-OK: CODEX-LIVE-OK"
    )
    const commandOk = finalState.nodes["terminal-probe"]?.status === "completed"
    const bounded = finalState.starts === LIVE_DOCTOR_MAX_STARTS
    checks.push(
      {
        name: "live-codex-authenticated",
        ok: codexOk,
        detail: codexOk ? "authenticated result accepted" : "unexpected Codex result"
      },
      {
        name: "live-codex-to-claude-handoff",
        ok: claudeOk,
        detail: claudeOk ? "durable input consumed" : "unexpected Claude handoff result"
      },
      {
        name: "live-downstream-command",
        ok: commandOk,
        detail: commandOk ? "/usr/bin/true completed" : "command did not complete"
      },
      {
        name: "live-terminal-bounds",
        ok: bounded,
        detail: `${finalState.starts}/${LIVE_DOCTOR_MAX_STARTS} starts; run ${finalState.status}`
      }
    )
    if (!checks.every((check) => check.ok)) {
      throw new Error("One or more live diagnostic boundaries produced an unexpected result.")
    }
    finalState = await quiesceLiveDoctorRun(runDir, finalState, surface)
    checks.push({
      name: "live-pane-shutdown",
      ok: true,
      detail: "all recorded diagnostic panes are closed"
    })
    await removeRun(runDir)
    await rm(workspace, { recursive: true, force: true })
    return {
      ok: true,
      warning: LIVE_DOCTOR_WARNING,
      runId,
      checks,
      artifacts: null,
      cleaned: true
    }
  } catch (error) {
    let shutdownError: unknown = null
    try {
      finalState = await quiesceLiveDoctorRun(runDir, finalState, surface)
      checks.push({
        name: "live-pane-shutdown",
        ok: true,
        detail: "all recorded diagnostic panes are closed; durable failure artifacts retained"
      })
    } catch (candidate) {
      shutdownError = candidate
      checks.push({
        name: "live-pane-shutdown",
        ok: false,
        detail: candidate instanceof Error ? candidate.message : String(candidate)
      })
    }
    checks.push({
      name: "live-diagnostic",
      ok: false,
      detail: [
        error instanceof Error ? error.message : String(error),
        ...(shutdownError === null
          ? []
          : [
              "Pane shutdown could not be confirmed; use the retained run path to stop the named panes immediately."
            ])
      ].join(" ")
    })
    return {
      ok: false,
      warning: LIVE_DOCTOR_WARNING,
      runId,
      checks,
      artifacts: { workspace, runDirectory: runDir },
      cleaned: false
    }
  } finally {
    if (previousDisableUi === undefined) {
      delete process.env.ORCHESTRATE_DISABLE_UI
    } else {
      process.env.ORCHESTRATE_DISABLE_UI = previousDisableUi
    }
  }
}
