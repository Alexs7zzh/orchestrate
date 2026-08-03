import type {
  AttemptState,
  EventRecord,
  GateState,
  NodeRunState,
  NodeStatus,
  PaneReference,
  Provider,
  RunState
} from "./types.js"

import { holdBlocksDependencies } from "./state.js"

export type PaneCondition = "live" | "gone" | "blocked" | "done"

export interface PaneGarnish {
  readonly condition: PaneCondition
  readonly detail: string | null
}

export interface BoardModelOptions {
  readonly now: string
  // Pane health is deliberately external presentation data. It must never be
  // used to infer or mutate workflow state.
  readonly paneGarnish?: Readonly<Record<string, PaneGarnish>>
}

export interface AttemptMetric {
  readonly attempt: number
  readonly status: AttemptState["status"]
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly elapsedMs: number | null
}

export interface StalledPaneView {
  readonly condition: "gone" | "blocked" | "done"
  readonly detail: string
  readonly manualCommand: string | null
}

export interface BoardNodeView {
  readonly id: string
  readonly templateId: string
  readonly title: string
  readonly type: NodeRunState["type"]
  readonly provider: Provider | null
  readonly needs: readonly string[]
  readonly depth: number
  readonly status: NodeStatus
  readonly glyph: string
  readonly downstreamHeld: boolean
  readonly continuation: "auto" | "hold"
  readonly continuationGlyph: "▸" | "⏸"
  readonly repeatId: string | null
  readonly round: number | null
  readonly currentRound: boolean
  readonly attempts: readonly AttemptMetric[]
  readonly elapsedMs: number | null
  readonly pane: PaneReference | null
  readonly resultPath: string | null
  readonly stalledPane: StalledPaneView | null
}

export interface BoardNodeRow {
  readonly kind: "node"
  readonly key: string
  readonly depth: number
  readonly node: BoardNodeView
}

export interface BoardRepeatHistoryRow {
  readonly kind: "repeat-history"
  readonly key: string
  readonly depth: number
  readonly repeatId: string
  readonly round: number
  readonly nodeIds: readonly string[]
  readonly statuses: readonly NodeStatus[]
  readonly elapsedMs: number | null
}

export type BoardRow = BoardNodeRow | BoardRepeatHistoryRow

interface AttentionBase {
  readonly title: string
  readonly detail: string
  readonly command: string | null
}

export interface GateAttention extends AttentionBase {
  readonly kind: "gate"
  readonly nodeId: string
  readonly digest: string
}

export interface RevisionAttention extends AttentionBase {
  readonly kind: "revision"
  readonly digest: string
}

export interface MaxRoundsAttention extends AttentionBase {
  readonly kind: "max-rounds"
  readonly repeatId: string
  readonly continueCommand: string
}

export interface FuseAttention extends AttentionBase {
  readonly kind: "fuse"
}

export interface DownstreamHeldAttention extends AttentionBase {
  readonly kind: "downstream-held"
  readonly nodeId: string
  readonly scope: "template" | "instance"
}

export interface StalledPaneAttention extends AttentionBase {
  readonly kind: "stalled-pane"
  readonly nodeId: string
  readonly condition: "gone" | "blocked" | "done"
}

export type BoardAttention =
  | GateAttention
  | RevisionAttention
  | FuseAttention
  | MaxRoundsAttention
  | DownstreamHeldAttention
  | StalledPaneAttention

export interface BoardViewModel {
  readonly run: {
    readonly id: string
    readonly name: string
    readonly objective: string
    readonly status: RunState["status"]
    readonly pause: RunState["pause"]
    readonly elapsedMs: number
  }
  readonly needsYou: readonly BoardAttention[]
  readonly nodes: readonly BoardNodeView[]
  readonly rows: readonly BoardRow[]
  readonly selectableNodeIds: readonly string[]
}

export type BoardInput =
  | {
      readonly type: "key"
      readonly key: "up" | "down" | "enter" | "p" | "r" | "s" | "h" | "q"
    }
  | {
      readonly type: "mouse"
      readonly button: "left" | "other"
      readonly action: "press" | "release"
      readonly row: number
    }

