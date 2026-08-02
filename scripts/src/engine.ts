import { Ajv2020 } from "ajv/dist/2020.js"
import { Deferred, Effect, Fiber, FiberMap, Queue, Ref, Schedule, Semaphore } from "effect"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, openSync, realpathSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import type {
  AgentNode,
  DynamicNode,
  EventRecord,
  InputSpec,
  NodeRunState,
  ProcessIdentity,
  RunState,
  SessionState,
  SupervisorDecision,
  SupervisorNode,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

import supervisorOutputJsonSchema from "../../references/supervisor-decision.schema.json" with { type: "json" }
import internalSupervisorDecisionJsonSchema from "./generated/supervisor-decision.internal.schema.json" with { type: "json" }
import { boundedStderrTail, readTextIfPresent, runProcessEffect } from "./process.js"
import { effectiveNodeTimeout, executeAgentEffect, renderAgentPromptText } from "./providers.js"
import {
  pollControlRequestsEffect,
  removeControlRequestsEffect
} from "./runtime/control-requests.js"
import {
  appendEventEffect,
  deliverRecordedCallbackEffect,
  desktopNotificationArgv,
  emitEventEffect as emitEffect
} from "./runtime/event-journal.js"
import {
  createInteractiveHostEffect,
  executeInteractiveNodeEffect,
  type InteractiveHost
} from "./runtime/interactive.js"
import { createRunMirror, type RunMirror } from "./runtime/mirror.js"
import { makeRunStore, StatePersistenceError, type RunStore } from "./runtime/run-store.js"
import { allWorkflowNodes, selectRunnableBatch, terminalNode } from "./runtime/scheduler.js"
import {
  CONTRACT_VERSION,
  acquireWorkerLock,
  appendEvent,
  readJson,
  readRunState,
  workflowPath,
  writeRunState
} from "./state.js"
import { normalizedStaticPrefix, overlappingMutableNodes, validateWorkflow } from "./validation.js"

const EMERGENCY_AGENT_START_FUSE = 10_000

function now(): string {
  return new Date().toISOString()
}

function approvalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function pendingPatchDigest(
  supervisorId: string,
  decision: SupervisorDecision,
  reasons: readonly string[]
): string {
  return approvalDigest({ supervisorId, decision, reasons })
}

export function legacyPendingPatchDigest(decision: SupervisorDecision): string {
  return approvalDigest(decision)
}

export function supervisorInputDigest(supervisorId: string, reason: string, round: number): string {
  return approvalDigest({ supervisorId, reason, round })
}

// Binds one gate approval to this run, this node, and the exact rendered
// content the node would execute with; any change to any of the three
// invalidates the approval.
export function gateApprovalDigest(runId: string, nodeId: string, content: string): string {
  return approvalDigest({ runId, nodeId, content })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function promiseEffect<A>(operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: operation, catch: asError })
}

function canonicalPath(candidate: string): string {
  let cursor = path.resolve(candidate)
  const tail: string[] = []
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) {
      break
    }
    tail.push(path.basename(cursor))
    cursor = parent
  }
  const canonicalBase = existsSync(cursor) ? realpathSync(cursor) : cursor
  return path.resolve(canonicalBase, ...tail.toReversed())
}

function withinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(canonicalPath(root), canonicalPath(candidate))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function arrayEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function setEquals(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].toSorted()
  const sortedRight = [...right].toSorted()
  return arrayEquals(sortedLeft, sortedRight)
}

function startsWithArray(value: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((part, index) => value[index] === part)
}

function recordEquals(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftEntries = Object.entries(left).toSorted(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).toSorted(([a], [b]) => a.localeCompare(b))
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value
    )
  )
}

function supervisorBarrierCycle(
  workflow: WorkflowSpec,
  state: RunState,
  supervisor: SupervisorNode,
  added: readonly DynamicNode[]
): string | null {
  const byId = new Map(
    [...workflow.nodes, ...state.dynamicNodes, ...added].map((node) => [node.id, node])
  )
  const dependsOnSupervisor = (nodeId: string, seen = new Set<string>()): boolean => {
    if (nodeId === supervisor.id) {
      return true
    }
    if (seen.has(nodeId)) {
      return false
    }
    seen.add(nodeId)
    return (
      byId.get(nodeId)?.needs.some((dependency) => dependsOnSupervisor(dependency, seen)) === true
    )
  }
  const cyclic = added.find((node) => dependsOnSupervisor(node.id))
  return cyclic?.id ?? null
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate)
    return true
  } catch {
    return false
  }
}

function renderToken(value: string, runId: string, nodeId: string): string {
  return value.replaceAll("{{runId}}", runId).replaceAll("{{nodeId}}", nodeId)
}

// Only worktree SETUP mutates the base repository ("git worktree add"), so it
// is serialized per canonical repo while node bodies run concurrently in
// their worktrees. The worker is a single process, so in-memory locks suffice.
const worktreeSetupLocks = new Map<string, Semaphore.Semaphore>()

function worktreeSetupLock(baseRepo: string): Semaphore.Semaphore {
  const key = canonicalPath(baseRepo)
  let lock = worktreeSetupLocks.get(key)
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1)
    worktreeSetupLocks.set(key, lock)
  }
  return lock
}

function resolveWorkspaceEffect(
  workflow: WorkflowSpec,
  node: WorkflowNode,
  runDir: string,
  timeoutMinutes: number | null,
  onSpawn: (
    pid: number,
    identity: ProcessIdentity | null
  ) => Effect.Effect<void, Error | StatePersistenceError>
): Effect.Effect<string, Error | StatePersistenceError> {
  const workspace = node.workspace
  if (workspace.mode !== "git-worktree") {
    return Effect.succeed(path.resolve(workspace.path ?? node.cwd ?? workflow.cwd))
  }
  const base = path.resolve(node.cwd ?? workflow.cwd)
  const setup = Effect.gen(function* () {
    const workspacePath = path.resolve(workspace.path ?? path.join(runDir, "workspaces", node.id))
    const git = workspace.git
    const branch = renderToken(git.branch, path.basename(runDir), node.id)
    if (yield* promiseEffect(() => pathExists(workspacePath))) {
      const inspectionPath = path.join(runDir, `worktree-inspect-${node.id}.log`)
      const inspection = yield* runProcessEffect({
        argv: ["git", "-C", base, "worktree", "list", "--porcelain"],
        cwd: base,
        stdoutPath: inspectionPath,
        stderrPath: path.join(runDir, `worktree-inspect-${node.id}-error.log`),
        timeoutMinutes,
        onSpawn
      })
      if (inspection.exitCode !== 0) {
        return yield* Effect.fail(
          new Error(`Could not inspect existing Git worktree for node "${node.id}".`)
        )
      }
      const blocks = (yield* promiseEffect(() => readTextIfPresent(inspectionPath))).split(/\n\n+/)
      const expectedPath = canonicalPath(workspacePath)
      const expectedBranch = `refs/heads/${branch}`
      const match = blocks.find((block) => {
        const worktree = block.match(/^worktree (.+)$/m)?.[1]
        return worktree !== undefined && canonicalPath(worktree) === expectedPath
      })
      if (match === undefined || !match.split("\n").includes(`branch ${expectedBranch}`)) {
        return yield* Effect.fail(
          new Error(
            `Existing path for node "${node.id}" is not the approved Git worktree and branch.`
          )
        )
      }
      const ancestry = yield* runProcessEffect({
        argv: ["git", "-C", workspacePath, "merge-base", "--is-ancestor", git.startPoint, "HEAD"],
        cwd: workspacePath,
        stdoutPath: path.join(runDir, `worktree-base-${node.id}.log`),
        stderrPath: path.join(runDir, `worktree-base-${node.id}-error.log`),
        timeoutMinutes,
        onSpawn
      })
      if (ancestry.exitCode !== 0) {
        return yield* Effect.fail(
          new Error(
            `Existing Git worktree for node "${node.id}" is not based on ${git.startPoint}.`
          )
        )
      }
      return workspacePath
    }
    yield* promiseEffect(() => mkdir(path.dirname(workspacePath), { recursive: true }))
    const result = yield* runProcessEffect({
      argv: ["git", "-C", base, "worktree", "add", workspacePath, "-b", branch, git.startPoint],
      cwd: base,
      stdoutPath: path.join(runDir, "worktree.log"),
      stderrPath: path.join(runDir, "worktree-error.log"),
      timeoutMinutes,
      onSpawn
    })
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new Error(`git worktree add failed for node "${node.id}" with exit ${result.exitCode}.`)
      )
    }
    return workspacePath
  })
  return worktreeSetupLock(base).withPermit(setup)
}

