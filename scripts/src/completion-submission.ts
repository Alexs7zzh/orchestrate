import { Ajv2020 } from "ajv/dist/2020.js"

import type { NodeDoneSubmission } from "./state.js"

import { loadAttemptCompletionContractAt } from "./attempt-capability.js"
import { readDeclaredNonemptyResult } from "./completion-evidence.js"
import { assertNodeSubmissionIdentity, atomicWriteJson } from "./state.js"

export async function submitNodeDone(
  runId: string,
  nodeId: string,
  token: string,
  outcome: "completed" | "failed",
  hold = false,
  contractPath = process.env.ORCHESTRATE_COMPLETION_CONTRACT
): Promise<NodeDoneSubmission> {
  // Preserve public argument-validation order before consulting the
  // launcher-only environment contract.
  assertNodeSubmissionIdentity(runId, nodeId, token)
  if (hold && outcome !== "completed") {
    throw new Error("--hold is valid only with --outcome completed.")
  }
  if (contractPath === undefined || contractPath.trim().length === 0) {
    throw new Error(
      "node-done requires the launcher-provided ORCHESTRATE_COMPLETION_CONTRACT path. Run it from the owning provider pane."
    )
  }
  const loadedContract = await loadAttemptCompletionContractAt(contractPath, runId, nodeId, token)
  const contract = loadedContract.contract
  if (!contract.allowedOutcomes.includes(outcome) || (hold && outcome !== contract.holdOutcome)) {
    throw new Error("Requested completion is not allowed by the attempt-local contract.")
  }
  const declaredResult = await readDeclaredNonemptyResult(
    contract.resultPath,
    `Declared result for node "${nodeId}"`
  )
  if (outcome === "completed" && contract.output.format === "json") {
    if (contract.output.schema === null) {
      throw new Error(`Result contract for node "${nodeId}" has no JSON schema.`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(declaredResult.text) as unknown
    } catch (cause) {
      throw new Error(
        `Result for node "${nodeId}" is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause }
      )
    }
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(contract.output.schema)
    if (!validate(parsed)) {
      throw new Error(
        `Result for node "${nodeId}" does not satisfy its output schema: ${new Ajv2020().errorsText(validate.errors ?? [], { separator: "; " })}`
      )
    }
  }
  const submission: NodeDoneSubmission = {
    version: 2,
    runId,
    nodeId,
    token,
    outcome,
    hold,
    capability: {
      digest: contract.capabilityDigest,
      completionContractSha256: loadedContract.sha256
    },
    result: {
      sha256: declaredResult.sha256,
      byteLength: declaredResult.byteLength
    }
  }
  await atomicWriteJson(contract.envelopePath, submission)
  return submission
}