export type BoardAction =
  | { readonly type: "select-node"; readonly nodeId: string }
  | { readonly type: "focus-node"; readonly nodeId: string; readonly pane: PaneReference }
  | { readonly type: "show-result"; readonly nodeId: string; readonly resultPath: string | null }
  | { readonly type: "pause-run"; readonly runId: string }
  | { readonly type: "resume-run"; readonly runId: string }
  | { readonly type: "stop-run"; readonly runId: string }
  | { readonly type: "hold-node"; readonly runId: string; readonly nodeId: string }
  | { readonly type: "release-node"; readonly runId: string; readonly nodeId: string }
  | { readonly type: "quit" }
  | { readonly type: "none" }

const STATUS_GLYPHS: Readonly<Record<NodeStatus, string>> = {
  pending: "○",
  ready: "◌",
  running: "●",
  "awaiting-approval": "◆",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
  paused: "Ⅱ"
}

const TERMINAL_NODE_STATUSES = new Set<NodeStatus>(["completed", "failed", "cancelled"])

const ATTEMPT_FINISH_EVENTS = new Set<EventRecord["type"]>([
  "node.completed",
  "node.failed",
  "node.cancelled"
])

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function eventAttempt(event: EventRecord): number | null {
  if (event.data === null || typeof event.data !== "object") {
    return null
  }
  const value = (event.data as Readonly<Record<string, unknown>>).attempt
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

function elapsed(start: string | null, finish: string | null, now: string): number | null {
  const startMs = parseTimestamp(start)
  const finishMs = parseTimestamp(finish ?? now)
  return startMs === null || finishMs === null ? null : Math.max(0, finishMs - startMs)
}

function attemptMetrics(
  node: NodeRunState,
  events: readonly EventRecord[],
  now: string
): readonly AttemptMetric[] {
  const nodeEvents = events.filter((event) => event.nodeId === node.id)
  return node.attempts.map((attempt) => {
    const started = nodeEvents.find(
      (event) => event.type === "node.started" && eventAttempt(event) === attempt.attempt
    )?.timestamp
    const finished = nodeEvents.find(
      (event) => ATTEMPT_FINISH_EVENTS.has(event.type) && eventAttempt(event) === attempt.attempt
    )?.timestamp
    const startedAt = started ?? attempt.startedAt
    const finishedAt = finished ?? attempt.finishedAt
    return {
      attempt: attempt.attempt,
      status: attempt.status,
      startedAt,
      finishedAt,
      elapsedMs: elapsed(startedAt, finishedAt, now)
    }
  })
}

function repeatByTemplate(state: RunState): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const node of Object.values(state.nodes)) {
    if (node.repeatId !== null) {
      result.set(node.templateId, node.repeatId)
    }
  }
  return result
}

function runtimeNeeds(
  state: RunState,
  node: NodeRunState,
  templates: ReadonlyMap<string, string>
): readonly string[] {
  return node.needs.flatMap((templateId) => {
    const repeatId = templates.get(templateId)
    if (repeatId === undefined) {
      return [templateId]
    }
    const round =
      node.repeatId === repeatId && node.round !== null
        ? node.round
        : state.repeats[repeatId]?.round
    if (round === undefined) {
      return []
    }
    const runtimeId = `${templateId}--r${round}`
    return [runtimeId]
  })
}

