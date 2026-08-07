import type { PaneGarnish } from "./board-model.js"
import type { HerdrAgentStatus, HerdrSurface } from "./herdr-surface.js"
import type { RunState } from "./types.js"

import { readAuthenticatedCompletionEvidence } from "./completion-evidence.js"

export interface LivePaneSample {
  readonly condition: "live" | "blocked" | "done" | "gone"
  readonly detail: string | null
}

const BLOCKED_DETAIL = "Agent is blocked — human needed."
const DONE_DETAIL =
  "Result missing: agent finished without authenticated node-done — recovery needed."
const SUBMITTED_DETAIL = "Authenticated completion submitted; pending reconcile."

export function classifyLivePane(
  live: boolean,
  nodeType: RunState["nodes"][string]["type"],
  agentStatus: HerdrAgentStatus | null
): LivePaneSample {
  if (!live) {
    return { condition: "gone", detail: "Pane gone — human needed." }
  }
  if (nodeType === "agent" && agentStatus === "blocked") {
    return { condition: "blocked", detail: BLOCKED_DETAIL }
  }
  if (nodeType === "agent" && agentStatus === "done") {
    return { condition: "done", detail: DONE_DETAIL }
  }
  // Herdr 0.7 reports idle, working, blocked, unknown, and done. Idle,
  // unknown, and unrecognized startup samples are transient. Done means the
  // provider finished while durable state still says running. Observation
  // authenticates transport evidence before treating any blocked/done/gone
  // sample as actionable owner recovery.
  return { condition: "live", detail: null }
}

export async function observePaneGarnish(
  state: RunState,
  surface: HerdrSurface
): Promise<Readonly<Record<string, PaneGarnish>>> {
  const observed = Object.values(state.nodes).filter(
    (node) =>
      node.status === "running" &&
      node.attempts.at(-1)?.pane !== null &&
      node.attempts.at(-1)?.pane !== undefined
  )
  // One `pane list` snapshot replaces a pane-get plus agent-get pair per node.
  const snapshot = observed.length === 0 ? new Map() : await surface.paneSnapshot()
  const entries = await Promise.all(
    observed.map(async (node) => {
      const pane = node.attempts.at(-1)?.pane
      if (pane === null || pane === undefined) {
        return null
      }
      const observation = snapshot.get(pane.paneId)
      const live = observation !== undefined
      const agentStatus = live && node.type === "agent" ? (observation.agentStatus ?? null) : null
      const sample = classifyLivePane(live, node.type, agentStatus)
      const attempt = node.attempts.at(-1)
      if (sample.condition !== "live" && attempt !== undefined) {
        const submitted = await readAuthenticatedCompletionEvidence({
          runId: state.id,
          nodeId: node.id,
          token: attempt.token,
          resultPath: attempt.resultPath
        })
          .then(() => true)
          .catch(() => false)
        if (submitted) {
          return [node.id, { condition: "submitted", detail: SUBMITTED_DETAIL } as const] as const
        }
      }
      return [
        node.id,
        sample.condition === "live"
          ? ({ condition: "live", detail: null } as const)
          : sample.condition === "blocked"
            ? ({
                condition: "blocked",
                detail: sample.detail
              } as const)
            : sample.condition === "done"
              ? ({ condition: "done", detail: sample.detail } as const)
              : ({ condition: "gone", detail: sample.detail } as const)
      ] as const
    })
  )
  return Object.fromEntries(entries.filter((entry) => entry !== null))
}