async function validateAgentOutput(node: AgentNode, resultText: string): Promise<void> {
  if (node.output.format !== "json") {
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(resultText)
  } catch (error) {
    throw new Error(
      `Node "${node.id}" returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    )
  }
  if (node.output.schema !== null) {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const validate = ajv.compile(node.output.schema)
    if (!validate(parsed)) {
      throw new Error(
        `Node "${node.id}" output failed JSON Schema validation: ${ajv.errorsText(validate.errors, {
          separator: "; "
        })}`
      )
    }
  }
}

function supervisorContext(
  workflow: WorkflowSpec,
  node: SupervisorNode,
  state: RunState,
  resultPaths: Readonly<Record<string, string>>
): string {
  const round = state.goalRounds[node.id] ?? 0
  const barrier = state.supervisorBarriers[node.id] ?? node.needs
  const results = barrier
    .map((id) => {
      const result = resultPaths[id]
      return result === undefined ? `${id}: no result` : `${id}: ${result}`
    })
    .join("\n")
  const response = state.supervisorResponses[node.id]
  return [
    `Goal: ${node.goal}`,
    `Success condition: ${node.termination.success}`,
    `Convergence test: ${node.termination.convergence}`,
    `Completed adaptive rounds: ${round}`,
    `Latest result paths:\n${results}`,
    ...(response === undefined
      ? []
      : [
          `User response to the previous pause (input digest ${response.inputDigest}):`,
          response.message
        ]),
    "",
    "Return only the structured supervisor decision. Use status=complete when the goal is met.",
    "Use status=continue and addNodes to schedule the next bounded round.",
    "Use status=pause when user judgment or permission outside the envelope is needed.",
    `Approved envelope: ${JSON.stringify(node.envelope)}`
  ].join("\n")
}

function envelopeViolations(
  workflow: WorkflowSpec,
  supervisor: SupervisorNode,
  decision: SupervisorDecision,
  state: RunState
): readonly string[] {
  const violations: string[] = []
  const added = decision.addNodes
  if (
    supervisor.envelope.maxAddedNodesPerRound !== null &&
    added.length > supervisor.envelope.maxAddedNodesPerRound
  ) {
    violations.push(
      `Patch adds ${added.length} nodes, above maxAddedNodesPerRound=${supervisor.envelope.maxAddedNodesPerRound}.`
    )
  }
  for (const node of added) {
    if (!supervisor.envelope.nodeTypes.includes(node.type)) {
      violations.push(`Node "${node.id}" has unapproved type "${node.type}".`)
    }
    if (!supervisor.envelope.workspaceModes.includes(node.workspace.mode)) {
      violations.push(`Node "${node.id}" uses unapproved workspace mode "${node.workspace.mode}".`)
    }
    if (!supervisor.envelope.vcs.includes(node.workspace.vcs)) {
      violations.push(`Node "${node.id}" uses unapproved VCS "${node.workspace.vcs}".`)
    }
    if (node.workspace.mode === "git-worktree") {
      const git = node.workspace.git
      if (
        !supervisor.envelope.gitWorktree.allowed ||
        git === null ||
        !supervisor.envelope.gitWorktree.branchPrefixes.some((prefix) =>
          git.branch.startsWith(prefix)
        ) ||
        !supervisor.envelope.gitWorktree.startPoints.includes(git.startPoint) ||
        (git.removeOnClean && !supervisor.envelope.gitWorktree.allowRemoveOnClean)
      ) {
        violations.push(`Node "${node.id}" uses unapproved Git worktree settings.`)
      }
    }
    if (node.type === "command") {
      if (!supervisor.envelope.allowCommands) {
        violations.push(`Node "${node.id}" adds an unapproved command.`)
      } else if (
        !supervisor.envelope.commandArgvPrefixes.some((prefix) =>
          startsWithArray(node.argv, prefix)
        )
      ) {
        violations.push(`Node "${node.id}" argv is outside the approved command prefixes.`)
      } else if (
        Object.keys(node.env).length > 0 &&
        !supervisor.envelope.allowedCommandEnv.some((allowed) => recordEquals(node.env, allowed))
      ) {
        violations.push(`Node "${node.id}" environment is outside the approved command values.`)
      }
      if (node.inheritEnv.length > 0) {
        violations.push(
          `Node "${node.id}" is an adaptive command and may not inherit controller environment variables; it must declare inheritEnv: [].`
        )
      }
    } else {
      if (!supervisor.envelope.providers.includes(node.provider)) {
        violations.push(`Node "${node.id}" uses unapproved provider "${node.provider}".`)
      }
      if (
        !supervisor.envelope.models.includes(node.model) &&
        !supervisor.envelope.models.includes("*")
      ) {
        violations.push(`Node "${node.id}" uses unapproved model "${node.model}".`)
      }
      if (
        node.provider === "codex" &&
        !supervisor.envelope.codexSandboxes.includes(node.permissions.sandbox)
      ) {
        violations.push(`Node "${node.id}" uses an unapproved Codex sandbox.`)
      }
      if (
        node.provider === "claude" &&
        !supervisor.envelope.claudePermissionModes.includes(node.permissions.permissionMode)
      ) {
        violations.push(`Node "${node.id}" uses an unapproved Claude permission mode.`)
      }
      if (
        node.permissions.extraArgs.length > 0 &&
        !supervisor.envelope.allowedExtraArgs.some((allowed) =>
          arrayEquals(node.permissions.extraArgs, allowed)
        )
      ) {
        violations.push(`Node "${node.id}" uses unapproved provider CLI arguments.`)
      }
      if (
        node.permissions.inheritEnv.length > 0 &&
        !supervisor.envelope.allowedInheritedEnv.some((allowed) =>
          setEquals(node.permissions.inheritEnv, allowed)
        )
      ) {
        violations.push(`Node "${node.id}" inherits unapproved provider environment variables.`)
      }
      if (
        Object.keys(node.permissions.env).length > 0 &&
        !supervisor.envelope.allowedProviderEnv.some((allowed) =>
          recordEquals(node.permissions.env, allowed)
        )
      ) {
        violations.push(`Node "${node.id}" uses unapproved provider environment values.`)
      }
      if (
        node.session.from !== null &&
        !supervisor.envelope.resumableSessionAliases.includes(node.session.from)
      ) {
        violations.push(
          `Node "${node.id}" resumes unapproved session alias "${node.session.from}".`
        )
      }
      const savedAlias = node.session.saveAs
      if (
        savedAlias !== null &&
        !supervisor.envelope.newSessionAliasPrefixes.some((prefix) => savedAlias.startsWith(prefix))
      ) {
        violations.push(
          `Node "${node.id}" saves session alias "${node.session.saveAs}" outside approved prefixes.`
        )
      }
    }
    const mayMutate =
      node.type === "command"
        ? node.mutates
        : (node.provider === "codex" && node.permissions.sandbox !== "read-only") ||
          (node.provider === "claude" && node.permissions.permissionMode !== "plan")
    if (mayMutate && node.workspace.writes.length === 0) {
      violations.push(`Potentially mutating node "${node.id}" has no declared write set.`)
    }
    const cwd = path.resolve(node.workspace.path ?? node.cwd ?? workflow.cwd)
    if (!supervisor.envelope.cwdRoots.some((root) => withinRoot(cwd, root))) {
      violations.push(`Node "${node.id}" cwd is outside approved roots: ${cwd}`)
    }
    for (const write of node.workspace.writes) {
      const staticPart = normalizedStaticPrefix(write)
      const target = path.resolve(cwd, staticPart)
      if (!supervisor.envelope.writeRoots.some((root) => withinRoot(target, root))) {
        violations.push(`Node "${node.id}" write path is outside approved roots: ${target}`)
      }
    }
  }

  const merged: WorkflowSpec = {
    ...workflow,
    nodes: [...workflow.nodes, ...state.dynamicNodes, ...added]
  }
  const previousPairs = new Set(
    overlappingMutableNodes({
      ...workflow,
      nodes: [...workflow.nodes, ...state.dynamicNodes]
    }).map(([left, right]) => `${left}\0${right}`)
  )
  for (const [left, right] of overlappingMutableNodes(merged)) {
    if (!previousPairs.has(`${left}\0${right}`)) {
      violations.push(
        `Patch introduces a parallel write conflict between "${left}" and "${right}".`
      )
    }
  }
  return violations
}

function resultPathMap(state: RunState): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.values(state.nodes)
      .filter((node) => node.resultPath !== null)
      .map((node) => [node.id, node.resultPath as string])
  )
}

function effectiveWorkflowNodeTimeout(workflow: WorkflowSpec, node: WorkflowNode): number | null {
  return effectiveNodeTimeout(node, workflow.limits.nodeWallTimeMinutes)
}

interface ResolvedCommandInput {
  readonly from: string
  readonly as: string
  readonly include: "content" | "path"
  readonly value: string
}

// Resolves a command node's declared inputs exactly as they are written to
// its inputs.json file; gate content for command nodes digests this same
// resolution.
async function resolveCommandInputs(
  inputs: readonly InputSpec[],
  resultPaths: Readonly<Record<string, string>>
): Promise<readonly ResolvedCommandInput[]> {
  return Promise.all(
    inputs.map(async (input) => {
      const resultPath = resultPaths[input.from]
      if (resultPath === undefined) {
        throw new Error(`Input result for "${input.from}" is unavailable.`)
      }
      return {
        from: input.from,
        as: input.as,
        include: input.include,
        value: input.include === "path" ? resultPath : await readFile(resultPath, "utf8")
      }
    })
  )
}

// The exact digest-bound content a gate approval covers: the fully rendered
// prompt for agent-like nodes (frame + input sections + supervisor context),
// or the argv plus resolved inputs for command nodes. Environment values are
// deliberately never part of this content.
function gateContentEffect(
  workflow: WorkflowSpec,
  node: WorkflowNode,
  state: RunState
): Effect.Effect<string, Error> {
  const resultPaths = resultPathMap(state)
  if (node.type === "command") {
    return promiseEffect(async () =>
      JSON.stringify(
        { argv: node.argv, inputs: await resolveCommandInputs(node.inputs, resultPaths) },
        null,
        2
      )
    )
  }
  return promiseEffect(() =>
    renderAgentPromptText(
      node,
      resultPaths,
      node.type === "supervisor" ? supervisorContext(workflow, node, state, resultPaths) : undefined
    )
  )
}

function executeCommandNodeEffect(
  node: Extract<WorkflowNode, { readonly type: "command" }>,
  cwd: string,
  nodeDir: string,
  resultPaths: Readonly<Record<string, string>>,
  timeoutMinutes: number | null,
  onSpawn: (
    pid: number,
    identity: ProcessIdentity | null
  ) => Effect.Effect<void, Error | StatePersistenceError>
): Effect.Effect<
  { readonly exitCode: number; readonly resultText: string },
  Error | StatePersistenceError
> {
  return Effect.gen(function* () {
    const stdoutPath = path.join(nodeDir, "stdout.log")
    const inputs = yield* promiseEffect(() => resolveCommandInputs(node.inputs, resultPaths))
    const inputsPath = path.join(nodeDir, "inputs.json")
    yield* promiseEffect(() =>
      writeFile(inputsPath, `${JSON.stringify(inputs, null, 2)}\n`, { mode: 0o600 })
    )
    const inherited = Object.fromEntries(
      node.inheritEnv.flatMap((name) => {
        const value = process.env[name]
        return value === undefined ? [] : [[name, value]]
      })
    )
    const result = yield* runProcessEffect({
      argv: node.argv,
      cwd,
      env: { ...inherited, ...node.env, ORCHESTRATE_INPUTS_FILE: inputsPath },
      inheritEnv: false,
      stdoutPath,
      stderrPath: path.join(nodeDir, "stderr.log"),
      timeoutMinutes,
      onSpawn
    })
    if (!node.allowedExitCodes.includes(result.exitCode)) {
      const stderrTail = yield* promiseEffect(() =>
        boundedStderrTail(path.join(nodeDir, "stderr.log"))
      )
      return yield* Effect.fail(
        new Error(
          `Command exited with ${String(result.exitCode)}; allowed: ${node.allowedExitCodes.join(", ")}.${
            stderrTail.length === 0 ? "" : ` Last stderr: ${stderrTail}`
          }`
        )
      )
    }
    return {
      exitCode: result.exitCode,
      resultText: yield* promiseEffect(() => readTextIfPresent(stdoutPath))
    }
  })
}

// Compiled lazily so startup never pays for it on runs without supervisors.
let supervisorDecisionValidator: ReturnType<Ajv2020["compile"]> | null = null

function parseSupervisorDecision(resultText: string): SupervisorDecision {
  const parsed = JSON.parse(resultText) as unknown
  supervisorDecisionValidator ??= new Ajv2020({ allErrors: true, strict: false }).compile(
    internalSupervisorDecisionJsonSchema
  )
  if (supervisorDecisionValidator(parsed) !== true) {
    throw new Error(
      `Supervisor decision failed JSON Schema validation: ${new Ajv2020().errorsText(
        supervisorDecisionValidator.errors ?? [],
        { separator: "; " }
      )}`
    )
  }
  return parsed as SupervisorDecision
}

function pauseRunEffect(
  workflow: WorkflowSpec,
  runDir: string,
  store: RunStore,
  reason: string,
  code: string
): Effect.Effect<void, Error | StatePersistenceError> {
  return Effect.gen(function* () {
    const state = yield* store.update((current) => ({
      ...current,
      status: "pausing",
      pauseReason: reason,
      pauseCode: code
    }))
    yield* emitEffect(workflow, runDir, state, "run.pausing", reason, undefined, undefined, true)
  })
}

function applyDecisionEffect(
  workflow: WorkflowSpec,
  runDir: string,
  store: RunStore,
  supervisor: SupervisorNode,
  decision: SupervisorDecision,
  approved: boolean
): Effect.Effect<boolean, Error | StatePersistenceError> {
  return Effect.gen(function* () {
    let state = yield* store.read
    if (decision.status === "complete") {
      state = yield* store.update((current) => ({
        ...current,
        nodes: {
          ...current.nodes,
          [supervisor.id]: {
            ...(current.nodes[supervisor.id] as NodeRunState),
            status: "completed",
            finishedAt: now()
          }
        },
        supervisorBarriers: { ...current.supervisorBarriers, [supervisor.id]: [] },
        pendingPatch: null,
        approvedPendingPatch: false,
        supervisorResponses: Object.fromEntries(
          Object.entries(current.supervisorResponses).filter(([id]) => id !== supervisor.id)
        )
      }))
      yield* emitEffect(
        workflow,
        runDir,
        state,
        "node.completed",
        `Completed "${supervisor.title}" (${supervisor.id}).`,
        supervisor.id,
        undefined,
        workflow.heartbeat.milestones
      )
      return true
    }
    if (decision.status === "pause") {
      const inputDigest = supervisorInputDigest(
        supervisor.id,
        decision.reason,
        state.goalRounds[supervisor.id] ?? 0
      )
      yield* store.update((current) => ({
        ...current,
        nodes: {
          ...current.nodes,
          [supervisor.id]: {
            ...(current.nodes[supervisor.id] as NodeRunState),
            status: "pending",
            finishedAt: now()
          }
        },
        pendingInput: {
          supervisorId: supervisor.id,
          reason: decision.reason,
          digest: inputDigest
        },
        supervisorResponses: Object.fromEntries(
          Object.entries(current.supervisorResponses).filter(([id]) => id !== supervisor.id)
        )
      }))
      yield* pauseRunEffect(
        workflow,
        runDir,
        store,
        `Supervisor "${supervisor.id}" requested input: ${decision.reason}`,
        `supervisor-input:${supervisor.id}`
      )
      return false
    }
    if (decision.addNodes.length === 0) {
      yield* store.update((current) => ({
        ...current,
        nodes: {
          ...current.nodes,
          [supervisor.id]: {
            ...(current.nodes[supervisor.id] as NodeRunState),
            status: "pending",
            finishedAt: now()
          }
        }
      }))
      yield* pauseRunEffect(
        workflow,
        runDir,
        store,
        `Supervisor "${supervisor.id}" requested another round without adding work. This is treated as semantic no-progress.`,
        `semantic-no-progress:${supervisor.id}`
      )
      return false
    }
    const completedRounds = state.goalRounds[supervisor.id] ?? 0
    const goalRoundsCode = `goal-rounds:${supervisor.id}`
    if (
      !state.overriddenLimits.includes(goalRoundsCode) &&
      ((supervisor.termination.maxRounds !== null &&
        completedRounds >= supervisor.termination.maxRounds) ||
        (workflow.limits.maxGoalRounds !== null &&
          completedRounds >= workflow.limits.maxGoalRounds))
    ) {
      yield* store.update((current) => ({
        ...current,
        nodes: {
          ...current.nodes,
          [supervisor.id]: {
            ...(current.nodes[supervisor.id] as NodeRunState),
            status: "pending",
            finishedAt: now()
          }
        }
      }))
      yield* pauseRunEffect(
        workflow,
        runDir,
        store,
        `Supervisor "${supervisor.id}" requested another round after reaching its approved goal-round limit.`,
        goalRoundsCode
      )
      return false
    }
    if (
      !state.overriddenLimits.includes(`goal-wall-time:${supervisor.id}`) &&
      supervisor.termination.maxWallTimeMinutes !== null &&
      state.supervisorStartedAt[supervisor.id] !== undefined &&
      (Date.now() - new Date(state.supervisorStartedAt[supervisor.id] as string).getTime()) /
        60_000 >=
        supervisor.termination.maxWallTimeMinutes
    ) {
      yield* store.update((current) => ({
        ...current,
        nodes: {
          ...current.nodes,
          [supervisor.id]: {
            ...(current.nodes[supervisor.id] as NodeRunState),
            status: "pending",
            finishedAt: now()
          }
        }
      }))
      yield* pauseRunEffect(
        workflow,
        runDir,
        store,
        `Supervisor "${supervisor.id}" requested another round after reaching its approved goal wall-time limit.`,
        `goal-wall-time:${supervisor.id}`
      )
      return false
    }
    // Interactive nodes are ALWAYS out-of-envelope for adaptive patches, as a
    // hard rejection rather than an approvable violation: a supervisor must
    // not spawn human-attended sessions.
    const interactiveAdded = decision.addNodes.find(
      (candidate) => candidate.type === "agent" && candidate.interactive
    )
    if (interactiveAdded !== undefined) {
      yield* store.update((current) => ({
        ...current,
        nodes: {
          ...current.nodes,
          [supervisor.id]: {
            ...(current.nodes[supervisor.id] as NodeRunState),
            status: "pending",
            finishedAt: now()
          }
        }
      }))
      yield* pauseRunEffect(
        workflow,
        runDir,
        store,
        `Supervisor "${supervisor.id}" proposed interactive node "${interactiveAdded.id}". Adaptive patches may never add interactive nodes; this patch cannot be approved.`,
        `invalid-patch:${supervisor.id}`
      )
      return false
    }
    const cyclicBarrierNode = supervisorBarrierCycle(workflow, state, supervisor, decision.addNodes)
    if (cyclicBarrierNode !== null) {
      yield* store.update((current) => ({
        ...current,
        nodes: {
          ...current.nodes,
          [supervisor.id]: {
            ...(current.nodes[supervisor.id] as NodeRunState),
            status: "pending",
            finishedAt: now()
          }
        }
      }))
      yield* pauseRunEffect(
        workflow,
        runDir,
        store,
        `Supervisor "${supervisor.id}" proposed node "${cyclicBarrierNode}" that depends on the supervisor while also becoming its barrier.`,
        `invalid-patch:${supervisor.id}`
      )
      return false
    }
    const mergedValidation = validateWorkflow({
      ...workflow,
      nodes: [...workflow.nodes, ...state.dynamicNodes, ...decision.addNodes]
    })
    const structuralErrors = mergedValidation.issues.filter(
      (issue) => issue.severity === "error" && issue.code !== "write-conflict"
    )
    if (structuralErrors.length > 0) {
      yield* store.update((current) => ({
        ...current,
        nodes: {
          ...current.nodes,
          [supervisor.id]: {
            ...(current.nodes[supervisor.id] as NodeRunState),
            status: "pending",
            finishedAt: now()
          }
        }
      }))
      yield* pauseRunEffect(
        workflow,
        runDir,
        store,
        `Supervisor "${supervisor.id}" proposed an invalid DAG patch: ${structuralErrors
          .map((issue) => issue.message)
          .join(" ")}`,
        `invalid-patch:${supervisor.id}`
      )
      return false
    }
    const violations = approved ? [] : envelopeViolations(workflow, supervisor, decision, state)
    if (violations.length > 0) {
      yield* store.update((current) => ({
        ...current,
        pendingPatch: {
          supervisorId: supervisor.id,
          decision,
          reasons: violations,
          digest: pendingPatchDigest(supervisor.id, decision, violations)
        },
        approvedPendingPatch: false,
        nodes: {
          ...current.nodes,
          [supervisor.id]: {
            ...(current.nodes[supervisor.id] as NodeRunState),
            status: "pending",
            finishedAt: now()
          }
        }
      }))
      yield* pauseRunEffect(
        workflow,
        runDir,
        store,
        `Supervisor "${supervisor.id}" proposed work outside its approved envelope: ${violations.join(" ")}`,
        `adaptive-patch:${supervisor.id}`
      )
      return false
    }
    const newNodeStates = Object.fromEntries(
      decision.addNodes.map((node) => [
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
        } satisfies NodeRunState
      ])
    )
    state = yield* store.update((current) => ({
      ...current,
      dynamicNodes: [...current.dynamicNodes, ...decision.addNodes],
      nodes: {
        ...current.nodes,
        ...newNodeStates,
        [supervisor.id]: {
          ...(current.nodes[supervisor.id] as NodeRunState),
          status: "pending",
          finishedAt: now()
        }
      },
      supervisorBarriers: {
        ...current.supervisorBarriers,
        [supervisor.id]: decision.addNodes.map((node) => node.id)
      },
      goalRounds: {
        ...current.goalRounds,
        [supervisor.id]: (current.goalRounds[supervisor.id] ?? 0) + 1
      },
      pendingPatch: null,
      approvedPendingPatch: false,
      supervisorResponses: Object.fromEntries(
        Object.entries(current.supervisorResponses).filter(([id]) => id !== supervisor.id)
      )
    }))
    yield* emitEffect(
      workflow,
      runDir,
      state,
      "goal.expanded",
      `Supervisor "${supervisor.id}" added ${decision.addNodes.length} nodes: ${decision.reason}`,
      supervisor.id,
      { nodes: decision.addNodes.map((node) => node.id) },
      workflow.heartbeat.milestones
    )
    return true
  })
}

class NodeAttemptError extends Error {
  readonly workspacePath: string

  constructor(cause: unknown, workspacePath: string) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "NodeAttemptError"
    this.workspacePath = workspacePath
  }
}

function runNodeEffect(
  workflow: WorkflowSpec,
  runDir: string,
  store: RunStore,
  node: WorkflowNode,
  detachedCallbacks: Queue.Queue<EventRecord>,
  mirror: RunMirror | null,
  interactiveHost: InteractiveHost | null
): Effect.Effect<void, Error | StatePersistenceError> {
  const markRetry = (
    failure: NodeAttemptError
  ): Effect.Effect<void, Error | StatePersistenceError> =>
    Effect.gen(function* () {
      const state = yield* store.update((current) => ({
        ...current,
        nodes: {
          ...current.nodes,
          [node.id]: {
            ...(current.nodes[node.id] as NodeRunState),
            status: "pending",
            finishedAt: now(),
            error: failure.message,
            workspacePath: failure.workspacePath || null,
            processPid: null,
            processIdentity: null,
            interactive: null
          }
        }
      }))
      yield* emitEffect(
        workflow,
        runDir,
        state,
        "node.retrying",
        `Node "${node.id}" failed and will retry: ${failure.message}`,
        node.id
      )
    })

  // The scheduler reserves the first agent start when it launches this node;
  // only in-fiber retry attempts add to the budget below.
  let startReserved = node.type !== "command"

  const attemptEffect = Effect.suspend(() =>
    Effect.gen(function* () {
      const previousState = yield* store.read
      const previous = previousState.nodes[node.id] as NodeRunState
      const attempt = previous.attempts + 1
      const nodeDir = path.join(runDir, "nodes", node.id, `attempt-${attempt}`)
      yield* promiseEffect(() => mkdir(nodeDir, { recursive: true }))
      let workspacePath = ""
      let state = yield* store.update((current) => ({
        ...current,
        supervisorStartedAt:
          node.type === "supervisor" && current.supervisorStartedAt[node.id] === undefined
            ? { ...current.supervisorStartedAt, [node.id]: now() }
            : current.supervisorStartedAt,
        nodes: {
          ...current.nodes,
          [node.id]: {
            ...(current.nodes[node.id] as NodeRunState),
            status: "running",
            attempts: attempt,
            startedAt: now(),
            finishedAt: null,
            error: null,
            workspacePath: null
          }
        }
      }))

      const timeoutMinutes = effectiveWorkflowNodeTimeout(workflow, node)
      const body = Effect.gen(function* () {
        const trackProcess = (
          pid: number,
          identity: ProcessIdentity | null
        ): Effect.Effect<void, StatePersistenceError> =>
          Effect.asVoid(
            store.update((current) => ({
              ...current,
              nodes: {
                ...current.nodes,
                [node.id]: {
                  ...(current.nodes[node.id] as NodeRunState),
                  processPid: pid,
                  processIdentity: identity
                }
              }
            }))
          )

        workspacePath = yield* resolveWorkspaceEffect(
          workflow,
          node,
          runDir,
          timeoutMinutes,
          trackProcess
        )
        const countsAgentStart = node.type !== "command" && !startReserved
        startReserved = false
        state = yield* store.update((current) => ({
          ...current,
          agentStarts: countsAgentStart ? current.agentStarts + 1 : current.agentStarts,
          nodes: {
            ...current.nodes,
            [node.id]: {
              ...(current.nodes[node.id] as NodeRunState),
              workspacePath
            }
          }
        }))
        yield* emitEffect(
          workflow,
          runDir,
          state,
          "node.started",
          `Started "${node.title}" (${node.id}), attempt ${attempt}.`,
          node.id,
          undefined,
          workflow.heartbeat.milestones
        )
        // Presentation only: fire-and-forget herdr pane for this attempt.
        // The mirror never fails, blocks, or feeds anything back into the run.
        yield* Effect.sync(() => mirror?.nodeAttemptStarted(node, attempt))

        let exitCode = 0
        let resultText = ""
        let sessionId: string | null = null
        if (node.type === "command") {
          const result = yield* executeCommandNodeEffect(
            node,
            workspacePath,
            nodeDir,
            resultPathMap(state),
            timeoutMinutes,
            trackProcess
          )
          exitCode = result.exitCode
          resultText = result.resultText
        } else {
          const executionNode =
            node.session.reuseOnRepeat &&
            node.session.saveAs !== null &&
            state.sessions[node.session.saveAs] !== undefined
              ? {
                  ...node,
                  session: {
                    ...node.session,
                    mode: "resume" as const,
                    from: node.session.saveAs
                  }
                }
              : node
          if (node.type === "agent" && node.interactive) {
            if (interactiveHost === null) {
              yield* Effect.fail(
                new Error(
                  `Interactive node "${node.id}" has no herdr host; the herdr CLI is required (https://herdr.dev).`
                )
              )
            }
            const result = yield* executeInteractiveNodeEffect({
              workflow,
              runDir,
              store,
              host: interactiveHost as InteractiveHost,
              node: executionNode as AgentNode,
              attempt,
              nodeDir,
              cwd: workspacePath,
              sessions: state.sessions,
              resultPaths: resultPathMap(state)
            })
            exitCode = result.exitCode
            resultText = result.resultText
            sessionId = result.sessionId
          } else {
            const result = yield* executeAgentEffect({
              node: executionNode,
              cwd: workspacePath,
              nodeDir,
              runDir,
              sessions: state.sessions,
              resultPaths: resultPathMap(state),
              timeoutMinutes,
              onSpawn: trackProcess,
              ...(node.type === "supervisor"
                ? {
                    supervisorSchema: supervisorOutputJsonSchema,
                    supervisorContext: supervisorContext(
                      workflow,
                      node,
                      state,
                      resultPathMap(state)
                    )
                  }
                : {})
            })
            exitCode = result.exitCode
            resultText = result.resultText
            sessionId = result.sessionId
            if (exitCode !== 0) {
              const stderrTail = yield* promiseEffect(() =>
                boundedStderrTail(path.join(nodeDir, "stderr.log"))
              )
              yield* Effect.fail(
                new Error(
                  `${node.provider} exited with ${exitCode}.${
                    stderrTail.length === 0 ? "" : ` Last stderr: ${stderrTail}`
                  }`
                )
              )
            }
            if (node.type === "agent") {
              yield* promiseEffect(() => validateAgentOutput(node, resultText))
            }
          }
        }

        const resultPath = path.join(nodeDir, "result.txt")
        yield* promiseEffect(() => writeFile(resultPath, resultText, { mode: 0o600 }))
        state = yield* store.update((current) => ({
          ...current,
          sessions:
            node.type !== "command" && node.session.saveAs !== null && sessionId !== null
              ? {
                  ...current.sessions,
                  [node.session.saveAs]: {
                    alias: node.session.saveAs,
                    provider: node.provider,
                    sessionId
                  } satisfies SessionState
                }
              : current.sessions,
          nodes: {
            ...current.nodes,
            [node.id]: {
              ...(current.nodes[node.id] as NodeRunState),
              status: node.type === "supervisor" ? "running" : "completed",
              finishedAt: now(),
              exitCode,
              error: null,
              resultPath,
              sessionId,
              processPid: null,
              processIdentity: null,
              interactive: null
            }
          }
        }))

        if (node.type === "supervisor") {
          const decision = yield* Effect.try({
            try: () => parseSupervisorDecision(resultText),
            catch: asError
          })
          yield* applyDecisionEffect(workflow, runDir, store, node, decision, false)
        } else {
          yield* emitEffect(
            workflow,
            runDir,
            state,
            "node.completed",
            `Completed "${node.title}" (${node.id}).`,
            node.id,
            undefined,
            workflow.heartbeat.milestones
          )
        }
      })

      // One deadline bounds the whole attempt (worktree setup plus the main
      // process); interruption still kills the process tree via scope release.
      const bounded =
        timeoutMinutes === null
          ? body
          : Effect.raceFirst(
              body,
              Effect.andThen(
                Effect.sleep(timeoutMinutes * 60_000),
                Effect.fail(
                  new Error(`Node "${node.id}" timed out after ${timeoutMinutes} minutes.`)
                )
              )
            )

      return yield* Effect.matchEffect(bounded, {
        onFailure: (error) => {
          const failure: NodeAttemptError | StatePersistenceError =
            error instanceof StatePersistenceError
              ? error
              : new NodeAttemptError(error, workspacePath)
          return Effect.fail(failure)
        },
        onSuccess: () => Effect.succeed(undefined)
      })
    })
  )

  const retrySchedule = Schedule.tap(
    node.retry.delaySeconds > 0
      ? Schedule.upTo(Schedule.spaced(node.retry.delaySeconds * 1000), {
          times: node.retry.maxAttempts - 1
        })
      : Schedule.recurs(node.retry.maxAttempts - 1),
    ({ input }) =>
      input instanceof NodeAttemptError ? markRetry(input) : Effect.succeed(undefined)
  ) as Schedule.Schedule<number, Error, StatePersistenceError>

  const retried = Effect.retry(attemptEffect, {
    schedule: retrySchedule,
    while: (error: Error) => error instanceof NodeAttemptError
  })

  const settled = Effect.matchEffect(retried, {
    onFailure: (error) => {
      if (!(error instanceof NodeAttemptError)) {
        return Effect.fail(error)
      }
      return Effect.gen(function* () {
        const state = yield* store.update((current) => ({
          ...current,
          nodes: {
            ...current.nodes,
            [node.id]: {
              ...(current.nodes[node.id] as NodeRunState),
              status: "failed",
              finishedAt: now(),
              error: error.message,
              workspacePath: error.workspacePath || null,
              processPid: null,
              processIdentity: null,
              interactive: null
            }
          }
        }))
        yield* emitEffect(
          workflow,
          runDir,
          state,
          "node.failed",
          `Node "${node.id}" failed: ${error.message}`,
          node.id,
          undefined,
          true
        )
      })
    },
    onSuccess: () => Effect.succeed(undefined)
  })

  return Effect.onInterrupt(settled, () =>
    Effect.gen(function* () {
      const snapshot = yield* store.read
      const currentNode = snapshot.nodes[node.id] as NodeRunState
      if (terminalNode(currentNode.status)) {
        return
      }
      const state = yield* store.update((current) => ({
        ...current,
        nodes: {
          ...current.nodes,
          [node.id]: {
            ...(current.nodes[node.id] as NodeRunState),
            status: "cancelled",
            finishedAt: now(),
            error: "Interrupted by a stop request.",
            processPid: null,
            processIdentity: null,
            interactive: null
          }
        }
      }))
      const event = yield* appendEventEffect(
        runDir,
        state,
        "node.cancelled",
        `Node "${node.id}" was cancelled: Interrupted by a stop request.`,
        node.id
      )
      yield* Queue.offer(detachedCallbacks, event)
    })
  )
}

