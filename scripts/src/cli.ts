import { spawn } from "node:child_process"
import { watch } from "node:fs"
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { isDeepStrictEqual } from "node:util"

import type { PaneGarnish } from "./board-model.js"
import type {
  CrankEvent,
  EventRecord,
  RunState,
  UiPreferenceLayer,
  ValidationIssue,
  WorkflowSpec
} from "./types.js"

import { buildBoardModel } from "./board-model.js"
import { observePaneGarnish, runBoardTui } from "./board.js"
import {
  crankRun,
  handleHerdrAgentStatusEvent,
  readBoundedResult,
  reconcileRun,
  startWorkflowRun,
  submitNodeDone
} from "./crank.js"
import {
  HerdrSurface,
  removeWorkflowWorktrees,
  requireHerdr,
  workflowWorktreePath
} from "./herdr-surface.js"
import {
  readPreferences,
  replaceUiPreferenceLayer,
  setUiPreference,
  uiPreferencesWithOrigins
} from "./preferences.js"
import { herdrPluginHealth, installedBuild, migrateStagedInstallation, runSetup } from "./setup.js"
import {
  acquireRunLock,
  createRunId,
  ensureStateDirectories,
  eventsPath,
  holdBlocksDependencies,
  listRunStates,
  readEvents,
  readRunState,
  readUiSnapshot,
  readWorkflow,
  removeRun,
  resolveDefaultRunDirectory,
  resolveRunDirectory,
  runDirectory,
  runNeedsAttention,
  runtimeBuild,
  stateRoot
} from "./state.js"
import { overlappingMutableNodes, validateWorkflow } from "./validation.js"
import { runUiWizard } from "./wizard.js"

declare const ORCHESTRATE_BUILD_EMBEDDED: string

const EXIT_OK = 0
const EXIT_ERROR = 1
const EXIT_ATTENTION = 2

export function jsonRequested(args: readonly string[]): boolean {
  return args.some((argument) => argument === "--json" || argument.startsWith("--json="))
}

export type JsonErrorCode =
  | "usage"
  | "validation"
  | "not_found"
  | "conflict"
  | "herdr"
  | "io"
  | "command_failed"

function jsonErrorCode(error: unknown, message: string): JsonErrorCode {
  const candidateCode =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined
  const systemCode = typeof candidateCode === "string" ? candidateCode : ""
  if (/\bherdr\b/i.test(message)) {
    return "herdr"
  }
  if (systemCode === "ENOENT") {
    return "not_found"
  }
  if (["EEXIST", "EBUSY", "EAGAIN", "EALREADY"].includes(systemCode)) {
    return "conflict"
  }
  if (/^E[A-Z0-9]+$/.test(systemCode)) {
    return "io"
  }
  if (
    /^(?:Usage:|Unknown (?:flag|command|global argument|ui subcommand)|--\S+ (?:requires|does not accept)|.* requires (?:one |exactly )?|.* accepts (?:at most |one )?|Unsupported shell |ui \S+ is interactive)/.test(
      message
    )
  ) {
    return "usage"
  }
  if (
    /^(?:ERROR\b|Invalid\b)|\bmust be (?:an? |valid\b)|\bmust name\b|\bvalue must be valid JSON\b/.test(
      message
    )
  ) {
    return "validation"
  }
  if (
    /^(?:No runs exist\.|No run matches |Unknown node |Unknown repeat )|\bnot found\b/i.test(
      message
    )
  ) {
    return "not_found"
  }
  if (/\b(?:already|ambiguous|conflict|digest mismatch)\b/i.test(message)) {
    return "conflict"
  }
  return "command_failed"
}

export function jsonError(error: unknown): {
  readonly ok: false
  readonly error: { readonly code: JsonErrorCode; readonly message: string }
} {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: {
      code: jsonErrorCode(error, message),
      message
    }
  }
}

export const PUBLIC_COMMAND_HELP = {
  validate: "Usage: orchestrate validate <workflow.json> [--json]",
  preview: "Usage: orchestrate preview <workflow.json> [--json]",
  run: "Usage: orchestrate run <workflow.json> --approve <sha256> [--allow-write-conflicts] [--dry-run] [--json]",
  status: "Usage: orchestrate status [<run>] [--wait] [--json]",
  events: "Usage: orchestrate events [<run>] [--follow] [--json]",
  board: "Usage: orchestrate board [<run>] [--json]",
  reconcile: "Usage: orchestrate reconcile <run> [--json]",
  result: "Usage: orchestrate result <run> <node> [--attempt <n>] [--json]",
  runs: "Usage: orchestrate runs [--active|--paused|--needs-attention|--settled] [--json]",
  approve:
    "Usage: orchestrate approve <run> --gate <node> --digest <sha256> [--json]\n       orchestrate approve <run> --revision <sha256> [--json]",
  pause: "Usage: orchestrate pause <run> [--json]",
  resume:
    "Usage: orchestrate resume <run> [--override-fuse] [--continue-rounds <n>|--accept-repeat <repeat>] [--json]",
  stop: "Usage: orchestrate stop <run> [--yes] [--json]",
  hold: "Usage: orchestrate hold <run> <node> [--json]",
  release: "Usage: orchestrate release <run> <node> [--json]",
  revise:
    "Usage: orchestrate revise <run> <workflow.json> [--json]\n       orchestrate revise <run> --discard [--json]",
  "node-done":
    "Usage: orchestrate node-done <run> <node> --token <token> --outcome <completed|failed> [--hold] [--json]",
  "node-exit":
    "Usage: orchestrate node-exit <run> <node> --token <token> --code <integer> [--json]",
  "herdr-event": "Usage: orchestrate herdr-event [--json]",
  ui: [
    "Usage: orchestrate ui show [--origin] [--project <cwd>] [--json]",
    "       orchestrate ui set <path> <json-value> [--project <cwd>] [--json]",
    "       orchestrate ui edit [--project <cwd>] [--json]",
    "       orchestrate ui wizard [--project <cwd>] [--json]",
    "       orchestrate ui restore <run> [--json]"
  ].join("\n"),
  clean:
    "Usage: orchestrate clean <run> [--dry-run] [--json]\n       orchestrate clean --settled [--dry-run] [--json]",
  completion: "Usage: orchestrate completion <fish|zsh|bash> [--json]",
  setup: "Usage: orchestrate setup [--dry-run] [--remove] [--defaults|--no-wizard] [--json]",
  doctor: "Usage: orchestrate doctor [--json]"
} as const

export type PublicCommand = keyof typeof PUBLIC_COMMAND_HELP
export const PUBLIC_COMMANDS = Object.freeze(Object.keys(PUBLIC_COMMAND_HELP) as PublicCommand[])
const PUBLIC_COMMAND_SET: ReadonlySet<string> = new Set(PUBLIC_COMMANDS)
// Agent panes, the plugin event hook, and shell-completion helpers must never
// mutate the installation; setup and doctor stay the explicit lifecycle and
// read-only diagnostic paths.
const MIGRATION_EXEMPT_COMMANDS: ReadonlySet<string> = new Set([
  "node-done",
  "node-exit",
  "herdr-event",
  "completion",
  "setup",
  "doctor"
])
const HELP: Readonly<Record<string, string>> = PUBLIC_COMMAND_HELP

