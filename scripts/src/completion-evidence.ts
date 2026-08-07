import { Option, Schema } from "effect"
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"

import type { NodeDoneSubmission } from "./state.js"

import {
  loadAttemptCapabilityManifest,
  type AttemptCapabilityManifest,
  type AttemptCompletionContract
} from "./attempt-capability.js"
import { NodeDoneSubmissionSchema } from "./schema.js"
import { atomicWriteFile } from "./state.js"

export const MAX_RESULT_BYTES = 1024 * 1024

const decodeNodeDoneSubmission = Schema.decodeUnknownOption(NodeDoneSubmissionSchema, {
  onExcessProperty: "error"
})

export interface BoundedRegularFile {
  readonly bytes: Buffer
  readonly text: string
  readonly sha256: string
  readonly byteLength: number
}

export async function readBoundedRegularFileEvidence(
  file: string,
  label: string
): Promise<BoundedRegularFile> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file, flags)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`${label} must be a regular file, not a symbolic link.`, { cause: error })
    }
    throw error
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file.`)
    }
    if (metadata.size > MAX_RESULT_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_RESULT_BYTES}-byte result limit.`)
    }
    const buffer = Buffer.alloc(MAX_RESULT_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (read.bytesRead === 0) {
        break
      }
      bytesRead += read.bytesRead
    }
    if (bytesRead > MAX_RESULT_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_RESULT_BYTES}-byte result limit.`)
    }
    const bytes = buffer.subarray(0, bytesRead)
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(bytes)
    return {
      bytes,
      text: bytes.toString("utf8"),
      sha256: hasher.digest("hex"),
      byteLength: bytesRead
    }
  } finally {
    await handle.close()
  }
}

export async function projectResultBytes(
  destination: string,
  bytes: Uint8Array,
  label: string
): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  let existing: BoundedRegularFile | null = null
  try {
    existing = await readBoundedRegularFileEvidence(destination, label)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  const expected = { sha256: hasher.digest("hex"), byteLength: bytes.byteLength }
  if (existing !== null) {
    if (existing.sha256 !== expected.sha256 || existing.byteLength !== expected.byteLength) {
      throw new Error(`${label} already exists with different bytes.`)
    }
    if (((await lstat(destination)).mode & 0o777) !== 0o400) {
      throw new Error(`${label} must have mode 0400.`)
    }
    return expected
  }
  await atomicWriteFile(destination, bytes, 0o400)
  const projected = await readBoundedRegularFileEvidence(destination, label)
  if (projected.sha256 !== expected.sha256 || projected.byteLength !== expected.byteLength) {
    throw new Error(`${label} changed while it was projected.`)
  }
  if (((await lstat(destination)).mode & 0o777) !== 0o400) {
    throw new Error(`${label} must have mode 0400.`)
  }
  return expected
}

export async function readBoundedRegularFile(file: string, label: string): Promise<string> {
  return (await readBoundedRegularFileEvidence(file, label)).text
}

export async function readDeclaredNonemptyResult(
  resultPath: string,
  label: string
): Promise<BoundedRegularFile> {
  let result: BoundedRegularFile
  try {
    result = await readBoundedRegularFileEvidence(resultPath, label)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(
        new Error(
          `${label} was not found at ${resultPath}. Write the declared nonempty result to that exact path before rerunning node-done.`,
          { cause: error }
        ),
        { code: "ENOENT" }
      )
    }
    throw error
  }
  if (result.text.trim().length === 0) {
    throw new Error(`${label} must not be empty.`)
  }
  return result
}

export interface CompletionEvidenceExpectation {
  readonly runId: string
  readonly nodeId: string
  readonly token: string
  readonly resultPath: string
}

export interface AuthenticatedCompletionEvidence {
  readonly submission: NodeDoneSubmission
  readonly declaredResult: string
  readonly declaredResultBytes: Buffer
  readonly manifest: AttemptCapabilityManifest
  readonly contract: AttemptCompletionContract
}

type BoundCompletionEvidence = Pick<
  AuthenticatedCompletionEvidence,
  "submission" | "declaredResult" | "declaredResultBytes"
>

export class CompletionEvidenceError extends Error {
  readonly kind: "missing-envelope" | "invalid-envelope" | "missing-or-invalid-result"

  constructor(kind: CompletionEvidenceError["kind"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "CompletionEvidenceError"
    this.kind = kind
  }
}

function authenticatedSubmission(
  expected: CompletionEvidenceExpectation & {
    readonly capabilityDigest: string
    readonly completionContractSha256: string
  },
  value: unknown
): NodeDoneSubmission {
  const submission = Option.getOrNull(decodeNodeDoneSubmission(value))
  if (
    submission === null ||
    submission.runId !== expected.runId ||
    submission.nodeId !== expected.nodeId ||
    submission.token !== expected.token ||
    submission.capability.digest !== expected.capabilityDigest ||
    submission.capability.completionContractSha256 !== expected.completionContractSha256 ||
    (submission.hold && submission.outcome !== "completed")
  ) {
    throw new CompletionEvidenceError(
      "invalid-envelope",
      `Completion submission for node "${expected.nodeId}" is invalid or stale.`
    )
  }
  return submission
}

export function validateAuthenticatedCompletionEvidence(
  expected: CompletionEvidenceExpectation & {
    readonly capabilityDigest: string
    readonly completionContractSha256: string
  },
  value: unknown,
  declaredResult: BoundedRegularFile
): BoundCompletionEvidence {
  const submission = authenticatedSubmission(expected, value)
  if (
    submission.result.sha256 !== declaredResult.sha256 ||
    submission.result.byteLength !== declaredResult.byteLength
  ) {
    throw new CompletionEvidenceError(
      "missing-or-invalid-result",
      `Completion submission for node "${expected.nodeId}" does not match the exact result bytes preflighted by node-done.`
    )
  }
  if (declaredResult.text.trim().length === 0) {
    throw new CompletionEvidenceError(
      "missing-or-invalid-result",
      `Completion submission for node "${expected.nodeId}" has no valid nonempty declared result: Declared result for node "${expected.nodeId}" must not be empty.`
    )
  }
  return {
    submission,
    declaredResult: declaredResult.text,
    declaredResultBytes: declaredResult.bytes
  }
}

export async function readAuthenticatedCompletionEvidence(
  expected: CompletionEvidenceExpectation
): Promise<AuthenticatedCompletionEvidence> {
  let capability: Awaited<ReturnType<typeof loadAttemptCapabilityManifest>>
  try {
    capability = await loadAttemptCapabilityManifest(
      expected.runId,
      expected.nodeId,
      expected.token
    )
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
    throw new CompletionEvidenceError(
      missing ? "missing-envelope" : "invalid-envelope",
      missing
        ? `Completion submission for node "${expected.nodeId}" does not exist.`
        : `Completion capability for node "${expected.nodeId}" could not be validated: ${error instanceof Error ? error.message : String(error)}`,
      error
    )
  }
  if (capability.contract.resultPath !== expected.resultPath) {
    throw new CompletionEvidenceError(
      "invalid-envelope",
      `Completion capability for node "${expected.nodeId}" does not match its active result path.`
    )
  }
  const envelopePath = capability.contract.envelopePath
  let rawEnvelope: string
  try {
    rawEnvelope = await readBoundedRegularFile(
      envelopePath,
      `Completion submission for node "${expected.nodeId}"`
    )
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
    throw new CompletionEvidenceError(
      missing ? "missing-envelope" : "invalid-envelope",
      missing
        ? `Completion submission for node "${expected.nodeId}" does not exist.`
        : `Completion submission for node "${expected.nodeId}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
      error
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawEnvelope) as unknown
  } catch (error) {
    throw new CompletionEvidenceError(
      "invalid-envelope",
      `Completion submission for node "${expected.nodeId}" is not valid JSON.`,
      error
    )
  }
  const boundExpectation = {
    ...expected,
    capabilityDigest: capability.manifest.capabilityDigest,
    completionContractSha256: capability.manifest.completion.contractSha256
  }
  const submission = authenticatedSubmission(boundExpectation, parsed)
  let declaredResult: BoundedRegularFile
  try {
    declaredResult = await readBoundedRegularFileEvidence(
      expected.resultPath,
      `Declared result for node "${expected.nodeId}"`
    )
  } catch (error) {
    throw new CompletionEvidenceError(
      "missing-or-invalid-result",
      `Completion submission for node "${expected.nodeId}" has no valid nonempty declared result: ${error instanceof Error ? error.message : String(error)}`,
      error
    )
  }
  const evidence = validateAuthenticatedCompletionEvidence(
    boundExpectation,
    submission,
    declaredResult
  )
  return {
    ...evidence,
    manifest: capability.manifest,
    contract: capability.contract
  }
}

export async function projectAuthenticatedCompletionResult(
  expected: CompletionEvidenceExpectation,
  destination: string,
  label: string
): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  const evidence = await readAuthenticatedCompletionEvidence(expected)
  try {
    await projectResultBytes(destination, evidence.declaredResultBytes, label)
  } catch (error) {
    throw new Error(`${label} could not be projected to ${destination}.`, { cause: error })
  }
  return {
    sha256: evidence.submission.result.sha256,
    byteLength: evidence.submission.result.byteLength
  }
}