function dependencyOrder(state: RunState): {
  readonly nodes: readonly NodeRunState[]
  readonly needs: ReadonlyMap<string, readonly string[]>
  readonly depths: ReadonlyMap<string, number>
} {
  const authoredOrder = Object.values(state.nodes)
  const originalIndex = new Map(authoredOrder.map((node, index) => [node.id, index]))
  const templates = repeatByTemplate(state)
  const needs = new Map(
    authoredOrder.map((node) => [node.id, runtimeNeeds(state, node, templates)] as const)
  )
  const pending = new Set(authoredOrder.map((node) => node.id))
  const ordered: NodeRunState[] = []
  const emitted = new Set<string>()

  while (pending.size > 0) {
    const ready = [...pending]
      .filter((id) => (needs.get(id) ?? []).every((dependency) => emitted.has(dependency)))
      .toSorted((left, right) => (originalIndex.get(left) ?? 0) - (originalIndex.get(right) ?? 0))
    // Stored workflows are validated as DAGs. Keep malformed presentation
    // data visible, rather than letting a corrupted dependency hide nodes.
    const next = ready[0] ?? [...pending][0]
    if (next === undefined) {
      break
    }
    pending.delete(next)
    emitted.add(next)
    const node = state.nodes[next]
    if (node !== undefined) {
      ordered.push(node)
    }
  }

  const depths = new Map<string, number>()
  for (const node of ordered) {
    const dependencyDepths = (needs.get(node.id) ?? []).map(
      (dependency) => depths.get(dependency) ?? 0
    )
    depths.set(node.id, dependencyDepths.length === 0 ? 0 : Math.max(...dependencyDepths) + 1)
  }
  return { nodes: ordered, needs, depths }
}

function isHeld(state: RunState, node: NodeRunState): boolean {
  return state.holds[node.id] !== undefined || state.holds[node.templateId] !== undefined
}

export function gateApprovalCommand(runId: string, gate: GateState): string {
  return `orchestrate approve ${runId} --gate ${gate.nodeId} --digest ${gate.digest}`
}

export function revisionApprovalCommand(runId: string, digest: string): string {
  return `orchestrate approve ${runId} --revision ${digest}`
}

export function nodeDoneCommand(runId: string, nodeId: string, token: string): string {
  return `orchestrate node-done ${runId} ${nodeId} --token ${token} --outcome completed`
}

function stalledPane(
  state: RunState,
  node: NodeRunState,
  garnish: PaneGarnish | undefined
): StalledPaneView | null {
  if (node.status !== "running" || garnish === undefined || garnish.condition === "live") {
    return null
  }
  const attempt = node.attempts.at(-1)
  const manualCommand =
    node.type === "agent" && attempt !== undefined
      ? nodeDoneCommand(state.id, node.id, attempt.token)
      : null
  return {
    condition: garnish.condition,
    detail:
      garnish.detail ??
      (garnish.condition === "gone"
        ? "Pane gone — human needed."
        : garnish.condition === "blocked"
          ? "Agent is blocked — human needed."
          : "Result missing: agent finished without authenticated node-done — recovery needed."),
    manualCommand
  }
}

function runElapsed(state: RunState, events: readonly EventRecord[], now: string): number {
  const started = events.find((event) => event.type === "run.started")?.timestamp ?? state.startedAt
  const finished = events
    .toReversed()
    .find((event) => ["run.completed", "run.failed", "run.stopped"].includes(event.type))?.timestamp
  return elapsed(started, finished ?? state.finishedAt, now) ?? 0
}

