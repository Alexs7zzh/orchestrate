import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  NodeRunState,
  PendingRevision,
  RunState,
  ValidationIssue,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

import {
  gateApprovalDigest,
  legacyPendingPatchDigest,
  launchWorker,
  pendingPatchDigest,
  runWorker,
  supervisorInputDigest
} from "./engine.js"
import {
  captureApprovedPatch,
  captureApprovedWorkflow,
  capturePreferencesSafely,
  formatMergedPreferences,
  mergedPreferences,
  preferencesDisabled
} from "./preferences.js"
import { runProcessEffect, terminateRecordedProcessTree } from "./process.js"
import {
  buildRunReport,
  isLimitPauseCode,
  modelLabel,
  runReportText,
  topologicalRows
} from "./report.js"
import { emitEvent } from "./runtime/event-journal.js"
import { hasCodexWakeHook, installCodexWakeHook } from "./runtime/harness-hooks.js"
import { liveInteractiveNodes } from "./runtime/interactive.js"
import {
  closeMirrorWorkspace,
  herdrCliAvailable,
  mirrorDisabled,
  mirrorRequestedByEnvironment
} from "./runtime/mirror.js"
import {
  detectedWakeOwner,
  registerWake,
  waitForOwnedRun,
  waitForRun,
  type WakeHarness
} from "./runtime/wake-registry.js"
import {
  CONTRACT_VERSION,
  acquireWorkerLock,
  appendEvent,
  atomicWriteJson,
  createRun,
  eventsPath,
  isExpectedWorker,
  isProcessAlive,
  listRunStates,
  pauseRequestPath,
  readJson,
  readRunState,
  removeRun,
  resolveRunDirectory,
  runDirectory,
  stateRoot,
  stopRequestPath,
  workflowPath,
  writeRunState
} from "./state.js"
import { canonicalize, overlappingMutableNodes, validateWorkflow } from "./validation.js"

const usage = `orchestrate — design-approved, adaptive agent workflows

Usage:
  orchestrate validate <workflow.json> [--json]
  orchestrate preview <workflow.json>
  orchestrate run <workflow.json> --approve <sha256> [options]
  orchestrate status <run-id> [--json]
  orchestrate report <run-id> [--json]
  orchestrate wait <run-id> [--interval <seconds>] [--json]
  orchestrate watch <run-id> [--interval <seconds>] [--once]
  orchestrate events <run-id> [--json]
  orchestrate result <run-id> <node-id> [--attempt <n>]
  orchestrate pause <run-id>
  orchestrate stop <run-id>
  orchestrate resume <run-id> [--approve-patch <sha256>] [--approve-revision <sha256>] [--respond <text> --input-digest <sha256>] [--approve-gate <node-id> --gate-digest <sha256>] [--override-limit] [--override-emergency-fuse]
  orchestrate revise <run-id> <revised-workflow.json>
  orchestrate revise <run-id> --discard
  orchestrate node-done <run-id> <node-id> --token <token> --outcome <completed|failed>
  orchestrate wake <run-id> [--harness <codex|claude> --session <id>]
  orchestrate runs [--json]
  orchestrate prefs [--project <path>]
  orchestrate clean <run-id>
  orchestrate setup [--force] [--no-hooks]
  orchestrate doctor

Run options:
  --allow-write-conflicts      Record explicit approval of write-safety warnings.
  --override-emergency-fuse    Disable the high-tolerance process-start fuse.
  --foreground                 Run in this process instead of detaching.
  --no-wake                    Do not bind this run to the current harness session.
  --mirror                     Mirror the run into read-only herdr panes (presentation only).

Resume options:
  --approve-revision <sha256>  Apply the pending human revision proposed with "orchestrate revise".
  --override-limit             Continue past the specific approved limit that paused the run.
  --recover                    Recover a stale run after verifying its worker is gone.
  --mirror                     Enable herdr mirroring for the resumed run.

Environment:
  ORCHESTRATE_STATE_DIR        Override ~/.local/state/orchestrate.
  XDG_STATE_HOME               Set the state base when ORCHESTRATE_STATE_DIR is unset.
  ORCHESTRATE_DISABLE_PREFS    Set to 1 to disable preference detection and capture.
  ORCHESTRATE_DISABLE_AUTO_WAKE Set to 1 to disable harness-session wake registration.
  ORCHESTRATE_MIRROR           Set to "herdr" to mirror every run as if --mirror were passed.
  ORCHESTRATE_DISABLE_MIRROR   Set to 1 to hard-disable herdr mirroring everywhere.
`

interface ParsedArgs {
  readonly positionals: readonly string[]
  readonly flags: ReadonlyMap<string, string | true>
}

const VALUE_FLAGS = new Set([
  "approve",
  "interval",
  "approve-patch",
  "approve-revision",
  "respond",
  "input-digest",
  "approve-gate",
  "gate-digest",
  "attempt",
  "project",
  "harness",
  "session",
  "marker",
  "token",
  "outcome"
])

const KNOWN_FLAGS = new Set([
  ...VALUE_FLAGS,
  "json",
  "discard",
  "allow-write-conflicts",
  "override-emergency-fuse",
  "override-limit",
  "recover",
  "foreground",
  "once",
  "force",
  "no-hooks",
  "no-wake",
  "mirror"
])

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] as string
    if (!value.startsWith("--")) {
      positionals.push(value)
      continue
    }
    const equal = value.indexOf("=")
    if (equal !== -1) {
      flags.set(value.slice(2, equal), value.slice(equal + 1))
      continue
    }
    const name = value.slice(2)
    const following = args[index + 1]
    const followingFlag =
      following !== undefined && following.startsWith("--")
        ? (following.slice(2).split("=", 1)[0] as string)
        : null
    // A value flag consumes the next token — including arbitrary dash-prefixed
    // values like --respond "--starts-with-dash" — unless that token is itself
    // a recognized flag, which signals a genuinely missing value; flagString
    // then reports it. Use --name=value for values that collide with flag
    // names.
    if (
      VALUE_FLAGS.has(name) &&
      following !== undefined &&
      (followingFlag === null || !KNOWN_FLAGS.has(followingFlag))
    ) {
      flags.set(name, following)
      index += 1
    } else {
      flags.set(name, true)
    }
  }
  return { positionals, flags }
}

function requirePositional(parsed: ParsedArgs, index: number, label: string): string {
  const value = parsed.positionals[index]
  if (value === undefined) {
    throw new Error(`Missing ${label}.`)
  }
  return value
}

function flagString(parsed: ParsedArgs, name: string): string | null {
  const value = parsed.flags.get(name)
  if (value === undefined) {
    return null
  }
  if (value === true) {
    throw new Error(`--${name} requires a value.`)
  }
  return value
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name)
}

function validateCliShape(
  command: string,
  parsed: ParsedArgs,
  positionalCount: number,
  allowedFlags: readonly string[]
): void {
  if (parsed.positionals.length > positionalCount) {
    throw new Error(`Command "${command}" received unexpected positional arguments.`)
  }
  const allowed = new Set(allowedFlags)
  for (const flag of parsed.flags.keys()) {
    if (!allowed.has(flag)) {
      throw new Error(`Unknown flag "--${flag}" for command "${command}".`)
    }
  }
}

async function loadValidatedWorkflow(filePath: string): Promise<{
  readonly workflow: WorkflowSpec
  readonly digest: string
  readonly issues: readonly ValidationIssue[]
}> {
  const absolute = path.resolve(filePath)
  const raw = JSON.parse(await readFile(absolute, "utf8")) as unknown
  const result = validateWorkflow(raw)
  if (result.workflow === null || result.digest === null) {
    throw new Error(formatIssues(result.issues))
  }
  return { workflow: result.workflow, digest: result.digest, issues: result.issues }
}

function formatIssues(issues: readonly ValidationIssue[]): string {
  if (issues.length === 0) {
    return "No validation issues."
  }
  return issues
    .map(
      (issue) => `${issue.severity === "error" ? "ERROR" : "WARN "} ${issue.code}: ${issue.message}`
    )
    .join("\n")
}

function formatLimit(value: number | null, unit: string): string {
  return value === null ? "unbounded" : `${value} ${unit}`
}

function contextLabel(node: WorkflowNode): string {
  if (node.type === "command") {
    return "n/a"
  }
  const suffix = node.session.saveAs === null ? "" : ` → ${node.session.saveAs}`
  const repeat = node.session.reuseOnRepeat ? "; repeats resume saved session" : ""
  return node.session.mode === "fresh"
    ? `fresh${node.session.retain ? ", retained" : ", disposable"}${suffix}${repeat}`
    : `${node.session.mode} ${node.session.from ?? "?"}${suffix}${repeat}`
}

function permissionLabel(node: WorkflowNode): string {
  if (node.type === "command") {
    return `command argv=${JSON.stringify(node.argv)}; mutates=${node.mutates}; inheritEnv=${JSON.stringify(node.inheritEnv)}; envKeys=${JSON.stringify(Object.keys(node.env))}`
  }
  const permission =
    node.provider === "codex"
      ? node.permissions.sandbox
      : node.provider === "claude"
        ? node.permissions.permissionMode
        : "test-only"
  const extra =
    node.permissions.extraArgs.length === 0
      ? ""
      : `; extraArgs=${JSON.stringify(node.permissions.extraArgs)}`
  const environment = `; inheritEnv=${JSON.stringify(node.permissions.inheritEnv)}; envKeys=${JSON.stringify(Object.keys(node.permissions.env))}`
  return `${permission ?? "unspecified"}${extra}${environment}`
}

