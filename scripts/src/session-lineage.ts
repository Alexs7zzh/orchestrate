import type { AgentNode, RunState } from "./types.js"

import { digestValue } from "./digest.js"

export function claudeSessionLineageIdentity(runId: string, alias: string): string {
  return digestValue("session-lineage", { runId, provider: "claude", alias })
}

export function claudeSessionLineageId(
  node: Extract<AgentNode, { readonly provider: "claude" }>,
  state: RunState
): string | null {
  if (node.session.mode !== "fresh") {
    const alias = node.session.from
    const source = alias === null ? undefined : state.sessions[alias]
    if (source === undefined || source.provider !== "claude") {
      throw new Error(`Node "${node.id}" cannot resolve its Claude session lineage.`)
    }
    return source.lineageId ?? claudeSessionLineageIdentity(state.id, source.alias)
  }
  if (node.session.saveAs === null) {
    return null
  }
  return claudeSessionLineageIdentity(state.id, node.session.saveAs)
}

export function claudeSessionLineageIdAtCompletion(
  node: Extract<AgentNode, { readonly provider: "claude" }>,
  state: RunState
): string | null {
  if (
    node.session.mode !== "fresh" &&
    (node.session.from === null || state.sessions[node.session.from] === undefined)
  ) {
    return null
  }
  return claudeSessionLineageId(node, state)
}
