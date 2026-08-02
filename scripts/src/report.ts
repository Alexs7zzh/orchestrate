import { readFile } from "node:fs/promises"
import path from "node:path"

import type {
  EventRecord,
  NodeStatus,
  NodeType,
  RunState,
  RunStatus,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

import { eventsPath, readJson, workflowPath } from "./state.js"

const RESULT_SUMMARY_HEAD_LINES = 15
const RESULT_SUMMARY_TAIL_LINES = 5
const RESULT_SUMMARY_MAX_LINE_LENGTH = 200

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set([
  "starting",
  "running",
  "pausing",
  "stopping"
])

export interface ReportGoalRounds {
  readonly supervisorId: string
  readonly used: number
  readonly max: number | null
}

export interface ReportRun {
  readonly id: string
  readonly workflowName: string
  readonly objective: string
  readonly status: RunStatus
  readonly workerAlive: boolean
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly updatedAt: string
  readonly elapsedSeconds: number
  readonly error: string | null
  readonly pauseReason: string | null
  readonly pauseCode: string | null
  readonly limits: {
    readonly agentStarts: { readonly used: number; readonly max: number | null }
    readonly goalRounds: readonly ReportGoalRounds[]
  }
  readonly notes: readonly string[]
}

export interface ReportAttention {
  readonly kind:
    | "pending-patch"
    | "pending-input"
    | "pending-revision"
    | "pending-gate"
    | "awaiting-interactive"
    | "limit"
    | "emergency-fuse"
    | "paused"
    | "failed"
    | "stale-worker"
  readonly summary: string
  readonly detail: string | null
  readonly digest: string | null
  readonly resumeCommand: string | null
}

export interface ReportNode {
  readonly id: string
  readonly title: string
  readonly type: NodeType | null
  readonly provider: string | null
  readonly model: string | null
  readonly effort: string | null
  readonly status: NodeStatus
  readonly attempts: number
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly durationSeconds: number | null
  readonly exitCode: number | null
  readonly error: string | null
  readonly resultPath: string | null
  readonly resultSummary: readonly string[] | null
  readonly resultLinesOmitted: number
  readonly resultCommand: string | null
  readonly note: string | null
}

export interface ReportSupervisorRound {
  readonly supervisorId: string
  readonly round: number
  readonly decision: "continue" | "complete" | "pause"
  readonly reason: string | null
  readonly addedNodes: readonly { readonly id: string; readonly title: string }[]
}

export interface RunReport {
  readonly run: ReportRun
  readonly needsAttention: readonly ReportAttention[]
  readonly nodes: readonly ReportNode[]
  readonly supervisorRounds: readonly ReportSupervisorRound[]
}

export function topologicalRows(nodes: readonly WorkflowNode[]): readonly WorkflowNode[] {
  const remaining = new Map(nodes.map((node) => [node.id, node]))
  const emitted = new Set<string>()
  const ordered: WorkflowNode[] = []
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((node) => node.needs.every((dependency) => emitted.has(dependency)))
      .toSorted((a, b) => a.id.localeCompare(b.id))
    if (ready.length === 0) {
      ordered.push(...remaining.values())
      break
    }
    for (const node of ready) {
      ordered.push(node)
      emitted.add(node.id)
      remaining.delete(node.id)
    }
  }
  return ordered
}

export function modelLabel(node: WorkflowNode): string {
  if (node.type === "command") {
    return "command"
  }
  return `${node.provider}/${node.model}${node.effort === null ? "" : ` (${node.effort})`}`
}

