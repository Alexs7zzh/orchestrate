import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { WorkflowProvenance, WorkflowSpec } from "../src/types.js"

import { loadWorkflowSource } from "../src/workflow-source.js"
import { workflowSourceYaml } from "./workflow-source-fixture.js"

export async function workflowProvenance(workflow: WorkflowSpec): Promise<WorkflowProvenance> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "orchestrate-provenance-fixture-"))
  const source = path.join(temporary, "workflow.yaml")
  try {
    await Bun.write(source, workflowSourceYaml(workflow), { createPath: false })
    const loaded = await loadWorkflowSource(source)
    if (loaded.workflow === null || loaded.provenance === null) {
      throw new Error(`Fixture workflow did not load: ${JSON.stringify(loaded.diagnostics)}`)
    }
    return loaded.provenance
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
