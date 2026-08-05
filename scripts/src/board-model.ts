import type {
  AttemptState,
  EventRecord,
  GateState,
  NodeRunState,
  NodeStatus,
  PaneReference,
  Provider,
  RepeatCondition,
  RepeatSpec,
  RunState,
  WorkflowNode
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
  // Repeat bounds and conditions live only in the workflow spec; without them
  // the board still renders rounds, just without the "round R/N — until" line.
  readonly repeats?: readonly RepeatSpec[]
  // Authored nodes let the board recognize legacy workflows that copied
  // round-shaped nodes instead of declaring a repeat. Runtime state alone
  // intentionally does not carry output schemas, which supply the best
  // available convergence label for those workflows.
  readonly workflowNodes?: readonly WorkflowNode[]
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
  readonly skip: NonNullable<NodeRunState["skip"]> | null
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

export interface BoardRepeatRoundRow {
  readonly kind: "repeat-round"
  readonly key: string
  readonly depth: number
  readonly repeatId: string
  readonly round: number
  readonly maxRounds: number | null
  readonly until: string | null
  readonly backTo: readonly string[]
}

export interface BoardUnrolledRepeatRow {
  readonly kind: "unrolled-repeat"
  readonly key: string
  readonly depth: number
  readonly label: string
  readonly round: number
  readonly maxRounds: number
  readonly until: string | null
  readonly backTo: readonly string[]
}

export type BoardRow =
  | BoardNodeRow
  | BoardRepeatHistoryRow
  | BoardRepeatRoundRow
  | BoardUnrolledRepeatRow

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

export interface ConditionAttention extends AttentionBase {
  readonly kind: "condition"
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

export interface WorkroomAttention extends AttentionBase {
  readonly kind: "workroom"
  readonly workroomId: string
  readonly seatId: string
}

export type BoardAttention =
  | GateAttention
  | RevisionAttention
  | FuseAttention
  | ConditionAttention
  | MaxRoundsAttention
  | DownstreamHeldAttention
  | WorkroomAttention
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
  skipped: "↷",
  failed: "✗",
  cancelled: "⊘",
  paused: "Ⅱ"
}

const TERMINAL_NODE_STATUSES = new Set<NodeStatus>(["completed", "skipped", "failed", "cancelled"])

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

export function runtimeDependencyIds(state: RunState, node: NodeRunState): readonly string[] {
  return runtimeNeeds(state, node, repeatByTemplate(state))
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
  if (state.status === "completed" || state.status === "failed" || state.status === "stopped") {
    return []
  }
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

  const condition: ConditionAttention[] =
    state.pause?.kind !== "condition"
      ? []
      : [
          {
            kind: "condition",
            title: "Condition contract needs revision",
            detail: state.pause.message,
            command: null
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
        title: `${node?.title ?? hold.target}: ${node?.status === "completed" || node?.status === "skipped" ? `${node.status}; ` : ""}downstream held`,
        detail:
          "Release the hold to allow dependents to proceed; the terminal outcome is unchanged.",
        command: `orchestrate release ${state.id} ${hold.target}`
      }
    })

  const workrooms: WorkroomAttention[] = Object.values(state.workrooms).flatMap((workroom) =>
    workroom.status !== "active"
      ? []
      : Object.values(workroom.seats).flatMap((seat) =>
          seat.status !== "attention"
            ? []
            : [
                {
                  kind: "workroom" as const,
                  workroomId: workroom.id,
                  seatId: seat.id,
                  title: `${workroom.id}: seat ${seat.id} needs occupancy attention`,
                  detail: "Inspect or repair the workroom tab, then reconcile the planned seat.",
                  command: `orchestrate reconcile ${state.id}`
                }
              ]
        )
  )

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

  return [
    ...gates,
    ...revisions,
    ...fuse,
    ...condition,
    ...maxRounds,
    ...downstreamHeld,
    ...workrooms,
    ...stalled
  ]
}