function redactWorkflowSecrets(workflow: WorkflowSpec): WorkflowSpec {
  const redacted = JSON.parse(JSON.stringify(workflow)) as WorkflowSpec
  const callback = redacted.heartbeat.callback
  if (callback.type === "webhook") {
    const mutableCallback = callback as unknown as {
      headers: Readonly<Record<string, string>>
    }
    mutableCallback.headers = Object.fromEntries(
      Object.keys(callback.headers).map((key) => [key, "<redacted>"])
    )
  }
  for (const node of redacted.nodes) {
    if (node.type === "command") {
      const mutableCommand = node as unknown as {
        env: Readonly<Record<string, string>>
      }
      mutableCommand.env = Object.fromEntries(
        Object.keys(node.env).map((key) => [key, "<redacted>"])
      )
    } else {
      const mutablePermissions = node.permissions as unknown as {
        env: Readonly<Record<string, string>>
      }
      mutablePermissions.env = Object.fromEntries(
        Object.keys(node.permissions.env).map((key) => [key, "<redacted>"])
      )
    }
    if (node.type === "supervisor") {
      const mutableEnvelope = node.envelope as unknown as {
        allowedCommandEnv: readonly Readonly<Record<string, string>>[]
        allowedProviderEnv: readonly Readonly<Record<string, string>>[]
      }
      mutableEnvelope.allowedCommandEnv = node.envelope.allowedCommandEnv.map((environment) =>
        Object.fromEntries(Object.keys(environment).map((key) => [key, "<redacted>"]))
      )
      mutableEnvelope.allowedProviderEnv = node.envelope.allowedProviderEnv.map((environment) =>
        Object.fromEntries(Object.keys(environment).map((key) => [key, "<redacted>"]))
      )
    }
  }
  return redacted
}

export function previewText(
  workflow: WorkflowSpec,
  digest: string,
  issues: readonly ValidationIssue[]
): string {
  const redactedWorkflow = redactWorkflowSecrets(workflow)
  const lines = [
    `Workflow: ${workflow.name}`,
    `Objective: ${workflow.objective}`,
    `Working directory: ${workflow.cwd}`,
    `Approval digest: ${digest}`,
    "",
    "DAG:",
    ...topologicalRows(workflow.nodes).map((node) => {
      const needs = node.needs.length === 0 ? "start" : node.needs.join(",")
      const writes =
        node.workspace.writes.length === 0 ? "none declared" : node.workspace.writes.join(",")
      const gate = node.gate === "approval" ? " | GATED: pauses for approval before start" : ""
      const interactive =
        node.type === "agent" && node.interactive
          ? " | INTERACTIVE: runs as a live TUI in herdr; human may participate"
          : ""
      return `  ${node.id} <- [${needs}] | ${modelLabel(node)} | ${contextLabel(node)} | permission: ${permissionLabel(node)} | declared writes: ${writes}${gate}${interactive}`
    }),
    "",
    "Execution decisions:",
    `  Concurrency: ${workflow.concurrency}`,
    `  Heartbeat: ${
      workflow.heartbeat.intervalMinutes === null
        ? "milestones only / disabled interval"
        : `every ${workflow.heartbeat.intervalMinutes} minutes`
    }`,
    `  Milestone callbacks: ${workflow.heartbeat.milestones ? "yes" : "no"}`,
    `  Callback: ${JSON.stringify(redactedWorkflow.heartbeat.callback)}`,
    `  Node wall-time: ${formatLimit(workflow.limits.nodeWallTimeMinutes, "minutes")}`,
    `  Workflow wall-time: ${formatLimit(workflow.limits.workflowWallTimeMinutes, "minutes")}`,
    `  Agent starts: ${formatLimit(workflow.limits.maxAgentStarts, "starts")}`,
    `  Goal rounds: ${formatLimit(workflow.limits.maxGoalRounds, "rounds")}`,
    `  Write conflicts: ${workflow.writeConflicts}`,
    "",
    formatIssues(issues),
    "",
    "Digest-bound workflow JSON (header/env values redacted; digest binds the original file):",
    JSON.stringify(redactedWorkflow, null, 2)
  ]
  return lines.join("\n")
}

function summarizeState(state: RunState, workerAlive: boolean): string {
  const pendingRevision = state.pendingRevision ?? null
  const counts = new Map<string, number>()
  for (const node of Object.values(state.nodes)) {
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1)
  }
  const countText = [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(" ")
  return [
    `Run: ${state.id}`,
    `Workflow: ${state.workflowName}`,
    `Status: ${state.status}${workerAlive || state.pid === null ? "" : " (worker not alive)"}`,
    `Nodes: ${countText || "none"}`,
    `Agent starts: ${state.agentStarts}`,
    `Created: ${state.createdAt}`,
    `Updated: ${state.updatedAt}`,
    ...(state.pauseReason === null ? [] : [`Paused: ${state.pauseReason}`]),
    ...(state.error === null ? [] : [`Error: ${state.error}`]),
    // The full node-done command (token included) is shown deliberately: the
    // human reading this is the legitimate operator, and the report shares
    // the state file's trust domain. The token only guards other contexts.
    ...Object.values(state.nodes)
      .filter((node) => node.status === "running" && (node.interactive ?? null) !== null)
      .flatMap((node) => {
        const record = node.interactive as NonNullable<typeof node.interactive>
        return [
          `Awaiting interactive node "${node.id}" (attempt ${record.attempt}) in herdr pane ${record.paneId ?? "(opening)"} since ${record.startedAt}${record.idleSince === null ? "" : `; looks idle since ${record.idleSince}`}.`,
          `  Complete with: orchestrate node-done ${state.id} ${node.id} --token ${record.token} --outcome completed`
        ]
      }),
    ...(state.pendingPatch === null
      ? []
      : [
          `Pending adaptive patch from ${state.pendingPatch.supervisorId}:`,
          ...state.pendingPatch.reasons.map((reason) => `  - ${reason}`),
          `Patch approval digest: ${state.pendingPatch.digest}`,
          "Proposed decision:",
          JSON.stringify(state.pendingPatch.decision, null, 2)
        ]),
    ...(state.pendingInput === null
      ? []
      : [
          `Pending supervisor input from ${state.pendingInput.supervisorId}: ${state.pendingInput.reason}`,
          `Input digest: ${state.pendingInput.digest}`,
          `Resume with --respond <text> --input-digest ${state.pendingInput.digest}`
        ]),
    ...(state.pendingGate === null
      ? []
      : [
          `Pending approval gate before node ${state.pendingGate.nodeId} ("${state.pendingGate.title}").`,
          `Gate digest: ${state.pendingGate.digest}`,
          `Rendered content: orchestrate report ${state.id} (bounded) or orchestrate status ${state.id} --json (full)`,
          `Resume with --approve-gate ${state.pendingGate.nodeId} --gate-digest ${state.pendingGate.digest}`
        ]),
    ...(pendingRevision === null
      ? []
      : [
          `Pending human revision proposed at ${pendingRevision.createdAt}:`,
          ...pendingRevision.summary.map((line) => `  - ${line}`),
          `Revision digest: ${pendingRevision.digest}`,
          `Apply with: orchestrate resume ${state.id} --approve-revision ${pendingRevision.digest}`,
          `Discard with: orchestrate revise ${state.id} --discard`
        ])
  ].join("\n")
}

function settledExitCode(state: RunState): number {
  return state.status === "completed" ? 0 : state.status === "paused" ? 2 : 1
}

// Resolves the presentation-only mirroring choice at launch/resume time.
// --mirror demands a usable herdr CLI and fails cleanly without one; the
// always-on ORCHESTRATE_MIRROR=herdr environment variable degrades to a
// stderr note instead. ORCHESTRATE_DISABLE_MIRROR=1 wins over both.
function requestedMirror(parsed: ParsedArgs): "herdr" | null {
  if (mirrorDisabled()) {
    return null
  }
  const flagged = hasFlag(parsed, "mirror")
  if (!flagged && !mirrorRequestedByEnvironment()) {
    return null
  }
  if (!herdrCliAvailable()) {
    if (flagged) {
      throw new Error(
        "--mirror requires the herdr CLI on PATH (https://herdr.dev); no usable herdr was found."
      )
    }
    console.error(
      "ORCHESTRATE_MIRROR=herdr is set but no usable herdr CLI is on PATH; mirroring is disabled for this run."
    )
    return null
  }
  return "herdr"
}

// Interactive nodes are executed inside herdr panes — herdr is their
// execution substrate, not presentation — so launching or resuming a run
// whose pending nodes include one requires a usable herdr CLI up front.
function requireHerdrForInteractiveNodes(nodeIds: readonly string[]): void {
  if (nodeIds.length === 0) {
    return
  }
  if (!herdrCliAvailable()) {
    throw new Error(
      `Interactive node${nodeIds.length === 1 ? "" : "s"} ${nodeIds
        .map((id) => `"${id}"`)
        .join(
          ", "
        )} run as live TUIs in herdr panes; the herdr CLI is required on PATH (https://herdr.dev), and no usable herdr was found.`
    )
  }
}