function buildAttention(
  state: RunState,
  nodes: readonly BoardNodeView[]
): readonly BoardAttention[] {
  const order = new Map(nodes.map((node, index) => [node.id, index]))
  const gates: GateAttention[] = Object.values(state.gates)
    .filter((gate) => gate.approvedAt === null)
    .toSorted((left, right) => (order.get(left.nodeId) ?? 0) - (order.get(right.nodeId) ?? 0))
    .map((gate) => ({
      kind: "gate",
      nodeId: gate.nodeId,
      digest: gate.digest,
      title: `Approve ${gate.title}`,
      detail: `Digest ${gate.digest}`,
      command: gateApprovalCommand(state.id, gate)
    }))

  const revisions: RevisionAttention[] =
    state.pendingRevision === null
      ? []
      : [
          {
            kind: "revision",
            digest: state.pendingRevision.digest,
            title: "Approve pending revision",
            detail:
              state.pendingRevision.summary.length === 0
                ? `Digest ${state.pendingRevision.digest}`
                : state.pendingRevision.summary.join("; "),
            command: revisionApprovalCommand(state.id, state.pendingRevision.digest)
          }
        ]

  const maxRounds: MaxRoundsAttention[] =
    state.pause?.kind !== "max-rounds" || state.pause.repeatId === null
      ? []
      : [
          {
            kind: "max-rounds",
            repeatId: state.pause.repeatId,
            title: `Repeat ${state.pause.repeatId} reached max rounds`,
            detail: state.pause.message,
            command: `orchestrate resume ${state.id} --accept-repeat ${state.pause.repeatId}`,
            continueCommand: `orchestrate resume ${state.id} --continue-rounds 1`
          }
        ]

  const fuse: FuseAttention[] =
    state.pause?.kind !== "fuse"
      ? []
      : [
          {
            kind: "fuse",
            title: "Pane-start fuse reached",
            detail: state.pause.message,
            command: `orchestrate resume ${state.id} --override-fuse`
          }
        ]

  const downstreamHeld: DownstreamHeldAttention[] = Object.values(state.holds)
    .filter((hold) => holdBlocksDependencies(state, hold))
    .map((hold) => {
      const node = nodes.find((candidate) => candidate.id === hold.target)
      return {
        kind: "downstream-held",
        nodeId: hold.target,
        scope: hold.scope,
        title: `${node?.title ?? hold.target}: ${node?.status === "completed" ? "completed; " : ""}downstream held`,
        detail:
          "Release the hold to allow dependents to proceed; the completed outcome is unchanged.",
        command: `orchestrate release ${state.id} ${hold.target}`
      }
    })

  const stalled: StalledPaneAttention[] = nodes.flatMap((node) => {
    if (node.stalledPane === null) {
      return []
    }
    return [
      {
        kind: "stalled-pane",
        nodeId: node.id,
        condition: node.stalledPane.condition,
        title:
          node.stalledPane.condition === "blocked"
            ? `${node.title}: agent blocked`
            : node.stalledPane.condition === "done"
              ? `${node.title}: result missing`
              : `${node.title}: pane gone`,
        detail: node.stalledPane.detail,
        command: node.stalledPane.manualCommand
      }
    ]
  })

  return [...gates, ...revisions, ...fuse, ...maxRounds, ...downstreamHeld, ...stalled]
}

function visibleRows(nodes: readonly BoardNodeView[]): readonly BoardRow[] {
  const rows: BoardRow[] = []
  const emittedHistory = new Set<string>()
  for (const node of nodes) {
    if (node.repeatId === null || node.round === null || node.currentRound) {
      rows.push({ kind: "node", key: node.id, depth: node.depth, node })
      continue
    }
    const key = `${node.repeatId}:r${node.round}`
    if (emittedHistory.has(key)) {
      continue
    }
    emittedHistory.add(key)
    const roundNodes = nodes.filter(
      (candidate) => candidate.repeatId === node.repeatId && candidate.round === node.round
    )
    rows.push({
      kind: "repeat-history",
      key,
      depth: Math.min(...roundNodes.map((candidate) => candidate.depth)),
      repeatId: node.repeatId,
      round: node.round,
      nodeIds: roundNodes.map((candidate) => candidate.id),
      statuses: roundNodes.map((candidate) => candidate.status),
      elapsedMs: roundNodes.reduce<number | null>(
        (total, candidate) =>
          candidate.elapsedMs === null ? total : (total ?? 0) + candidate.elapsedMs,
        null
      )
    })
  }
  return rows
}

