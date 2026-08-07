import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  compileAttemptCapabilityManifest,
  ensureAttemptTrustIdentities,
  loadAttemptCapabilityManifest
} from "../src/attempt-capability.js"
import { submitNodeDone } from "../src/completion-submission.js"
import { compileProviderLaunchIdentity, materializeProviderRelay } from "../src/provider-launch.js"
import { completionSubmissionPath, submissionScratchDirectory } from "../src/state.js"

const RUN_ID = "20260806120000-1234abcd"
const NODE_ID = "owner"
const TOKEN = "a".repeat(64)

let temporaryRoot = ""

async function compileCapability() {
  const trust = await ensureAttemptTrustIdentities(RUN_ID, NODE_ID, TOKEN)
  const providerLaunch = await compileProviderLaunchIdentity(
    "codex",
    path.join(temporaryRoot, "bin")
  )
  const providerRelay = await materializeProviderRelay(
    providerLaunch,
    path.join(trust.control.path, "provider-launcher")
  )
  const providerControlRoot = path.join(temporaryRoot, "codex-home")
  await mkdir(providerControlRoot)
  return compileAttemptCapabilityManifest(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 1,
      token: TOKEN,
      provider: "codex",
      accessIntent: "read-only",
      sourceRoots: [temporaryRoot],
      declaredWriteRoots: [],
      providerControlRoot,
      lineageRoot: null,
      providerLaunch,
      providerRelay,
      unreadableRoots: [path.join(temporaryRoot, "state")],
      immutableRoots: [path.join(temporaryRoot, "state"), providerControlRoot],
      completionExecutablePath: providerLaunch.entry.canonicalPath,
      projectedInputs: [],
      output: {
        format: "json",
        schema: {
          type: "object",
          properties: { verdict: { type: "boolean" } },
          required: ["verdict"],
          additionalProperties: false
        }
      }
    },
    async (draft) => [
      {
        kind: "codex-profile",
        path: draft.assets.codexProfilePath,
        content: "test=true\n"
      }
    ]
  )
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-capability-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
  const bin = path.join(temporaryRoot, "bin")
  await mkdir(bin)
  const executable = path.join(bin, "codex")
  await Bun.write(executable, "#!/bin/sh\nexit 0\n", { createPath: false })
  await chmod(executable, 0o700)
})

afterEach(async () => {
  delete process.env.ORCHESTRATE_STATE_DIR
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe("attempt capability contract", () => {
  test("persists four distinct immutable trust identities and reloads the same contract", async () => {
    const manifest = await compileCapability()
    const identities = Object.values(manifest.trust)
    expect(new Set(identities.map((identity) => identity.path)).size).toBe(4)
    expect(new Set(identities.map((identity) => `${identity.device}:${identity.inode}`)).size).toBe(
      4
    )
    expect(identities.every((identity) => identity.mode === 0o700)).toBe(true)
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(path.dirname(manifest.completion.contractPath)).toBe(manifest.trust.control.path)

    const loaded = await loadAttemptCapabilityManifest(RUN_ID, NODE_ID, TOKEN)
    expect(loaded.manifest).toEqual(manifest)
    expect(Object.isFrozen(loaded.manifest)).toBe(true)
    expect(path.dirname(loaded.contract.resultPath)).toBe(manifest.trust.outbox.path)
  })

  test("submits from only the immutable contract and rejects invalid completed JSON first", async () => {
    const manifest = await compileCapability()
    const completionPath = completionSubmissionPath(
      path.join(manifest.trust.outbox.path, "result.txt")
    )
    await Bun.write(path.join(manifest.trust.outbox.path, "result.txt"), "{}\n", {
      createPath: false
    })
    await expect(
      submitNodeDone(RUN_ID, NODE_ID, TOKEN, "completed", false, manifest.completion.contractPath)
    ).rejects.toThrow("does not satisfy its output schema")
    expect(await Bun.file(completionPath).exists()).toBe(false)

    await Bun.write(path.join(manifest.trust.outbox.path, "result.txt"), '{"verdict":true}\n', {
      createPath: false
    })
    const submission = await submitNodeDone(
      RUN_ID,
      NODE_ID,
      TOKEN,
      "completed",
      false,
      manifest.completion.contractPath
    )
    expect(submission).toMatchObject({
      version: 2,
      capability: {
        digest: manifest.capabilityDigest,
        completionContractSha256: manifest.completion.contractSha256
      }
    })
    expect(await Bun.file(completionPath).exists()).toBe(true)
  })

  test("restores permissive scratch and rejects symlink or identity replacement", async () => {
    const manifest = await compileCapability()
    const scratch = submissionScratchDirectory(RUN_ID, NODE_ID, TOKEN)
    await chmod(scratch, 0o777)
    await ensureAttemptTrustIdentities(RUN_ID, NODE_ID, TOKEN)
    expect((await lstat(scratch)).mode & 0o777).toBe(0o700)

    await rm(scratch, { recursive: true })
    await mkdir(scratch)
    await expect(loadAttemptCapabilityManifest(RUN_ID, NODE_ID, TOKEN)).rejects.toThrow(
      "identity changed"
    )
    await rm(scratch, { recursive: true })
    await symlink(temporaryRoot, scratch)
    await expect(ensureAttemptTrustIdentities(RUN_ID, NODE_ID, TOKEN)).rejects.toThrow(
      "no-follow directory"
    )
    expect(manifest.trust.scratch.path).not.toBe(temporaryRoot)
  })
})
