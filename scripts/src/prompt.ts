import { createHash, randomBytes } from "node:crypto"
import path from "node:path"

import type { AgentNode, InputSpec, RunState, WorkflowNode, WorkflowSpec } from "./types.js"

import { orchestrateExecutable } from "./herdr-surface.js"
import { attemptDirectory, submissionResultPath } from "./state.js"

export interface PreparedNode {
  readonly token: string
  readonly resultPath: string
  readonly outputPath: string
  readonly gate: { readonly content: string; readonly digest: string } | null
}

function repeatForTemplate(workflow: WorkflowSpec, templateId: string): string | null {
  return workflow.repeats.find((repeat) => repeat.members.includes(templateId))?.id ?? null
}

function sourceRuntimeId(
  workflow: WorkflowSpec,
  state: RunState,
  runtimeNodeId: string,
  input: InputSpec
): string | null {
  const consumer = state.nodes[runtimeNodeId]
  if (input.round === "previous") {
    if (consumer?.round === null || consumer?.round === undefined || consumer.round <= 1) {
      return null
    }
    return `${input.from}--r${consumer.round - 1}`
  }
  const sourceRepeat = repeatForTemplate(workflow, input.from)
  if (
    consumer?.repeatId !== null &&
    consumer?.repeatId !== undefined &&
    consumer.repeatId === sourceRepeat &&
    consumer.round !== null
  ) {
    return `${input.from}--r${consumer.round}`
  }
  if (sourceRepeat !== null) {
    const repeat = state.repeats[sourceRepeat]
    return repeat === undefined ? null : `${input.from}--r${repeat.round}`
  }
  return input.from
}

function resultContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

export function renderAgentDirective(
  state: RunState,
  runtimeNodeId: string,
  node: AgentNode
): string {
  const round = state.nodes[runtimeNodeId]?.round
  return round === null || round === undefined
    ? node.prompt
    : node.prompt.replaceAll("{{round}}", String(round))
}

export function renderInputs(
  workflow: WorkflowSpec,
  state: RunState,
  runtimeNodeId: string,
  inputs: readonly InputSpec[]
): string {
  const sections: string[] = []
  for (const input of inputs) {
    const sourceId = sourceRuntimeId(workflow, state, runtimeNodeId, input)
    if (sourceId === null) {
      continue
    }
    const source = state.nodes[sourceId]
    if (source?.status === "skipped") {
      if (input.include === "path") {
        throw new Error(
          `Input "${input.from}" for node "${runtimeNodeId}" requests a path from a skipped node.`
        )
      }
      sections.push(`## ${input.as}\n\n[skipped]`)
      continue
    }
    if (source === undefined || source.resultPath === null) {
      throw new Error(`Input "${input.from}" for node "${runtimeNodeId}" has no completed result.`)
    }
    const value = input.include === "path" ? source.resultPath : resultContent(source.result)
    sections.push(`## ${input.as}\n\n${value}`)
  }
  return sections.join("\n\n")
}

export function renderNodeContent(
  workflow: WorkflowSpec,
  state: RunState,
  runtimeNodeId: string,
  node: WorkflowNode
): string {
  const inputs = renderInputs(workflow, state, runtimeNodeId, node.inputs)
  if (node.type === "agent") {
    return [renderAgentDirective(state, runtimeNodeId, node), inputs]
      .filter((part) => part.length > 0)
      .join("\n\n")
  }
  return [
    `Command: ${JSON.stringify(node.argv)}`,
    `Working directory: ${node.workspace.path ?? node.cwd ?? workflow.cwd}`,
    inputs
  ]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function nodeDoneCommand(
  runId: string,
  runtimeNodeId: string,
  token: string,
  outcome: "completed" | "failed",
  hold = false
): string {
  const command = [
    orchestrateExecutable(),
    "node-done",
    runId,
    runtimeNodeId,
    "--token",
    token,
    "--outcome",
    outcome
  ]
  if (hold) {
    command.push("--hold")
  }
  return command.map(shellQuote).join(" ")
}

export function promptContract(
  runId: string,
  runtimeNodeId: string,
  token: string,
  resultPath: string,
  node: AgentNode
): string {
  const resultRule =
    node.output.format === "json"
      ? "Write one JSON value that satisfies your output schema."
      : "Write your final plain-text result."
  return [
    "## Orchestrate completion contract",
    `${resultRule} Save it at exactly: ${resultPath}`,
    "When the result is complete, run exactly:",
    nodeDoneCommand(runId, runtimeNodeId, token, "completed"),
    "If the result is complete but no dependent may start yet, use this atomic completion-and-hold command instead:",
    nodeDoneCommand(runId, runtimeNodeId, token, "completed", true),
    "If the attempt cannot complete, write a useful failure result and run:",
    nodeDoneCommand(runId, runtimeNodeId, token, "failed"),
    `A human can continue them later with: ${shellQuote(orchestrateExecutable())} release ${shellQuote(runId)} ${shellQuote(runtimeNodeId)}`,
    "Do not leave the pane without reporting one of these outcomes."
  ].join("\n\n")
}

export function renderAgentPrompt(
  workflow: WorkflowSpec,
  state: RunState,
  runtimeNodeId: string,
  node: AgentNode,
  prepared: PreparedNode
): string {
  return `${renderNodeContent(workflow, state, runtimeNodeId, node)}\n\n${promptContract(
    state.id,
    runtimeNodeId,
    prepared.token,
    prepared.resultPath,
    node
  )}`
}

export function prepareNode(
  workflow: WorkflowSpec,
  state: RunState,
  runDir: string,
  runtimeNodeId: string
): PreparedNode {
  const runtimeNode = state.nodes[runtimeNodeId]
  if (runtimeNode === undefined) {
    throw new Error(`Unknown runtime node "${runtimeNodeId}".`)
  }
  const node = workflow.nodes.find((candidate) => candidate.id === runtimeNode.templateId)
  if (node === undefined) {
    throw new Error(`Unknown template "${runtimeNode.templateId}".`)
  }
  const attempt = runtimeNode.attempts.length + 1
  const attemptDir = attemptDirectory(runDir, runtimeNodeId, attempt)
  const content = renderNodeContent(workflow, state, runtimeNodeId, node)
  const token = randomBytes(32).toString("hex")
  return {
    token,
    resultPath:
      node.type === "agent"
        ? submissionResultPath(state.id, runtimeNodeId, token)
        : path.join(attemptDir, "result.txt"),
    outputPath: path.join(attemptDir, "output.log"),
    gate:
      node.gate === "approval"
        ? { content, digest: createHash("sha256").update(content).digest("hex") }
        : null
  }
}
