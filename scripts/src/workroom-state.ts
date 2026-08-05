import type { AttemptState, NodeRunState, RunState, WorkflowSpec } from "./types.js"

const RELEASING_NODE_STATUSES = new Set(["completed", "skipped"])

function nodeTemplate(workflow: WorkflowSpec, node: NodeRunState) {
  return workflow.nodes.find((candidate) => candidate.id === node.templateId)
}

export function initialWorkrooms(workflow: WorkflowSpec): RunState["workrooms"] {
  return Object.fromEntries(
    (workflow.presentation?.workrooms ?? []).map((workroom) => [
      workroom.id,
      {
        id: workroom.id,
        status: "pending" as const,
        workspaceId: null,
        tabId: null,
        seats: Object.fromEntries(
          workroom.seats.map((seat) => [
            seat.id,
            {
              id: seat.id,
              status: "empty" as const,
              nodeId: null,
              pane: null
            }
          ])
        )
      }
    ])
  )
}

export function updateWorkroomSeat(
  state: RunState,
  workflow: WorkflowSpec,
  node: NodeRunState,
  status: "empty" | "running" | "parked" | "attention",
  pane?: AttemptState["pane"]
): RunState {
  const template = nodeTemplate(workflow, node)
  if (template?.workroom === undefined || template.seat === undefined) {
    return state
  }
  const workroom = state.workrooms[template.workroom]
  const seat = workroom?.seats[template.seat]
  if (workroom === undefined || seat === undefined) {
    throw new Error(
      `Node "${node.id}" cannot resolve seat "${template.seat}" in workroom "${template.workroom}".`
    )
  }
  const nextPane = pane === undefined ? seat.pane : pane
  return {
    ...state,
    workrooms: {
      ...state.workrooms,
      [workroom.id]: {
        ...workroom,
        status:
          workroom.status === "settled"
            ? "settled"
            : status === "empty" && workroom.status === "pending"
              ? "pending"
              : "active",
        workspaceId: nextPane?.workspaceId ?? workroom.workspaceId,
        tabId: nextPane?.tabId ?? workroom.tabId,
        seats: {
          ...workroom.seats,
          [seat.id]: {
            ...seat,
            status,
            nodeId: status === "empty" ? null : node.id,
            pane: nextPane
          }
        }
      }
    }
  }
}

export function updateWorkroomSeatAfterFailure(
  state: RunState,
  workflow: WorkflowSpec,
  node: NodeRunState,
  clearPane: boolean
): RunState {
  const template = nodeTemplate(workflow, node)
  if (template?.workroom === undefined || template.seat === undefined) {
    return state
  }
  const workroom = state.workrooms[template.workroom]
  const seat = workroom?.seats[template.seat]
  if (workroom === undefined || seat === undefined) {
    throw new Error(
      `Node "${node.id}" cannot resolve seat "${template.seat}" in workroom "${template.workroom}".`
    )
  }
  const pane = clearPane ? null : seat.pane
  return updateWorkroomSeat(state, workflow, node, pane === null ? "empty" : "parked", pane)
}

export function refreshWorkroomSettlement(state: RunState, workflow: WorkflowSpec): RunState {
  let updated: Record<string, RunState["workrooms"][string]> | null = null
  for (const spec of workflow.presentation?.workrooms ?? []) {
    const workroom = (updated ?? state.workrooms)[spec.id]
    if (workroom === undefined || workroom.status === "settled" || workroom.status === "aborted") {
      continue
    }
    if (
      !spec.settlesOn.every((id) => {
        const anchor = state.nodes[id]
        return anchor !== undefined && RELEASING_NODE_STATUSES.has(anchor.status)
      })
    ) {
      continue
    }
    updated ??= { ...state.workrooms }
    updated[spec.id] = {
      ...workroom,
      status: "settled",
      seats: Object.fromEntries(
        Object.entries(workroom.seats).map(([id, seat]) => [
          id,
          {
            ...seat,
            status: seat.pane === null ? ("empty" as const) : ("parked" as const)
          }
        ])
      )
    }
  }
  return updated === null ? state : { ...state, workrooms: updated }
}

export function abortWorkrooms(state: RunState): RunState {
  return {
    ...state,
    workrooms: Object.fromEntries(
      Object.entries(state.workrooms).map(([id, workroom]) => [
        id,
        workroom.status === "settled"
          ? workroom
          : {
              ...workroom,
              status: "aborted" as const,
              seats: Object.fromEntries(
                Object.entries(workroom.seats).map(([seatId, seat]) => [
                  seatId,
                  {
                    ...seat,
                    status: seat.pane === null ? ("empty" as const) : ("parked" as const),
                    nodeId: seat.pane === null ? null : seat.nodeId
                  }
                ])
              )
            }
      ])
    )
  }
}