async function registerCurrentHarnessWake(runId: string, disabled: boolean): Promise<void> {
  if (disabled || process.env.ORCHESTRATE_DISABLE_AUTO_WAKE === "1") {
    return
  }
  const owner = detectedWakeOwner()
  if (owner === null) {
    return
  }
  await registerWake(owner.harness, owner.sessionId, runId)
  console.log(`Wake: registered ${owner.harness} session attention for ${runId}.`)
}

async function waitForWorkerStart(runDir: string, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const state = await readRunState(runDir)
    if (
      (state.pid === pid && state.workerToken !== null && state.status === "running") ||
      ["completed", "failed", "paused", "stopped"].includes(state.status)
    ) {
      return
    }
    if (!isProcessAlive(pid)) {
      const workerError = await readFile(path.join(runDir, "worker-error.log"), "utf8").catch(
        () => ""
      )
      throw new Error(
        `Worker ${pid} exited before startup was acknowledged.${
          workerError.length === 0 ? "" : `\n${workerError.slice(-4000)}`
        }`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Worker ${pid} did not acknowledge startup within 5 seconds.`)
}

async function commandValidate(parsed: ParsedArgs): Promise<number> {
  const filePath = requirePositional(parsed, 0, "workflow file")
  const absolute = path.resolve(filePath)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(absolute, "utf8"))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  const result = validateWorkflow(raw)
  if (hasFlag(parsed, "json")) {
    const redacted =
      result.workflow === null
        ? result
        : { ...result, workflow: redactWorkflowSecrets(result.workflow) }
    console.log(JSON.stringify(redacted, null, 2))
  } else {
    console.log(formatIssues(result.issues))
    if (result.digest !== null) {
      console.log(`Digest: ${result.digest}`)
    }
  }
  return result.workflow === null || result.issues.some((issue) => issue.severity === "error")
    ? 1
    : 0
}

async function commandPreview(parsed: ParsedArgs): Promise<number> {
  const loaded = await loadValidatedWorkflow(requirePositional(parsed, 0, "workflow file"))
  console.log(previewText(loaded.workflow, loaded.digest, loaded.issues))
  return loaded.issues.some((issue) => issue.severity === "error") ? 1 : 0
}

async function commandRun(parsed: ParsedArgs, scriptPath: string): Promise<number> {
  const loaded = await loadValidatedWorkflow(requirePositional(parsed, 0, "workflow file"))
  const errors = loaded.issues.filter((issue) => issue.severity === "error")
  if (errors.length > 0) {
    throw new Error(formatIssues(errors))
  }
  const approval = flagString(parsed, "approve")
  if (approval === null || approval !== loaded.digest) {
    throw new Error(
      "Run approval is missing or does not match this file. Re-run `orchestrate preview` and obtain explicit user approval of the new preview before launching; pass only the digest the user approved."
    )
  }
  const conflictWarnings = loaded.issues.filter(
    (issue) => issue.code === "write-conflict" || issue.code === "unknown-writes"
  )
  const allowWriteConflicts = hasFlag(parsed, "allow-write-conflicts")
  if (conflictWarnings.length > 0 && !allowWriteConflicts) {
    throw new Error(
      `${formatIssues(conflictWarnings)}\nRe-run only after explicit user approval with --allow-write-conflicts.`
    )
  }
  requireHerdrForInteractiveNodes(
    loaded.workflow.nodes
      .filter((node) => node.type === "agent" && node.interactive)
      .map((node) => node.id)
  )
  const mirror = requestedMirror(parsed)
  await capturePreferencesSafely(() => captureApprovedWorkflow(loaded.workflow))
  const { runDir, state } = await createRun(
    loaded.workflow,
    loaded.digest,
    allowWriteConflicts,
    hasFlag(parsed, "override-emergency-fuse"),
    mirror
  )
  console.log(`Run: ${state.id}`)
  console.log(`State: ${runDir}`)
  if (hasFlag(parsed, "foreground")) {
    await runWorker(runDir)
    const finished = await readRunState(runDir)
    console.log(summarizeState(finished, await isExpectedWorker(finished.pid, runDir)))
    return finished.status === "completed" ? 0 : 1
  }
  const pid = launchWorker(scriptPath, runDir)
  await waitForWorkerStart(runDir, pid)
  await registerCurrentHarnessWake(state.id, hasFlag(parsed, "no-wake"))
  console.log(`Worker PID: ${pid}`)
  console.log(`Watch: orchestrate watch ${state.id}`)
  return 0
}

async function commandStatus(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  const state = await readRunState(runDir)
  console.log(
    hasFlag(parsed, "json")
      ? JSON.stringify(state, null, 2)
      : summarizeState(state, await isExpectedWorker(state.pid, runDir))
  )
  return state.status === "failed" ? 1 : state.status === "paused" ? 2 : 0
}

// Read-only rendered digest of a run: header, needs-attention, per-node
// bounded result summaries, and supervisor rounds. Reads state, workflow, and
// events without touching the run lock, so it never interferes with a live
// worker.
async function commandReport(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  const state = await readRunState(runDir)
  const report = await buildRunReport(runDir, state, await isExpectedWorker(state.pid, runDir))
  console.log(hasFlag(parsed, "json") ? JSON.stringify(report, null, 2) : runReportText(report))
  return state.status === "failed" ? 1 : state.status === "paused" ? 2 : 0
}

async function commandWait(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  const intervalValue = flagString(parsed, "interval")
  const intervalSeconds = intervalValue === null ? 0.5 : Number(intervalValue)
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("--interval must be a positive number of seconds.")
  }
  const state = await waitForRun(runDir, intervalSeconds * 1000)
  console.log(
    hasFlag(parsed, "json")
      ? JSON.stringify(state)
      : summarizeState(state, await isExpectedWorker(state.pid, runDir))
  )
  return settledExitCode(state)
}

export async function readNewEvents(
  filePath: string,
  position: number
): Promise<{ readonly position: number; readonly lines: readonly string[] }> {
  let handle
  try {
    handle = await open(filePath, "r")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { position, lines: [] }
    }
    throw error
  }
  try {
    const size = (await handle.stat()).size
    if (size <= position) {
      return { position, lines: [] }
    }
    const buffer = Buffer.alloc(size - position)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    // Only bytes up to the last newline are consumed; a partially appended
    // trailing line is re-read on the next poll once it is complete. Splitting
    // at a newline byte keeps multi-byte UTF-8 sequences intact.
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (lastNewline === -1) {
      return { position, lines: [] }
    }
    const content = buffer.subarray(0, lastNewline + 1).toString("utf8")
    return {
      position: position + lastNewline + 1,
      lines: content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    }
  } finally {
    await handle.close()
  }
}

function printEventLine(line: string): void {
  try {
    const event = JSON.parse(line) as {
      timestamp: string
      type: string
      message: string
      nodeId?: string
    }
    console.log(
      `${event.timestamp} ${event.type}${event.nodeId === undefined ? "" : ` [${event.nodeId}]`}: ${event.message}`
    )
  } catch {
    console.log(line)
  }
}

async function commandWatch(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  const once = hasFlag(parsed, "once")
  const intervalValue = flagString(parsed, "interval")
  const intervalSeconds = intervalValue === null ? 1 : Number(intervalValue)
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("--interval must be a positive number of seconds.")
  }
  let position = 0
  for (;;) {
    const update = await readNewEvents(eventsPath(runDir), position)
    position = update.position
    for (const line of update.lines) {
      printEventLine(line)
    }
    const state = await readRunState(runDir)
    if (once || ["completed", "failed", "paused", "stopped"].includes(state.status)) {
      console.log(summarizeState(state, await isExpectedWorker(state.pid, runDir)))
      return state.status === "completed" ? 0 : state.status === "paused" ? 2 : 1
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000))
  }
}

async function commandEvents(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  const update = await readNewEvents(eventsPath(runDir), 0)
  if (hasFlag(parsed, "json")) {
    const events = update.lines.map((line) => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        return { raw: line }
      }
    })
    console.log(JSON.stringify(events, null, 2))
    return 0
  }
  for (const line of update.lines) {
    printEventLine(line)
  }
  return 0
}

async function commandResult(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  const nodeId = requirePositional(parsed, 1, "node id")
  const state = await readRunState(runDir)
  const node = state.nodes[nodeId]
  if (node === undefined) {
    throw new Error(`Run ${state.id} has no node "${nodeId}".`)
  }
  const attemptValue = flagString(parsed, "attempt")
  let resultPath: string
  if (attemptValue === null) {
    if (node.resultPath === null) {
      throw new Error(`Node "${nodeId}" in run ${state.id} has no recorded result yet.`)
    }
    resultPath = node.resultPath
  } else {
    const attempt = Number(attemptValue)
    if (!Number.isInteger(attempt) || attempt <= 0) {
      throw new Error("--attempt must be a positive integer.")
    }
    resultPath = path.join(runDir, "nodes", nodeId, `attempt-${attempt}`, "result.txt")
  }
  let content: string
  try {
    content = await readFile(resultPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Node "${nodeId}" in run ${state.id} has no result at ${resultPath}.`, {
        cause: error
      })
    }
    throw error
  }
  process.stdout.write(content)
  return 0
}