// The specific pause codes that resume accepts --override-limit for. Report
// and resume must agree so the override command the report prints is the one
// that actually works.
export function isLimitPauseCode(code: string | null): boolean {
  return (
    code === "workflow-wall-time" ||
    code === "max-agent-starts" ||
    code?.startsWith("goal-rounds:") === true ||
    code?.startsWith("goal-wall-time:") === true
  )
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m`
  }
  if (minutes > 0) {
    return `${minutes}m${String(rest).padStart(2, "0")}s`
  }
  return `${rest}s`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function secondsBetween(startIso: string | null, endIso: string | null): number | null {
  if (startIso === null) {
    return null
  }
  const start = Date.parse(startIso)
  const end = endIso === null ? Date.now() : Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null
  }
  return Math.max(0, Math.round((end - start) / 1000))
}

// First ~15 and last ~5 lines with an explicit omission marker so no report
// surface ever inlines an unbounded node result.
export function boundedResultSummary(
  content: string,
  resultCommand: string
): { readonly lines: readonly string[]; readonly omitted: number } {
  const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content
  const all =
    trimmed.length === 0
      ? []
      : trimmed
          .split("\n")
          .map((line) =>
            line.length > RESULT_SUMMARY_MAX_LINE_LENGTH
              ? `${line.slice(0, RESULT_SUMMARY_MAX_LINE_LENGTH)}…`
              : line
          )
  if (all.length <= RESULT_SUMMARY_HEAD_LINES + RESULT_SUMMARY_TAIL_LINES) {
    return { lines: all, omitted: 0 }
  }
  const omitted = all.length - RESULT_SUMMARY_HEAD_LINES - RESULT_SUMMARY_TAIL_LINES
  return {
    lines: [
      ...all.slice(0, RESULT_SUMMARY_HEAD_LINES),
      `… (${omitted} lines omitted, see: ${resultCommand})`,
      ...all.slice(-RESULT_SUMMARY_TAIL_LINES)
    ],
    omitted
  }
}

async function readEventRecords(runDir: string): Promise<{
  readonly events: readonly EventRecord[]
  readonly note: string | null
}> {
  let raw: string
  try {
    raw = await readFile(eventsPath(runDir), "utf8")
  } catch (error) {
    return {
      events: [],
      note: `events.jsonl is unreadable (${errorMessage(error)}); supervisor rounds may be incomplete.`
    }
  }
  const events: EventRecord[] = []
  for (const line of raw.split("\n")) {
    const candidate = line.trim()
    if (candidate.length === 0) {
      continue
    }
    try {
      events.push(JSON.parse(candidate) as EventRecord)
    } catch {
      // A torn or damaged journal line is skipped; the rest still renders.
    }
  }
  return { events, note: null }
}

function supervisorRoundsFromEvents(
  events: readonly EventRecord[],
  supervisorIds: ReadonlySet<string>,
  definitions: ReadonlyMap<string, WorkflowNode>
): readonly ReportSupervisorRound[] {
  const counters = new Map<string, number>()
  const nextRound = (supervisorId: string): number => {
    const round = (counters.get(supervisorId) ?? 0) + 1
    counters.set(supervisorId, round)
    return round
  }
  const rounds: ReportSupervisorRound[] = []
  for (const event of events) {
    if (event.type === "goal.expanded" && typeof event.nodeId === "string") {
      const dataNodes = (event.data as { readonly nodes?: unknown } | undefined)?.nodes
      const addedIds = Array.isArray(dataNodes)
        ? dataNodes.filter((id): id is string => typeof id === "string")
        : []
      const reason = /^Supervisor "[^"]*" added \d+ nodes?: ([\s\S]*)$/.exec(event.message)?.[1]
      rounds.push({
        supervisorId: event.nodeId,
        round: nextRound(event.nodeId),
        decision: "continue",
        reason: reason ?? null,
        addedNodes: addedIds.map((id) => ({ id, title: definitions.get(id)?.title ?? id }))
      })
      continue
    }
    if (
      event.type === "node.completed" &&
      typeof event.nodeId === "string" &&
      supervisorIds.has(event.nodeId)
    ) {
      rounds.push({
        supervisorId: event.nodeId,
        round: nextRound(event.nodeId),
        decision: "complete",
        reason: null,
        addedNodes: []
      })
      continue
    }
    if (event.type === "run.pausing") {
      const match = /^Supervisor "([^"]+)" requested input: ([\s\S]*)$/.exec(event.message)
      if (match !== null && supervisorIds.has(match[1] as string)) {
        rounds.push({
          supervisorId: match[1] as string,
          round: nextRound(match[1] as string),
          decision: "pause",
          reason: match[2] as string,
          addedNodes: []
        })
      }
    }
  }
  return rounds
}

function effectiveMaxRounds(
  workflow: WorkflowSpec | null,
  definition: WorkflowNode | undefined
): number | null {
  const limits = [
    workflow?.limits.maxGoalRounds ?? null,
    definition?.type === "supervisor" ? definition.termination.maxRounds : null
  ].filter((value): value is number => value !== null)
  return limits.length === 0 ? null : Math.min(...limits)
}

// Never includes env values, webhook headers, or full patch decisions —
// only ids, titles, digests, and reasons — so a report cannot leak anything
// preview redacts. The node-done token IS included deliberately: the human
// reading the report is the legitimate operator and the report shares the
// state file's trust domain; the token only guards other contexts.
function attentionItems(
  state: RunState,
  workerAlive: boolean,
  runDir: string
): readonly ReportAttention[] {
  const items: ReportAttention[] = []
  if (state.pendingPatch !== null) {
    const added = state.pendingPatch.decision.addNodes
    items.push({
      kind: "pending-patch",
      summary: `Pending adaptive patch from "${state.pendingPatch.supervisorId}" (${added.length} node${added.length === 1 ? "" : "s"}): ${state.pendingPatch.decision.reason}`,
      detail: [
        ...state.pendingPatch.reasons,
        ...(added.length === 0
          ? []
          : [`Adds: ${added.map((node) => `${node.id} "${node.title}"`).join(", ")}`])
      ].join("\n"),
      digest: state.pendingPatch.digest,
      resumeCommand: `orchestrate resume ${state.id} --approve-patch ${state.pendingPatch.digest}`
    })
  }
  if (state.pendingInput !== null) {
    items.push({
      kind: "pending-input",
      summary: `Supervisor "${state.pendingInput.supervisorId}" needs a response.`,
      detail: state.pendingInput.reason,
      digest: state.pendingInput.digest,
      resumeCommand: `orchestrate resume ${state.id} --respond "<answer>" --input-digest ${state.pendingInput.digest}`
    })
  }
  const pendingRevision = state.pendingRevision ?? null
  if (pendingRevision !== null) {
    items.push({
      kind: "pending-revision",
      summary:
        "A human workflow revision of the remaining plan awaits digest-bound approval (or discard it with: " +
        `orchestrate revise ${state.id} --discard).`,
      detail: pendingRevision.summary.join("\n"),
      digest: pendingRevision.digest,
      resumeCommand: `orchestrate resume ${state.id} --approve-revision ${pendingRevision.digest}`
    })
  }
  if (state.pendingGate !== null) {
    // Rendered gate content is user-authored prompt plus completed node
    // results — safe to show — but it is bounded here like every other
    // result surface; the full text lives in state.json.
    const bounded = boundedResultSummary(
      state.pendingGate.content,
      `orchestrate status ${state.id} --json`
    )
    items.push({
      kind: "pending-gate",
      summary: `Node "${state.pendingGate.nodeId}" ("${state.pendingGate.title}") is gated; approve its rendered content to run it.`,
      detail: [
        "Rendered content the node will run with:",
        ...bounded.lines,
        `Full text: orchestrate status ${state.id} --json (pendingGate.content)`
      ].join("\n"),
      digest: state.pendingGate.digest,
      resumeCommand: `orchestrate resume ${state.id} --approve-gate ${state.pendingGate.nodeId} --gate-digest ${state.pendingGate.digest}`
    })
  }
  for (const node of Object.values(state.nodes)) {
    const record = node.interactive ?? null
    if (node.status !== "running" || record === null) {
      continue
    }
    const elapsed = secondsBetween(record.startedAt, null) ?? 0
    items.push({
      kind: "awaiting-interactive",
      summary: `Node "${node.id}" runs as a live interactive TUI (herdr pane ${record.paneId ?? "(opening)"}) and waits for its node-done call.`,
      detail: [
        `Attempt ${record.attempt}, running ${formatDuration(elapsed)}.`,
        ...(record.idleSince === null
          ? []
          : [
              `Looks idle since ${record.idleSince} with no node-done call; a human can join the pane and finish it.`
            ]),
        `Result report path: ${path.join(runDir, "nodes", node.id, `attempt-${record.attempt}`, "result.txt")}`
      ].join("\n"),
      digest: null,
      resumeCommand: `orchestrate node-done ${state.id} ${node.id} --token ${record.token} --outcome completed`
    })
  }
  if (state.status === "paused" || state.status === "pausing") {
    if (isLimitPauseCode(state.pauseCode)) {
      items.push({
        kind: "limit",
        summary: `Paused at approved limit "${state.pauseCode}".`,
        detail: state.pauseReason,
        digest: null,
        resumeCommand: `orchestrate resume ${state.id} --override-limit`
      })
    } else if (state.pauseCode === "emergency-fuse") {
      items.push({
        kind: "emergency-fuse",
        summary: "Paused at the emergency process-start fuse.",
        detail: state.pauseReason,
        digest: null,
        resumeCommand: `orchestrate resume ${state.id} --override-emergency-fuse`
      })
    } else if (
      state.pendingPatch === null &&
      state.pendingInput === null &&
      state.pendingGate === null &&
      pendingRevision === null
    ) {
      items.push({
        kind: "paused",
        summary: `Run is ${state.status}.`,
        detail: state.pauseReason,
        digest: null,
        resumeCommand: `orchestrate resume ${state.id}`
      })
    }
  }
  if (state.status === "failed") {
    items.push({
      kind: "failed",
      summary: "Run failed.",
      detail: state.error,
      digest: null,
      resumeCommand: null
    })
  }
  if (ACTIVE_STATUSES.has(state.status) && state.pid !== null && !workerAlive) {
    items.push({
      kind: "stale-worker",
      summary: `Run is ${state.status} but its recorded worker is not alive.`,
      detail: null,
      digest: null,
      resumeCommand: `orchestrate resume ${state.id} --recover`
    })
  }
  return items
}

export async function buildRunReport(
  runDir: string,
  state: RunState,
  workerAlive: boolean
): Promise<RunReport> {
  const notes: string[] = []
  let workflow: WorkflowSpec | null = null
  try {
    workflow = await readJson<WorkflowSpec>(workflowPath(runDir))
  } catch (error) {
    notes.push(
      `workflow.json is unreadable (${errorMessage(error)}); node titles, models, and limits are incomplete.`
    )
  }
  const definitions = new Map<string, WorkflowNode>(
    [...(workflow?.nodes ?? []), ...state.dynamicNodes].map((node) => [node.id, node])
  )
  const orderedIds = [
    ...topologicalRows([...definitions.values()]).map((node) => node.id),
    ...Object.keys(state.nodes)
      .filter((id) => !definitions.has(id))
      .toSorted()
  ]

  const nodes: ReportNode[] = []
  for (const id of orderedIds) {
    const definition = definitions.get(id)
    const nodeState = state.nodes[id]
    const resultPath = nodeState?.resultPath ?? null
    const resultCommand = resultPath === null ? null : `orchestrate result ${state.id} ${id}`
    let resultSummary: readonly string[] | null = null
    let resultLinesOmitted = 0
    let note: string | null = null
    if (resultPath !== null) {
      try {
        const summary = boundedResultSummary(
          await readFile(resultPath, "utf8"),
          resultCommand as string
        )
        resultSummary = summary.lines
        resultLinesOmitted = summary.omitted
      } catch (error) {
        note = `result file is unreadable at ${resultPath} (${errorMessage(error)})`
      }
    }
    if (nodeState === undefined) {
      note = "no recorded node state"
    }
    const agentDefinition =
      definition !== undefined && definition.type !== "command" ? definition : null
    nodes.push({
      id,
      title: definition?.title ?? id,
      type: definition?.type ?? null,
      provider: agentDefinition === null ? null : agentDefinition.provider,
      model: agentDefinition === null ? null : agentDefinition.model,
      effort: agentDefinition === null ? null : agentDefinition.effort,
      status: nodeState?.status ?? "pending",
      attempts: nodeState?.attempts ?? 0,
      startedAt: nodeState?.startedAt ?? null,
      finishedAt: nodeState?.finishedAt ?? null,
      durationSeconds: secondsBetween(nodeState?.startedAt ?? null, nodeState?.finishedAt ?? null),
      exitCode: nodeState?.exitCode ?? null,
      error: nodeState?.error ?? null,
      resultPath,
      resultSummary,
      resultLinesOmitted,
      resultCommand,
      note
    })
  }

  const supervisorIds = new Set<string>([
    ...[...definitions.values()]
      .filter((node) => node.type === "supervisor")
      .map((node) => node.id),
    ...Object.keys(state.goalRounds),
    ...Object.keys(state.supervisorStartedAt),
    ...Object.keys(state.supervisorBarriers)
  ])
  const { events, note: eventsNote } = await readEventRecords(runDir)
  if (eventsNote !== null) {
    notes.push(eventsNote)
  }
  const supervisorRounds = supervisorRoundsFromEvents(events, supervisorIds, definitions)

  return {
    run: {
      id: state.id,
      workflowName: state.workflowName,
      objective: state.objective,
      status: state.status,
      workerAlive,
      createdAt: state.createdAt,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      updatedAt: state.updatedAt,
      elapsedSeconds: secondsBetween(state.startedAt ?? state.createdAt, state.finishedAt) ?? 0,
      error: state.error,
      pauseReason: state.pauseReason,
      pauseCode: state.pauseCode,
      limits: {
        agentStarts: { used: state.agentStarts, max: workflow?.limits.maxAgentStarts ?? null },
        goalRounds: [...supervisorIds].toSorted().map((supervisorId) => ({
          supervisorId,
          used: state.goalRounds[supervisorId] ?? 0,
          max: effectiveMaxRounds(workflow, definitions.get(supervisorId))
        }))
      },
      notes
    },
    needsAttention: attentionItems(state, workerAlive, runDir),
    nodes,
    supervisorRounds
  }
}

const NODE_GROUP_ORDER: readonly NodeStatus[] = [
  "running",
  "failed",
  "completed",
  "cancelled",
  "pending"
]

const ATTENTION_COMMAND_LABELS: Readonly<Record<ReportAttention["kind"], string>> = {
  "pending-patch": "Approve",
  "pending-input": "Respond",
  "pending-revision": "Approve",
  "pending-gate": "Approve",
  "awaiting-interactive": "Complete",
  limit: "Override",
  "emergency-fuse": "Override",
  paused: "Resume",
  failed: "Resume",
  "stale-worker": "Recover"
}

function usageLabel(used: number, max: number | null): string {
  return max === null ? `${used} (unbounded)` : `${used} of ${max}`
}

function nodeLine(node: ReportNode): string {
  const kind =
    node.type === null
      ? "unknown"
      : node.type === "command"
        ? "command"
        : `${node.type} ${node.provider}/${node.model}${node.effort === null ? "" : ` (${node.effort})`}`
  const parts = [`${node.id} "${node.title}"`, kind, `attempts: ${node.attempts}`]
  if (node.durationSeconds !== null) {
    parts.push(
      node.status === "running"
        ? `running ${formatDuration(node.durationSeconds)}`
        : formatDuration(node.durationSeconds)
    )
  }
  return parts.join(" | ")
}

export function runReportText(report: RunReport): string {
  const { run } = report
  const staleWorker = report.needsAttention.some((item) => item.kind === "stale-worker")
  const lines: string[] = [
    `Run: ${run.id}`,
    `Workflow: ${run.workflowName}`,
    `Objective: ${run.objective}`,
    `Status: ${run.status}${staleWorker ? " (worker not alive)" : ""}`,
    `Started: ${run.startedAt ?? `${run.createdAt} (created)`}`,
    `Updated: ${run.updatedAt}`,
    `Elapsed: ${formatDuration(run.elapsedSeconds)}`,
    `Agent starts: ${usageLabel(run.limits.agentStarts.used, run.limits.agentStarts.max)}`
  ]
  if (run.limits.goalRounds.length > 0) {
    lines.push(
      `Goal rounds: ${run.limits.goalRounds
        .map((entry) => `${entry.supervisorId} ${usageLabel(entry.used, entry.max)}`)
        .join(", ")}`
    )
  }
  for (const note of run.notes) {
    lines.push(`Note: ${note}`)
  }

  if (report.needsAttention.length > 0) {
    lines.push("", "Needs attention:")
    for (const item of report.needsAttention) {
      lines.push(`  ${item.summary}`)
      if (item.detail !== null && item.detail.length > 0) {
        for (const detailLine of item.detail.split("\n")) {
          lines.push(`    ${detailLine}`)
        }
      }
      if (item.digest !== null) {
        lines.push(`    Digest: ${item.digest}`)
      }
      if (item.resumeCommand !== null) {
        lines.push(`    ${ATTENTION_COMMAND_LABELS[item.kind]}: ${item.resumeCommand}`)
      }
    }
  }

  lines.push("", "Nodes:")
  if (report.nodes.length === 0) {
    lines.push("  none")
  }
  for (const status of NODE_GROUP_ORDER) {
    const group = report.nodes.filter((node) => node.status === status)
    if (group.length === 0) {
      continue
    }
    lines.push(`  ${status}:`)
    for (const node of group) {
      lines.push(`    ${nodeLine(node)}`)
      if (node.error !== null) {
        lines.push(`      error: ${node.error}`)
      }
      if (node.note !== null) {
        lines.push(`      note: ${node.note}`)
      }
      if (node.resultSummary !== null) {
        for (const summaryLine of node.resultSummary) {
          lines.push(`      | ${summaryLine}`)
        }
      }
    }
  }

  if (run.limits.goalRounds.length > 0) {
    lines.push("", "Supervisor rounds:")
    if (report.supervisorRounds.length === 0) {
      lines.push("  none recorded yet")
    }
    for (const round of report.supervisorRounds) {
      lines.push(
        `  ${round.supervisorId} round ${round.round}: ${round.decision}${
          round.reason === null ? "" : ` — ${round.reason}`
        }`
      )
      if (round.addedNodes.length > 0) {
        lines.push(
          `    added: ${round.addedNodes.map((node) => `${node.id} "${node.title}"`).join(", ")}`
        )
      }
    }
  }

  lines.push(
    "",
    `Follow up: orchestrate watch ${run.id} | orchestrate wait ${run.id} | orchestrate result ${run.id} <node-id>`
  )
  return lines.join("\n")
}
