import type { NodeRunState, RunState, WorkflowNode, WorkflowSpec } from "../types.js"

function effectiveDependencies(node: WorkflowNode, state: RunState): readonly string[] {
  if (node.type !== "supervisor") {
    return node.needs
  }
  return [...node.needs, ...(state.supervisorBarriers[node.id] ?? [])]
}

function nodeResources(node: WorkflowNode, state: RunState): readonly string[] {
  const resources = [...node.workspace.exclusiveResources]
  if (node.type !== "command") {
    const lineage = (alias: string): string =>
      `session:${node.provider}:${state.sessions[alias]?.sessionId ?? alias}`
    if (node.session.mode === "resume" && node.session.from !== null) {
      resources.push(lineage(node.session.from))
    }
    // A saveAs producer claims its session lineage too: a repeated node with
    // reuseOnRepeat resumes this alias at execution time, and an unordered
    // resumer of the alias must never run concurrently with its producer.
    if (node.session.saveAs !== null) {
      resources.push(lineage(node.session.saveAs))
    }
  }
  return resources
}

export function terminalNode(status: NodeRunState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

export function selectRunnableBatch(
  nodes: readonly WorkflowNode[],
  state: RunState,
  capacity: number,
  activeNodeIds: ReadonlySet<string>
): readonly WorkflowNode[] {
  const selected: WorkflowNode[] = []
  const resources = new Set<string>()
  for (const node of nodes) {
    if (state.nodes[node.id]?.status === "running" || activeNodeIds.has(node.id)) {
      for (const resource of nodeResources(node, state)) {
        resources.add(resource)
      }
    }
  }
  for (const node of nodes) {
    if (selected.length >= capacity) {
      break
    }
    if (activeNodeIds.has(node.id)) {
      continue
    }
    const nodeState = state.nodes[node.id]
    if (nodeState?.status !== "pending") {
      continue
    }
    const dependencies = effectiveDependencies(node, state)
    if (dependencies.some((dependency) => state.nodes[dependency]?.status !== "completed")) {
      continue
    }
    const needed = nodeResources(node, state)
    if (needed.some((resource) => resources.has(resource))) {
      continue
    }
    selected.push(node)
    for (const resource of needed) {
      resources.add(resource)
    }
  }
  return selected
}

export function allWorkflowNodes(workflow: WorkflowSpec, state: RunState): readonly WorkflowNode[] {
  return [...workflow.nodes, ...state.dynamicNodes]
}