const GLOBAL_HELP = `orchestrate — herdr-native agent workflow state machine

Usage: orchestrate <command> [arguments] [--json]

Commands:
  ${PUBLIC_COMMANDS.join(", ")}

Exit codes:
  0  success
  1  error
  2  the observed run needs human attention

Environment:
  ORCHESTRATE_STATE_DIR  Override the state directory.
  XDG_STATE_HOME         State base when ORCHESTRATE_STATE_DIR is unset.
  ORCHESTRATE_DISABLE_PREFS=1  Disable preference reads and writes.
  ORCHESTRATE_DISABLE_UI=1     Suppress board auto-open and presentation notifications.

Run "orchestrate <command> --help" for command details.`

interface ParsedArgs {
  readonly positionals: readonly string[]
  readonly flags: ReadonlyMap<string, string | true>
}

const VALUE_FLAGS = new Set([
  "approve",
  "gate",
  "digest",
  "revision",
  "continue-rounds",
  "accept-repeat",
  "attempt",
  "token",
  "outcome",
  "code",
  "project"
])

const BOOLEAN_FLAGS = new Set([
  "active",
  "allow-write-conflicts",
  "defaults",
  "discard",
  "dry-run",
  "follow",
  "help",
  "hold",
  "json",
  "needs-attention",
  "no-wizard",
  "origin",
  "override-fuse",
  "paused",
  "remove",
  "settled",
  "wait",
  "yes"
])

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const equal = token.indexOf("=")
    if (equal !== -1) {
      const name = token.slice(2, equal)
      if (BOOLEAN_FLAGS.has(name)) {
        throw new Error(`--${name} does not accept a value.`)
      }
      flags.set(name, token.slice(equal + 1))
      continue
    }
    const name = token.slice(2)
    if (VALUE_FLAGS.has(name)) {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--${name} requires a value.`)
      }
      flags.set(name, value)
      index += 1
    } else {
      flags.set(name, true)
    }
  }
  return { positionals, flags }
}

function flag(parsed: ParsedArgs, name: string): string | null {
  const value = parsed.flags.get(name)
  if (value === undefined) {
    return null
  }
  if (value === true) {
    throw new Error(`--${name} requires a value.`)
  }
  return value
}

function has(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.has(name)
}

function booleanFlag(parsed: ParsedArgs, name: string): boolean {
  const value = parsed.flags.get(name)
  if (value === undefined) {
    return false
  }
  if (value !== true) {
    throw new Error(`--${name} does not accept a value.`)
  }
  return true
}

function shape(
  command: string,
  parsed: ParsedArgs,
  minimum: number,
  maximum: number,
  allowed: readonly string[]
): void {
  const accepted = new Set(["json", "help", ...allowed])
  for (const name of parsed.flags.keys()) {
    if (!accepted.has(name)) {
      throw new Error(`Unknown flag --${name} for ${command}.`)
    }
  }
  if (parsed.positionals.length < minimum || parsed.positionals.length > maximum) {
    throw new Error(HELP[command] ?? `Invalid arguments for ${command}.`)
  }
}

function integer(value: string | null, label: string): number | null {
  if (value === null) {
    return null
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`${label} must be an integer.`)
  }
  return parsed
}

function output(json: boolean, value: unknown, human: string): void {
  console.log(json ? JSON.stringify(value) : human)
}

function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.length === 0
    ? "Valid."
    : issues
        .map(
          (issue) =>
            `${issue.severity === "error" ? "ERROR" : "WARN "} ${issue.code}: ${issue.message}`
        )
        .join("\n")
}

async function loadWorkflow(file: string): Promise<{
  readonly workflow: WorkflowSpec
  readonly digest: string
  readonly issues: readonly ValidationIssue[]
}> {
  const parsed = JSON.parse(await readFile(path.resolve(file), "utf8")) as unknown
  const result = validateWorkflow(parsed)
  if (result.workflow === null || result.digest === null) {
    throw new Error(formatIssues(result.issues))
  }
  return {
    workflow: result.workflow,
    digest: result.digest,
    issues: result.issues
  }
}

function previewCallback(workflow: WorkflowSpec) {
  const callback = workflow.callback
  if (callback.type === "command") {
    return {
      type: callback.type,
      executable: callback.argv[0],
      argumentCount: Math.max(0, callback.argv.length - 1),
      timeoutSeconds: callback.timeoutSeconds
    }
  }
  if (callback.type === "webhook") {
    let endpoint = "<invalid-url>"
    try {
      const parsed = new URL(callback.url)
      parsed.username = ""
      parsed.password = ""
      parsed.search = ""
      parsed.hash = ""
      endpoint = parsed.toString()
    } catch {
      // Validation owns URL acceptance. Preview never exposes an unparsed secret-bearing value.
    }
    return {
      type: callback.type,
      endpoint,
      headerNames: Object.keys(callback.headers).toSorted(),
      timeoutSeconds: callback.timeoutSeconds
    }
  }
  return callback
}

function previewPlan(workflow: WorkflowSpec, digest: string, issues: readonly ValidationIssue[]) {
  const depths = dependencyDepths(
    Object.fromEntries(workflow.nodes.map((entry) => [entry.id, entry]))
  )
  return {
    digest,
    name: workflow.name,
    objective: workflow.objective,
    cwd: workflow.cwd,
    concurrency: workflow.concurrency,
    limits: workflow.limits,
    callback: previewCallback(workflow),
    milestones: workflow.milestones,
    writeConflicts: workflow.writeConflicts,
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title,
      depth: depths.get(node.id) ?? 1,
      needs: node.needs,
      gate: node.gate,
      provider: node.type === "agent" ? node.provider : null,
      permissions: node.type === "agent" ? node.permissions : null,
      workspace: node.workspace,
      environmentKeys:
        node.type === "agent" ? Object.keys(node.permissions.env) : Object.keys(node.env)
    })),
    repeats: workflow.repeats,
    issues
  }
}

function previewText(plan: ReturnType<typeof previewPlan>): string {
  const rows = plan.nodes
    .toSorted((left, right) => left.depth - right.depth)
    .map(
      (node) =>
        `  ${String(node.depth).padStart(2)} ${node.id} [${node.type}${node.provider === null ? "" : `/${node.provider}`}] needs=${node.needs.join(",") || "-"} gate=${node.gate}${
          node.permissions === null
            ? ""
            : ` escalation=${node.permissions.escalation} execution=${JSON.stringify(node.permissions.execution)}`
        }`
    )
  return [
    `${plan.name}: ${plan.objective}`,
    `Digest: ${plan.digest}`,
    `Cwd: ${plan.cwd}`,
    `Concurrency: ${plan.concurrency}`,
    `Max starts: ${plan.limits.maxStarts ?? "unlimited"}`,
    `Callback: ${JSON.stringify(plan.callback)}`,
    `Milestones: ${plan.milestones}`,
    `Write conflicts: ${plan.writeConflicts}`,
    "Nodes:",
    ...rows,
    ...(plan.repeats.length === 0
      ? []
      : ["Repeats:", ...plan.repeats.map((repeat) => `  ${repeat.id} (max ${repeat.maxRounds})`)]),
    ...(plan.issues.length === 0 ? [] : [formatIssues(plan.issues)])
  ].join("\n")
}

async function executableAvailable(command: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) {
      continue
    }
    try {
      await access(path.join(directory, command), 1)
      return true
    } catch {
      // Keep searching PATH.
    }
  }
  return false
}

async function commandSucceeds(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: process.env, stdio: "ignore" })
    child.on("error", () => {
      resolve(false)
    })
    child.on("close", (code) => {
      resolve(code === 0)
    })
  })
}

interface PreflightCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

async function runPreflight(
  workflow: WorkflowSpec,
  approved: string,
  digest: string,
  allowWriteConflicts: boolean
): Promise<readonly PreflightCheck[]> {
  const checks: PreflightCheck[] = []
  checks.push({
    name: "digest",
    ok: approved === digest,
    detail: approved === digest ? digest : "Approval does not match the preview digest."
  })
  try {
    checks.push({ name: "herdr", ok: true, detail: await requireHerdr() })
  } catch (error) {
    checks.push({ name: "herdr", ok: false, detail: String(error) })
  }
  for (const provider of new Set(
    workflow.nodes.flatMap((node) => (node.type === "agent" ? [node.provider] : []))
  )) {
    const ok = await executableAvailable(provider)
    checks.push({
      name: `provider:${provider}`,
      ok,
      detail: ok ? "found" : `${provider} not on PATH`
    })
  }
  const worktrees = workflow.nodes.flatMap((node) =>
    node.workspace.mode === "git-worktree" ? [{ node, workspace: node.workspace }] : []
  )
  if (worktrees.length > 0) {
    const git = await executableAvailable("git")
    checks.push({
      name: "git",
      ok: git,
      detail: git ? "found" : "git not on PATH"
    })
    if (git) {
      const repository = await commandSucceeds("git", [
        "-C",
        workflow.cwd,
        "rev-parse",
        "--git-dir"
      ])
      checks.push({
        name: "git-repository",
        ok: repository,
        detail: repository ? workflow.cwd : `${workflow.cwd} is not a Git repository`
      })
      for (const item of worktrees) {
        const startPoint = await commandSucceeds("git", [
          "-C",
          workflow.cwd,
          "rev-parse",
          "--verify",
          `${item.workspace.git.startPoint}^{commit}`
        ])
        checks.push({
          name: `worktree:${item.node.id}`,
          ok: startPoint,
          detail: startPoint
            ? item.workspace.git.startPoint
            : `Unknown start point ${item.workspace.git.startPoint}`
        })
      }
    }
  }
  for (const [name, candidate] of new Map([
    ["workflow-cwd", workflow.cwd],
    ...workflow.nodes.flatMap((node) =>
      node.workspace.mode === "git-worktree"
        ? []
        : [[`node-cwd:${node.id}`, node.workspace.path ?? node.cwd ?? workflow.cwd] as const]
    )
  ])) {
    const ok = await stat(candidate).then(
      (value) => value.isDirectory(),
      () => false
    )
    checks.push({
      name,
      ok,
      detail: ok ? candidate : `Directory does not exist: ${candidate}`
    })
  }
  const overlaps = overlappingMutableNodes(workflow)
  const conflictApproved = overlaps.length === 0 || allowWriteConflicts
  checks.push({
    name: "write-conflicts",
    ok: conflictApproved,
    detail:
      overlaps.length === 0
        ? "none"
        : allowWriteConflicts
          ? `approved: ${overlaps.map((pair) => pair.join("/")).join(", ")}`
          : `Pass --allow-write-conflicts after reviewing: ${overlaps.map((pair) => pair.join("/")).join(", ")}`
  })
  return checks
}

function holdsForNode(state: RunState, node: RunState["nodes"][string]) {
  return Object.values(state.holds).filter(
    (hold) => hold.target === node.id || hold.target === node.templateId
  )
}

function dependencyDepths(
  nodes: Readonly<Record<string, { readonly needs: readonly string[] }>>
): ReadonlyMap<string, number> {
  const depths = new Map<string, number>()
  const resolve = (id: string, trail: ReadonlySet<string>): number => {
    const cached = depths.get(id)
    if (cached !== undefined) {
      return cached
    }
    const needs = nodes[id]?.needs ?? []
    const depth =
      needs.length === 0 || trail.has(id)
        ? 1
        : 1 + Math.max(...needs.map((need) => resolve(need, new Set([...trail, id]))))
    depths.set(id, depth)
    return depth
  }
  for (const id of Object.keys(nodes)) {
    resolve(id, new Set())
  }
  return depths
}

function statusValue(state: RunState, observedAttention = runNeedsAttention(state)) {
  const depths = dependencyDepths(state.nodes)
  return {
    runId: state.id,
    name: state.workflowName,
    objective: state.objective,
    status: state.status,
    needsAttention: observedAttention,
    pause: state.pause,
    pendingRevision:
      state.pendingRevision === null
        ? null
        : {
            digest: state.pendingRevision.digest,
            summary: state.pendingRevision.summary,
            createdAt: state.pendingRevision.createdAt
          },
    starts: state.starts,
    updatedAt: state.updatedAt,
    nodes: Object.values(state.nodes).map((node) => ({
      id: node.id,
      title: node.title,
      type: node.type,
      status: node.status,
      depth: depths.get(node.id) ?? 1,
      needs: node.needs,
      waitingOn: node.needs.filter((need) => state.nodes[need]?.status !== "completed"),
      downstreamHeld: holdsForNode(state, node).length > 0,
      holdTargets: holdsForNode(state, node).map((hold) => hold.target),
      attempt: node.attempts.at(-1)?.attempt ?? null,
      resultPath: node.resultPath,
      error: node.error
    })),
    gates: Object.values(state.gates).filter((gate) => gate.approvedAt === null),
    holds: Object.values(state.holds),
    repeats: Object.values(state.repeats)
  }
}

function statusText(
  state: RunState,
  approvalGateTemplates: ReadonlySet<string> = new Set()
): string {
  const value = statusValue(state)
  const needs = [
    ...value.gates.map(
      (gate) =>
        `  gate ${gate.nodeId}: orchestrate approve ${state.id} --gate ${gate.nodeId} --digest ${gate.digest}`
    ),
    ...(state.pendingRevision === null
      ? []
      : [`  revision: orchestrate approve ${state.id} --revision ${state.pendingRevision.digest}`]),
    ...(state.pause?.kind === "max-rounds" && state.pause.repeatId !== null
      ? [
          `  max rounds: orchestrate resume ${state.id} --continue-rounds 1`,
          `              orchestrate resume ${state.id} --accept-repeat ${state.pause.repeatId}`
        ]
      : []),
    ...value.holds
      .filter((hold) => holdBlocksDependencies(state, hold))
      .map(
        (hold) => `  downstream held ${hold.target}: orchestrate release ${state.id} ${hold.target}`
      )
  ]
  const recovery = Object.values(state.nodes).flatMap((node) => {
    const attempt = node.attempts.at(-1)
    if (node.type !== "agent" || node.status !== "running" || attempt === undefined) {
      return []
    }
    return [
      `  ${node.id}: orchestrate node-done ${state.id} ${node.id} --token ${attempt.token} --outcome failed`
    ]
  })
  return [
    `${state.workflowName} (${state.id})`,
    `Status: ${state.status}${value.needsAttention ? " — needs attention" : ""}`,
    `Objective: ${state.objective}`,
    ...(needs.length === 0 ? [] : ["Needs you:", ...needs]),
    ...(recovery.length === 0 ? [] : ["If a running pane disappeared:", ...recovery]),
    "Nodes:",
    ...value.nodes
      .toSorted((left, right) => left.depth - right.depth)
      .map((node) => {
        const gateAhead =
          (node.status === "pending" || node.status === "ready") &&
          approvalGateTemplates.has(state.nodes[node.id]?.templateId ?? node.id)
        const waiting =
          (node.status === "pending" || node.status === "ready") && node.waitingOn.length > 0
            ? ` — waiting on ${node.waitingOn.join(", ")}`
            : ""
        return `  ${String(node.depth).padStart(2)} ${node.id.padEnd(24)} ${node.status}${gateAhead ? " — approval gate ahead" : ""}${waiting}${node.downstreamHeld ? " — downstream held" : ""}${node.error === null ? "" : ` — ${node.error}`}`
      })
  ].join("\n")
}

function gatedTemplateIds(workflow: WorkflowSpec): ReadonlySet<string> {
  return new Set(workflow.nodes.filter((node) => node.gate === "approval").map((node) => node.id))
}

async function selectedRun(positional: string | undefined): Promise<string> {
  return positional === undefined ? resolveDefaultRunDirectory() : resolveRunDirectory(positional)
}

interface ObservedRun {
  readonly state: RunState
  readonly paneGarnish: Readonly<Record<string, PaneGarnish>>
  readonly needsAttention: boolean
}

function garnishNeedsAttention(garnish: Readonly<Record<string, PaneGarnish>>): boolean {
  return Object.values(garnish).some((sample) => sample.condition !== "live")
}

async function observeRuns(states: readonly RunState[]): Promise<readonly ObservedRun[]> {
  const surface = new HerdrSurface()
  return Promise.all(
    states.map(async (state) => {
      const paneGarnish = await observePaneGarnish(state, surface)
      return {
        state,
        paneGarnish,
        needsAttention: runNeedsAttention(state) || garnishNeedsAttention(paneGarnish)
      }
    })
  )
}

async function observedDefaultRunDirectory(): Promise<string> {
  const listing = await listRunStates()
  const observed = await observeRuns(listing.states)
  const selected = observed.find((run) => run.needsAttention) ?? observed[0]
  if (selected === undefined) {
    throw new Error("No runs exist.")
  }
  return runDirectory(selected.state.id)
}

async function selectBoardRun(positional: string | undefined): Promise<string> {
  if (positional !== undefined || !process.stdin.isTTY || !process.stdout.isTTY) {
    return positional === undefined ? observedDefaultRunDirectory() : selectedRun(positional)
  }
  const listing = await listRunStates()
  const observed = await observeRuns(listing.states)
  const preferred = observed.find((run) => run.needsAttention)?.state ?? listing.states[0]
  if (preferred === undefined) {
    throw new Error("No runs exist.")
  }
  if (listing.states.length === 1) {
    return runDirectory(preferred.id)
  }
  console.log("Runs:")
  listing.states.forEach((state, index) => {
    console.log(
      `${state.id === preferred.id ? ">" : " "} ${index + 1}. ${state.id}  ${state.status}  ${state.workflowName}`
    )
  })
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  })
  try {
    const answer = (await prompt.question(`Open run [${preferred.id}]: `)).trim()
    if (answer.length === 0) {
      return runDirectory(preferred.id)
    }
    const numbered = Number(answer)
    if (Number.isInteger(numbered) && numbered >= 1 && numbered <= listing.states.length) {
      return runDirectory((listing.states[numbered - 1] as RunState).id)
    }
    return resolveRunDirectory(answer)
  } finally {
    prompt.close()
  }
}

let watchInstalledHookForTests: (() => void | Promise<void>) | null = null

export function setWatchInstalledHookForTests(hook: (() => void | Promise<void>) | null): void {
  if (typeof ORCHESTRATE_BUILD_EMBEDDED === "string") {
    throw new TypeError(
      "Watch interleaving injection is unavailable in embedded production builds."
    )
  }
  watchInstalledHookForTests = hook
}

export async function watchBeforeScan<T>(
  file: string,
  scan: () => Promise<T | null>
): Promise<T | null> {
  let change: (() => void) | null = null
  let watchError: Error | null = null
  const changed = new Promise<void>((resolve) => {
    change = resolve
  })
  const watcher = watch(file, () => change?.())
  watcher.once("error", (error) => {
    watchError = error
    change?.()
  })
  try {
    const hook = watchInstalledHookForTests
    watchInstalledHookForTests = null
    await hook?.()
    const result = await scan()
    if (result !== null) {
      return result
    }
    await changed
    if (watchError !== null) {
      throw watchError
    }
    return null
  } finally {
    watcher.close()
  }
}

async function waitUntilAttentionOrSettled(runDir: string): Promise<RunState> {
  for (;;) {
    const state = await watchBeforeScan(path.join(runDir, "state.json"), async () => {
      const current = await readRunState(runDir)
      return runNeedsAttention(current) || current.status !== "running" ? current : null
    })
    if (state !== null) {
      return state
    }
  }
}

function eventText(event: EventRecord): string {
  return `${event.timestamp} #${event.sequence} ${event.type}${event.nodeId === undefined ? "" : ` ${event.nodeId}`} — ${event.message}`
}