async function commandStop(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  const state = await readRunState(runDir)
  if (!(await isExpectedWorker(state.pid, runDir))) {
    // A paused run has no worker to honor a stop request, so it is finalized
    // directly. The read-check-write must hold the run lock so it cannot
    // interleave with a concurrent resume observing the same paused state.
    const releaseLock = await acquireWorkerLock(runDir, `cli-${randomUUID()}`, "cli")
    try {
      const current = await readRunState(runDir)
      if (current.status !== "paused") {
        throw new Error(`Run ${current.id} has no live worker.`)
      }
      const validation = validateWorkflow(await readJson<unknown>(workflowPath(runDir)))
      if (
        validation.workflow === null ||
        validation.digest === null ||
        validation.digest !== current.digest
      ) {
        throw new Error(
          `Stored workflow integrity check failed before stopping paused run ${current.id}.`
        )
      }
      // The event lands before the terminal state so a watcher that observes
      // "stopped" always finds run.stopped already on disk.
      await emitEvent(
        validation.workflow,
        runDir,
        current,
        "run.stopped",
        `Stopped paused run ${current.id} without a live worker.`,
        undefined,
        undefined,
        true
      )
      await Promise.all([
        rm(stopRequestPath(runDir), { force: true }),
        rm(pauseRequestPath(runDir), { force: true })
      ])
      const now = new Date().toISOString()
      await writeRunState(runDir, {
        ...current,
        status: "stopped",
        pid: null,
        workerToken: null,
        finishedAt: now,
        updatedAt: now
      })
    } finally {
      await releaseLock()
    }
    console.log(`Stopped paused run ${state.id}.`)
    return 0
  }
  await atomicWriteJson(stopRequestPath(runDir), {
    requestedAt: new Date().toISOString(),
    workerToken: state.workerToken
  })
  console.log(`Stop requested for ${state.id}.`)
  return 0
}

async function commandPause(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  const state = await readRunState(runDir)
  if (state.status === "paused") {
    console.log(`Run ${state.id} is already paused.`)
    return 0
  }
  if (["completed", "failed", "stopped"].includes(state.status)) {
    throw new Error(`Run ${state.id} is ${state.status} and cannot be paused.`)
  }
  if (!(await isExpectedWorker(state.pid, runDir))) {
    throw new Error(
      `Run ${state.id} has no live worker. Recover it first with: orchestrate resume ${state.id} --recover`
    )
  }
  if (state.status === "pausing") {
    console.log(`Run ${state.id} is already pausing at a node boundary.`)
    return 0
  }
  if (state.status === "stopping") {
    throw new Error(`Run ${state.id} is stopping and cannot be paused.`)
  }
  await atomicWriteJson(pauseRequestPath(runDir), {
    requestedAt: new Date().toISOString(),
    workerToken: state.workerToken
  })
  console.log(`Pause requested for ${state.id}; running nodes will finish before it pauses.`)
  return 0
}

// A node with any executed attempt — or currently holding a non-pending
// lifecycle state — is immutable under a human revision: its recorded history
// must keep describing exactly the node object that produced it.
function nodeHasExecuted(nodeState: NodeRunState | undefined): boolean {
  return (
    nodeState !== undefined &&
    (nodeState.attempts > 0 ||
      nodeState.status === "completed" ||
      nodeState.status === "running" ||
      nodeState.status === "cancelled")
  )
}

interface RevisionDiff {
  readonly errors: readonly string[]
  readonly summary: readonly string[]
  readonly removedNodeIds: readonly string[]
  readonly changedWorkflowFields: readonly string[]
}

// Diffs a complete revised workflow against the stored one under the mid-run
// invariants: identity fields never change, executed nodes stay byte-identical
// (canonical compare) and are never removed, and only pending nodes may be
// added, modified, or removed. Structural validity of the result is the
// caller's separate revalidation concern.
function diffWorkflowRevision(
  stored: WorkflowSpec,
  revised: WorkflowSpec,
  state: RunState
): RevisionDiff {
  const errors: string[] = []
  for (const field of ["version", "name", "cwd"] as const) {
    if (canonicalize(stored[field]) !== canonicalize(revised[field])) {
      errors.push(
        `Workflow "${field}" may not change in a revision (stored ${JSON.stringify(
          stored[field]
        )}, revised ${JSON.stringify(revised[field])}).`
      )
    }
  }
  const changedWorkflowFields = (
    ["objective", "concurrency", "heartbeat", "limits", "writeConflicts"] as const
  ).filter((field) => canonicalize(stored[field]) !== canonicalize(revised[field]))
  const revisedById = new Map(revised.nodes.map((node) => [node.id, node]))
  const storedIds = new Set(stored.nodes.map((node) => node.id))
  const modified: string[] = []
  const removed: string[] = []
  for (const node of stored.nodes) {
    const nodeState = state.nodes[node.id]
    const executed = nodeHasExecuted(nodeState)
    const revisedNode = revisedById.get(node.id)
    if (revisedNode === undefined) {
      if (executed) {
        errors.push(
          `Node "${node.id}" has executed (status ${nodeState?.status ?? "unknown"}, attempts ${
            nodeState?.attempts ?? 0
          }) and may not be removed by a revision.`
        )
      } else {
        removed.push(node.id)
      }
      continue
    }
    if (canonicalize(node) === canonicalize(revisedNode)) {
      continue
    }
    if (executed) {
      errors.push(
        `Node "${node.id}" has executed (status ${nodeState?.status ?? "unknown"}, attempts ${
          nodeState?.attempts ?? 0
        }) and must stay byte-identical in a revision.`
      )
    } else {
      modified.push(node.id)
    }
  }
  const dynamicIds = new Set(state.dynamicNodes.map((node) => node.id))
  const added = revised.nodes
    .filter((node) => !storedIds.has(node.id))
    .map((node) => node.id)
    .filter((id) => {
      if (dynamicIds.has(id)) {
        errors.push(`New node id "${id}" collides with a supervisor-added dynamic node.`)
        return false
      }
      return true
    })
  const summary = [
    ...(added.length === 0 ? [] : [`Added nodes: ${added.join(", ")}`]),
    ...(modified.length === 0 ? [] : [`Modified nodes: ${modified.join(", ")}`]),
    ...(removed.length === 0 ? [] : [`Removed nodes: ${removed.join(", ")}`]),
    ...(changedWorkflowFields.length === 0
      ? []
      : [`Changed workflow fields: ${changedWorkflowFields.join(", ")}`])
  ]
  return {
    errors,
    summary: summary.length === 0 ? ["No changes relative to the stored workflow."] : summary,
    removedNodeIds: removed,
    changedWorkflowFields
  }
}

// Write-conflict pairs a revision would introduce beyond what the stored
// workflow (plus already-approved dynamic nodes) could produce.
function newWriteConflicts(
  stored: WorkflowSpec,
  revised: WorkflowSpec,
  state: RunState
): readonly [string, string][] {
  const before = new Set(
    overlappingMutableNodes({
      ...stored,
      nodes: [...stored.nodes, ...state.dynamicNodes]
    }).map(([left, right]) => `${left}\0${right}`)
  )
  return overlappingMutableNodes({
    ...revised,
    nodes: [...revised.nodes, ...state.dynamicNodes]
  }).filter(([left, right]) => !before.has(`${left}\0${right}`))
}

