import type { RunState, WorkflowNode, WorkflowSpec } from "./types.js"

type WorkroomSpec = NonNullable<WorkflowSpec["presentation"]>["workrooms"][number]
type SeatSpec = WorkroomSpec["seats"][number]

export function workroomSpecFor(
  workflow: WorkflowSpec,
  workroomId: string
): WorkroomSpec | undefined {
  return workflow.presentation?.workrooms.find((candidate) => candidate.id === workroomId)
}

export function seatSpecFor(
  workflow: WorkflowSpec,
  workroomId: string,
  seatId: string
): SeatSpec | undefined {
  return workroomSpecFor(workflow, workroomId)?.seats.find((candidate) => candidate.id === seatId)
}

export function templateForRuntimeNode(
  workflow: WorkflowSpec,
  state: RunState,
  runtimeId: string
): WorkflowNode {
  const templateId = state.nodes[runtimeId]?.templateId
  const template = workflow.nodes.find((candidate) => candidate.id === templateId)
  if (template === undefined) {
    throw new Error(`Runtime node "${runtimeId}" has no workflow template.`)
  }
  return template
}