function repeatConditionText(condition: RepeatCondition): string {
  if (condition.type === "command-success") {
    return `until ${condition.node} succeeds`
  }
  const field = condition.pointer.replace(/^\//, "").replaceAll("/", ".")
  return `until ${condition.node} reports ${field.length === 0 ? "its result" : field} = ${JSON.stringify(condition.equals)}`
}

interface ParsedUnrolledRound {
  readonly id: string
  readonly normalizedId: string
  readonly round: number
  readonly authoredIndex: number
}

interface UnrolledRoundGroup {
  readonly key: string
  readonly label: string
  readonly normalizedIds: readonly string[]
  readonly rounds: readonly number[]
  readonly members: readonly ParsedUnrolledRound[]
}

function parseUnrolledRoundId(id: string, authoredIndex: number): ParsedUnrolledRound | null {
  const segments = id.split("-")
  let parsed: {
    readonly index: number
    readonly prefix: string
    readonly marker: string
    readonly round: number
  } | null = null
  for (const [index, segment] of segments.entries()) {
    const match = /^(.*?)(r(?:ound)?)([1-9][0-9]*)$/.exec(segment)
    if (match === null) {
      continue
    }
    const prefix = match[1] ?? ""
    const marker = match[2] ?? ""
    // Avoid treating ordinary ids such as "server1" as round notation. The
    // compact s1r1 form is accepted because the prefix itself ends in a digit.
    if (marker !== "round" && prefix.length > 0 && !/[0-9]$/.test(prefix)) {
      continue
    }
    if (parsed !== null) {
      return null
    }
    parsed = { index, prefix, marker, round: Number(match[3]) }
  }
  if (parsed === null) {
    return null
  }
  segments[parsed.index] = `${parsed.prefix}${parsed.marker}#`
  return { id, normalizedId: segments.join("-"), round: parsed.round, authoredIndex }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function commonPrefix(values: readonly string[]): string {
  const first = values[0] ?? ""
  let length = first.length
  for (const value of values.slice(1)) {
    while (length > 0 && !value.startsWith(first.slice(0, length))) {
      length -= 1
    }
  }
  return first.slice(0, length)
}

// Some pre-repeat workflows copied an isomorphic multi-node round several
// times so resumed provider sessions could remain explicit. Collapse only
// exact, connected copies: ids must differ by one round token, every member
// must exist in every consecutive round, and same-round dependencies must be
// identical after normalizing that token. This deliberately avoids guessing
// from titles or prompts.
function unrolledRoundGroups(
  workflowNodes: readonly WorkflowNode[]
): readonly UnrolledRoundGroup[] {
  const parsed = workflowNodes.flatMap((node, index) => {
    const value = parseUnrolledRoundId(node.id, index)
    return value === null ? [] : [value]
  })
  const parsedById = new Map(parsed.map((value) => [value.id, value]))
  const nodesById = new Map(workflowNodes.map((node) => [node.id, node]))
  const buckets = new Map<string, ParsedUnrolledRound[]>()
  for (const value of parsed) {
    const bucket = buckets.get(value.normalizedId) ?? []
    bucket.push(value)
    buckets.set(value.normalizedId, bucket)
  }
  const candidateKeys = new Set(
    [...buckets]
      .filter(([, members]) => {
        const rounds = [...new Set(members.map((member) => member.round))].toSorted(
          (left, right) => left - right
        )
        return (
          rounds.length >= 2 &&
          rounds.every((round, index) => index === 0 || round === (rounds[index - 1] ?? 0) + 1)
        )
      })
      .map(([key]) => key)
  )
  const adjacent = new Map([...candidateKeys].map((key) => [key, new Set<string>()]))
  for (const value of parsed) {
    if (!candidateKeys.has(value.normalizedId)) {
      continue
    }
    const node = nodesById.get(value.id)
    for (const dependency of node?.needs ?? []) {
      const parsedDependency = parsedById.get(dependency)
      if (
        parsedDependency === undefined ||
        parsedDependency.round !== value.round ||
        !candidateKeys.has(parsedDependency.normalizedId) ||
        parsedDependency.normalizedId === value.normalizedId
      ) {
        continue
      }
      adjacent.get(value.normalizedId)?.add(parsedDependency.normalizedId)
      adjacent.get(parsedDependency.normalizedId)?.add(value.normalizedId)
    }
  }

  const seen = new Set<string>()
  const groups: UnrolledRoundGroup[] = []
  for (const start of candidateKeys) {
    if (seen.has(start)) {
      continue
    }
    const pending = [start]
    const component: string[] = []
    while (pending.length > 0) {
      const key = pending.pop()
      if (key === undefined || seen.has(key)) {
        continue
      }
      seen.add(key)
      component.push(key)
      pending.push(...(adjacent.get(key) ?? []))
    }
    if (component.length < 2) {
      continue
    }
    component.sort(
      (left, right) =>
        (buckets.get(left)?.[0]?.authoredIndex ?? 0) - (buckets.get(right)?.[0]?.authoredIndex ?? 0)
    )
    const rounds = [
      ...new Set((buckets.get(component[0] ?? "") ?? []).map((item) => item.round))
    ].toSorted((left, right) => left - right)
    if (
      !component.every((key) => {
        const memberRounds = [
          ...new Set((buckets.get(key) ?? []).map((item) => item.round))
        ].toSorted((left, right) => left - right)
        return sameNumbers(rounds, memberRounds)
      })
    ) {
      continue
    }
    const componentSet = new Set(component)
    const dependencyShapesMatch = component.every((key) => {
      const signatures = (buckets.get(key) ?? []).map((member) =>
        (nodesById.get(member.id)?.needs ?? [])
          .flatMap((dependency) => {
            const parsedDependency = parsedById.get(dependency)
            return parsedDependency !== undefined &&
              parsedDependency.round === member.round &&
              componentSet.has(parsedDependency.normalizedId)
              ? [parsedDependency.normalizedId]
              : []
          })
          .toSorted()
          .join("\n")
      )
      return signatures.every((signature) => signature === signatures[0])
    })
    if (!dependencyShapesMatch) {
      continue
    }
    const prefix = commonPrefix(component)
    const roundMarker = prefix.lastIndexOf("r#")
    const label = (roundMarker < 0 ? prefix : prefix.slice(0, roundMarker)).replace(/[-_.]+$/, "")
    groups.push({
      key: component.join("|"),
      label: label.length === 0 ? "rounds" : label,
      normalizedIds: component,
      rounds,
      members: component
        .flatMap((key) => buckets.get(key) ?? [])
        .toSorted((left, right) => left.authoredIndex - right.authoredIndex)
    })
  }
  return groups.toSorted(
    (left, right) => (left.members[0]?.authoredIndex ?? 0) - (right.members[0]?.authoredIndex ?? 0)
  )
}

function schemaRequiresDone(node: WorkflowNode | undefined): boolean {
  if (node?.type !== "agent" || node.output.format !== "json" || node.output.schema === null) {
    return false
  }
  const required = node.output.schema["required"]
  return Array.isArray(required) && required.includes("done")
}

function visibleRows(
  nodes: readonly BoardNodeView[],
  repeats: readonly RepeatSpec[],
  workflowNodes: readonly WorkflowNode[]
): readonly BoardRow[] {
  const rows: BoardRow[] = []
  const emittedHistory = new Set<string>()
  const emittedRounds = new Set<string>()
  const repeatMembers = new Map(
    [...new Set(nodes.flatMap((node) => (node.repeatId === null ? [] : [node.repeatId])))].map(
      (repeatId) => [repeatId, nodes.filter((node) => node.repeatId === repeatId)] as const
    )
  )
  const manualGroups = unrolledRoundGroups(workflowNodes)
  const manualByMember = new Map(
    manualGroups.flatMap((group) => group.members.map((member) => [member.id, group] as const))
  )
  const workflowById = new Map(workflowNodes.map((node) => [node.id, node]))
  const activeManualRounds = new Map(
    manualGroups.map((group) => {
      const active =
        group.rounds.find((round) =>
          group.members
            .filter((member) => member.round === round)
            .some((member) => {
              const status = nodes.find((node) => node.id === member.id)?.status
              return status !== "completed" && status !== "skipped"
            })
        ) ??
        group.rounds.at(-1) ??
        1
      return [group.key, active] as const
    })
  )
  const lastActiveManualMember = new Map(
    manualGroups.map((group) => {
      const active = activeManualRounds.get(group.key)
      const ids = group.members
        .filter((member) => member.round === active)
        .map((member) => member.id)
      return [group.key, nodes.findLast((node) => ids.includes(node.id))?.id ?? ids.at(-1)] as const
    })
  )
  for (const node of nodes) {
    const manualGroup = manualByMember.get(node.id)
    if (manualGroup !== undefined) {
      const activeRound = activeManualRounds.get(manualGroup.key)
      const member = manualGroup.members.find((candidate) => candidate.id === node.id)
      if (member?.round !== activeRound) {
        continue
      }
      rows.push({ kind: "node", key: node.id, depth: 1, node })
      if (lastActiveManualMember.get(manualGroup.key) === node.id) {
        const firstRound = manualGroup.rounds[0] ?? activeRound ?? 1
        const firstRoundMembers = manualGroup.members.filter(
          (candidate) => candidate.round === firstRound
        )
        const firstRoundIds = new Set(firstRoundMembers.map((candidate) => candidate.id))
        const backTo = firstRoundMembers
          .filter(
            (candidate) =>
              !(workflowById.get(candidate.id)?.needs ?? []).some((dependency) =>
                firstRoundIds.has(dependency)
              )
          )
          .map((candidate) => candidate.id)
        const verdict = firstRoundMembers.find((candidate) =>
          schemaRequiresDone(workflowById.get(candidate.id))
        )
        rows.push({
          kind: "unrolled-repeat",
          key: `${manualGroup.key}:loop`,
          depth: 1,
          label: manualGroup.label,
          round: activeRound ?? firstRound,
          maxRounds: manualGroup.rounds.at(-1) ?? firstRound,
          until: verdict === undefined ? null : `until ${verdict.id} reports done = true`,
          backTo
        })
      }
      continue
    }
    if (node.repeatId === null || node.round === null || node.currentRound) {
      const exitsManualGroup = node.needs.some((dependency) => manualByMember.has(dependency))
      rows.push({ kind: "node", key: node.id, depth: exitsManualGroup ? 0 : node.depth, node })
      if (node.repeatId !== null && node.round !== null) {
        const members = repeatMembers.get(node.repeatId) ?? []
        const currentMembers = members.filter((candidate) => candidate.currentRound)
        if (currentMembers.at(-1)?.id === node.id && !emittedRounds.has(node.repeatId)) {
          emittedRounds.add(node.repeatId)
          const spec = repeats.find((candidate) => candidate.id === node.repeatId)
          const currentIds = new Set(currentMembers.map((candidate) => candidate.id))
          rows.push({
            kind: "repeat-round",
            key: `${node.repeatId}:round`,
            depth: Math.min(...members.map((candidate) => candidate.depth)),
            repeatId: node.repeatId,
            round: node.round,
            maxRounds: spec?.maxRounds ?? null,
            until: spec === undefined ? null : repeatConditionText(spec.until),
            backTo: currentMembers
              .filter(
                (candidate) => !candidate.needs.some((dependency) => currentIds.has(dependency))
              )
              .map((candidate) => candidate.templateId)
          })
        }
      }
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
      skip: node.skip ?? null,
      stalledPane: stalledPane(state, node, options.paneGarnish?.[node.id])
    }
  })
  const rows = visibleRows(nodes, options.repeats ?? [], options.workflowNodes ?? [])
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
    if (
      selected === undefined ||
      model.run.status === "completed" ||
      model.run.status === "failed" ||
      model.run.status === "stopped"
    ) {
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