async function streamEvents(runDir: string, json: boolean, follow: boolean): Promise<void> {
  let emitted = 0
  if (!follow) {
    const events = await readEvents(runDir)
    if (json) {
      console.log(JSON.stringify({ events }))
    } else {
      for (const event of events) {
        console.log(eventText(event))
      }
    }
    return
  }
  for (;;) {
    await watchBeforeScan(eventsPath(runDir), async () => {
      const events = await readEvents(runDir)
      const pending = events.slice(emitted)
      for (const event of pending) {
        console.log(json ? JSON.stringify(event) : eventText(event))
      }
      emitted = events.length
      return pending.length > 0 ? true : null
    })
  }
}

export function structuralDiff(before: WorkflowSpec, after: WorkflowSpec): readonly string[] {
  const changes: string[] = []
  for (const key of [
    "name",
    "objective",
    "cwd",
    "concurrency",
    "callback",
    "milestones",
    "limits",
    "writeConflicts",
    "repeats"
  ] as const) {
    if (!isDeepStrictEqual(before[key], after[key])) {
      changes.push(`~ ${key}`)
    }
  }
  const left = new Map(before.nodes.map((node) => [node.id, node]))
  const right = new Map(after.nodes.map((node) => [node.id, node]))
  for (const id of left.keys()) {
    if (!right.has(id)) {
      changes.push(`- node ${id}`)
    }
  }
  for (const [id, node] of right) {
    if (!left.has(id)) {
      changes.push(`+ node ${id}`)
    } else if (!isDeepStrictEqual(left.get(id), node)) {
      changes.push(`~ node ${id}`)
    }
  }
  return changes
}