// Verifies stored-workflow integrity and the invariants once more, then
// atomically-in-effect swaps the revision in: the prior workflow is archived
// under revisions/<n>-workflow.json, workflow.json becomes the revised
// document, run.revised is journaled, and now-stale approval state is cleared
// so changed nodes re-gate and dangling supervisor requests disappear. The
// caller holds the CLI run lock.
async function applyRevisionUnderLock(
  runDir: string,
  state: RunState,
  revisedWorkflow: WorkflowSpec,
  revisionDigest: string
): Promise<RunState> {
  const stored = validateWorkflow(await readJson<unknown>(workflowPath(runDir)))
  if (stored.workflow === null || stored.digest === null || stored.digest !== state.digest) {
    throw new Error(
      `Stored workflow integrity check failed before applying the revision to run ${state.id}.`
    )
  }
  const diff = diffWorkflowRevision(stored.workflow, revisedWorkflow, state)
  if (diff.errors.length > 0) {
    throw new Error(
      [
        `The pending revision for run ${state.id} no longer satisfies the mid-run invariants:`,
        ...diff.errors.map((error) => `  - ${error}`)
      ].join("\n")
    )
  }
  const revisionsDir = path.join(runDir, "revisions")
  await mkdir(revisionsDir, { recursive: true })
  const sequence =
    (await readdir(revisionsDir)).filter((name) => /^\d+-workflow\.json$/.test(name)).length + 1
  await atomicWriteJson(path.join(revisionsDir, `${sequence}-workflow.json`), stored.workflow)
  await atomicWriteJson(workflowPath(runDir), revisedWorkflow)
  await appendEvent(runDir, {
    timestamp: new Date().toISOString(),
    runId: state.id,
    type: "run.revised",
    message: `Applied approved human revision ${revisionDigest} (revision ${sequence}); the prior workflow is archived at revisions/${sequence}-workflow.json.`,
    data: {
      digest: revisionDigest,
      previousDigest: state.digest,
      archive: `revisions/${sequence}-workflow.json`,
      summary: diff.summary
    }
  })
  const storedById = new Map(stored.workflow.nodes.map((node) => [node.id, node]))
  const revisedById = new Map(revisedWorkflow.nodes.map((node) => [node.id, node]))
  // True when the revision touched this node: nodes it never mentioned
  // (dynamic nodes, unknown ids) keep their recorded approval state.
  const changedOrRemoved = (nodeId: string): boolean => {
    const storedNode = storedById.get(nodeId)
    if (storedNode === undefined) {
      return false
    }
    const revisedNode = revisedById.get(nodeId)
    return revisedNode === undefined || canonicalize(storedNode) !== canonicalize(revisedNode)
  }
  const removedIds = new Set(diff.removedNodeIds)
  const nodes: Record<string, NodeRunState> = Object.fromEntries(
    Object.entries(state.nodes).filter(([id]) => !removedIds.has(id))
  )
  for (const node of revisedWorkflow.nodes) {
    nodes[node.id] ??= {
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
  }
  const gateStale = state.pendingGate !== null && changedOrRemoved(state.pendingGate.nodeId)
  const inputStale =
    state.pendingInput !== null && changedOrRemoved(state.pendingInput.supervisorId)
  const patchStale =
    state.pendingPatch !== null && changedOrRemoved(state.pendingPatch.supervisorId)
  // Revised limits govern from now on: a limit pause loses its override
  // requirement when the revision changed the limits, and the worker
  // re-checks the new values before scheduling anything.
  const limitPauseSuperseded =
    diff.changedWorkflowFields.includes("limits") && isLimitPauseCode(state.pauseCode)
  const updated: RunState = {
    ...state,
    digest: revisionDigest,
    workflowName: revisedWorkflow.name,
    objective: revisedWorkflow.objective,
    nodes,
    // Changed gated nodes re-gate with freshly rendered content.
    satisfiedGates: state.satisfiedGates.filter((id) => !changedOrRemoved(id)),
    pendingGate: gateStale ? null : state.pendingGate,
    approvedPendingGate: gateStale ? false : state.approvedPendingGate,
    pendingInput: inputStale ? null : state.pendingInput,
    pendingPatch: patchStale ? null : state.pendingPatch,
    approvedPendingPatch: patchStale ? false : state.approvedPendingPatch,
    pendingRevision: null,
    pauseReason: limitPauseSuperseded ? null : state.pauseReason,
    pauseCode: limitPauseSuperseded ? null : state.pauseCode,
    updatedAt: new Date().toISOString()
  }
  await writeRunState(runDir, updated)
  return updated
}

async function commandRevise(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  if (hasFlag(parsed, "discard")) {
    if (parsed.positionals.length > 1) {
      throw new Error("revise --discard takes no revised workflow file.")
    }
    const releaseLock = await acquireWorkerLock(runDir, `cli-${randomUUID()}`, "cli")
    try {
      const state = await readRunState(runDir)
      const pending = state.pendingRevision ?? null
      if (pending === null) {
        console.log(`Run ${state.id} has no pending revision to discard.`)
        return 0
      }
      await appendEvent(runDir, {
        timestamp: new Date().toISOString(),
        runId: state.id,
        type: "run.revision-discarded",
        message: `Discarded the pending human revision ${pending.digest}.`
      })
      await writeRunState(runDir, {
        ...state,
        pendingRevision: null,
        updatedAt: new Date().toISOString()
      })
      console.log(`Discarded pending revision ${pending.digest} for run ${state.id}.`)
    } finally {
      await releaseLock()
    }
    return 0
  }
  const loaded = await loadValidatedWorkflow(requirePositional(parsed, 1, "revised workflow file"))
  const loadedErrors = loaded.issues.filter((issue) => issue.severity === "error")
  if (loadedErrors.length > 0) {
    throw new Error(formatIssues(loadedErrors))
  }
  // The read-check-write below must hold the run lock so it cannot interleave
  // with a concurrent resume or stop observing the same paused state.
  const releaseLock = await acquireWorkerLock(runDir, `cli-${randomUUID()}`, "cli")
  try {
    const state = await readRunState(runDir)
    if (state.status !== "paused") {
      throw new Error(
        `Run ${state.id} is ${state.status}; a revision requires a paused run. Pause it first with: orchestrate pause ${state.id}`
      )
    }
    const stored = validateWorkflow(await readJson<unknown>(workflowPath(runDir)))
    if (stored.workflow === null || stored.digest === null || stored.digest !== state.digest) {
      throw new Error(
        `Stored workflow integrity check failed for run ${state.id}; refusing to diff a revision against it.`
      )
    }
    const diff = diffWorkflowRevision(stored.workflow, loaded.workflow, state)
    if (diff.errors.length > 0) {
      throw new Error(
        [
          "The revision violates the mid-run invariants:",
          ...diff.errors.map((error) => `  - ${error}`)
        ].join("\n")
      )
    }
    // Already-approved dynamic nodes stay in the run, so the revised document
    // must also stand together with them (dangling needs, duplicate ids).
    if (state.dynamicNodes.length > 0) {
      const merged = validateWorkflow({
        ...loaded.workflow,
        nodes: [...loaded.workflow.nodes, ...state.dynamicNodes]
      })
      const mergedErrors = merged.issues.filter(
        (issue) => issue.severity === "error" && issue.code !== "write-conflict"
      )
      if (mergedErrors.length > 0) {
        throw new Error(
          `The revision does not stand together with this run's approved dynamic nodes:\n${formatIssues(mergedErrors)}`
        )
      }
    }
    const conflicts = newWriteConflicts(stored.workflow, loaded.workflow, state)
    const pendingRevision: PendingRevision = {
      workflow: loaded.workflow,
      digest: loaded.digest,
      summary: diff.summary,
      createdAt: new Date().toISOString()
    }
    const replaced = state.pendingRevision ?? null
    await appendEvent(runDir, {
      timestamp: new Date().toISOString(),
      runId: state.id,
      type: "run.revision-proposed",
      message: `Proposed a human revision with digest ${loaded.digest}${
        replaced === null ? "" : `, replacing pending revision ${replaced.digest}`
      }: ${diff.summary.join("; ")}`,
      data: { digest: loaded.digest, summary: diff.summary }
    })
    await writeRunState(runDir, {
      ...state,
      pendingRevision,
      updatedAt: new Date().toISOString()
    })
    console.log(`Proposed revision for run ${state.id}:`)
    for (const line of diff.summary) {
      console.log(`  ${line}`)
    }
    for (const [left, right] of conflicts) {
      console.log(
        `  WARN write-conflict: potential parallel write overlap between "${left}" and "${right}".`
      )
    }
    if (replaced !== null) {
      console.log(`  Replaces the previously pending revision ${replaced.digest}.`)
    }
    console.log(`Revision digest: ${loaded.digest}`)
    console.log(`Apply with: orchestrate resume ${state.id} --approve-revision ${loaded.digest}`)
    console.log(`Discard with: orchestrate revise ${state.id} --discard`)
  } finally {
    await releaseLock()
  }
  return 0
}

async function commandResume(parsed: ParsedArgs, scriptPath: string): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  // A resumed run whose PENDING nodes include an interactive node needs the
  // herdr CLI just like launch does; fail cleanly before touching run state.
  try {
    const currentState = await readRunState(runDir)
    const storedWorkflow = await readJson<WorkflowSpec>(workflowPath(runDir))
    requireHerdrForInteractiveNodes(
      liveInteractiveNodes(storedWorkflow, currentState).map((node) => node.id)
    )
  } catch (error) {
    if (error instanceof Error && error.message.includes("herdr CLI is required")) {
      throw error
    }
    // An unreadable workflow/state surfaces through the normal resume path.
  }
  // Hold the run lock across the read-check-write sequence so two concurrent
  // resumes cannot both observe "paused" and race their state writes. The
  // lock is released before launching the worker; the worker then takes it.
  const releaseLock = await acquireWorkerLock(runDir, `cli-${randomUUID()}`, "cli")
  try {
    await resumeUnderLock(parsed, runDir)
  } finally {
    await releaseLock()
  }
  const state = await readRunState(runDir)
  const pid = launchWorker(scriptPath, runDir)
  await waitForWorkerStart(runDir, pid)
  await registerCurrentHarnessWake(state.id, hasFlag(parsed, "no-wake"))
  console.log(`Resumed ${state.id} with worker PID ${pid}.`)
  return 0
}