export function runWorkerEffect(runDir: string): Effect.Effect<void, Error> {
  return Effect.scoped(
    Effect.gen(function* () {
      const workerToken = randomUUID()
      yield* Effect.acquireRelease(
        promiseEffect(() => acquireWorkerLock(runDir, workerToken)),
        (release) => Effect.ignore(promiseEffect(release))
      )
      const initialState = yield* promiseEffect(() => readRunState(runDir))

      if (initialState.contractVersion !== CONTRACT_VERSION) {
        const reason = `Run ${initialState.id} was created by runtime contract ${
          initialState.contractVersion ?? "unversioned"
        }, but this runtime implements contract ${CONTRACT_VERSION}. Resume it with the runtime that created it, or clean this run and relaunch the workflow with the current runtime.`
        yield* promiseEffect(() =>
          appendEvent(runDir, {
            timestamp: now(),
            runId: initialState.id,
            type: "run.paused",
            message: reason
          })
        )
        yield* promiseEffect(() =>
          writeRunState(runDir, {
            ...initialState,
            status: "paused",
            pid: null,
            workerToken: null,
            pauseReason: reason,
            pauseCode: "contract-version",
            updatedAt: now()
          })
        )
        const notification = yield* Effect.match(
          runProcessEffect({
            argv: desktopNotificationArgv(
              `Run ${initialState.id} paused: runtime contract mismatch. Run "orchestrate status ${initialState.id}" for details.`
            ),
            cwd: runDir,
            stdoutPath: path.join(runDir, "callback.log"),
            stderrPath: path.join(runDir, "callback-error.log"),
            timeoutMinutes: 1
          }),
          { onFailure: (error) => error, onSuccess: () => null }
        )
        if (notification !== null) {
          yield* promiseEffect(() =>
            appendEvent(runDir, {
              timestamp: now(),
              runId: initialState.id,
              type: "callback.failed",
              message: notification.message
            })
          )
        }
        return
      }

      const workflowValidation = validateWorkflow(
        yield* promiseEffect(() => readJson<unknown>(workflowPath(runDir)))
      )
      if (workflowValidation.workflow === null || workflowValidation.digest === null) {
        const message = `Stored workflow is invalid: ${workflowValidation.issues
          .map((issue) => issue.message)
          .join(" ")}`
        yield* promiseEffect(() =>
          writeRunState(runDir, {
            ...initialState,
            status: "failed",
            error: message,
            finishedAt: now(),
            updatedAt: now()
          })
        )
        yield* Effect.fail(new Error(message))
      }
      if (workflowValidation.digest !== initialState.digest) {
        const message =
          "Stored workflow no longer matches the user-approved digest. Refusing to execute."
        yield* promiseEffect(() =>
          writeRunState(runDir, {
            ...initialState,
            status: "failed",
            error: message,
            finishedAt: now(),
            updatedAt: now()
          })
        )
        yield* Effect.fail(new Error(message))
      }

      const workflow = workflowValidation.workflow as WorkflowSpec
      const store = yield* makeRunStore(runDir, initialState)
      const stopSignal = yield* Deferred.make<void>()
      const pauseSignal = yield* Deferred.make<void>()
      const fatalSignal = yield* Deferred.make<never, Error>()
      const wakeQueue = yield* Queue.unbounded<void>()
      const detachedCallbacks = yield* Queue.unbounded<EventRecord>()
      const activeNodes = yield* FiberMap.make<string, void, never>()
      const activeNodeIds = yield* Ref.make<ReadonlySet<string>>(new Set())

      const requestStop = (): void => {
        Deferred.doneUnsafe(stopSignal, Effect.succeed(undefined))
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.on("SIGTERM", requestStop)
          process.on("SIGINT", requestStop)
        }),
        () =>
          Effect.sync(() => {
            process.removeListener("SIGTERM", requestStop)
            process.removeListener("SIGINT", requestStop)
          })
      )
      yield* removeControlRequestsEffect(runDir)

      const reportBackgroundFailure = <A>(effect: Effect.Effect<A, Error>): Effect.Effect<void> =>
        Effect.matchEffect(effect, {
          onFailure: (error) =>
            Effect.sync(() => {
              Deferred.doneUnsafe(fatalSignal, Effect.fail(error))
            }),
          onSuccess: () => Effect.succeed(undefined)
        })

      const controlPoll = yield* Effect.forkScoped(
        reportBackgroundFailure(
          Effect.andThen(
            Effect.sleep(500),
            Effect.repeat(
              pollControlRequestsEffect(runDir, workerToken, stopSignal, pauseSignal),
              Schedule.spaced(500)
            )
          )
        )
      )

      let state = yield* store.update((current) => ({
        ...current,
        status:
          current.status === "starting" || current.status === "paused" ? "running" : current.status,
        startedAt: current.startedAt ?? now(),
        pid: process.pid,
        workerToken,
        stopRequested: false,
        pauseReason: null,
        pauseCode: null
      }))
      yield* emitEffect(
        workflow,
        runDir,
        state,
        "run.started",
        `Run ${state.id} started.`,
        undefined,
        undefined,
        true
      )
      // Presentation only: best-effort herdr mirror (null unless the run
      // opted in). Calls are fire-and-forget and swallow their own errors.
      // runStarted fires inside the lifecycle, after the interactive host has
      // ensured the run's shared herdr workspace, so both use one workspace.
      const mirror = createRunMirror(workflow, runDir, state)

      const heartbeat =
        workflow.heartbeat.intervalMinutes === null
          ? null
          : yield* Effect.forkScoped(
              reportBackgroundFailure(
                Effect.andThen(
                  Effect.sleep(workflow.heartbeat.intervalMinutes * 60_000),
                  Effect.repeat(
                    Effect.flatMap(store.read, (current) =>
                      emitEffect(
                        workflow,
                        runDir,
                        current,
                        "run.heartbeat",
                        `Run ${current.id} is ${current.status}; ${Object.values(current.nodes).filter((item) => item.status === "completed").length}/${Object.keys(current.nodes).length} nodes completed.`,
                        undefined,
                        undefined,
                        true
                      )
                    ),
                    Schedule.spaced(workflow.heartbeat.intervalMinutes * 60_000)
                  )
                )
              )
            )

      const stopBackground = Effect.gen(function* () {
        if (heartbeat !== null) {
          yield* Fiber.interrupt(heartbeat)
        }
        yield* Fiber.interrupt(controlPoll)
      })

      const drainDetachedCallbacks = Effect.gen(function* () {
        const events = yield* Queue.clear(detachedCallbacks)
        for (const event of events) {
          yield* deliverRecordedCallbackEffect(workflow, runDir, event)
        }
      })

      const awaitActivity = Effect.raceAll([
        Effect.asVoid(Queue.take(wakeQueue)),
        Deferred.await(stopSignal),
        Deferred.await(pauseSignal),
        Deferred.await(fatalSignal)
      ])

      // Assigned at the top of the lifecycle (inside its failure handling)
      // when the run has pending interactive nodes; a failure to build the
      // host fails the run cleanly instead of stranding it.
      let interactiveHost: InteractiveHost | null = null

      const launchNode = (node: WorkflowNode): Effect.Effect<void> => {
        const guarded = Effect.matchEffect(
          runNodeEffect(workflow, runDir, store, node, detachedCallbacks, mirror, interactiveHost),
          {
            onFailure: (error) =>
              Effect.sync(() => {
                Deferred.doneUnsafe(fatalSignal, Effect.fail(error))
              }),
            onSuccess: () => Effect.succeed(undefined)
          }
        ).pipe(
          Effect.ensuring(
            Effect.andThen(
              Ref.update(activeNodeIds, (current) => {
                const next = new Set(current)
                next.delete(node.id)
                return next
              }),
              Effect.asVoid(Queue.offer(wakeQueue, undefined))
            )
          )
        )
        return Effect.gen(function* () {
          yield* Ref.update(activeNodeIds, (current) => new Set([...current, node.id]))
          yield* FiberMap.run(activeNodes, node.id, guarded)
        })
      }

      const lifecycle = Effect.gen(function* () {
        state = yield* store.read
        // Interactive nodes execute inside herdr panes, so the host (and the
        // run's herdr workspace, shared with --mirror) must exist before any
        // of them is scheduled. Headless-only runs never touch herdr here.
        interactiveHost = yield* createInteractiveHostEffect(workflow, runDir, state)
        yield* Effect.sync(() => mirror?.runStarted())
        if (state.pendingPatch !== null && state.approvedPendingPatch) {
          if (
            pendingPatchDigest(
              state.pendingPatch.supervisorId,
              state.pendingPatch.decision,
              state.pendingPatch.reasons
            ) !== state.pendingPatch.digest
          ) {
            yield* Effect.fail(
              new Error(
                "Approved pending patch no longer matches its digest; execution was refused."
              )
            )
          }
          const supervisor = allWorkflowNodes(workflow, state).find(
            (node): node is SupervisorNode =>
              node.id === state.pendingPatch?.supervisorId && node.type === "supervisor"
          )
          if (supervisor === undefined) {
            yield* Effect.fail(
              new Error(`Pending patch supervisor "${state.pendingPatch.supervisorId}" is missing.`)
            )
          }
          yield* applyDecisionEffect(
            workflow,
            runDir,
            store,
            supervisor as SupervisorNode,
            state.pendingPatch.decision,
            true
          )
        }

        if (state.pendingGate !== null && state.approvedPendingGate) {
          const gate = state.pendingGate
          if (gateApprovalDigest(state.id, gate.nodeId, gate.content) !== gate.digest) {
            yield* Effect.fail(
              new Error(
                "Approved gate content no longer matches its digest; execution was refused."
              )
            )
          }
          const gatedNode = allWorkflowNodes(workflow, state).find(
            (node) => node.id === gate.nodeId
          )
          if (gatedNode === undefined) {
            yield* Effect.fail(new Error(`Gated node "${gate.nodeId}" is missing.`))
          }
          // Completed nodes are immutable, so a re-render must reproduce the
          // approved content exactly; refuse to run anything else.
          const rendered = yield* gateContentEffect(workflow, gatedNode as WorkflowNode, state)
          if (rendered !== gate.content) {
            yield* Effect.fail(
              new Error(
                `Gated node "${gate.nodeId}" would no longer run with its approved rendered content; execution was refused.`
              )
            )
          }
          state = yield* store.update((current) => ({
            ...current,
            satisfiedGates: [...current.satisfiedGates, gate.nodeId],
            pendingGate: null,
            approvedPendingGate: false
          }))
          yield* emitEffect(
            workflow,
            runDir,
            state,
            "gate.approved",
            `Approval gate before node "${gate.nodeId}" was approved; the node may start.`,
            gate.nodeId
          )
        }

        while (true) {
          state = yield* store.read
          if (yield* Deferred.isDone(stopSignal)) {
            yield* FiberMap.clear(activeNodes)
            yield* FiberMap.awaitEmpty(activeNodes)
            yield* stopBackground
            yield* drainDetachedCallbacks
            state = yield* store.read
            yield* emitEffect(
              workflow,
              runDir,
              state,
              "run.stopped",
              `Run ${state.id} stopped.`,
              undefined,
              undefined,
              true
            )
            yield* removeControlRequestsEffect(runDir)
            yield* store.update((current) => ({
              ...current,
              status: "stopped",
              pid: null,
              workerToken: null,
              finishedAt: now(),
              stopRequested: true
            }))
            return
          }

          if (state.status === "running" && (yield* Deferred.isDone(pauseSignal))) {
            // Interactive nodes count as running nodes for the pause drain:
            // the pause waits for them, and the callback names them so the
            // human knows the run is waiting on live TUI sessions.
            const runningInteractive = allWorkflowNodes(workflow, state)
              .filter(
                (candidate) =>
                  candidate.type === "agent" &&
                  candidate.interactive &&
                  state.nodes[candidate.id]?.status === "running"
              )
              .map((candidate) => candidate.id)
            yield* pauseRunEffect(
              workflow,
              runDir,
              store,
              `Manual node-boundary pause requested for run ${state.id}; running nodes will finish before the run pauses.${
                runningInteractive.length === 0
                  ? ""
                  : ` The pause is waiting on interactive nodes: ${runningInteractive.join(", ")} — finish them via node-done in their herdr panes, or stop the run.`
              }`,
              "user-request"
            )
            continue
          }

          if (state.status !== "running") {
            const drained = yield* Effect.raceFirst(
              Effect.as(FiberMap.awaitEmpty(activeNodes), "drained" as const),
              Effect.as(Deferred.await(stopSignal), "stop" as const)
            )
            if (drained === "stop" || (yield* Deferred.isDone(stopSignal))) {
              continue
            }
            state = yield* store.read
            if (state.status === "pausing") {
              const failed = Object.values(state.nodes).find((item) => item.status === "failed")
              if (failed !== undefined) {
                yield* stopBackground
                yield* drainDetachedCallbacks
                const message = `Node "${failed.id}" failed: ${failed.error ?? "unknown error"}`
                yield* emitEffect(
                  workflow,
                  runDir,
                  state,
                  "run.failed",
                  message,
                  undefined,
                  undefined,
                  true
                )
                yield* removeControlRequestsEffect(runDir)
                yield* store.update((current) => ({
                  ...current,
                  status: "failed",
                  pid: null,
                  workerToken: null,
                  error: message,
                  finishedAt: now()
                }))
                return
              }
              if (Object.values(state.nodes).every((item) => terminalNode(item.status))) {
                yield* stopBackground
                yield* drainDetachedCallbacks
                yield* emitEffect(
                  workflow,
                  runDir,
                  state,
                  "run.completed",
                  `Run ${state.id} completed before the requested pause boundary.`,
                  undefined,
                  undefined,
                  true
                )
                yield* removeControlRequestsEffect(runDir)
                yield* store.update((current) => ({
                  ...current,
                  status: "completed",
                  pid: null,
                  workerToken: null,
                  finishedAt: now()
                }))
                return
              }
              yield* stopBackground
              yield* drainDetachedCallbacks
              yield* emitEffect(
                workflow,
                runDir,
                state,
                "run.paused",
                state.pauseReason ?? `Run ${state.id} paused.`,
                undefined,
                undefined,
                true
              )
              yield* removeControlRequestsEffect(runDir)
              yield* store.update((current) => ({
                ...current,
                status: "paused",
                pid: null,
                workerToken: null,
                stopRequested: false
              }))
            } else {
              yield* removeControlRequestsEffect(runDir)
            }
            return
          }

          const failed = Object.values(state.nodes).find((item) => item.status === "failed")
          if (failed !== undefined) {
            const drained = yield* Effect.raceFirst(
              Effect.as(FiberMap.awaitEmpty(activeNodes), "drained" as const),
              Effect.as(Deferred.await(stopSignal), "stop" as const)
            )
            if (drained === "stop" || (yield* Deferred.isDone(stopSignal))) {
              continue
            }
            yield* stopBackground
            yield* drainDetachedCallbacks
            const message = `Node "${failed.id}" failed: ${failed.error ?? "unknown error"}`
            yield* emitEffect(
              workflow,
              runDir,
              state,
              "run.failed",
              message,
              undefined,
              undefined,
              true
            )
            yield* removeControlRequestsEffect(runDir)
            yield* store.update((current) => ({
              ...current,
              status: "failed",
              pid: null,
              workerToken: null,
              error: message,
              finishedAt: now()
            }))
            return
          }
          if (Object.values(state.nodes).every((item) => terminalNode(item.status))) {
            yield* stopBackground
            yield* drainDetachedCallbacks
            yield* emitEffect(
              workflow,
              runDir,
              state,
              "run.completed",
              `Run ${state.id} completed.`,
              undefined,
              undefined,
              true
            )
            yield* removeControlRequestsEffect(runDir)
            yield* store.update((current) => ({
              ...current,
              status: "completed",
              pid: null,
              workerToken: null,
              finishedAt: now()
            }))
            return
          }

          const activeIds = yield* Ref.get(activeNodeIds)
          const activeCount = activeIds.size
          const elapsedMinutes =
            (Date.now() - new Date(state.startedAt as string).getTime()) / 60_000
          if (
            !state.overriddenLimits.includes("workflow-wall-time") &&
            workflow.limits.workflowWallTimeMinutes !== null &&
            elapsedMinutes >= workflow.limits.workflowWallTimeMinutes
          ) {
            if (activeCount > 0) {
              yield* awaitActivity
              continue
            }
            yield* pauseRunEffect(
              workflow,
              runDir,
              store,
              `Workflow wall-time limit ${workflow.limits.workflowWallTimeMinutes} minutes reached; no running node was killed.`,
              "workflow-wall-time"
            )
            continue
          }

          const nodes = allWorkflowNodes(workflow, state)
          const selected = selectRunnableBatch(
            nodes,
            state,
            Math.max(0, workflow.concurrency - activeCount),
            activeIds
          )
          // A runnable gated node pauses the run at this node boundary before
          // any attempt starts: nothing from this batch launches, already
          // running nodes drain normally, and the fully rendered content is
          // published for digest-bound approval. Gates are approved one at a
          // time; the next gated node pauses again after resume.
          const gatedNode = selected.find(
            (candidate) =>
              candidate.gate === "approval" && !state.satisfiedGates.includes(candidate.id)
          )
          if (gatedNode !== undefined) {
            const content = yield* gateContentEffect(workflow, gatedNode, state)
            const digest = gateApprovalDigest(state.id, gatedNode.id, content)
            state = yield* store.update((current) => ({
              ...current,
              pendingGate: {
                nodeId: gatedNode.id,
                title: gatedNode.title,
                content,
                digest
              },
              approvedPendingGate: false
            }))
            yield* pauseRunEffect(
              workflow,
              runDir,
              store,
              `Node "${gatedNode.id}" ("${gatedNode.title}") is gated and awaits approval of its rendered content before it starts. Review it with: orchestrate report ${state.id}`,
              `gate:${gatedNode.id}`
            )
            continue
          }
          const configuredRemaining =
            workflow.limits.maxAgentStarts === null ||
            state.overriddenLimits.includes("max-agent-starts")
              ? Number.POSITIVE_INFINITY
              : workflow.limits.maxAgentStarts - state.agentStarts
          const fuseRemaining = state.emergencyFuseOverride
            ? Number.POSITIVE_INFINITY
            : EMERGENCY_AGENT_START_FUSE - state.agentStarts
          let remainingAgentStarts = Math.min(configuredRemaining, fuseRemaining)
          const batch = selected.filter((candidate) => {
            if (candidate.type === "command") {
              return true
            }
            if (remainingAgentStarts <= 0) {
              return false
            }
            remainingAgentStarts -= 1
            return true
          })

          if (batch.length === 0) {
            if (activeCount > 0) {
              yield* awaitActivity
              continue
            }
            if (configuredRemaining <= 0) {
              yield* pauseRunEffect(
                workflow,
                runDir,
                store,
                `Workflow maxAgentStarts=${workflow.limits.maxAgentStarts as number} reached; no running node was killed.`,
                "max-agent-starts"
              )
              continue
            }
            if (fuseRemaining <= 0) {
              yield* pauseRunEffect(
                workflow,
                runDir,
                store,
                `Emergency fuse reached ${EMERGENCY_AGENT_START_FUSE} agent starts. Resume with the explicit fuse override to continue.`,
                "emergency-fuse"
              )
              continue
            }
            const pending = Object.values(state.nodes).filter((item) => item.status === "pending")
            yield* pauseRunEffect(
              workflow,
              runDir,
              store,
              `No runnable nodes remain, but ${pending.length} nodes are pending. Check dependencies and session/resource constraints.`,
              "no-runnable"
            )
            continue
          }

          // Reserving the budget before the next scheduler read keeps parallel
          // launches from overshooting maxAgentStarts or the emergency fuse.
          const reservedAgentStarts = batch.filter((node) => node.type !== "command").length
          if (reservedAgentStarts > 0) {
            state = yield* store.update((current) => ({
              ...current,
              agentStarts: current.agentStarts + reservedAgentStarts
            }))
          }
          for (const node of batch) {
            yield* launchNode(node)
          }
          if ((yield* Ref.get(activeNodeIds)).size >= workflow.concurrency) {
            yield* awaitActivity
          }
        }
      })

      yield* Effect.matchEffect(lifecycle, {
        onFailure: (error) =>
          Effect.gen(function* () {
            yield* FiberMap.clear(activeNodes)
            yield* FiberMap.awaitEmpty(activeNodes)
            yield* stopBackground
            yield* drainDetachedCallbacks
            const current = yield* store.read
            yield* Effect.ignore(
              emitEffect(
                workflow,
                runDir,
                current,
                "run.failed",
                error.message,
                undefined,
                undefined,
                true
              )
            )
            yield* removeControlRequestsEffect(runDir)
            yield* store.update(
              (failedState) => ({
                ...failedState,
                status: "failed",
                pid: null,
                workerToken: null,
                error: error.message,
                finishedAt: now()
              }),
              { recoverPersistence: true }
            )
          }),
        onSuccess: () => Effect.succeed(undefined)
      })
    })
  )
}

export function runWorker(runDir: string): Promise<void> {
  return Effect.runPromise(runWorkerEffect(runDir))
}

export function launchWorker(scriptPath: string, runDir: string): number {
  const workerLog = path.join(runDir, "worker.log")
  const workerError = path.join(runDir, "worker-error.log")
  const stdout = openSync(workerLog, "a", 0o600)
  const stderr = openSync(workerError, "a", 0o600)
  const child = spawn(process.execPath, [scriptPath, "__worker", runDir], {
    detached: true,
    stdio: ["ignore", stdout, stderr],
    env: process.env
  })
  closeSync(stdout)
  closeSync(stderr)
  child.unref()
  return child.pid ?? 0
}
