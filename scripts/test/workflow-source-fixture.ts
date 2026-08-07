import { stringify } from "yaml"

import type { AgentNode, WorkflowNode, WorkflowSpec } from "../src/types.js"

function sourceSession(node: AgentNode): unknown {
  if (node.session.mode === "fresh") {
    return node.session.saveAs === null ? "fresh" : { fresh: node.session.saveAs }
  }
  return {
    [node.session.mode]: node.session.from,
    ...(node.session.saveAs === null ? {} : { saveAs: node.session.saveAs })
  }
}

function common(node: WorkflowNode) {
  return {
    id: node.id,
    title: node.title,
    needs: node.needs,
    ...(node.workroom === undefined ? {} : { workroom: node.workroom }),
    ...(node.seat === undefined ? {} : { seat: node.seat }),
    cwd: node.cwd,
    workspace: node.workspace,
    inputs: node.inputs,
    retry: node.retry,
    gate: node.gate,
    ...(node.when === undefined ? {} : { when: node.when })
  }
}

function sourceNode(node: WorkflowNode) {
  if (node.type === "command") {
    return {
      ...common(node),
      command: node.argv,
      mutates: node.mutates,
      inheritEnv: node.inheritEnv,
      env: node.env,
      allowedExitCodes: node.allowedExitCodes
    }
  }
  return {
    ...common(node),
    agent: node.provider,
    prompt: node.prompt,
    model: node.model,
    ...(node.effort === null ? {} : { effort: node.effort }),
    access: node.permissions.access,
    escalation: node.permissions.escalation,
    extraArgs: node.permissions.extraArgs,
    inheritEnv: node.permissions.inheritEnv,
    env: node.permissions.env,
    output:
      node.output.format === "text"
        ? { format: "text" }
        : { format: "json", schema: node.output.schema },
    session: sourceSession(node)
  }
}

export function workflowSourceYaml(workflow: WorkflowSpec): string {
  return stringify({
    name: workflow.name,
    objective: workflow.objective,
    cwd: workflow.cwd,
    concurrency: workflow.concurrency,
    callback: workflow.callback,
    milestones: workflow.milestones,
    limits: workflow.limits,
    writeConflicts: workflow.writeConflicts,
    ...(workflow.presentation === undefined ? {} : { presentation: workflow.presentation }),
    nodes: workflow.nodes.map(sourceNode),
    repeats: workflow.repeats
  })
}