async function resumeUnderLock(parsed: ParsedArgs, runDir: string): Promise<void> {
  let state = await readRunState(runDir)
  const recover = hasFlag(parsed, "recover")
  if (state.status !== "paused") {
    if (!recover || !["running", "starting", "pausing", "stopping"].includes(state.status)) {
      throw new Error(
        `Only paused runs can resume normally; ${state.id} is ${state.status}. Use --recover only for a stale worker.`
      )
    }
    if (await isExpectedWorker(state.pid, runDir)) {
      throw new Error(`Run ${state.id} still has a live verified worker; recovery was refused.`)
    }
    if (state.contractVersion !== CONTRACT_VERSION) {
      throw new Error(
        `Run ${state.id} uses runtime contract ${state.contractVersion ?? "unversioned"}; recovery requires contract ${CONTRACT_VERSION} and was refused before signaling recorded processes.`
      )
    }
    const storedValidation = validateWorkflow(await readJson<unknown>(workflowPath(runDir)))
    if (storedValidation.workflow === null || storedValidation.digest === null) {
      throw new Error(
        `Stored workflow for run ${state.id} is invalid; recovery was refused before signaling recorded processes.`
      )
    }
    if (storedValidation.digest !== state.digest) {
      throw new Error(
        `Stored workflow for run ${state.id} no longer matches its approved digest; recovery was refused before signaling recorded processes.`
      )
    }
    for (const node of Object.values(state.nodes).filter(
      (candidate) => candidate.status === "running"
    )) {
      const termination = await terminateRecordedProcessTree(node.processPid, node.processIdentity)
      if (termination === "unverified") {
        throw new Error(
          `Could not verify recorded child process ${node.processPid} for node "${node.id}". Recovery was refused to avoid signaling an unrelated process.`
        )
      }
    }
    // MVP recovery policy for interactive nodes: the TUI is herdr's child and
    // survives a worker crash, but its done-token dies with the failed
    // attempt. Recovery fails the in-flight attempt (a retry gets a fresh
    // token and tab) and tells the user the old pane may still be open.
    for (const node of Object.values(state.nodes).filter(
      (candidate) => candidate.status === "running" && (candidate.interactive ?? null) !== null
    )) {
      await appendEvent(runDir, {
        timestamp: new Date().toISOString(),
        runId: state.id,
        type: "node.interactive.recovered",
        nodeId: node.id,
        message: `Interactive node "${node.id}" was in flight when the worker died; recovery failed that attempt and its node-done token is void. Its herdr pane ${node.interactive?.paneId ?? "(unknown)"} may still be open and can be closed manually; any retry opens a fresh pane with a new token.`
      })
    }
    const storedWorkflow = storedValidation.workflow
    const definitions = new Map(
      [...storedWorkflow.nodes, ...state.dynamicNodes].map((node) => [node.id, node])
    )
    const exhausted = Object.values(state.nodes).filter(
      (node) =>
        node.status === "running" &&
        node.attempts >= (definitions.get(node.id)?.retry.maxAttempts ?? 0)
    )
    if (exhausted.length > 0) {
      state = {
        ...state,
        status: "failed",
        pid: null,
        workerToken: null,
        error: `Recovery cannot rerun nodes whose retry budget is exhausted: ${exhausted
          .map((node) => node.id)
          .join(", ")}.`,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        nodes: Object.fromEntries(
          Object.entries(state.nodes).map(([id, node]) => [
            id,
            exhausted.some((candidate) => candidate.id === id)
              ? {
                  ...node,
                  status: "failed" as const,
                  finishedAt: new Date().toISOString(),
                  error: "The worker exited during the final approved attempt.",
                  processPid: null,
                  processIdentity: null,
                  interactive: null
                }
              : node
          ])
        )
      }
      await writeRunState(runDir, state)
      throw new Error(state.error ?? "Recovery retry budget is exhausted.")
    }
    state = {
      ...state,
      nodes: Object.fromEntries(
        Object.entries(state.nodes).map(([id, node]) => [
          id,
          node.status === "running"
            ? {
                ...node,
                status: "pending" as const,
                finishedAt: new Date().toISOString(),
                error: "Recovered after the previous worker exited without finalizing this node.",
                processPid: null,
                processIdentity: null,
                interactive: null
              }
            : node
        ])
      ),
      status: "paused",
      pid: null,
      workerToken: null,
      pauseReason: "Recovered stale worker state; interrupted nodes will retry.",
      pauseCode: "recovered-worker"
    }
  }
  const revisionApproval = flagString(parsed, "approve-revision")
  const pendingRevision = state.pendingRevision ?? null
  if (pendingRevision === null && revisionApproval !== null) {
    throw new Error(`Run ${state.id} has no pending revision.`)
  }
  if (pendingRevision !== null) {
    if (revisionApproval === null) {
      throw new Error(
        `Run ${state.id} has a pending human revision. Review it (orchestrate report ${state.id}) and pass --approve-revision ${pendingRevision.digest} only with user approval, or discard it with: orchestrate revise ${state.id} --discard`
      )
    }
    // The digest is recomputed from the stored revision content, so a
    // tampered pendingRevision can match neither its recorded digest nor the
    // digest the user approved.
    const revalidated = validateWorkflow(pendingRevision.workflow)
    if (
      revalidated.workflow === null ||
      revalidated.digest === null ||
      revalidated.digest !== pendingRevision.digest ||
      revalidated.issues.some((issue) => issue.severity === "error")
    ) {
      throw new Error(
        `Run ${state.id} has a pending revision whose stored content no longer matches its approval digest. Revision approval was refused.`
      )
    }
    if (revisionApproval !== pendingRevision.digest) {
      throw new Error(
        `Revision approval is stale. Review the pending revision and pass --approve-revision ${pendingRevision.digest}.`
      )
    }
    state = await applyRevisionUnderLock(runDir, state, revalidated.workflow, revalidated.digest)
  }
  if (
    state.pendingPatch !== null &&
    pendingPatchDigest(
      state.pendingPatch.supervisorId,
      state.pendingPatch.decision,
      state.pendingPatch.reasons
    ) !== state.pendingPatch.digest
  ) {
    if (legacyPendingPatchDigest(state.pendingPatch.decision) === state.pendingPatch.digest) {
      state = {
        ...state,
        pendingPatch: {
          ...state.pendingPatch,
          digest: pendingPatchDigest(
            state.pendingPatch.supervisorId,
            state.pendingPatch.decision,
            state.pendingPatch.reasons
          )
        },
        updatedAt: new Date().toISOString()
      }
      await writeRunState(runDir, state)
      throw new Error(
        `Run ${state.id} used a legacy patch approval digest. The digest was refreshed; review status and explicitly approve the newly displayed digest.`
      )
    }
    throw new Error(
      `Run ${state.id} has a pending patch whose decision no longer matches its approval digest. Patch approval was refused.`
    )
  }
  if (state.pendingPatch !== null && !hasFlag(parsed, "approve-patch")) {
    throw new Error(
      `Run ${state.id} has a pending out-of-envelope patch. Review status and pass --approve-patch ${state.pendingPatch.digest} only with user approval.`
    )
  }
  const response = flagString(parsed, "respond")
  const inputDigest = flagString(parsed, "input-digest")
  if (state.pendingInput !== null) {
    const currentInputDigest = supervisorInputDigest(
      state.pendingInput.supervisorId,
      state.pendingInput.reason,
      state.goalRounds[state.pendingInput.supervisorId] ?? 0
    )
    if (currentInputDigest !== state.pendingInput.digest) {
      throw new Error(
        `Run ${state.id} has pending supervisor input that no longer matches its approval digest. The response was refused.`
      )
    }
    if (response === null || inputDigest === null) {
      throw new Error(
        `Run ${state.id} requires a response to supervisor "${state.pendingInput.supervisorId}". Pass --respond <text> --input-digest ${state.pendingInput.digest}.`
      )
    }
    if (inputDigest !== state.pendingInput.digest) {
      throw new Error(
        `Supervisor input approval is stale. Review status and pass --input-digest ${state.pendingInput.digest}.`
      )
    }
  } else if (response !== null || inputDigest !== null) {
    throw new Error(`Run ${state.id} has no pending supervisor input.`)
  }
  const gateApproval = flagString(parsed, "approve-gate")
  const gateDigest = flagString(parsed, "gate-digest")
  if (state.pendingGate !== null) {
    const currentGateDigest = gateApprovalDigest(
      state.id,
      state.pendingGate.nodeId,
      state.pendingGate.content
    )
    if (currentGateDigest !== state.pendingGate.digest) {
      throw new Error(
        `Run ${state.id} has a pending approval gate whose content no longer matches its digest. Gate approval was refused.`
      )
    }
    if (gateApproval === null || gateDigest === null) {
      throw new Error(
        `Run ${state.id} is gated before node "${state.pendingGate.nodeId}". Review the rendered content (orchestrate report ${state.id}; full text via orchestrate status ${state.id} --json) and pass --approve-gate ${state.pendingGate.nodeId} --gate-digest ${state.pendingGate.digest} only with user approval.`
      )
    }
    if (gateApproval !== state.pendingGate.nodeId) {
      throw new Error(
        `Run ${state.id} is gated before node "${state.pendingGate.nodeId}", not "${gateApproval}".`
      )
    }
    if (gateDigest !== state.pendingGate.digest) {
      throw new Error(
        `Gate approval is stale. Review the rendered content again and pass --gate-digest ${state.pendingGate.digest}.`
      )
    }
  } else if (gateApproval !== null || gateDigest !== null) {
    throw new Error(`Run ${state.id} has no pending approval gate.`)
  }
  const patchApproval = flagString(parsed, "approve-patch")
  if (
    state.pendingPatch !== null &&
    patchApproval !== null &&
    patchApproval !== state.pendingPatch.digest
  ) {
    throw new Error(
      `Patch approval is stale. Review status and pass --approve-patch ${state.pendingPatch.digest}`
    )
  }
  const limitPause = isLimitPauseCode(state.pauseCode)
  if (limitPause && !hasFlag(parsed, "override-limit")) {
    throw new Error(
      `Run ${state.id} paused at approved limit "${state.pauseCode}". Pass --override-limit only with user approval.`
    )
  }
  if (state.pauseCode === "emergency-fuse" && !hasFlag(parsed, "override-emergency-fuse")) {
    throw new Error(
      `Run ${state.id} reached the emergency fuse. Pass --override-emergency-fuse only with user approval.`
    )
  }
  if (state.pendingPatch !== null && patchApproval !== null) {
    const stored = validateWorkflow(await readJson<unknown>(workflowPath(runDir)))
    const storedErrors = stored.issues.filter((issue) => issue.severity === "error")
    if (
      stored.workflow === null ||
      stored.digest === null ||
      stored.digest !== state.digest ||
      storedErrors.length > 0
    ) {
      throw new Error(
        `Stored workflow integrity check failed before patch approval.${
          storedErrors.length === 0 ? "" : `\n${formatIssues(storedErrors)}`
        }`
      )
    }
    const storedWorkflow = stored.workflow
    await capturePreferencesSafely(() =>
      captureApprovedPatch(storedWorkflow, state.pendingPatch?.decision.addNodes ?? [])
    )
  }
  const updated: RunState = {
    ...state,
    status: "starting",
    pid: null,
    pauseReason: null,
    pauseCode: null,
    // Presentation only: --mirror can turn mirroring on for this run;
    // otherwise the recorded choice from launch survives the resume.
    mirror: requestedMirror(parsed) ?? state.mirror ?? null,
    stopRequested: false,
    approvedPendingPatch: state.pendingPatch !== null && patchApproval !== null,
    // The pending gate stays in state so the worker can independently verify
    // the approved content against a fresh render before satisfying the gate.
    approvedPendingGate: state.pendingGate !== null && gateApproval !== null,
    supervisorResponses:
      state.pendingInput !== null && response !== null
        ? {
            ...state.supervisorResponses,
            [state.pendingInput.supervisorId]: {
              message: response,
              inputDigest: state.pendingInput.digest,
              respondedAt: new Date().toISOString()
            }
          }
        : state.supervisorResponses,
    pendingInput: null,
    emergencyFuseOverride:
      state.emergencyFuseOverride || hasFlag(parsed, "override-emergency-fuse"),
    overriddenLimits:
      limitPause && state.pauseCode !== null
        ? [...new Set([...state.overriddenLimits, state.pauseCode])]
        : state.overriddenLimits,
    updatedAt: new Date().toISOString()
  }
  await writeRunState(runDir, updated)
}

