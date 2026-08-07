import type {
  InputSpec,
  NodeStatus,
  Provider,
  RunState,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

export interface ResolvedHandoff {
  readonly inputIndex: number
  readonly input: InputSpec
  readonly sourceTemplateId: string
  readonly sourceRuntimeId: string
  readonly sourceTitle: string
  readonly sourceType: WorkflowNode["type"]
  readonly sourceProvider: Provider | "command"
  readonly sourceRound: number | null
  readonly sourceStatus: NodeStatus
  readonly sourceFormat: "text" | "json"
  readonly value: unknown
  readonly resultPath: string | null
}

function repeatForTemplate(workflow: WorkflowSpec, templateId: string): string | null {
  return workflow.repeats.find((repeat) => repeat.members.includes(templateId))?.id ?? null
}

// This is the single workflow-template to immutable-runtime binding rule used
// by readiness, path projection, and human prompt presentation.
export function resolveInputSourceId(
  workflow: WorkflowSpec,
  state: RunState,
  runtimeNodeId: string,
  input: InputSpec
): string | null {
  const consumer = state.nodes[runtimeNodeId]
  if (consumer === undefined) {
    throw new Error(`Unknown input consumer "${runtimeNodeId}".`)
  }
  const sourceRepeat = repeatForTemplate(workflow, input.from)
  if (input.round === "previous") {
    if (consumer.repeatId === null || consumer.round === null || consumer.round <= 1) {
      return null
    }
    if (sourceRepeat !== consumer.repeatId) {
      throw new Error(
        `Previous-round input "${input.from}" is outside repeat "${consumer.repeatId}".`
      )
    }
    return `${input.from}--r${consumer.round - 1}`
  }
  if (sourceRepeat === null) {
    return input.from
  }
  if (consumer.repeatId === sourceRepeat && consumer.round !== null) {
    return `${input.from}--r${consumer.round}`
  }
  const repeat = state.repeats[sourceRepeat]
  return repeat?.status === "completed" ? `${input.from}--r${repeat.round}` : null
}

export function resolveHandoffs(
  workflow: WorkflowSpec,
  state: RunState,
  runtimeNodeId: string,
  inputs: readonly InputSpec[]
): readonly ResolvedHandoff[] {
  return inputs.flatMap((input, inputIndex) => {
    const sourceRuntimeId = resolveInputSourceId(workflow, state, runtimeNodeId, input)
    if (sourceRuntimeId === null) {
      return []
    }
    const source = state.nodes[sourceRuntimeId]
    const template = workflow.nodes.find((candidate) => candidate.id === input.from)
    if (source === undefined || template === undefined) {
      throw new Error(
        `Input "${input.from}" for node "${runtimeNodeId}" has no resolved runtime source.`
      )
    }
    return [
      {
        inputIndex,
        input,
        sourceTemplateId: template.id,
        sourceRuntimeId,
        sourceTitle: template.title,
        sourceType: template.type,
        sourceProvider: template.type === "agent" ? template.provider : "command",
        sourceRound: source.round,
        sourceStatus: source.status,
        sourceFormat: template.type === "agent" ? template.output.format : "text",
        value: source.result,
        resultPath: source.resultPath
      }
    ] satisfies readonly ResolvedHandoff[]
  })
}

export function handoffsReady(handoffs: readonly ResolvedHandoff[]): boolean {
  return handoffs.every(
    ({ sourceStatus }) => sourceStatus === "completed" || sourceStatus === "skipped"
  )
}
