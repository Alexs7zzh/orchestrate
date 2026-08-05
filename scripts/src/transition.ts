import { isDeepStrictEqual } from "node:util"

import type {
  AttemptState,
  CrankEvent,
  EventRecord,
  EventType,
  InputSpec,
  NodeRunState,
  RepeatSpec,
  RunOrigin,
  RunState,
  SpawnIntent,
  TransitionResult,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

import { diffState } from "./state-patch.js"
import { hasResolvedHistory } from "./state.js"
import {
  abortWorkrooms,
  initialWorkrooms,
  refreshWorkroomSettlement,
  updateWorkroomSeat,
  updateWorkroomSeatAfterFailure
} from "./workroom-state.js"

export interface PreparedNode {
  readonly token: string
  readonly resultPath: string
  readonly outputPath: string
  readonly gate: { readonly content: string; readonly digest: string } | null
}

export interface TransitionContext {
  readonly prepareNode?: (
    state: RunState,
    workflow: WorkflowSpec,
    node: NodeRunState
  ) => PreparedNode
  readonly uiDegraded?: string | null
  readonly deferScheduling?: boolean
}

export interface InitialRunOptions {
  readonly id: string
  readonly runtimeVersion: string
  readonly digest: string
  readonly now: string
  readonly origin: RunOrigin | null
  readonly allowWriteConflicts?: boolean
  readonly fuseOverride?: boolean
}

interface EventOptions {
  readonly nodeId?: string
  readonly data?: unknown
  readonly root?: boolean
}

const TERMINAL_NODE_STATUSES = new Set(["completed", "skipped", "failed", "cancelled"])
const RELEASING_NODE_STATUSES = new Set(["completed", "skipped"])

function sameNodeExceptWhen(before: WorkflowNode, after: WorkflowNode): boolean {
  const { when: _beforeWhen, ...beforeRest } = before
  const { when: _afterWhen, ...afterRest } = after
  return same(beforeRest, afterRest)
}

function nodeState(
  node: WorkflowNode,
  id = node.id,
  repeatId: string | null = null,
  round: number | null = null
): NodeRunState {
  return {
    id,
    templateId: node.id,
    title: node.title,
    type: node.type,
    provider: node.type === "agent" ? node.provider : null,
    needs: node.needs,
    origin: repeatId === null ? "initial" : "loop-round",
    repeatId,
    round,
    status: "pending",
    attempts: [],
    resultPath: null,
    result: null,
    error: null
  }
}

export function createInitialRunState(
  workflow: WorkflowSpec,
  options: InitialRunOptions
): RunState {
  const repeatMembers = new Set(workflow.repeats.flatMap((repeat) => repeat.members))
  return {
    runtimeVersion: options.runtimeVersion,
    sequence: 0,
    id: options.id,
    workflowName: workflow.name,
    objective: workflow.objective,
    digest: options.digest,
    status: "running",
    createdAt: options.now,
    startedAt: options.now,
    finishedAt: null,
    updatedAt: options.now,
    error: null,
    pause: null,
    origin: options.origin,
    allowWriteConflicts: options.allowWriteConflicts ?? false,
    starts: 0,
    fuseOverride: options.fuseOverride ?? false,
    repeatRoundExtensions: {},
    pendingRevision: null,
    nodes: Object.fromEntries(
      workflow.nodes
        .filter((node) => !repeatMembers.has(node.id))
        .map((node) => [node.id, nodeState(node)])
    ),
    sessions: {},
    gates: {},
    holds: {},
    repeats: Object.fromEntries(
      workflow.repeats.map((repeat) => [
        repeat.id,
        {
          id: repeat.id,
          round: 1,
          status: "pending" as const,
          instanceIds: [],
          completedAt: null
        }
      ])
    ),
    workrooms: initialWorkrooms(workflow),
    spawnIntents: {}
  }
}

function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right)
}

function replaceNode(state: RunState, node: NodeRunState): RunState {
  return { ...state, nodes: { ...state.nodes, [node.id]: node } }
}

function removeKeys<T>(record: Readonly<Record<string, T>>, keys: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)))
}

function currentAttempt(node: NodeRunState): AttemptState {
  const attempt = node.attempts.at(-1)
  if (attempt === undefined || (attempt.status !== "running" && attempt.status !== "planned")) {
    throw new Error(`Node "${node.id}" has no active attempt.`)
  }
  return attempt
}

function runningAttempt(node: NodeRunState): AttemptState {
  const attempt = currentAttempt(node)
  if (attempt.status !== "running") {
    throw new Error(`Node "${node.id}" has not been observed in a herdr pane.`)
  }
  return attempt
}

function templateMap(workflow: WorkflowSpec): Map<string, WorkflowNode> {
  return new Map(workflow.nodes.map((node) => [node.id, node]))
}

function repeatMap(workflow: WorkflowSpec): Map<string, RepeatSpec> {
  return new Map(workflow.repeats.map((repeat) => [repeat.id, repeat]))
}

function workroomMap(workflow: WorkflowSpec) {
  return new Map(
    (workflow.presentation?.workrooms ?? []).map((workroom) => [workroom.id, workroom])
  )
}

function repeatForTemplate(workflow: WorkflowSpec, templateId: string): RepeatSpec | undefined {
  return workflow.repeats.find((repeat) => repeat.members.includes(templateId))
}

function instanceId(templateId: string, round: number): string {
  return `${templateId}--r${round}`
}

// Resolves a workflow-level input source to the immutable runtime instance
// whose result the renderer must bind. Round one has no previous result, and
// consumers outside a repeat see only its final (settled) round.
export function resolveInputSourceId(
  state: RunState,
  workflow: WorkflowSpec,
  consumerId: string,
  input: InputSpec
): string | null {
  const consumer = state.nodes[consumerId]
  if (consumer === undefined) {
    throw new Error(`Unknown input consumer "${consumerId}".`)
  }
  const sourceRepeat = repeatForTemplate(workflow, input.from)
  if (input.round === "previous") {
    if (consumer.repeatId === null || consumer.round === null || consumer.round === 1) {
      return null
    }
    if (sourceRepeat?.id !== consumer.repeatId) {
      throw new Error(
        `Previous-round input "${input.from}" is outside repeat "${consumer.repeatId}".`
      )
    }
    return instanceId(input.from, consumer.round - 1)
  }
  if (sourceRepeat === undefined) {
    return input.from
  }
  if (consumer.repeatId === sourceRepeat.id && consumer.round !== null) {
    return instanceId(input.from, consumer.round)
  }
  const repeatState = state.repeats[sourceRepeat.id]
  return repeatState?.status === "completed" ? instanceId(input.from, repeatState.round) : null
}