function nodeDoneTokenMatches(expected: string, provided: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(provided).digest()
  )
}

// Called from INSIDE an interactive node's TUI session per its prompt
// contract, without the worker being a parent: it validates the one-time
// token against durable state, then publishes an atomic done record that the
// worker's 500ms interactive poll picks up (control-request style).
async function commandNodeDone(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  const nodeId = requirePositional(parsed, 1, "node id")
  const token = flagString(parsed, "token")
  const outcome = flagString(parsed, "outcome")
  if (token === null || token.length === 0) {
    throw new Error("node-done requires --token <token> from the node's prompt contract.")
  }
  if (outcome !== "completed" && outcome !== "failed") {
    throw new Error('node-done requires --outcome "completed" or --outcome "failed".')
  }
  const state = await readRunState(runDir)
  const node = state.nodes[nodeId]
  if (node === undefined) {
    throw new Error(`Run ${state.id} has no node "${nodeId}".`)
  }
  const record = node.interactive ?? null
  if (node.status !== "running" || record === null) {
    throw new Error(
      `Node "${nodeId}" in run ${state.id} is not awaiting an interactive completion.`
    )
  }
  if (!nodeDoneTokenMatches(record.token, token)) {
    throw new Error(
      `The provided token does not match the pending interactive attempt for node "${nodeId}" in run ${state.id}.`
    )
  }
  const attemptDir = path.join(runDir, "nodes", nodeId, `attempt-${record.attempt}`)
  const resultPath = path.join(attemptDir, "result.txt")
  const resultSize = await stat(resultPath).then(
    (info) => info.size,
    () => 0
  )
  if (resultSize === 0) {
    throw new Error(
      `Write the result report first: ${resultPath} must exist and be non-empty, then re-run node-done.`
    )
  }
  // Exclusive, atomic publication: a fully written temp file is hard-linked
  // into place, so the worker can never read a torn record and a second
  // node-done call is rejected instead of silently overwriting the first.
  const donePath = path.join(attemptDir, "interactive-done.json")
  const temporary = `${donePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(
    temporary,
    `${JSON.stringify({ outcome, reportedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  )
  try {
    await link(temporary, donePath)
  } catch (error) {
    await rm(temporary, { force: true })
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Node "${nodeId}" in run ${state.id} already has a reported interactive outcome for attempt ${record.attempt}.`,
        { cause: error }
      )
    }
    throw error
  }
  await rm(temporary, { force: true })
  await appendEvent(runDir, {
    timestamp: new Date().toISOString(),
    runId: state.id,
    type: outcome === "completed" ? "node.interactive.completed" : "node.interactive.failed",
    nodeId,
    message: `Interactive node "${nodeId}" attempt ${record.attempt} reported outcome "${outcome}" via node-done.`
  })
  console.log(
    `Recorded interactive outcome "${outcome}" for node "${nodeId}" in run ${state.id}; the workflow worker finalizes the attempt within moments.`
  )
  return 0
}

const ACTIVE_RUN_STATUSES = ["starting", "running", "pausing", "stopping"] as const

async function commandRuns(parsed: ParsedArgs): Promise<number> {
  const { states, damaged } = await listRunStates()
  const rows = await Promise.all(
    states.map(async (state) => ({
      state,
      workerAlive:
        (ACTIVE_RUN_STATUSES as readonly string[]).includes(state.status) &&
        (await isExpectedWorker(state.pid, runDirectory(state.id)))
    }))
  )
  if (hasFlag(parsed, "json")) {
    console.log(
      JSON.stringify(
        {
          runs: rows.map(({ state, workerAlive }) => ({ ...state, workerAlive })),
          damaged: damaged.map((name) => ({ id: name, status: "damaged" }))
        },
        null,
        2
      )
    )
    return 0
  }
  if (rows.length === 0 && damaged.length === 0) {
    console.log(`No runs in ${stateRoot()}.`)
    return 0
  }
  for (const { state, workerAlive } of rows) {
    const status =
      (ACTIVE_RUN_STATUSES as readonly string[]).includes(state.status) && !workerAlive
        ? `${state.status} (worker dead)`
        : state.status
    console.log(`${state.id}  ${status.padEnd(9)}  ${state.workflowName}  ${state.updatedAt}`)
  }
  for (const name of damaged) {
    console.log(`${name}  damaged`)
  }
  return 0
}

async function commandPrefs(parsed: ParsedArgs): Promise<number> {
  if (preferencesDisabled()) {
    console.log("Preferences are disabled by ORCHESTRATE_DISABLE_PREFS=1.")
    return 0
  }
  const project = flagString(parsed, "project") ?? process.cwd()
  console.log(formatMergedPreferences(await mergedPreferences(project)))
  return 0
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false
    }
    throw error
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
}

async function cleanupWorktrees(runDir: string): Promise<void> {
  const state = await readRunState(runDir)
  if (await isExpectedWorker(state.pid, runDir)) {
    throw new Error(`Run ${state.id} is still active; stop it before cleaning.`)
  }
  const workflow = await readJson<WorkflowSpec>(workflowPath(runDir))
  const nodes = [...workflow.nodes, ...state.dynamicNodes]
  const processed = new Set<string>()
  const bases = new Set<string>()
  for (const node of nodes) {
    if (node.workspace.mode !== "git-worktree") {
      continue
    }
    const workspacePath = state.nodes[node.id]?.workspacePath
    if (workspacePath === null || workspacePath === undefined || processed.has(workspacePath)) {
      continue
    }
    processed.add(workspacePath)
    const base = path.resolve(node.cwd ?? workflow.cwd)
    bases.add(base)
    // A worktree that clean will not remove — an explicit external path with
    // removeOnClean=false — is left entirely alone: its dirtiness does not
    // block cleaning, because removing the run cannot touch it.
    if (!isPathInside(runDir, workspacePath) && !node.workspace.git?.removeOnClean) {
      continue
    }
    if (!(await pathExists(workspacePath))) {
      continue
    }
    let dirty = false
    const status = await Effect.runPromise(
      runProcessEffect({
        argv: ["git", "-C", workspacePath, "status", "--porcelain"],
        cwd: base,
        stdoutPath: path.join(runDir, "clean.log"),
        stderrPath: path.join(runDir, "clean-error.log"),
        timeoutMinutes: null,
        onStdoutLine: (line) => {
          if (line.trim().length > 0) {
            dirty = true
          }
        }
      })
    )
    if (status.exitCode !== 0) {
      throw new Error(`Could not inspect worktree ${workspacePath}; the run was not cleaned.`)
    }
    if (dirty) {
      throw new Error(
        `Worktree ${workspacePath} has uncommitted changes; the run was not cleaned. Commit or discard the changes, then clean again.`
      )
    }
    const result = await Effect.runPromise(
      runProcessEffect({
        argv: ["git", "-C", base, "worktree", "remove", workspacePath],
        cwd: base,
        stdoutPath: path.join(runDir, "clean.log"),
        stderrPath: path.join(runDir, "clean-error.log"),
        timeoutMinutes: null
      })
    )
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not safely remove worktree ${workspacePath}. It may contain changes; the run was not cleaned.`
      )
    }
  }
  // --expire now ensures freshly missing run-owned worktree metadata is
  // actually pruned; locked worktrees are exempt from pruning by Git itself.
  for (const base of bases) {
    await Effect.runPromise(
      runProcessEffect({
        argv: ["git", "-C", base, "worktree", "prune", "--expire", "now"],
        cwd: base,
        stdoutPath: path.join(runDir, "clean.log"),
        stderrPath: path.join(runDir, "clean-error.log"),
        timeoutMinutes: null
      })
    ).catch(() => undefined)
  }
}