async function mutation(
  prefix: string,
  event: CrankEvent,
  json: boolean,
  message: string
): Promise<number> {
  const runDir = await resolveRunDirectory(prefix)
  const result = await crankRun(runDir, event)
  output(json, statusValue(result.state), `${message} ${result.state.id}.`)
  return EXIT_OK
}

async function confirmStop(runId: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return true
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  })
  try {
    const answer = await prompt.question(`Stop run ${runId} and close its live panes? [y/N] `)
    return /^(?:y|yes)$/i.test(answer.trim())
  } finally {
    prompt.close()
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

async function editUiLayer(project: string | null): Promise<void> {
  const preferences = await readPreferences()
  const resolved = project === null ? null : path.resolve(project)
  const layer =
    resolved === null
      ? preferences.global.ui
      : (preferences.projects[resolved]?.ui ?? emptyUiLayer())
  const temporary = await mkdtemp(path.join(os.tmpdir(), "orchestrate-ui-"))
  const file = path.join(temporary, "ui.json")
  await writeFile(file, `${JSON.stringify(layer, null, 2)}\n`)
  const editor = process.env.EDITOR?.trim()
  if (editor === undefined || editor.length === 0) {
    await rm(temporary, { recursive: true, force: true })
    throw new Error("ui edit requires $EDITOR.")
  }
  const [executable, ...args] = editor.split(/\s+/)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable as string, [...args, file], {
      stdio: "inherit"
    })
    let spawnError: Error | null = null
    child.once("error", (error) => {
      spawnError = error
    })
    child.once("close", (code) => {
      if (spawnError !== null) {
        reject(spawnError)
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Editor exited with ${code}.`))
      }
    })
  })
  try {
    await replaceUiPreferenceLayer(
      JSON.parse(await readFile(file, "utf8")) as UiPreferenceLayer,
      resolved
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function shellVariable(name: string): string {
  return ["$", `{${name}}`].join("")
}

export const COMMAND_COMPLETION_SHAPES = Object.freeze([
  { command: "status", runWord: 3, nodeWord: null },
  { command: "events", runWord: 3, nodeWord: null },
  { command: "board", runWord: 3, nodeWord: null },
  { command: "reconcile", runWord: 3, nodeWord: null },
  { command: "result", runWord: 3, nodeWord: 4 },
  { command: "approve", runWord: 3, nodeWord: null },
  { command: "pause", runWord: 3, nodeWord: null },
  { command: "resume", runWord: 3, nodeWord: null },
  { command: "stop", runWord: 3, nodeWord: null },
  { command: "hold", runWord: 3, nodeWord: 4 },
  { command: "release", runWord: 3, nodeWord: 4 },
  { command: "revise", runWord: 3, nodeWord: null },
  { command: "node-done", runWord: 3, nodeWord: 4 },
  { command: "node-exit", runWord: 3, nodeWord: 4 },
  { command: "clean", runWord: 3, nodeWord: null },
  { command: "ui", subcommand: "restore", runWord: 4, nodeWord: null }
] as const)

function completionScript(shell: string): string {
  const commands = PUBLIC_COMMANDS.join(" ")
  const dollar = "$"
  const directRunCommands = COMMAND_COMPLETION_SHAPES.filter(
    (completionShape) => completionShape.runWord === 3 && !("subcommand" in completionShape)
  )
    .map((completionShape) => completionShape.command)
    .join(" ")
  const nodeCommands = COMMAND_COMPLETION_SHAPES.filter(
    (completionShape) => completionShape.nodeWord === 4
  )
    .map((completionShape) => completionShape.command)
    .join(" ")
  const directRunPattern = directRunCommands.replaceAll(" ", "|")
  const nodePattern = nodeCommands.replaceAll(" ", "|")
  if (shell === "fish") {
    return [
      `complete -c orchestrate -f -n '__fish_use_subcommand' -a '${commands}'`,
      "function __orchestrate_runs; orchestrate runs 2>/dev/null | string match -r '^[^ ]+'; end",
      "function __orchestrate_nodes; set -l w (commandline -opc); test (count $w) -ge 3; and orchestrate status $w[3] 2>/dev/null | awk '/^Nodes:/{f=1;next} f && /^  /{print $1}'; end",
      `function __orchestrate_at_run; set -l w (commandline -opc); if test (count $w) -eq 2; and contains -- $w[2] ${directRunCommands}; return 0; end; test (count $w) -eq 3; and test "$w[2]" = ui; and test "$w[3]" = restore; end`,
      `function __orchestrate_at_node; set -l w (commandline -opc); test (count $w) -eq 3; and contains -- $w[2] ${nodeCommands}; end`,
      "complete -c orchestrate -f -n '__orchestrate_at_run' -a '(__orchestrate_runs)'",
      "complete -c orchestrate -f -n '__orchestrate_at_node' -a '(__orchestrate_nodes)'"
    ].join("\n")
  }
  if (shell === "zsh") {
    return [
      "#compdef orchestrate",
      `_arguments '1:command:(${commands})' '*::argument:->args'`,
      `if (( CURRENT == 3 )) && [[ ${shellVariable("words[2]")} == (${directRunPattern}) ]]; then`,
      `  compadd -- ${dollar}{(f)"$(orchestrate runs 2>/dev/null | awk '{print $1}')"}`,
      `elif (( CURRENT == 4 )) && [[ ${shellVariable("words[2]")} == (${nodePattern}) ]]; then`,
      `  compadd -- ${dollar}{(f)"$(orchestrate status ${shellVariable("words[3]")} 2>/dev/null | awk '/^Nodes:/{f=1;next} f && /^  /{print $1}')"}`,
      `elif (( CURRENT == 4 )) && [[ ${shellVariable("words[2]")} == ui && ${shellVariable("words[3]")} == restore ]]; then`,
      `  compadd -- ${dollar}{(f)"$(orchestrate runs 2>/dev/null | awk '{print $1}')"}`,
      "fi"
    ].join("\n")
  }
  if (shell === "bash") {
    return [
      "_orchestrate_complete() {",
      `  local cur=${shellVariable("COMP_WORDS[COMP_CWORD]")}`,
      `  local commands='${commands}'`,
      '  if (( COMP_CWORD == 1 )); then COMPREPLY=( $(compgen -W "$commands" -- "$cur") ); return; fi',
      `  if (( COMP_CWORD == 2 )) && [[ ${shellVariable("COMP_WORDS[1]")} =~ ^(${directRunPattern})$ ]]; then`,
      '    COMPREPLY=( $(compgen -W "$(orchestrate runs 2>/dev/null | awk \'{print $1}\')" -- "$cur") ); return',
      "  fi",
      `  if (( COMP_CWORD == 3 )) && [[ ${shellVariable("COMP_WORDS[1]")} =~ ^(${nodePattern})$ ]]; then`,
      `    COMPREPLY=( $(compgen -W "$(orchestrate status ${shellVariable("COMP_WORDS[2]")} 2>/dev/null | awk '/^Nodes:/{f=1;next} f && /^  /{print $1}')" -- "$cur") )`,
      "    return",
      "  fi",
      `  if (( COMP_CWORD == 3 )) && [[ ${shellVariable("COMP_WORDS[1]")} == ui && ${shellVariable("COMP_WORDS[2]")} == restore ]]; then`,
      '    COMPREPLY=( $(compgen -W "$(orchestrate runs 2>/dev/null | awk \'{print $1}\')" -- "$cur") ); return',
      "  fi",
      "}",
      "complete -F _orchestrate_complete orchestrate"
    ].join("\n")
  }
  throw new Error(`Unsupported shell "${shell}"; choose fish, zsh, or bash.`)
}

async function doctorReport(): Promise<{
  readonly ok: boolean
  readonly build: string
  readonly checks: readonly PreflightCheck[]
}> {
  const checks: PreflightCheck[] = []
  try {
    checks.push({ name: "herdr", ok: true, detail: await requireHerdr() })
  } catch (error) {
    checks.push({ name: "herdr", ok: false, detail: String(error) })
  }
  const plugin = await herdrPluginHealth()
  checks.push({ name: "herdr-plugin", ...plugin })
  for (const provider of ["codex", "claude"] as const) {
    const ok = await executableAvailable(provider)
    checks.push({
      name: provider,
      ok,
      detail: ok ? "found" : "not found (optional until used)"
    })
  }
  try {
    await ensureStateDirectories()
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

async function handleUi(parsed: ParsedArgs, json: boolean): Promise<number> {
  const subcommand = parsed.positionals[0]
  if (subcommand === undefined) {
    throw new Error(HELP.ui)
  }
  const project = flag(parsed, "project")
  if (subcommand === "show") {
    shape("ui", parsed, 1, 1, ["origin", "project"])
    const merged = await uiPreferencesWithOrigins(project ?? process.cwd())
    const value = has(parsed, "origin") ? merged : merged.value
    output(json, value, JSON.stringify(value, null, 2))
    return EXIT_OK
  }
  if (subcommand === "set") {
    shape("ui", parsed, 3, 3, ["project"])
    const dotted = parsed.positionals[1] as string
    let value: unknown
    try {
      value = JSON.parse(parsed.positionals[2] as string) as unknown
    } catch {
      throw new Error("ui set value must be valid JSON.")
    }
    await setUiPreference(dotted, value, project)
    const merged = await uiPreferencesWithOrigins(project ?? process.cwd())
    output(json, merged.value, `Set ui.${dotted}.`)
    return EXIT_OK
  }
  if (subcommand === "edit") {
    shape("ui", parsed, 1, 1, ["project"])
    await editUiLayer(project)
    output(json, { edited: true, project }, "UI preferences updated.")
    return EXIT_OK
  }
  if (subcommand === "wizard") {
    shape("ui", parsed, 1, 1, ["project"])
    await runUiWizard(project)
    output(json, { configured: true, project }, "UI preferences updated.")
    return EXIT_OK
  }
  if (subcommand === "restore") {
    shape("ui", parsed, 2, 2, [])
    const runDir = await resolveRunDirectory(parsed.positionals[1] as string)
    const state = await readRunState(runDir)
    const surface = new HerdrSurface()
    await surface.connect()
    const snapshot = await surface.paneSnapshot()
    const dead: string[] = []
    for (const node of Object.values(state.nodes)) {
      const pane = node.attempts.at(-1)?.pane
      if (
        node.status === "running" &&
        pane !== null &&
        pane !== undefined &&
        !snapshot.has(pane.paneId)
      ) {
        dead.push(pane.paneId)
      }
    }
    const result = await crankRun(runDir, { type: "restore", deadPaneIds: dead }, { surface })
    if (!json) {
      await surface.openBoard(state.id, await readUiSnapshot(runDir)).catch(() => undefined)
    }
    output(
      json,
      { runId: state.id, deadPaneIds: dead, status: result.state.status },
      `Restored ${state.id}; ${dead.length} vanished pane(s) reconciled.`
    )
    return EXIT_OK
  }
  throw new Error(`Unknown ui subcommand "${subcommand}".`)
}

async function inspectCleanRun(runDir: string, repair: boolean) {
  const state = await readRunState(runDir, { repair })
  const workflow = await readWorkflow(runDir)
  const worktrees = Object.values(state.nodes).flatMap((runtime) => {
    const node = workflow.nodes.find((candidate) => candidate.id === runtime.templateId)
    if (node?.workspace.mode !== "git-worktree" || !node.workspace.git.removeOnClean) {
      return []
    }
    return [workflowWorktreePath(state, runtime.id, node)]
  })
  const item = {
    runId: state.id,
    panes: [
      ...new Set(
        Object.values(state.nodes).flatMap((node) =>
          node.attempts.flatMap((attempt) => (attempt.pane === null ? [] : [attempt.pane.paneId]))
        )
      )
    ],
    worktrees: [...new Set(worktrees)],
    directory: runDir
  }
  return { state, workflow, item }
}

export async function runCli(
  args: readonly string[],
  scriptPath = process.argv[1] ?? process.execPath
): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    for (const argument of args.slice(1)) {
      if (argument.startsWith("--json=")) {
        throw new Error("--json does not accept a value.")
      }
      if (argument !== "--json") {
        throw new Error(`Unknown global argument "${argument}".`)
      }
    }
    output(jsonRequested(args), { command: null, help: GLOBAL_HELP }, GLOBAL_HELP)
    return EXIT_OK
  }
  if (args[0] === "--version") {
    for (const argument of args.slice(1)) {
      if (argument.startsWith("--json=")) {
        throw new Error("--json does not accept a value.")
      }
      if (argument !== "--json") {
        throw new Error(`Unknown global argument "${argument}".`)
      }
    }
    output(jsonRequested(args), { version: runtimeBuild() }, runtimeBuild())
    return EXIT_OK
  }
  const command = args[0] as string
  if (!PUBLIC_COMMAND_SET.has(command)) {
    throw new Error(`Unknown command "${command}".\n\n${GLOBAL_HELP}`)
  }
  const parsed = parseArgs(args.slice(1))
  const json = has(parsed, "json")
  if (has(parsed, "help")) {
    output(json, { command, help: HELP[command] }, HELP[command] as string)
    return EXIT_OK
  }

  if (!MIGRATION_EXEMPT_COMMANDS.has(command) && process.stdout.isTTY && process.stderr.isTTY) {
    try {
      const migration = await migrateStagedInstallation(scriptPath)
      if (migration.migrated) {
        console.error(
          `Migrated the staged installation to ${migration.to} (was ${migration.from}).`
        )
      }
    } catch (error) {
      console.error(
        `Staged installation migration failed: ${error instanceof Error ? error.message : String(error)}. Run orchestrate setup.`
      )
    }
  }

  if (command === "validate") {
    shape(command, parsed, 1, 1, [])
    const raw = JSON.parse(await readFile(path.resolve(parsed.positionals[0] as string), "utf8"))
    const result = validateWorkflow(raw)
    output(json, result, formatIssues(result.issues))
    return result.workflow === null ? EXIT_ERROR : EXIT_OK
  }
  if (command === "preview") {
    shape(command, parsed, 1, 1, [])
    const loaded = await loadWorkflow(parsed.positionals[0] as string)
    const plan = previewPlan(loaded.workflow, loaded.digest, loaded.issues)
    output(json, plan, previewText(plan))
    return EXIT_OK
  }
  if (command === "run") {
    shape(command, parsed, 1, 1, ["approve", "allow-write-conflicts", "dry-run"])
    const approved = flag(parsed, "approve")
    if (approved === null) {
      throw new Error("run requires --approve with the preview digest.")
    }
    const loaded = await loadWorkflow(parsed.positionals[0] as string)
    const checks = await runPreflight(
      loaded.workflow,
      approved,
      loaded.digest,
      has(parsed, "allow-write-conflicts")
    )
    const failed = checks.filter((check) => !check.ok)
    if (has(parsed, "dry-run")) {
      output(
        json,
        { ok: failed.length === 0, digest: loaded.digest, checks },
        checks
          .map((check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`)
          .join("\n")
      )
      return failed.length === 0 ? EXIT_OK : EXIT_ERROR
    }
    if (failed.length > 0) {
      throw new Error(failed.map((check) => `${check.name}: ${check.detail}`).join("\n"))
    }
    const runId = createRunId()
    const ui = (await uiPreferencesWithOrigins(loaded.workflow.cwd)).value
    const result = await startWorkflowRun(loaded.workflow, ui, {
      runId,
      digest: loaded.digest,
      allowWriteConflicts: has(parsed, "allow-write-conflicts")
    })
    output(
      json,
      statusValue(result.state),
      `Started ${runId}. Run orchestrate reconcile ${runId} after a node submits or whenever you want to advance the run.`
    )
    return EXIT_OK
  }
  if (command === "status") {
    shape(command, parsed, 0, 1, ["wait"])
    const runDir = await selectedRun(parsed.positionals[0])
    const state = has(parsed, "wait")
      ? await waitUntilAttentionOrSettled(runDir)
      : await readRunState(runDir)
    const workflow = await readWorkflow(runDir).catch(() => null)
    output(
      json,
      statusValue(state),
      statusText(state, workflow === null ? undefined : gatedTemplateIds(workflow))
    )
    return runNeedsAttention(state) ? EXIT_ATTENTION : EXIT_OK
  }
  if (command === "events") {
    shape(command, parsed, 0, 1, ["follow"])
    const runDir = await selectedRun(parsed.positionals[0])
    await streamEvents(runDir, json, has(parsed, "follow"))
    return EXIT_OK
  }
  if (command === "board") {
    shape(command, parsed, 0, 1, [])
    const runDir = json
      ? parsed.positionals[0] === undefined
        ? await observedDefaultRunDirectory()
        : await selectedRun(parsed.positionals[0])
      : await selectBoardRun(parsed.positionals[0])
    if (!json && process.stdin.isTTY && process.stdout.isTTY) {
      await runBoardTui(runDir)
      return EXIT_OK
    }
    const state = await readRunState(runDir)
    const paneGarnish = await observePaneGarnish(state, new HerdrSurface())
    const boardWorkflow = await readWorkflow(runDir).catch(() => null)
    const model = buildBoardModel(state, await readEvents(runDir), {
      now: new Date().toISOString(),
      paneGarnish,
      repeats: boardWorkflow?.repeats ?? [],
      workflowNodes: boardWorkflow?.nodes ?? []
    })
    output(
      json,
      model,
      [
        statusText(state, boardWorkflow === null ? undefined : gatedTemplateIds(boardWorkflow)),
        ...(model.needsYou.length === 0
          ? []
          : [
              "",
              "NEEDS YOU:",
              ...model.needsYou.map(
                (item) => `  ${item.title}${item.detail.length === 0 ? "" : ` — ${item.detail}`}`
              )
            ])
      ].join("\n")
    )
    return model.needsYou.length > 0 || runNeedsAttention(state) ? EXIT_ATTENTION : EXIT_OK
  }
  if (command === "reconcile") {
    shape(command, parsed, 1, 1, [])
    const runDir = await resolveRunDirectory(parsed.positionals[0] as string)
    const result = await reconcileRun(runDir)
    output(
      json,
      { ...statusValue(result.state), events: result.events },
      result.events.length === 0
        ? `Reconciled ${result.state.id}; no transitions were ready.`
        : `Reconciled ${result.state.id}; applied ${result.events.length} event(s).`
    )
    return runNeedsAttention(result.state) ? EXIT_ATTENTION : EXIT_OK
  }
  if (command === "result") {
    shape(command, parsed, 2, 2, ["attempt"])
    const runDir = await resolveRunDirectory(parsed.positionals[0] as string)
    const state = await readRunState(runDir)
    const nodeId = parsed.positionals[1] as string
    const node = state.nodes[nodeId]
    if (node === undefined) {
      throw new Error(`Unknown node "${nodeId}" in run ${state.id}.`)
    }
    const requested = integer(flag(parsed, "attempt"), "--attempt")
    const attempt =
      requested === null
        ? node.attempts.at(-1)
        : node.attempts.find((candidate) => candidate.attempt === requested)
    if (attempt === undefined) {
      throw new Error(`Node "${nodeId}" has no requested attempt.`)
    }
    const template = (await readWorkflow(runDir)).nodes.find(
      (candidate) => candidate.id === node.templateId
    )
    const file = template?.type === "command" ? attempt.outputPath : attempt.resultPath
    const content = await readBoundedResult(file, `Result for node "${nodeId}"`)
    output(
      json,
      {
        runId: state.id,
        nodeId,
        attempt: attempt.attempt,
        status: node.status,
        downstreamHeld: holdsForNode(state, node).length > 0,
        holds: holdsForNode(state, node),
        path: file,
        content
      },
      content
    )
    return EXIT_OK
  }
  if (command === "runs") {
    shape(command, parsed, 0, 0, ["active", "paused", "needs-attention", "settled"])
    const filters = ["active", "paused", "needs-attention", "settled"].filter((name) =>
      has(parsed, name)
    )
    if (filters.length > 1) {
      throw new Error("runs accepts at most one filter.")
    }
    const listing = await listRunStates()
    const observed = await observeRuns(listing.states)
    const filter = filters[0]
    const states = observed.filter((run) => {
      const state = run.state
      if (filter === "active") {
        return state.status === "running"
      }
      if (filter === "paused") {
        return state.status === "paused"
      }
      if (filter === "needs-attention") {
        return run.needsAttention
      }
      if (filter === "settled") {
        return ["completed", "failed", "stopped"].includes(state.status)
      }
      return true
    })
    const value = {
      runs: states.map((run) => statusValue(run.state, run.needsAttention)),
      damaged: listing.damaged
    }
    output(
      json,
      value,
      states.length === 0
        ? "No matching runs."
        : states
            .map(
              (run) => `${run.state.id}  ${run.state.status.padEnd(9)}  ${run.state.workflowName}`
            )
            .join("\n")
    )
    return filter === "needs-attention" && states.length > 0 ? EXIT_ATTENTION : EXIT_OK
  }
  if (command === "approve") {
    shape(command, parsed, 1, 1, ["gate", "digest", "revision"])
    const gate = flag(parsed, "gate")
    const digest = flag(parsed, "digest")
    const revision = flag(parsed, "revision")
    if (gate !== null && digest !== null && revision === null) {
      return mutation(
        parsed.positionals[0] as string,
        { type: "approve-gate", nodeId: gate, digest },
        json,
        "Approved gate for"
      )
    }
    if (revision !== null && gate === null && digest === null) {
      return mutation(
        parsed.positionals[0] as string,
        { type: "approve-revision", digest: revision },
        json,
        "Approved revision for"
      )
    }
    throw new Error("approve requires exactly --gate <node> --digest <sha> or --revision <sha>.")
  }
  if (command === "pause") {
    shape(command, parsed, 1, 1, [])
    return mutation(parsed.positionals[0] as string, { type: "pause" }, json, "Paused")
  }
  if (command === "resume") {
    shape(command, parsed, 1, 1, ["override-fuse", "continue-rounds", "accept-repeat"])
    const continueRounds = integer(flag(parsed, "continue-rounds"), "--continue-rounds")
    const acceptRepeat = flag(parsed, "accept-repeat")
    if (continueRounds !== null && acceptRepeat !== null) {
      throw new Error("resume accepts one max-rounds decision.")
    }
    return mutation(
      parsed.positionals[0] as string,
      {
        type: "resume",
        overrideFuse: has(parsed, "override-fuse"),
        continueRounds,
        acceptRepeat
      },
      json,
      "Resumed"
    )
  }
  if (command === "stop") {
    shape(command, parsed, 1, 1, ["yes"])
    const prefix = parsed.positionals[0] as string
    const runDir = await resolveRunDirectory(prefix)
    const state = await readRunState(runDir)
    if (!json && !has(parsed, "yes") && !(await confirmStop(state.id))) {
      output(json, { runId: state.id, stopped: false }, "Stop cancelled.")
      return EXIT_OK
    }
    return mutation(prefix, { type: "stop" }, json, "Stopped")
  }
  if (command === "hold" || command === "release") {
    shape(command, parsed, 2, 2, [])
    return mutation(
      parsed.positionals[0] as string,
      { type: command, nodeId: parsed.positionals[1] as string },
      json,
      command === "hold" ? "Held downstream dependencies in" : "Released downstream dependencies in"
    )
  }
  if (command === "revise") {
    shape(command, parsed, 1, 2, ["discard"])
    const prefix = parsed.positionals[0] as string
    if (has(parsed, "discard")) {
      if (parsed.positionals.length !== 1) {
        throw new Error("revise --discard does not accept a workflow file.")
      }
      return mutation(prefix, { type: "discard-revision" }, json, "Discarded revision for")
    }
    if (parsed.positionals[1] === undefined) {
      throw new Error(HELP.revise)
    }
    const runDir = await resolveRunDirectory(prefix)
    const before = await readWorkflow(runDir)
    const loaded = await loadWorkflow(parsed.positionals[1])
    const summary = structuralDiff(before, loaded.workflow)
    const result = await crankRun(runDir, {
      type: "propose-revision",
      workflow: loaded.workflow,
      digest: loaded.digest,
      summary
    })
    output(
      json,
      { runId: result.state.id, digest: loaded.digest, summary },
      [`Proposed revision for ${result.state.id}.`, ...summary, `Digest: ${loaded.digest}`].join(
        "\n"
      )
    )
    return EXIT_OK
  }
  if (command === "node-done") {
    shape(command, parsed, 2, 2, ["token", "outcome", "hold"])
    const token = flag(parsed, "token")
    const outcome = flag(parsed, "outcome")
    if (token === null || (outcome !== "completed" && outcome !== "failed")) {
      throw new Error(HELP[command])
    }
    const runDir = runDirectory(parsed.positionals[0] as string)
    const result = await submitNodeDone(
      runDir,
      parsed.positionals[1] as string,
      token,
      outcome,
      booleanFlag(parsed, "hold")
    )
    output(
      json,
      { ...result, submitted: true },
      `Submitted ${outcome}${result.hold ? " with an atomic downstream hold" : ""} for ${result.nodeId}.`
    )
    return EXIT_OK
  }
  if (command === "herdr-event") {
    shape(command, parsed, 0, 0, [])
    const result = await handleHerdrAgentStatusEvent(
      process.env.HERDR_PLUGIN_EVENT,
      process.env.HERDR_PLUGIN_EVENT_JSON
    )
    output(
      json,
      result,
      `Handled Herdr event; matched ${result.matched} node(s), prompted ${result.prompted} master(s).`
    )
    return EXIT_OK
  }
  if (command === "node-exit") {
    shape(command, parsed, 2, 2, ["token", "code"])
    const token = flag(parsed, "token")
    const code = integer(flag(parsed, "code"), "--code")
    if (token === null || code === null) {
      throw new Error(HELP[command])
    }
    return mutation(
      parsed.positionals[0] as string,
      {
        type: "node-exit",
        nodeId: parsed.positionals[1] as string,
        token,
        code,
        error: null
      },
      json,
      "Recorded command exit for"
    )
  }
  if (command === "ui") {
    if (json && (parsed.positionals[0] === "edit" || parsed.positionals[0] === "wizard")) {
      throw new Error(`ui ${parsed.positionals[0]} is interactive and cannot be used with --json.`)
    }
    return handleUi(parsed, json)
  }
  if (command === "clean") {
    shape(command, parsed, 0, 1, ["settled", "dry-run"])
    if ((parsed.positionals.length === 0) === !has(parsed, "settled")) {
      throw new Error("clean requires one run or --settled.")
    }
    const runDirs = has(parsed, "settled")
      ? (await listRunStates()).states
          .filter((state) => ["completed", "failed", "stopped"].includes(state.status))
          .map((state) => path.join(stateRoot(), "runs", state.id))
      : [await resolveRunDirectory(parsed.positionals[0] as string)]
    const plan = [] as Array<{
      runId: string
      panes: readonly string[]
      worktrees: readonly string[]
      directory: string
    }>
    if (has(parsed, "dry-run")) {
      for (const runDir of runDirs) {
        plan.push((await inspectCleanRun(runDir, false)).item)
      }
    } else {
      const surface = new HerdrSurface()
      for (const runDir of runDirs) {
        const release = await acquireRunLock(runDir)
        try {
          const inspected = await inspectCleanRun(runDir, true)
          if (
            inspected.state.status !== "completed" &&
            inspected.state.status !== "failed" &&
            inspected.state.status !== "stopped"
          ) {
            throw new Error(
              `Run "${inspected.state.id}" is ${inspected.state.status}; stop it before cleaning.`
            )
          }
          plan.push(inspected.item)
          for (const pane of inspected.item.panes) {
            await surface.closePane(pane).catch(() => undefined)
          }
          await removeWorkflowWorktrees(inspected.workflow, inspected.state)
          await removeRun(inspected.item.directory)
        } finally {
          await release()
        }
      }
    }
    output(
      json,
      { dryRun: has(parsed, "dry-run"), runs: plan },
      `${has(parsed, "dry-run") ? "Would clean" : "Cleaned"} ${plan.length} run(s).`
    )
    return EXIT_OK
  }
  if (command === "completion") {
    shape(command, parsed, 1, 1, [])
    const shell = parsed.positionals[0] as string
    const script = completionScript(shell)
    output(json, { shell, script }, script)
    return EXIT_OK
  }
  if (command === "doctor") {
    shape(command, parsed, 0, 0, [])
    const report = await doctorReport()
    output(
      json,
      report,
      [
        `Build: ${report.build}`,
        ...report.checks.map(
          (check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`
        )
      ].join("\n")
    )
    return report.ok ? EXIT_OK : EXIT_ERROR
  }
  if (command === "setup") {
    shape(command, parsed, 0, 0, ["dry-run", "remove", "defaults", "no-wizard"])
    if (has(parsed, "defaults") && has(parsed, "no-wizard")) {
      throw new Error("setup accepts --defaults or --no-wizard, not both.")
    }
    const delegatedSource = process.env.ORCHESTRATE_SETUP_SOURCE?.trim()
    delete process.env.ORCHESTRATE_SETUP_SOURCE
    const result = await runSetup({
      invokedPath:
        delegatedSource === undefined || delegatedSource.length === 0
          ? scriptPath
          : delegatedSource,
      remove: has(parsed, "remove"),
      dryRun: has(parsed, "dry-run")
    })
    if (!result.dryRun && !result.remove) {
      if (has(parsed, "defaults")) {
        await replaceUiPreferenceLayer(emptyUiLayer(), null)
      } else if (
        !json &&
        !has(parsed, "no-wizard") &&
        process.stdin.isTTY &&
        process.stdout.isTTY
      ) {
        await runUiWizard(null)
      }
    }
    const doctor = result.dryRun || result.remove ? null : await doctorReport()
    output(
      json,
      { ...result, doctor },
      result.steps
        .map(
          (step) =>
            `${step.status.toUpperCase()} ${step.action}: ${step.target}${step.detail === null ? "" : ` — ${step.detail}`}`
        )
        .join("\n")
    )
    return doctor === null || doctor.ok ? EXIT_OK : EXIT_ERROR
  }
  return EXIT_ERROR
}