export function resolveConditionSourceId(
  state: RunState,
  workflow: WorkflowSpec,
  consumerId: string,
  sourceTemplateId: string
): string | null {
  const consumer = state.nodes[consumerId]
  if (consumer === undefined) {
    throw new Error(`Unknown condition consumer "${consumerId}".`)
  }
  const sourceRepeat = repeatForTemplate(workflow, sourceTemplateId)
  if (sourceRepeat === undefined) {
    return sourceTemplateId
  }
  if (consumer.repeatId === sourceRepeat.id && consumer.round !== null) {
    return instanceId(sourceTemplateId, consumer.round)
  }
  const repeatState = state.repeats[sourceRepeat.id]
  return repeatState?.status === "completed"
    ? instanceId(sourceTemplateId, repeatState.round)
    : null
}

function held(state: RunState, node: NodeRunState): boolean {
  return state.holds[node.id] !== undefined || state.holds[node.templateId] !== undefined
}

function nodeReleasesDependencies(state: RunState, id: string): boolean {
  const node = state.nodes[id]
  return node !== undefined && RELEASING_NODE_STATUSES.has(node.status) && !held(state, node)
}

function repeatReleasesDependencies(
  state: RunState,
  workflow: WorkflowSpec,
  repeat: RepeatSpec
): boolean {
  const repeatState = state.repeats[repeat.id]
  return (
    repeatState?.status === "completed" &&
    repeat.members.every((member) =>
      nodeReleasesDependencies(state, instanceId(member, repeatState.round))
    )
  )
}

function dependencySatisfied(
  state: RunState,
  workflow: WorkflowSpec,
  dependent: NodeRunState,
  dependencyTemplateId: string
): boolean {
  const dependencyRepeat = repeatForTemplate(workflow, dependencyTemplateId)
  if (dependencyRepeat === undefined) {
    return nodeReleasesDependencies(state, dependencyTemplateId)
  }
  if (dependent.repeatId === dependencyRepeat.id && dependent.round !== null) {
    return nodeReleasesDependencies(state, instanceId(dependencyTemplateId, dependent.round))
  }
  return repeatReleasesDependencies(state, workflow, dependencyRepeat)
}

function dependenciesSatisfied(
  state: RunState,
  workflow: WorkflowSpec,
  node: NodeRunState,
  template: WorkflowNode
): boolean {
  return template.needs.every((dependency) =>
    dependencySatisfied(state, workflow, node, dependency)
  )
}

function normalizeResourcePath(value: string): string {
  return value.replace(/\/+$/, "") || "/"
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeResourcePath(left)
  const b = normalizeResourcePath(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function conflicts(left: WorkflowNode, right: WorkflowNode, allowWrites: boolean): boolean {
  if (
    left.workspace.exclusiveResources.some((resource) =>
      right.workspace.exclusiveResources.includes(resource)
    )
  ) {
    return true
  }
  if (allowWrites) {
    return false
  }
  return left.workspace.writes.some((a) => right.workspace.writes.some((b) => pathsOverlap(a, b)))
}

function pointerValue(
  document: unknown,
  pointer: string
): { readonly found: boolean; readonly value: unknown } {
  if (pointer === "") {
    return { found: true, value: document }
  }
  let cursor = document
  for (const encoded of pointer.slice(1).split("/")) {
    const part = encoded.replaceAll("~1", "/").replaceAll("~0", "~")
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(part) || Number(part) >= cursor.length) {
        return { found: false, value: undefined }
      }
      cursor = cursor[Number(part)]
    } else if (cursor !== null && typeof cursor === "object") {
      if (!Object.hasOwn(cursor, part)) {
        return { found: false, value: undefined }
      }
      cursor = (cursor as Record<string, unknown>)[part]
    } else {
      return { found: false, value: undefined }
    }
  }
  return { found: true, value: cursor }
}

function repeatVerdictClean(
  state: RunState,
  workflow: WorkflowSpec,
  repeat: RepeatSpec,
  round: number
): boolean {
  const verdict = repeat.until
  const node = state.nodes[instanceId(verdict.node, round)]
  if (node === undefined) {
    return false
  }
  if (verdict.type === "command-success") {
    const template = workflow.nodes.find(
      (candidate) => candidate.id === verdict.node && candidate.type === "command"
    )
    const code = node.attempts.at(-1)?.exitCode
    return (
      template?.type === "command" &&
      code !== null &&
      code !== undefined &&
      template.allowedExitCodes.includes(code)
    )
  }
  const pointed = pointerValue(node.result, verdict.pointer)
  return pointed.found && same(pointed.value, verdict.equals)
}

function isSettled(state: RunState, workflow: WorkflowSpec): boolean {
  if (
    Object.values(state.holds).some((hold) =>
      Object.values(state.nodes).some(
        (node) =>
          RELEASING_NODE_STATUSES.has(node.status) &&
          (hold.scope === "instance" ? node.id === hold.target : node.templateId === hold.target) &&
          (node.repeatId === null || node.round === state.repeats[node.repeatId]?.round)
      )
    )
  ) {
    return false
  }
  if (Object.values(state.repeats).some((repeat) => repeat.status !== "completed")) {
    return false
  }
  const repeatMembers = new Set(workflow.repeats.flatMap((repeat) => repeat.members))
  return workflow.nodes
    .filter((node) => !repeatMembers.has(node.id))
    .every((node) => {
      const runtime = state.nodes[node.id]
      return runtime !== undefined && RELEASING_NODE_STATUSES.has(runtime.status)
    })
}

function requirePreparedNode(
  state: RunState,
  workflow: WorkflowSpec,
  node: NodeRunState,
  context: TransitionContext | undefined
): PreparedNode {
  const prepared = context?.prepareNode?.(state, workflow, node)
  if (prepared === undefined) {
    throw new Error(`Prepared execution content is required for node "${node.id}".`)
  }
  return prepared
}

function assertActive(state: RunState, event: CrankEvent): void {
  if (["completed", "failed", "stopped"].includes(state.status) && event.type !== "run") {
    throw new Error(`Run "${state.id}" is already ${state.status}.`)
  }
}