export function buildBoardModel(
  state: RunState,
  events: readonly EventRecord[],
  options: BoardModelOptions
): BoardViewModel {
  const relevantEvents = events
    .filter((event) => event.runId === state.id)
    .toSorted((left, right) => left.sequence - right.sequence)
  const ordered = dependencyOrder(state)
  const nodes = ordered.nodes.map((node): BoardNodeView => {
    const attempts = attemptMetrics(node, relevantEvents, options.now)
    const latestAttempt = attempts.at(-1)
    const currentRound =
      node.repeatId === null || node.round === state.repeats[node.repeatId]?.round
    const hold = isHeld(state, node)
    return {
      id: node.id,
      templateId: node.templateId,
      title: node.title,
      type: node.type,
      provider: node.provider,
      needs: ordered.needs.get(node.id) ?? [],
      depth: ordered.depths.get(node.id) ?? 0,
      status: node.status,
      glyph: STATUS_GLYPHS[node.status],
      downstreamHeld: hold,
      continuation: hold ? "hold" : "auto",
      continuationGlyph: hold ? "⏸" : "▸",
      repeatId: node.repeatId,
      round: node.round,
      currentRound,
      attempts,
      elapsedMs: latestAttempt?.elapsedMs ?? null,
      pane: node.attempts.at(-1)?.pane ?? null,
      resultPath: node.resultPath,
      stalledPane: stalledPane(state, node, options.paneGarnish?.[node.id])
    }
  })
  const rows = visibleRows(nodes)
  return {
    run: {
      id: state.id,
      name: state.workflowName,
      objective: state.objective,
      status: state.status,
      pause: state.pause,
      elapsedMs: runElapsed(state, relevantEvents, options.now)
    },
    needsYou: buildAttention(state, nodes),
    nodes,
    rows,
    selectableNodeIds: rows.flatMap((row) => (row.kind === "node" ? [row.node.id] : []))
  }
}

function activateNode(model: BoardViewModel, nodeId: string): BoardAction {
  const node = model.nodes.find((candidate) => candidate.id === nodeId)
  if (node === undefined) {
    return { type: "none" }
  }
  if (node.status === "running" && node.pane !== null) {
    return { type: "focus-node", nodeId, pane: node.pane }
  }
  if (TERMINAL_NODE_STATUSES.has(node.status)) {
    return { type: "show-result", nodeId, resultPath: node.resultPath }
  }
  return { type: "select-node", nodeId }
}

export function mapBoardInput(
  model: BoardViewModel,
  selectedNodeId: string | null,
  input: BoardInput
): BoardAction {
  if (input.type === "mouse") {
    if (input.button !== "left" || input.action !== "press") {
      return { type: "none" }
    }
    const row = model.rows[input.row]
    return row?.kind === "node" ? activateNode(model, row.node.id) : { type: "none" }
  }

  if (input.key === "q") {
    return { type: "quit" }
  }
  if (input.key === "p") {
    return model.run.status === "paused" && model.run.pause?.kind === "human"
      ? { type: "resume-run", runId: model.run.id }
      : model.run.status === "running"
        ? { type: "pause-run", runId: model.run.id }
        : { type: "none" }
  }
  if (input.key === "r") {
    return model.run.status === "paused" && model.run.pause?.kind === "human"
      ? { type: "resume-run", runId: model.run.id }
      : { type: "none" }
  }
  if (input.key === "s") {
    return model.run.status === "running" || model.run.status === "paused"
      ? { type: "stop-run", runId: model.run.id }
      : { type: "none" }
  }
  const selected = model.nodes.find((node) => node.id === selectedNodeId)
  if (input.key === "h") {
    if (selected === undefined) {
      return { type: "none" }
    }
    return selected.downstreamHeld
      ? { type: "release-node", runId: model.run.id, nodeId: selected.id }
      : { type: "hold-node", runId: model.run.id, nodeId: selected.id }
  }
  if (input.key === "enter") {
    return selected === undefined ? { type: "none" } : activateNode(model, selected.id)
  }

  const selectable = model.selectableNodeIds
  if (selectable.length === 0) {
    return { type: "none" }
  }
  const current = selectedNodeId === null ? -1 : selectable.indexOf(selectedNodeId)
  const next =
    input.key === "down"
      ? Math.min(current + 1, selectable.length - 1)
      : Math.max(current <= 0 ? 0 : current - 1, 0)
  const nodeId = selectable[next]
  return nodeId === undefined ? { type: "none" } : { type: "select-node", nodeId }
}
