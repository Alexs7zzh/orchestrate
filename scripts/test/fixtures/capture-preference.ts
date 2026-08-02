import type { WorkflowSpec } from "../../src/types.js"

import { captureApprovedWorkflow } from "../../src/preferences.js"

const project = process.argv[2]
const model = process.argv[3]
if (project === undefined || model === undefined) {
  throw new Error("Expected project and model arguments.")
}

const workflow: WorkflowSpec = {
  version: 1,
  name: "cross-process-preference-test",
  objective: "Exercise the preference file lock.",
  cwd: project,
  concurrency: 1,
  heartbeat: { intervalMinutes: null, milestones: false, callback: { type: "none" } },
  limits: {
    nodeWallTimeMinutes: null,
    workflowWallTimeMinutes: null,
    maxAgentStarts: null,
    maxGoalRounds: null
  },
  writeConflicts: "reject",
  nodes: [
    {
      id: "review",
      type: "agent",
      title: "Review",
      needs: [],
      cwd: null,
      workspace: {
        mode: "shared",
        path: null,
        vcs: "none",
        writes: [],
        exclusiveResources: []
      },
      inputs: [],
      timeoutMinutes: null,
      retry: { maxAttempts: 1, delaySeconds: 0 },
      gate: "none",
      provider: "codex",
      model,
      effort: "low",
      prompt: "Review.",
      session: {
        mode: "fresh",
        from: null,
        saveAs: null,
        retain: false,
        reuseOnRepeat: false
      },
      permissions: {
        sandbox: "read-only",
        extraArgs: [],
        inheritEnv: [],
        env: {}
      },
      output: { format: "text", schema: null },
      interactive: false
    }
  ]
}

await captureApprovedWorkflow(workflow)