export function transition(
  initialState: RunState,
  initialWorkflow: WorkflowSpec,
  event: CrankEvent,
  now: string,
  context?: TransitionContext
): TransitionResult {
  let state = structuredClone(initialState)
  let workflow = initialWorkflow
  const events: EventRecord[] = []
  const actions: TransitionResult["actions"][number][] = []

  const emit = (
    type: EventType,
    message: string,
    update: (current: RunState) => RunState,
    options: EventOptions = {}
  ): void => {
    const before = state
    state = {
      ...update(before),
      sequence: before.sequence + 1,
      updatedAt: now
    }
    const patch = options.root === true ? diffState(null, state) : diffState(before, state)
    const record: EventRecord = {
      runtimeVersion: state.runtimeVersion,
      sequence: state.sequence,
      timestamp: now,
      runId: state.id,
      type,
      message,
      ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
      ...(options.data === undefined ? {} : { data: options.data }),
      patch
    }
    events.push(record)
  }

  const instantiateRound = (repeat: RepeatSpec, round: number): void => {
    const templates = templateMap(workflow)
    emit(
      "repeat.round-started",
      `Started round ${round} of repeat "${repeat.id}".`,
      (current) => {
        const additions = Object.fromEntries(
          repeat.members.map((member) => {
            const template = templates.get(member)
            if (template === undefined) {
              throw new Error(`Unknown repeat member "${member}".`)
            }
            const id = instanceId(member, round)
            return [id, nodeState(template, id, repeat.id, round)]
          })
        )
        const repeatState = current.repeats[repeat.id]
        if (repeatState === undefined) {
          throw new Error(`Unknown repeat "${repeat.id}".`)
        }
        return {
          ...current,
          nodes: { ...current.nodes, ...additions },
          repeats: {
            ...current.repeats,
            [repeat.id]: {
              ...repeatState,
              round,
              status: "running",
              instanceIds: [...repeatState.instanceIds, ...Object.keys(additions)],
              completedAt: null
            }
          }
        }
      },
      { data: { repeatId: repeat.id, round } }
    )
  }

  const completeRepeat = (repeat: RepeatSpec, accepted: boolean): void => {
    emit(
      "repeat.completed",
      `${accepted ? "Accepted" : "Completed"} repeat "${repeat.id}" at round ${state.repeats[repeat.id]?.round}.`,
      (current) => {
        const repeatState = current.repeats[repeat.id]
        if (repeatState === undefined) {
          return current
        }
        return {
          ...current,
          repeats: {
            ...current.repeats,
            [repeat.id]: { ...repeatState, status: "completed", completedAt: now }
          }
        }
      },
      { data: { repeatId: repeat.id, accepted } }
    )
  }

  const settleRepeats = (): void => {
    if (state.status === "failed" || state.status === "stopped") {
      return
    }
    for (const repeat of workflow.repeats) {
      const running = state.repeats[repeat.id]
      if (running?.status !== "running") {
        continue
      }
      const ids = repeat.members.map((member) => instanceId(member, running.round))
      if (!ids.every((id) => nodeReleasesDependencies(state, id))) {
        continue
      }
      if (repeatVerdictClean(state, workflow, repeat, running.round)) {
        completeRepeat(repeat, false)
        continue
      }
      const limit = repeat.maxRounds + (state.repeatRoundExtensions[repeat.id] ?? 0)
      if (running.round < limit) {
        instantiateRound(repeat, running.round + 1)
        continue
      }
      emit(
        "repeat.max-rounds",
        `Repeat "${repeat.id}" reached ${limit} rounds without a clean verdict. Continue with: orchestrate resume ${state.id} --continue-rounds 1 — or accept with: orchestrate resume ${state.id} --accept-repeat ${repeat.id}`,
        (current) => ({
          ...current,
          status: "paused",
          pause: {
            kind: "max-rounds",
            message: `Repeat "${repeat.id}" needs a decision: continue, accept, or stop.`,
            repeatId: repeat.id,
            createdAt: now
          },
          repeats: {
            ...current.repeats,
            [repeat.id]: { ...running, status: "max-rounds" }
          }
        }),
        { data: { repeatId: repeat.id, rounds: limit } }
      )
      return
    }
  }

  const failRun = (message: string): void => {
    const settledSeatPaneIds = new Set(
      Object.values(state.workrooms).flatMap((workroom) =>
        workroom.status !== "settled"
          ? []
          : Object.values(workroom.seats).flatMap((seat) =>
              seat.pane === null ? [] : [seat.pane.paneId]
            )
      )
    )
    const paneIds = new Set(
      Object.values(state.nodes).flatMap((node) =>
        node.attempts.flatMap((attempt) =>
          attempt.pane === null || settledSeatPaneIds.has(attempt.pane.paneId)
            ? []
            : [attempt.pane.paneId]
        )
      )
    )
    for (const paneId of paneIds) {
      actions.push({ type: "close-pane", paneId })
    }
    emit("run.failed", message, (current) =>
      abortWorkrooms({
        ...current,
        status: "failed",
        finishedAt: now,
        error: message,
        pause: null,
        nodes: Object.fromEntries(
          Object.entries(current.nodes).map(([id, node]) => [
            id,
            TERMINAL_NODE_STATUSES.has(node.status)
              ? node
              : {
                  ...node,
                  status: "cancelled" as const,
                  attempts: node.attempts.map((attempt) =>
                    attempt.status === "running" || attempt.status === "planned"
                      ? { ...attempt, status: "cancelled" as const, finishedAt: now }
                      : attempt
                  )
                }
          ])
        )
      })
    )
  }

  const failAttempt = (
    node: NodeRunState,
    error: string,
    exitCode: number | null,
    removeIntentId?: string,
    result: unknown = null,
    clearSeatPane = false
  ): void => {
    const attempt = currentAttempt(node)
    const failedAttempt: AttemptState = {
      ...attempt,
      status: "failed",
      finishedAt: now,
      exitCode,
      error
    }
    emit(
      "node.failed",
      `Node "${node.id}" attempt ${attempt.attempt} failed: ${error} Inspect with: orchestrate result ${state.id} ${node.id}`,
      (current) => {
        const failed = {
          ...replaceNode(current, {
            ...node,
            status: "failed",
            attempts: [...node.attempts.slice(0, -1), failedAttempt],
            resultPath: result === null ? node.resultPath : attempt.resultPath,
            result,
            error
          }),
          spawnIntents:
            removeIntentId === undefined
              ? current.spawnIntents
              : removeKeys(current.spawnIntents, new Set([removeIntentId]))
        }
        return updateWorkroomSeatAfterFailure(failed, workflow, node, clearSeatPane)
      },
      { nodeId: node.id, data: { attempt: attempt.attempt, exitCode } }
    )
    const template = templateMap(workflow).get(node.templateId)
    if (template === undefined) {
      throw new Error(`Unknown node template "${node.templateId}".`)
    }
    if (attempt.attempt < template.retry.maxAttempts) {
      emit(
        "node.retrying",
        `Node "${node.id}" will retry immediately.`,
        (current) => {
          const failedNode = current.nodes[node.id]
          if (failedNode === undefined) {
            throw new Error(`Unknown node "${node.id}".`)
          }
          return replaceNode(current, { ...failedNode, status: "pending", error: null })
        },
        { nodeId: node.id, data: { nextAttempt: attempt.attempt + 1 } }
      )
    } else {
      failRun(`Node "${node.id}" exhausted ${template.retry.maxAttempts} attempts.`)
    }
  }

  const schedule = (): void => {
    // A proposed graph is a human decision boundary. Live attempts may still
    // report outcomes, but neither the old nor proposed plan may advance until
    // the revision is explicitly approved or discarded.
    if (state.pendingRevision !== null) {
      return
    }
    settleRepeats()
    if (state.status !== "running") {
      if (isSettled(state, workflow) && state.status !== "completed") {
        emit("run.completed", `Run "${state.id}" completed.`, (current) => ({
          ...current,
          status: "completed",
          finishedAt: now,
          pause: null
        }))
      }
      return
    }
    const templates = templateMap(workflow)
    let madeProgress = true
    while (madeProgress && state.status === "running") {
      madeProgress = false
      for (const candidate of Object.values(state.nodes)) {
        if (candidate.status !== "pending" && candidate.status !== "ready") {
          continue
        }
        const template = templates.get(candidate.templateId)
        if (
          template === undefined ||
          !dependenciesSatisfied(state, workflow, candidate, template)
        ) {
          continue
        }
        const condition = template.when
        if (condition !== undefined) {
          const sourceId = resolveConditionSourceId(state, workflow, candidate.id, condition.node)
          const source = sourceId === null ? undefined : state.nodes[sourceId]
          if (source === undefined) {
            throw new Error(
              `Condition source "${condition.node}" for node "${candidate.id}" is not resolved.`
            )
          }
          const skip = (reason: "condition-false" | "source-skipped"): void => {
            emit(
              "node.skipped",
              `Skipped node "${candidate.id}" because its approved condition did not select it.`,
              (current) =>
                refreshWorkroomSettlement(
                  replaceNode(current, {
                    ...candidate,
                    status: "skipped",
                    skip: {
                      reason,
                      conditionNode: source.id,
                      pointer: condition.pointer,
                      skippedAt: now
                    }
                  }),
                  workflow
                ),
              {
                nodeId: candidate.id,
                data: {
                  conditionNode: source.id,
                  pointer: condition.pointer,
                  reason
                }
              }
            )
          }
          if (source.status === "skipped") {
            skip("source-skipped")
            madeProgress = true
            continue
          }
          const pointed = pointerValue(source.result, condition.pointer)
          if (!pointed.found) {
            const message = `Condition for node "${candidate.id}" could not resolve pointer "${condition.pointer}" in result of "${source.id}". Revise the unstarted node condition, then resume; or stop the run.`
            emit(
              "run.paused",
              message,
              (current) => ({
                ...current,
                status: "paused",
                pause: {
                  kind: "condition",
                  message,
                  repeatId: candidate.repeatId,
                  createdAt: now,
                  conditionNodeId: candidate.id,
                  condition
                }
              }),
              { data: { kind: "condition" } }
            )
            return
          }
          if (!same(pointed.value, condition.equals)) {
            skip("condition-false")
            madeProgress = true
            continue
          }
        }
        if (template.gate === "approval") {
          const gate = state.gates[candidate.id]
          if (gate === undefined) {
            const prepared = requirePreparedNode(state, workflow, candidate, context)
            if (prepared.gate === null) {
              throw new Error(
                `Prepared approval content is required for gated node "${candidate.id}".`
              )
            }
            const preparedGate = prepared.gate
            emit(
              "gate.opened",
              `Approval required for node "${candidate.id}". Approve with: orchestrate approve ${state.id} --gate ${candidate.id} --digest ${preparedGate.digest}`,
              (current) => ({
                ...replaceNode(current, {
                  ...candidate,
                  status: "awaiting-approval"
                }),
                gates: {
                  ...current.gates,
                  [candidate.id]: {
                    nodeId: candidate.id,
                    title: candidate.title,
                    content: preparedGate.content,
                    digest: preparedGate.digest,
                    openedAt: now,
                    approvedAt: null
                  }
                }
              }),
              { nodeId: candidate.id, data: { digest: preparedGate.digest } }
            )
            madeProgress = true
            continue
          }
          if (gate.approvedAt === null) {
            continue
          }
        }
        if (candidate.status === "pending") {
          emit(
            "node.ready",
            `Node "${candidate.id}" is ready.`,
            (current) => replaceNode(current, { ...candidate, status: "ready" }),
            { nodeId: candidate.id }
          )
          madeProgress = true
        }
        const running = Object.values(state.nodes).filter((node) => node.status === "running")
        if (running.length >= workflow.concurrency) {
          continue
        }
        if (
          running.some((active) => {
            const activeTemplate = templates.get(active.templateId)
            return (
              activeTemplate !== undefined &&
              conflicts(template, activeTemplate, state.allowWriteConflicts)
            )
          })
        ) {
          continue
        }
        const planned = Object.values(state.spawnIntents).filter(
          (intent) => intent.status === "planned"
        ).length
        if (
          workflow.limits.maxStarts !== null &&
          state.starts + planned >= workflow.limits.maxStarts &&
          !state.fuseOverride
        ) {
          if (planned > 0) {
            continue
          }
          emit(
            "run.paused",
            `Run reached its maxStarts fuse (${workflow.limits.maxStarts}).`,
            (current) => ({
              ...current,
              status: "paused",
              pause: {
                kind: "fuse",
                message: `Run reached its maxStarts fuse (${workflow.limits.maxStarts}).`,
                repeatId: null,
                createdAt: now
              }
            }),
            { data: { kind: "fuse" } }
          )
          return
        }
        const scheduledNode = state.nodes[candidate.id]
        if (scheduledNode === undefined) {
          continue
        }
        const prepared = requirePreparedNode(state, workflow, scheduledNode, context)
        const attemptNumber = scheduledNode.attempts.length + 1
        const intent: SpawnIntent = {
          id: `${candidate.id}:a${attemptNumber}`,
          nodeId: candidate.id,
          attempt: attemptNumber,
          token: prepared.token,
          status: "planned",
          createdAt: now
        }
        const attempt: AttemptState = {
          attempt: attemptNumber,
          status: "planned",
          token: prepared.token,
          pane: null,
          providerSessionId: null,
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          error: null,
          resultPath: prepared.resultPath,
          outputPath: prepared.outputPath
        }
        emit(
          "node.spawn-planned",
          `Planned spawn for node "${candidate.id}" attempt ${attemptNumber}.`,
          (current) => ({
            ...replaceNode(current, {
              ...scheduledNode,
              status: "running",
              attempts: [...scheduledNode.attempts, attempt]
            }),
            spawnIntents: { ...current.spawnIntents, [intent.id]: intent }
          }),
          { nodeId: candidate.id, data: { intentId: intent.id, attempt: attemptNumber } }
        )
        madeProgress = true
      }
      settleRepeats()
    }
    if (isSettled(state, workflow) && state.status === "running") {
      emit("run.completed", `Run "${state.id}" completed.`, (current) => ({
        ...current,
        status: "completed",
        finishedAt: now
      }))
    }
  }

  assertActive(state, event)
  switch (event.type) {
    case "run": {
      if (state.sequence !== 0) {
        throw new Error(`Run "${state.id}" was already started.`)
      }
      emit("run.started", `Started workflow run "${state.id}".`, (current) => current, {
        root: true
      })
      const uiDegraded = context?.uiDegraded
      if (uiDegraded !== undefined && uiDegraded !== null) {
        emit("ui.degraded", uiDegraded, (current) => current, {
          data: { reason: uiDegraded }
        })
      }
      actions.push({ type: "open-board" })
      for (const repeat of workflow.repeats) {
        instantiateRound(repeat, 1)
      }
      break
    }
    case "reconcile": {
      break
    }
    case "ui-degraded": {
      emit("ui.degraded", event.reason, (current) => current, {
        data: { reason: event.reason }
      })
      break
    }
    case "node-done": {
      const node = state.nodes[event.nodeId]
      if (node === undefined) {
        throw new Error(`Unknown node "${event.nodeId}".`)
      }
      const template = templateMap(workflow).get(node.templateId)
      if (template?.type !== "agent") {
        throw new Error(`Node "${event.nodeId}" is not an agent.`)
      }
      const attempt = runningAttempt(node)
      if (attempt.token !== event.token) {
        throw new Error(`Invalid or stale token for node "${node.id}".`)
      }
      if (event.outcome === "failed") {
        if (event.hold) {
          throw new Error("A failed node completion cannot request a hold.")
        }
        failAttempt(node, event.error ?? "Agent reported failure.", null, undefined, event.result)
        break
      }
      const transactionalRepeatResume =
        node.repeatId !== null &&
        template.session.mode === "resume" &&
        template.session.from !== null
      if (transactionalRepeatResume && event.providerSessionId === null) {
        throw new Error(
          `Persistent repeat node "${node.id}" completed without a forked provider session id.`
        )
      }
      const promotedSessionId = transactionalRepeatResume ? event.providerSessionId : null
      const completedAttempt: AttemptState = {
        ...attempt,
        status: "completed",
        providerSessionId: event.providerSessionId,
        finishedAt: now,
        error: null
      }
      emit(
        "node.completed",
        `Node "${node.id}" completed.`,
        (current) => {
          const resumedAlias =
            template.session.mode === "resume" && template.session.from !== null
              ? template.session.from
              : null
          const resumedSession = resumedAlias === null ? undefined : current.sessions[resumedAlias]
          const sessions = {
            ...current.sessions,
            ...(resumedAlias === null || resumedSession === undefined
              ? {}
              : {
                  [resumedAlias]: {
                    ...resumedSession,
                    ...(promotedSessionId === null ? {} : { sessionId: promotedSessionId }),
                    sourceNodeId: node.id
                  }
                }),
            ...(template.session.saveAs === null || event.providerSessionId === null
              ? {}
              : {
                  [template.session.saveAs]: {
                    alias: template.session.saveAs,
                    provider: template.provider,
                    sessionId: event.providerSessionId,
                    sourceNodeId: node.id
                  }
                })
          }
          const updated = replaceNode(current, {
            ...node,
            status: "completed",
            attempts: [...node.attempts.slice(0, -1), completedAttempt],
            resultPath: attempt.resultPath,
            result: event.result,
            error: null
          })
          const withSessions = {
            ...updated,
            sessions
          }
          return refreshWorkroomSettlement(
            updateWorkroomSeat(withSessions, workflow, node, "parked"),
            workflow
          )
        },
        { nodeId: node.id, data: { attempt: attempt.attempt } }
      )
      if (event.hold && state.holds[node.id] === undefined) {
        emit(
          "hold.set",
          `Downstream dependencies are held for instance "${node.id}".`,
          (current) => ({
            ...current,
            holds: {
              ...current.holds,
              [node.id]: { target: node.id, scope: "instance", setAt: now }
            }
          }),
          { nodeId: node.id, data: { scope: "instance", source: "node-done" } }
        )
      }
      break
    }
    case "node-exit": {
      const node = state.nodes[event.nodeId]
      if (node === undefined) {
        throw new Error(`Unknown node "${event.nodeId}".`)
      }
      const template = templateMap(workflow).get(node.templateId)
      if (template?.type !== "command") {
        throw new Error(`Node "${event.nodeId}" is not a command.`)
      }
      const attempt = runningAttempt(node)
      if (attempt.token !== event.token) {
        throw new Error(`Invalid or stale token for node "${node.id}".`)
      }
      const verdictRepeat =
        node.repeatId === null ? undefined : repeatMap(workflow).get(node.repeatId)
      const isRepeatVerdict =
        verdictRepeat?.until.type === "command-success" &&
        verdictRepeat.until.node === node.templateId
      const successful = template.allowedExitCodes.includes(event.code)
      if (!successful && !isRepeatVerdict) {
        failAttempt(node, event.error ?? `Command exited with code ${event.code}.`, event.code)
        break
      }
      const completedAttempt: AttemptState = {
        ...attempt,
        status: "completed",
        finishedAt: now,
        exitCode: event.code,
        error: event.error
      }
      emit(
        "node.completed",
        `Node "${node.id}" exited with code ${event.code}.`,
        (current) =>
          refreshWorkroomSettlement(
            updateWorkroomSeat(
              replaceNode(current, {
                ...node,
                status: "completed",
                attempts: [...node.attempts.slice(0, -1), completedAttempt],
                resultPath: attempt.outputPath,
                result: event.result ?? null,
                error: null
              }),
              workflow,
              node,
              "parked"
            ),
            workflow
          ),
        { nodeId: node.id, data: { attempt: attempt.attempt, exitCode: event.code } }
      )
      break
    }
    case "spawn-observed": {
      const node = state.nodes[event.nodeId]
      const intent = state.spawnIntents[event.intentId]
      if (node === undefined) {
        throw new Error(`Unknown node "${event.nodeId}".`)
      }
      if (intent === undefined || intent.nodeId !== node.id) {
        throw new Error(`Unknown spawn intent "${event.intentId}" for node "${event.nodeId}".`)
      }
      if (intent.status !== "planned") {
        throw new Error(`Spawn intent "${event.intentId}" was already observed.`)
      }
      const attempt = currentAttempt(node)
      if (
        attempt.status !== "planned" ||
        attempt.attempt !== intent.attempt ||
        attempt.token !== intent.token
      ) {
        throw new Error(`Spawn intent "${event.intentId}" does not match the active attempt.`)
      }
      emit(
        "node.started",
        `Started node "${node.id}" attempt ${attempt.attempt}.`,
        (current) => {
          const started: RunState = {
            ...replaceNode(current, {
              ...node,
              attempts: [
                ...node.attempts.slice(0, -1),
                {
                  ...attempt,
                  status: "running",
                  pane: event.pane,
                  providerSessionId: event.providerSessionId,
                  startedAt: now
                }
              ]
            }),
            starts: current.starts + 1,
            spawnIntents: {
              ...current.spawnIntents,
              [intent.id]: { ...intent, status: "spawned" as const }
            }
          }
          return updateWorkroomSeat(started, workflow, node, "running", event.pane)
        },
        { nodeId: node.id, data: { attempt: attempt.attempt, intentId: intent.id } }
      )
      break
    }
    case "spawn-failed": {
      const node = state.nodes[event.nodeId]
      const intent = state.spawnIntents[event.intentId]
      if (node === undefined) {
        throw new Error(`Unknown node "${event.nodeId}".`)
      }
      if (intent === undefined || intent.nodeId !== node.id || intent.status !== "planned") {
        throw new Error(
          `Unknown active spawn intent "${event.intentId}" for node "${event.nodeId}".`
        )
      }
      const attempt = currentAttempt(node)
      if (
        attempt.status !== "planned" ||
        attempt.attempt !== intent.attempt ||
        attempt.token !== intent.token
      ) {
        throw new Error(`Spawn intent "${event.intentId}" does not match the active attempt.`)
      }
      failAttempt(node, event.error, null, intent.id)
      break
    }
    case "spawn-attention": {
      const node = state.nodes[event.nodeId]
      const intent = state.spawnIntents[event.intentId]
      if (node === undefined) {
        throw new Error(`Unknown node "${event.nodeId}".`)
      }
      if (intent === undefined || intent.nodeId !== node.id || intent.status !== "planned") {
        throw new Error(
          `Unknown active spawn intent "${event.intentId}" for node "${event.nodeId}".`
        )
      }
      const template = templateMap(workflow).get(node.templateId)
      if (template?.workroom === undefined || template.seat === undefined) {
        throw new Error(`Node "${event.nodeId}" has no participant seat requiring attention.`)
      }
      emit(
        "workroom.attention",
        `Workroom "${template.workroom}" seat "${template.seat}" needs Herdr occupancy attention before node "${node.id}" can start.`,
        (current) => updateWorkroomSeat(current, workflow, node, "attention"),
        {
          nodeId: node.id,
          data: {
            intentId: intent.id,
            workroomId: template.workroom,
            seatId: template.seat
          }
        }
      )
      break
    }
    case "approve-gate": {
      const gate = state.gates[event.nodeId]
      const gateNode = state.nodes[event.nodeId]
      if (gate === undefined) {
        throw new Error(`Node "${event.nodeId}" has no open gate.`)
      }
      if (gateNode === undefined) {
        throw new Error(`Unknown node "${event.nodeId}".`)
      }
      if (gate.approvedAt !== null) {
        throw new Error(`Gate for node "${event.nodeId}" is already approved.`)
      }
      if (gate.digest !== event.digest) {
        throw new Error(`Gate digest mismatch for node "${event.nodeId}".`)
      }
      emit(
        "gate.approved",
        `Approved gate for node "${event.nodeId}".`,
        (current) => ({
          ...replaceNode(current, { ...gateNode, status: "pending" }),
          gates: { ...current.gates, [event.nodeId]: { ...gate, approvedAt: now } }
        }),
        { nodeId: event.nodeId, data: { digest: event.digest } }
      )
      break
    }
    case "hold": {
      const exact = state.nodes[event.nodeId]
      const template = templateMap(workflow).get(event.nodeId)
      if (exact === undefined && template === undefined) {
        throw new Error(`Unknown node "${event.nodeId}".`)
      }
      if (state.holds[event.nodeId] !== undefined) {
        throw new Error(`Node "${event.nodeId}" is already held.`)
      }
      const scope =
        exact === undefined || repeatForTemplate(workflow, event.nodeId) !== undefined
          ? "template"
          : "instance"
      emit(
        "hold.set",
        `Downstream dependencies are held for ${scope} "${event.nodeId}".`,
        (current) => ({
          ...current,
          holds: {
            ...current.holds,
            [event.nodeId]: { target: event.nodeId, scope, setAt: now }
          }
        }),
        { nodeId: event.nodeId, data: { scope, source: "manual" } }
      )
      break
    }
    case "release": {
      const hold = state.holds[event.nodeId]
      if (hold === undefined) {
        throw new Error(`Node "${event.nodeId}" is not held.`)
      }
      emit(
        "hold.released",
        `Released downstream dependencies for ${hold.scope} "${event.nodeId}".`,
        (current) => ({
          ...current,
          holds: removeKeys(current.holds, new Set([event.nodeId]))
        }),
        { nodeId: event.nodeId, data: { scope: hold.scope } }
      )
      break
    }
    case "pause": {
      if (state.status === "paused") {
        throw new Error(`Run "${state.id}" is already paused.`)
      }
      emit(
        "run.paused",
        `Paused run "${state.id}".`,
        (current) => ({
          ...current,
          status: "paused",
          pause: { kind: "human", message: "Paused by the user.", repeatId: null, createdAt: now }
        }),
        { data: { kind: "human" } }
      )
      break
    }
    case "resume": {
      if (state.status !== "paused" || state.pause === null) {
        throw new Error(`Run "${state.id}" is not paused.`)
      }
      if (event.continueRounds !== null && event.continueRounds < 1) {
        throw new Error("continueRounds must be a positive integer.")
      }
      const pausedRepeatId = state.pause.kind === "max-rounds" ? state.pause.repeatId : null
      if (event.continueRounds !== null && pausedRepeatId === null) {
        throw new Error("continueRounds requires a max-rounds pause.")
      }
      if (event.acceptRepeat !== null && event.acceptRepeat !== pausedRepeatId) {
        throw new Error(`Repeat "${event.acceptRepeat}" is not awaiting a max-rounds decision.`)
      }
      if (state.pause.kind === "fuse" && !event.overrideFuse) {
        throw new Error("Resuming a fuse pause requires overrideFuse.")
      }
      if (state.pause.kind === "condition") {
        const conditionNodeId = state.pause.conditionNodeId
        const pausedCondition = state.pause.condition
        const target = conditionNodeId === undefined ? undefined : state.nodes[conditionNodeId]
        const template =
          target === undefined
            ? undefined
            : workflow.nodes.find((candidate) => candidate.id === target.templateId)
        if (
          target === undefined ||
          template === undefined ||
          pausedCondition === undefined ||
          same(template.when, pausedCondition)
        ) {
          throw new Error(
            "A condition pause requires an approved revision that changes the paused node condition before resume."
          )
        }
      }
      if (pausedRepeatId !== null && event.continueRounds === null && event.acceptRepeat === null) {
        throw new Error("A max-rounds pause requires continueRounds or acceptRepeat.")
      }
      emit("run.resumed", `Resumed run "${state.id}".`, (current) => {
        const extensions = { ...current.repeatRoundExtensions }
        const repeats = { ...current.repeats }
        if (pausedRepeatId !== null && event.continueRounds !== null) {
          extensions[pausedRepeatId] = (extensions[pausedRepeatId] ?? 0) + event.continueRounds
          const pausedRepeat = repeats[pausedRepeatId]
          if (pausedRepeat === undefined) {
            throw new Error(`Unknown repeat "${pausedRepeatId}".`)
          }
          repeats[pausedRepeatId] = { ...pausedRepeat, status: "running" }
        }
        return {
          ...current,
          status: "running",
          pause: null,
          fuseOverride: current.fuseOverride || event.overrideFuse,
          repeatRoundExtensions: extensions,
          repeats
        }
      })
      if (event.acceptRepeat !== null) {
        const repeat = repeatMap(workflow).get(event.acceptRepeat)
        if (repeat === undefined) {
          throw new Error(`Unknown repeat "${event.acceptRepeat}".`)
        }
        completeRepeat(repeat, true)
      } else if (pausedRepeatId !== null) {
        const repeat = repeatMap(workflow).get(pausedRepeatId)
        const repeatState = state.repeats[pausedRepeatId]
        if (repeat === undefined || repeatState === undefined) {
          throw new Error(`Unknown repeat "${pausedRepeatId}".`)
        }
        instantiateRound(repeat, repeatState.round + 1)
      }
      break
    }
    case "stop": {
      for (const node of Object.values(state.nodes)) {
        for (const attempt of node.attempts) {
          if (attempt.pane !== null) {
            actions.push({ type: "close-pane", paneId: attempt.pane.paneId })
          }
        }
      }
      for (const node of Object.values(state.nodes)) {
        if (TERMINAL_NODE_STATUSES.has(node.status)) {
          continue
        }
        emit(
          "node.cancelled",
          `Cancelled node "${node.id}".`,
          (current) => {
            const active = current.nodes[node.id]
            if (active === undefined) {
              throw new Error(`Unknown node "${node.id}".`)
            }
            return replaceNode(current, {
              ...active,
              status: "cancelled",
              attempts: active.attempts.map((attempt) => {
                if (attempt.status !== "running" && attempt.status !== "planned") {
                  return attempt
                }
                return Object.assign({}, attempt, {
                  status: "cancelled" as const,
                  finishedAt: now
                })
              })
            })
          },
          { nodeId: node.id }
        )
      }
      emit("run.stopped", `Stopped run "${state.id}".`, (current) =>
        abortWorkrooms({
          ...current,
          status: "stopped",
          finishedAt: now,
          pause: null,
          spawnIntents: {}
        })
      )
      break
    }
    case "propose-revision": {
      if (state.pendingRevision !== null) {
        throw new Error("A revision is already pending.")
      }
      emit(
        "revision.proposed",
        `Proposed workflow revision ${event.digest}. Apply with: orchestrate approve ${state.id} --revision ${event.digest} — or discard with: orchestrate revise ${state.id} --discard`,
        (current) => ({
          ...current,
          pendingRevision: {
            workflow: event.workflow,
            digest: event.digest,
            summary: event.summary,
            createdAt: now
          }
        }),
        { data: { digest: event.digest, summary: event.summary } }
      )
      break
    }
    case "approve-revision": {
      const pending = state.pendingRevision
      if (pending === null) {
        throw new Error("There is no pending revision.")
      }
      if (pending.digest !== event.digest) {
        throw new Error("Revision digest mismatch.")
      }
      const revised = pending.workflow
      if (!same(workflow.repeats, revised.repeats)) {
        throw new Error("Revision changes the repeat contract of an active run.")
      }
      const oldTemplates = templateMap(workflow)
      const currentWorkrooms = workroomMap(workflow)
      const revisedWorkrooms = workroomMap(revised)
      const reservedWorkrooms = new Set(
        Object.values(state.nodes).flatMap((node) => {
          if (node.attempts.length === 0) {
            return []
          }
          const workroom = oldTemplates.get(node.templateId)?.workroom
          return workroom === undefined ? [] : [workroom]
        })
      )
      for (const workroom of Object.values(state.workrooms)) {
        if (
          (workroom.status !== "pending" || reservedWorkrooms.has(workroom.id)) &&
          !same(currentWorkrooms.get(workroom.id), revisedWorkrooms.get(workroom.id))
        ) {
          throw new Error(`Revision changes already-opened or reserved workroom "${workroom.id}".`)
        }
      }
      const revisedTemplates = templateMap(revised)
      const pausedConditionTarget =
        state.pause?.kind === "condition" && state.pause.conditionNodeId !== undefined
          ? state.nodes[state.pause.conditionNodeId]
          : undefined
      const conditionOnlyRevisionTemplate =
        pausedConditionTarget !== undefined &&
        pausedConditionTarget.status === "pending" &&
        !hasResolvedHistory(pausedConditionTarget)
          ? pausedConditionTarget.templateId
          : null
      for (const node of Object.values(state.nodes)) {
        if (!hasResolvedHistory(node)) {
          continue
        }
        const before = oldTemplates.get(node.templateId)
        const after = revisedTemplates.get(node.templateId)
        const changesOnlyPausedCondition =
          conditionOnlyRevisionTemplate === node.templateId &&
          before !== undefined &&
          after !== undefined &&
          sameNodeExceptWhen(before, after)
        if (
          before === undefined ||
          after === undefined ||
          (!same(before, after) && !changesOnlyPausedCondition)
        ) {
          throw new Error(`Revision changes already-started node template "${node.templateId}".`)
        }
      }
      for (const repeat of workflow.repeats) {
        const revisedRepeat = revised.repeats.find((candidate) => candidate.id === repeat.id)
        if (state.repeats[repeat.id]?.status !== "pending" && !same(repeat, revisedRepeat)) {
          throw new Error(`Revision changes active repeat "${repeat.id}".`)
        }
      }
      const revisedRepeatMembers = new Set(revised.repeats.flatMap((repeat) => repeat.members))
      const retainedRuntimeIds = new Set(
        Object.values(state.nodes)
          .filter((node) => node.origin === "loop-round" || revisedTemplates.has(node.templateId))
          .map((node) => node.id)
      )
      const reconciledNodes = removeKeys(
        state.nodes,
        new Set(Object.keys(state.nodes).filter((id) => !retainedRuntimeIds.has(id)))
      )
      for (const node of revised.nodes) {
        if (!revisedRepeatMembers.has(node.id)) {
          const existing = reconciledNodes[node.id]
          reconciledNodes[node.id] =
            existing === undefined
              ? nodeState(node)
              : !hasResolvedHistory(existing)
                ? { ...existing, title: node.title }
                : existing
        }
      }
      const revisedInitialWorkrooms = initialWorkrooms(revised)
      const reconciledWorkrooms: Record<string, RunState["workrooms"][string]> = {}
      for (const [id, initial] of Object.entries(revisedInitialWorkrooms)) {
        const existing = state.workrooms[id]
        reconciledWorkrooms[id] =
          existing !== undefined && existing.status !== "pending" ? existing : initial
      }
      workflow = revised
      emit(
        "revision.approved",
        `Approved workflow revision ${event.digest}.`,
        (current) =>
          refreshWorkroomSettlement(
            {
              ...current,
              workflowName: revised.name,
              objective: revised.objective,
              digest: event.digest,
              pendingRevision: null,
              nodes: reconciledNodes,
              workrooms: reconciledWorkrooms,
              holds: Object.fromEntries(
                Object.entries(current.holds).filter(([target, hold]) =>
                  hold.scope === "instance"
                    ? reconciledNodes[target] !== undefined
                    : revisedTemplates.has(target)
                )
              ),
              gates: Object.fromEntries(
                Object.entries(current.gates).filter(
                  ([id]) => reconciledNodes[id]?.attempts.length !== 0
                )
              )
            },
            revised
          ),
        { data: { digest: event.digest, workflow: revised } }
      )
      break
    }
    case "discard-revision": {
      if (state.pendingRevision === null) {
        throw new Error("There is no pending revision.")
      }
      const digest = state.pendingRevision.digest
      emit(
        "revision.discarded",
        `Discarded workflow revision ${digest}.`,
        (current) => ({
          ...current,
          pendingRevision: null
        }),
        { data: { digest } }
      )
      break
    }
    case "restore": {
      const dead = new Set(event.deadPaneIds)
      for (const node of Object.values(state.nodes)) {
        const attempt = node.attempts.at(-1)
        if (
          node.status === "running" &&
          attempt?.pane !== null &&
          attempt?.pane !== undefined &&
          dead.has(attempt.pane.paneId)
        ) {
          failAttempt(node, "The herdr pane disappeared.", null, undefined, null, true)
          if (state.status === "failed") {
            break
          }
        }
      }
      if (state.status !== "failed") {
        for (const [workroomId, workroom] of Object.entries(state.workrooms)) {
          if (workroom.status !== "active") {
            continue
          }
          for (const [seatId, seat] of Object.entries(workroom.seats)) {
            const paneId = seat.pane?.paneId
            if (paneId === undefined || !dead.has(paneId)) {
              continue
            }
            emit(
              "workroom.seat-cleared",
              `Cleared vanished pane "${paneId}" from seat "${seatId}" in workroom "${workroomId}".`,
              (current) => {
                const currentWorkroom = current.workrooms[workroomId]
                const currentSeat = currentWorkroom?.seats[seatId]
                if (currentWorkroom === undefined || currentSeat === undefined) {
                  return current
                }
                return {
                  ...current,
                  workrooms: {
                    ...current.workrooms,
                    [workroomId]: {
                      ...currentWorkroom,
                      seats: {
                        ...currentWorkroom.seats,
                        [seatId]: {
                          ...currentSeat,
                          status: "empty",
                          nodeId: null,
                          pane: null
                        }
                      }
                    }
                  }
                }
              },
              { data: { workroomId, seatId, paneId } }
            )
          }
        }
      }
      break
    }
  }

  if (event.type !== "ui-degraded" && context?.deferScheduling !== true) {
    schedule()
  }
  return { workflow, state, actions, events }
}