async function commandClean(parsed: ParsedArgs): Promise<number> {
  const runId = requirePositional(parsed, 0, "run id")
  const runDir = await resolveRunDirectory(runId)
  await cleanupWorktrees(runDir)
  // Presentation only, best-effort: closing the run's herdr mirror workspace
  // (when one was recorded) never blocks or fails the clean.
  await closeMirrorWorkspace(runDir)
  const removed = await removeRun(runId)
  console.log(`Removed run ${removed}. This cannot be recovered from Orchestrate.`)
  return 0
}

function parseWakeHarness(value: string): WakeHarness {
  if (value !== "codex" && value !== "claude") {
    throw new Error('--harness must be either "codex" or "claude".')
  }
  return value
}

async function commandWake(parsed: ParsedArgs): Promise<number> {
  const runDir = await resolveRunDirectory(requirePositional(parsed, 0, "run id"))
  const state = await readRunState(runDir)
  const detected = detectedWakeOwner()
  const harnessValue = flagString(parsed, "harness")
  const sessionValue = flagString(parsed, "session")
  const harness = harnessValue === null ? detected?.harness : parseWakeHarness(harnessValue)
  const sessionId = sessionValue ?? detected?.sessionId
  if (harness === undefined || sessionId === undefined) {
    throw new Error(
      "Could not detect a Codex or Claude harness session. Pass both --harness and --session explicitly."
    )
  }
  await registerWake(harness, sessionId, state.id)
  console.log(`Wake: registered ${harness} session attention for ${state.id}.`)
  return 0
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function commandWakeHook(parsed: ParsedArgs): Promise<number> {
  const harness = parseWakeHarness(requirePositional(parsed, 0, "harness"))
  let input: {
    readonly session_id?: unknown
    readonly thread_id?: unknown
  }
  try {
    input = JSON.parse(await readStandardInput()) as typeof input
  } catch {
    return 0
  }
  // stop_hook_active is deliberately ignored: harnesses set it for every stop
  // in a continuation chain until the user sends a new message, so returning
  // early on it would strand later owned runs after the first wake. Progress
  // stays bounded because each block consumes exactly one registration and
  // harnesses cap consecutive blocked stops themselves.
  const rawSession = input.session_id ?? input.thread_id
  if (typeof rawSession !== "string" || rawSession.trim().length === 0) {
    return 0
  }
  const settled = await waitForOwnedRun(harness, rawSession).catch((error: unknown) => {
    console.error(
      `Orchestrate wake hook failed open: ${error instanceof Error ? error.message : String(error)}`
    )
    return null
  })
  if (settled === null) {
    return 0
  }
  const { state } = settled
  const instruction =
    state.status === "paused"
      ? `Orchestrate run ${state.id} paused and needs attention. Inspect its status and continue only with any required user approval.`
      : `Orchestrate run ${state.id} reached ${state.status}. Inspect its status and node results, continue any approved workflow work, and report the outcome to the user.`
  console.log(JSON.stringify({ decision: "block", reason: instruction }))
  return 0
}

async function pathLinkTarget(candidate: string): Promise<string | null> {
  try {
    const info = await lstat(candidate)
    return info.isSymbolicLink()
      ? path.resolve(path.dirname(candidate), await readlink(candidate))
      : ""
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw error
  }
}

async function commandSetup(parsed: ParsedArgs, scriptPath: string): Promise<number> {
  const force = hasFlag(parsed, "force")
  const binDir = path.join(os.homedir(), ".local", "bin")
  const commandPath = path.join(binDir, "orchestrate")
  await mkdir(binDir, { recursive: true })
  const existing = await pathLinkTarget(commandPath)
  const resolvedScript = path.resolve(scriptPath)
  if (existing === "") {
    if (!force) {
      throw new Error(
        `${commandPath} exists and is not a symlink. Re-run with --force to replace it.`
      )
    }
    await rename(commandPath, `${commandPath}.backup-${Date.now()}`)
  } else if (existing !== null && existing !== resolvedScript) {
    if (!force) {
      throw new Error(
        `${commandPath} points to ${existing}. Re-run with --force to replace the symlink.`
      )
    }
    await rename(commandPath, `${commandPath}.backup-${Date.now()}`)
  }
  if (existing !== resolvedScript) {
    await symlink(resolvedScript, commandPath)
  }
  await chmod(resolvedScript, 0o755)
  console.log(`Command: ${commandPath} -> ${resolvedScript}`)
  if (!hasFlag(parsed, "no-hooks")) {
    const hook = await installCodexWakeHook(commandPath)
    console.log(
      `${hook.changed ? "Installed" : "Ready"} Codex wake hook: ${hook.filePath}${
        hook.changed ? " (restart Codex and approve the hook when prompted)" : ""
      }`
    )
  }
  return 0
}

async function commandDoctor(scriptPath: string): Promise<number> {
  const checks = [
    ["node", process.execPath],
    ["codex", spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0],
    ["claude", spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0],
    ["runtime", path.resolve(scriptPath)],
    ["state", stateRoot()]
  ] as const
  let healthy = true
  for (const [name, value] of checks) {
    const ok = typeof value === "boolean" ? value : value.length > 0
    healthy &&= ok
    console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${String(value)}`)
  }
  const codexWake = await hasCodexWakeHook()
  // Codex trusts hooks by content hash, so an installed hook is not
  // necessarily approved; doctor cannot observe trust and must not claim the
  // hook is live.
  console.log(
    `${codexWake ? "OK  " : "WARN"} codex wake hook: ${
      codexWake
        ? "installed; Codex must approve it in-app after any setup change before it is live"
        : "not installed (run orchestrate setup)"
    }`
  )
  const skillDir = path.dirname(path.dirname(path.resolve(scriptPath)))
  const claudePlugin =
    (await pathExists(path.join(skillDir, ".claude-plugin", "plugin.json"))) &&
    (await pathExists(path.join(skillDir, "hooks", "hooks.json")))
  console.log(
    `${claudePlugin ? "OK  " : "WARN"} claude wake hook: ${
      claudePlugin
        ? `plugin manifest at ${skillDir}; Claude Code must load this plugin for auto-wake (--bare and -p sessions do not)`
        : `no .claude-plugin/plugin.json + hooks/hooks.json under ${skillDir}; Claude Code auto-wake is unavailable`
    }`
  )
  return healthy ? 0 : 1
}

export async function runCli(args: readonly string[], scriptPath: string): Promise<number> {
  const [command, ...rest] = args
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(usage)
    return 0
  }
  const parsed = parseArgs(rest)
  const shapes: Readonly<Record<string, readonly [number, readonly string[]]>> = {
    validate: [1, ["json"]],
    preview: [1, []],
    run: [
      1,
      [
        "approve",
        "allow-write-conflicts",
        "override-emergency-fuse",
        "foreground",
        "no-wake",
        "mirror"
      ]
    ],
    status: [1, ["json"]],
    report: [1, ["json"]],
    wait: [1, ["interval", "json"]],
    watch: [1, ["interval", "once"]],
    events: [1, ["json"]],
    result: [2, ["attempt"]],
    pause: [1, []],
    stop: [1, []],
    resume: [
      1,
      [
        "approve-patch",
        "approve-revision",
        "override-limit",
        "override-emergency-fuse",
        "recover",
        "respond",
        "input-digest",
        "approve-gate",
        "gate-digest",
        "no-wake",
        "mirror"
      ]
    ],
    revise: [2, ["discard"]],
    "node-done": [2, ["token", "outcome"]],
    wake: [1, ["harness", "session"]],
    runs: [0, ["json"]],
    prefs: [0, ["project"]],
    clean: [1, []],
    setup: [0, ["force", "no-hooks"]],
    doctor: [0, []],
    __worker: [1, []],
    // The wake hook ignores extra positionals and an optional --marker <value>
    // so the installed hook command works whether the harness runs it through
    // a shell (legacy "# orchestrate-wake-hook" comment markers are stripped)
    // or execs argv directly (marker tokens arrive as extra arguments).
    "__wake-hook": [Number.POSITIVE_INFINITY, ["marker"]]
  }
  const shape = shapes[command]
  if (shape !== undefined) {
    validateCliShape(command, parsed, shape[0], shape[1])
  }
  switch (command) {
    case "validate":
      return commandValidate(parsed)
    case "preview":
      return commandPreview(parsed)
    case "run":
      return commandRun(parsed, scriptPath)
    case "status":
      return commandStatus(parsed)
    case "report":
      return commandReport(parsed)
    case "wait":
      return commandWait(parsed)
    case "watch":
      return commandWatch(parsed)
    case "events":
      return commandEvents(parsed)
    case "result":
      return commandResult(parsed)
    case "pause":
      return commandPause(parsed)
    case "stop":
      return commandStop(parsed)
    case "resume":
      return commandResume(parsed, scriptPath)
    case "revise":
      return commandRevise(parsed)
    case "node-done":
      return commandNodeDone(parsed)
    case "wake":
      return commandWake(parsed)
    case "runs":
      return commandRuns(parsed)
    case "prefs":
      return commandPrefs(parsed)
    case "clean":
      return commandClean(parsed)
    case "setup":
      return commandSetup(parsed, scriptPath)
    case "doctor":
      return commandDoctor(scriptPath)
    case "__worker":
      await runWorker(path.resolve(requirePositional(parsed, 0, "run directory")))
      return 0
    case "__wake-hook":
      return commandWakeHook(parsed)
    default:
      throw new Error(`Unknown command "${command}".\n\n${usage}`)
  }
}
