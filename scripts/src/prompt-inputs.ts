import type { InputSpec, RunState, WorkflowSpec } from "./types.js"

function repeatForTemplate(workflow: WorkflowSpec, templateId: string): string | null {
  return workflow.repeats.find((repeat) => repeat.members.includes(templateId))?.id ?? null
}

export function sourceRuntimeId(
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
