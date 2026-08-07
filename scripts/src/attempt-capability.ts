import { Schema } from "effect"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises"
import path from "node:path"

import type { OutputSpec } from "./types.js"

import { canonicalJson, digestValue } from "./digest.js"
import {
  assertProviderLaunchIdentity,
  decodeMaterializedProviderRelay,
  type MaterializedProviderRelay,
  type ProviderLaunchIdentity
} from "./provider-launch.js"
import {
  atomicWriteFile,
  attemptCapabilityManifestPath,
  attemptCompletionContractPath,
  submissionDirectory,
  submissionInboxArtifactPath,
  submissionsRoot
} from "./state.js"

const SHA256 = /^[0-9a-f]{64}$/
const MAX_CONTROL_BYTES = 1024 * 1024
const decodeOptions = { onExcessProperty: "error" } as const

const Sha256Schema = Schema.String.pipe(Schema.check(Schema.isPattern(SHA256)))
const DirectoryIdentitySchema = Schema.Struct({
  path: Schema.String,
  device: Schema.String,
  inode: Schema.String,
  mode: Schema.Number
})
const OutputContractSchema = Schema.Union([
  Schema.Struct({ format: Schema.Literal("text"), schema: Schema.Null }),
  Schema.Struct({
    format: Schema.Literal("json"),
    schema: Schema.Record(Schema.String, Schema.Unknown)
  })
])
const CanonicalFileIdentitySchema = Schema.Struct({
  lexicalPath: Schema.String,
  canonicalPath: Schema.String,
  device: Schema.String,
  inode: Schema.String,
  mode: Schema.Number,
  byteLength: Schema.Number,
  sha256: Sha256Schema
})
const ProviderDirectoryIdentitySchema = Schema.Struct({
  lexicalPath: Schema.String,
  canonicalPath: Schema.String,
  exists: Schema.Boolean,
  device: Schema.NullOr(Schema.String),
  inode: Schema.NullOr(Schema.String),
  mode: Schema.NullOr(Schema.Number)
})
const PathLookupIdentitySchema = Schema.Struct({
  command: Schema.String,
  searchedDirectories: Schema.Array(ProviderDirectoryIdentitySchema),
  candidatePath: Schema.String,
  executable: CanonicalFileIdentitySchema
})
const ProviderLaunchIdentitySchema = Schema.Struct({
  provider: Schema.Literals(["codex", "claude"]),
  normalizedPath: Schema.String,
  pathDirectories: Schema.Array(ProviderDirectoryIdentitySchema),
  entryLookup: PathLookupIdentitySchema,
  entry: CanonicalFileIdentitySchema,
  shebangChain: Schema.Array(
    Schema.Struct({
      script: CanonicalFileIdentitySchema,
      declaredInterpreter: CanonicalFileIdentitySchema,
      kind: Schema.Literals(["absolute", "env", "env-split"]),
      fixedArguments: Schema.Array(Schema.String),
      lookup: Schema.NullOr(PathLookupIdentitySchema)
    })
  ),
  terminalExecutable: CanonicalFileIdentitySchema,
  fixedArguments: Schema.Array(Schema.String),
  executionArgv: Schema.Array(Schema.String),
  relayInterpreter: CanonicalFileIdentitySchema,
  authorityEntries: Schema.Array(Schema.Struct({ label: Schema.String, path: Schema.String }))
})
const MaterializedProviderRelaySchema = Schema.Struct({
  directory: ProviderDirectoryIdentitySchema,
  path: Schema.String,
  identity: CanonicalFileIdentitySchema,
  sha256: Sha256Schema,
  environmentPath: Schema.String
})
const ProjectedInputSchema = Schema.Struct({
  inputIndex: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  sourceNodeId: Schema.String,
  path: Schema.String,
  sha256: Sha256Schema,
  byteLength: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
})
const PolicyAssetSchema = Schema.Struct({
  kind: Schema.Literals(["codex-profile", "claude-settings"]),
  path: Schema.String,
  sha256: Sha256Schema
})
const AttemptAccessPolicySchema = Schema.Struct({
  readableRoots: Schema.Array(Schema.String),
  writableRoots: Schema.Array(Schema.String),
  unreadableRoots: Schema.Array(Schema.String),
  immutableRoots: Schema.Array(Schema.String),
  completionExecutablePath: Schema.String
})

export interface CanonicalDirectoryIdentity {
  readonly path: string
  readonly device: string
  readonly inode: string
  readonly mode: number
}

export interface AttemptTrustIdentities {
  readonly control: CanonicalDirectoryIdentity
  readonly inbox: CanonicalDirectoryIdentity
  readonly outbox: CanonicalDirectoryIdentity
  readonly scratch: CanonicalDirectoryIdentity
}

export interface AttemptAccessPolicy {
  readonly readableRoots: readonly string[]
  readonly writableRoots: readonly string[]
  readonly unreadableRoots: readonly string[]
  readonly immutableRoots: readonly string[]
  readonly completionExecutablePath: string
}

export type AttemptOutputContract = OutputSpec

export interface AttemptCompletionContract {
  readonly version: 1
  readonly capabilityDigest: string
  readonly runId: string
  readonly nodeId: string
  readonly token: string
  readonly resultPath: string
  readonly envelopePath: string
  readonly allowedOutcomes: readonly ["completed", "failed"]
  readonly holdOutcome: "completed"
  readonly output: AttemptOutputContract
}

export interface AttemptCapabilityManifest {
  readonly version: 1
  readonly capabilityDigest: string
  readonly attempt: {
    readonly runId: string
    readonly nodeId: string
    readonly attempt: number
    readonly token: string
    readonly provider: "codex" | "claude"
  }
  readonly trust: AttemptTrustIdentities
  readonly sourceRoots: readonly string[]
  readonly declaredWriteRoots: readonly string[]
  readonly providerControlRoot: string
  readonly lineageRoot: string | null
  readonly providerLaunch: ProviderLaunchIdentity
  readonly providerRelay: MaterializedProviderRelay
  readonly access: AttemptAccessPolicy
  readonly projectedInputs: readonly ProjectedInputCapability[]
  readonly policyAssets: readonly AttemptPolicyAsset[]
  readonly assets: {
    readonly codexProfilePath: string
    readonly claudeSettingsPath: string
  }
  readonly completion: {
    readonly contractPath: string
    readonly contractSha256: string
  }
}

export interface ProjectedInputCapability {
  readonly inputIndex: number
  readonly sourceNodeId: string
  readonly path: string
  readonly sha256: string
  readonly byteLength: number
}

export interface AttemptPolicyAsset {
  readonly kind: "codex-profile" | "claude-settings"
  readonly path: string
  readonly sha256: string
}

const CompletionContractSchema = Schema.Struct({
  version: Schema.Literal(1),
  capabilityDigest: Sha256Schema,
  runId: Schema.String,
  nodeId: Schema.String,
  token: Schema.String,
  resultPath: Schema.String,
  envelopePath: Schema.String,
  allowedOutcomes: Schema.Tuple([Schema.Literal("completed"), Schema.Literal("failed")]),
  holdOutcome: Schema.Literal("completed"),
  output: OutputContractSchema
})

const CapabilityManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  capabilityDigest: Sha256Schema,
  attempt: Schema.Struct({
    runId: Schema.String,
    nodeId: Schema.String,
    attempt: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
    token: Schema.String,
    provider: Schema.Literals(["codex", "claude"])
  }),
  trust: Schema.Struct({
    control: DirectoryIdentitySchema,
    inbox: DirectoryIdentitySchema,
    outbox: DirectoryIdentitySchema,
    scratch: DirectoryIdentitySchema
  }),
  sourceRoots: Schema.Array(Schema.String),
  declaredWriteRoots: Schema.Array(Schema.String),
  providerControlRoot: Schema.String,
  lineageRoot: Schema.NullOr(Schema.String),
  providerLaunch: ProviderLaunchIdentitySchema,
  providerRelay: MaterializedProviderRelaySchema,
  access: AttemptAccessPolicySchema,
  projectedInputs: Schema.Array(ProjectedInputSchema),
  policyAssets: Schema.Array(PolicyAssetSchema),
  assets: Schema.Struct({
    codexProfilePath: Schema.String,
    claudeSettingsPath: Schema.String
  }),
  completion: Schema.Struct({ contractPath: Schema.String, contractSha256: Sha256Schema })
})

const decodeCompletionContract = Schema.decodeUnknownSync(CompletionContractSchema, decodeOptions)
const decodeCapabilityManifest = Schema.decodeUnknownSync(CapabilityManifestSchema, decodeOptions)

function digest(domain: "attempt-capability" | "completion-contract", value: unknown): string {
  return digestValue(domain, value)
}

function below(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

async function ensureExactDirectory(candidate: string, parent: string): Promise<string> {
  if (path.dirname(candidate) !== parent) {
    throw new Error(`Attempt capability directory "${candidate}" is not an exact child.`)
  }
  try {
    await mkdir(candidate, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error
    }
  }
  const metadata = await lstat(candidate, { bigint: true })
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Attempt capability path "${candidate}" must be a no-follow directory.`)
  }
  await chmod(candidate, 0o700)
  const canonicalParent = await realpath(parent)
  const canonical = await realpath(candidate)
  if (!below(canonicalParent, canonical)) {
    throw new Error(`Attempt capability directory "${canonical}" escaped its parent.`)
  }
  return canonical
}

async function directoryIdentity(candidate: string): Promise<CanonicalDirectoryIdentity> {
  const metadata = await lstat(candidate, { bigint: true })
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Attempt capability path "${candidate}" must be a no-follow directory.`)
  }
  return {
    path: await realpath(candidate),
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    mode: Number(metadata.mode & 0o777n)
  }
}

function assertDistinctTrustIdentities(trust: AttemptTrustIdentities): void {
  const identities = Object.entries(trust)
  for (let left = 0; left < identities.length; left += 1) {
    for (let right = left + 1; right < identities.length; right += 1) {
      const [leftName, leftIdentity] = identities[left] as [string, CanonicalDirectoryIdentity]
      const [rightName, rightIdentity] = identities[right] as [string, CanonicalDirectoryIdentity]
      if (
        leftIdentity.path === rightIdentity.path ||
        (leftIdentity.device === rightIdentity.device && leftIdentity.inode === rightIdentity.inode)
      ) {
        throw new Error(
          `Attempt capability ${leftName} and ${rightName} identities must be distinct.`
        )
      }
    }
  }
}

export async function ensureAttemptTrustIdentities(
  runId: string,
  nodeId: string,
  token: string
): Promise<AttemptTrustIdentities> {
  await mkdir(submissionsRoot(), { recursive: true, mode: 0o700 })
  await chmod(submissionsRoot(), 0o700)
  let parent = await realpath(submissionsRoot())
  for (const segment of [runId, nodeId, token]) {
    parent = await ensureExactDirectory(path.join(parent, segment), parent)
  }
  const expectedRoot = submissionDirectory(runId, nodeId, token)
  if ((await realpath(expectedRoot)) !== parent) {
    throw new Error("Attempt capability root does not match its token-addressed identity.")
  }
  const directories = {
    control: path.join(parent, "control"),
    inbox: path.join(parent, "inbox"),
    outbox: path.join(parent, "outbox"),
    scratch: path.join(parent, "scratch")
  }
  for (const candidate of Object.values(directories)) {
    await ensureExactDirectory(candidate, parent)
  }
  const trust = {
    control: await directoryIdentity(directories.control),
    inbox: await directoryIdentity(directories.inbox),
    outbox: await directoryIdentity(directories.outbox),
    scratch: await directoryIdentity(directories.scratch)
  }
  assertDistinctTrustIdentities(trust)
  return trust
}

export async function verifyAttemptTrustIdentities(trust: AttemptTrustIdentities): Promise<void> {
  assertDistinctTrustIdentities(trust)
  for (const [name, expected] of Object.entries(trust)) {
    const actual = await directoryIdentity(expected.path)
    if (
      actual.path !== expected.path ||
      actual.device !== expected.device ||
      actual.inode !== expected.inode ||
      actual.mode !== expected.mode ||
      actual.mode !== 0o700
    ) {
      throw new Error(`Attempt capability ${name} directory identity changed before use.`)
    }
  }
}

async function readExactModeFile(
  file: string,
  label: string,
  expectedMode: number
): Promise<Buffer> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const handle = await open(file, flags)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new Error(`${label} must be a regular file.`)
    }
    if ((metadata.mode & 0o777) !== expectedMode) {
      throw new Error(`${label} must have mode 0${expectedMode.toString(8)}.`)
    }
    if (metadata.size > MAX_CONTROL_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_CONTROL_BYTES}-byte limit.`)
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function readControlFile(file: string, label: string): Promise<string> {
  return (await readExactModeFile(file, label, 0o600)).toString("utf8")
}

async function fileSha256(file: string, label: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await readExactModeFile(file, label, 0o600))
  return hasher.digest("hex")
}

async function persistImmutableJson(file: string, value: unknown, label: string): Promise<void> {
  const rendered = `${JSON.stringify(value, null, 2)}\n`
  try {
    const existing = await readControlFile(file, label)
    if (canonicalJson(JSON.parse(existing) as unknown) !== canonicalJson(value)) {
      throw new Error(`${label} already exists with different content.`)
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }
  await atomicWriteFile(file, rendered, 0o600)
  await chmod(file, 0o600)
}

export interface CompileAttemptCapabilityInput {
  readonly runId: string
  readonly nodeId: string
  readonly attempt: number
  readonly token: string
  readonly provider: "codex" | "claude"
  readonly sourceRoots: readonly string[]
  readonly declaredWriteRoots: readonly string[]
  readonly providerControlRoot: string
  readonly lineageRoot: string | null
  readonly providerLaunch: ProviderLaunchIdentity
  readonly providerRelay: MaterializedProviderRelay
  readonly unreadableRoots: readonly string[]
  readonly immutableRoots: readonly string[]
  readonly completionExecutablePath: string
  readonly projectedInputs: readonly ProjectedInputCapability[]
  readonly output: AttemptOutputContract
}

export interface AttemptPolicyAssetContent {
  readonly kind: AttemptPolicyAsset["kind"]
  readonly path: string
  readonly content: string
}

export type BuildAttemptPolicyAssets = (
  draft: AttemptCapabilityManifest
) => Promise<readonly AttemptPolicyAssetContent[]>

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested)
    }
    Object.freeze(value)
  }
  return value
}

async function canonicalPathThroughExistingAncestor(candidate: string): Promise<string> {
  const suffix: string[] = []
  let cursor = path.resolve(candidate)
  for (;;) {
    try {
      return path.join(await realpath(cursor), ...suffix.toReversed())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) {
        throw error
      }
      suffix.push(path.basename(cursor))
      cursor = parent
    }
  }
}

async function canonicalRoots(roots: readonly string[], label: string): Promise<readonly string[]> {
  if (
    roots.some(
      (root) => !path.isAbsolute(root) || path.normalize(root) !== root || root.includes("\0")
    )
  ) {
    throw new Error(`Attempt capability ${label} roots must be normalized absolute paths.`)
  }
  return [
    ...new Set(await Promise.all(roots.map((root) => canonicalPathThroughExistingAncestor(root))))
  ]
}

async function assertProjectedInputs(
  input: CompileAttemptCapabilityInput,
  trust: AttemptTrustIdentities
): Promise<void> {
  const indexes = new Set<number>()
  const paths = new Set<string>()
  for (const projected of input.projectedInputs) {
    const expected = submissionInboxArtifactPath(
      input.runId,
      input.nodeId,
      input.token,
      projected.inputIndex,
      projected.sourceNodeId
    )
    const canonicalParent = await realpath(path.dirname(projected.path))
    if (
      path.basename(projected.path) !== path.basename(expected) ||
      canonicalParent !== trust.inbox.path
    ) {
      throw new Error(`Projected input ${projected.inputIndex} is outside the attempt inbox.`)
    }
    if (indexes.has(projected.inputIndex) || paths.has(projected.path)) {
      throw new Error(`Projected input ${projected.inputIndex} is duplicated.`)
    }
    indexes.add(projected.inputIndex)
    paths.add(projected.path)
    const bytes = await readExactModeFile(
      projected.path,
      `Projected input ${projected.inputIndex}`,
      0o400
    )
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(bytes)
    if (hasher.digest("hex") !== projected.sha256 || bytes.byteLength !== projected.byteLength) {
      throw new Error(`Projected input ${projected.inputIndex} does not match its exact bytes.`)
    }
  }
}

export async function compileAttemptCapabilityManifest(
  input: CompileAttemptCapabilityInput,
  buildPolicyAssets: BuildAttemptPolicyAssets = async () => []
): Promise<AttemptCapabilityManifest> {
  assertProviderLaunchIdentity(input.providerLaunch)
  decodeMaterializedProviderRelay(input.providerRelay)
  if (input.providerLaunch.provider !== input.provider) {
    throw new Error("Provider launch identity does not match the attempt provider.")
  }
  const trust = await ensureAttemptTrustIdentities(input.runId, input.nodeId, input.token)
  const sourceRoots = await canonicalRoots(input.sourceRoots, "source")
  const declaredWriteRoots = await canonicalRoots(input.declaredWriteRoots, "declared write")
  const unreadableRoots = await canonicalRoots(input.unreadableRoots, "unreadable authority")
  const configuredImmutableRoots = await canonicalRoots(input.immutableRoots, "immutable authority")
  const providerControlRoot = await canonicalPathThroughExistingAncestor(input.providerControlRoot)
  const lineageRoot =
    input.lineageRoot === null
      ? null
      : await canonicalPathThroughExistingAncestor(input.lineageRoot)
  const completionExecutablePath = await canonicalPathThroughExistingAncestor(
    input.completionExecutablePath
  )
  const immutableRoots = [...new Set([...configuredImmutableRoots, completionExecutablePath])]
  const access: AttemptAccessPolicy = {
    readableRoots: [
      ...new Set([...sourceRoots, trust.control.path, trust.inbox.path, completionExecutablePath])
    ],
    writableRoots: [...new Set([...declaredWriteRoots, trust.outbox.path, trust.scratch.path])],
    unreadableRoots,
    immutableRoots,
    completionExecutablePath
  }
  await assertProjectedInputs(input, trust)
  const contractPath = path.join(trust.control.path, "completion-contract.json")
  const core = {
    version: 1 as const,
    attempt: {
      runId: input.runId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      token: input.token,
      provider: input.provider
    },
    trust,
    sourceRoots,
    declaredWriteRoots,
    providerControlRoot,
    lineageRoot,
    providerLaunch: input.providerLaunch,
    providerRelay: input.providerRelay,
    access,
    projectedInputs: [...input.projectedInputs],
    assets: {
      codexProfilePath: path.join(trust.control.path, "codex-profile.toml"),
      claudeSettingsPath: path.join(trust.control.path, "claude-settings.json")
    },
    completion: { contractPath }
  }
  const capabilityDigest = digest("attempt-capability", core)
  const contract: AttemptCompletionContract = {
    version: 1,
    capabilityDigest,
    runId: input.runId,
    nodeId: input.nodeId,
    token: input.token,
    resultPath: path.join(trust.outbox.path, "result.txt"),
    envelopePath: path.join(trust.outbox.path, "completion.json"),
    allowedOutcomes: ["completed", "failed"],
    holdOutcome: "completed",
    output: input.output
  }
  const contractSha256 = digest("completion-contract", contract)
  const draft: AttemptCapabilityManifest = deepFreeze({
    ...core,
    capabilityDigest,
    completion: { contractPath, contractSha256 },
    policyAssets: []
  })
  await persistImmutableJson(contractPath, contract, "Attempt completion contract")
  const builtPolicyAssets = await buildPolicyAssets(draft)
  const expectedPolicy =
    input.provider === "codex"
      ? ({ kind: "codex-profile", path: draft.assets.codexProfilePath } as const)
      : ({ kind: "claude-settings", path: draft.assets.claudeSettingsPath } as const)
  if (
    builtPolicyAssets.length !== 1 ||
    builtPolicyAssets[0]?.kind !== expectedPolicy.kind ||
    builtPolicyAssets[0].path !== expectedPolicy.path
  ) {
    throw new Error("Attempt capability requires exactly its provider's compiled policy asset.")
  }
  const policyAssets: AttemptPolicyAsset[] = []
  for (const asset of builtPolicyAssets) {
    await atomicWriteFile(asset.path, asset.content, 0o600)
    await chmod(asset.path, 0o600)
    policyAssets.push({
      kind: asset.kind,
      path: asset.path,
      sha256: await fileSha256(asset.path, `Attempt ${asset.kind} policy asset`)
    })
  }
  const manifest: AttemptCapabilityManifest = {
    ...draft,
    policyAssets
  }
  await persistImmutableJson(
    attemptCapabilityManifestPath(input.runId, input.nodeId, input.token),
    manifest,
    "Attempt capability manifest"
  )
  return deepFreeze(manifest)
}

export async function loadAttemptCompletionContract(
  runId: string,
  nodeId: string,
  token: string
): Promise<{ readonly contract: AttemptCompletionContract; readonly sha256: string }> {
  return loadAttemptCompletionContractAt(
    attemptCompletionContractPath(runId, nodeId, token),
    runId,
    nodeId,
    token
  )
}

export async function loadAttemptCompletionContractAt(
  file: string,
  runId: string,
  nodeId: string,
  token: string
): Promise<{ readonly contract: AttemptCompletionContract; readonly sha256: string }> {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || file.includes("\0")) {
    throw new Error("Attempt completion contract path must be a normalized absolute path.")
  }
  if ((await lstat(file)).isSymbolicLink()) {
    throw new Error("Attempt completion contract must not be a symbolic link.")
  }
  // macOS exposes /var as a lexical alias of /private/var. Normalize the
  // launcher-provided existing file before comparing it with canonical paths
  // embedded in the contract. The final file identity is rejected above when
  // it is itself a symlink.
  const canonicalFile = await realpath(file)
  const parsed = decodeCompletionContract(
    JSON.parse(await readControlFile(canonicalFile, "Attempt completion contract"))
  )
  const contract = parsed as AttemptCompletionContract
  const controlDirectory = path.dirname(canonicalFile)
  const attemptDirectory = path.dirname(controlDirectory)
  if (
    path.basename(canonicalFile) !== "completion-contract.json" ||
    path.basename(controlDirectory) !== "control" ||
    contract.runId !== runId ||
    contract.nodeId !== nodeId ||
    contract.token !== token ||
    contract.resultPath !== path.join(attemptDirectory, "outbox", "result.txt") ||
    contract.envelopePath !== path.join(attemptDirectory, "outbox", "completion.json")
  ) {
    throw new Error("Attempt completion contract does not match its token-addressed identity.")
  }
  return deepFreeze({ contract, sha256: digest("completion-contract", contract) })
}

export async function loadAttemptCapabilityManifest(
  runId: string,
  nodeId: string,
  token: string
): Promise<{
  readonly manifest: AttemptCapabilityManifest
  readonly contract: AttemptCompletionContract
}> {
  const file = attemptCapabilityManifestPath(runId, nodeId, token)
  const decoded = decodeCapabilityManifest(
    JSON.parse(await readControlFile(file, "Attempt capability manifest"))
  )
  const manifest = decoded
  assertProviderLaunchIdentity(manifest.providerLaunch)
  decodeMaterializedProviderRelay(manifest.providerRelay)
  if (
    manifest.attempt.runId !== runId ||
    manifest.attempt.nodeId !== nodeId ||
    manifest.attempt.token !== token ||
    manifest.completion.contractPath !== attemptCompletionContractPath(runId, nodeId, token)
  ) {
    throw new Error("Attempt capability manifest does not match its token-addressed identity.")
  }
  const expectedPolicy =
    manifest.attempt.provider === "codex"
      ? ({ kind: "codex-profile", path: manifest.assets.codexProfilePath } as const)
      : ({ kind: "claude-settings", path: manifest.assets.claudeSettingsPath } as const)
  if (
    manifest.policyAssets.length !== 1 ||
    manifest.policyAssets[0]?.kind !== expectedPolicy.kind ||
    manifest.policyAssets[0].path !== expectedPolicy.path
  ) {
    throw new Error("Attempt capability policy assets are incomplete or duplicated.")
  }
  const expectedAccess: AttemptAccessPolicy = {
    readableRoots: [
      ...new Set([
        ...manifest.sourceRoots,
        manifest.trust.control.path,
        manifest.trust.inbox.path,
        manifest.access.completionExecutablePath
      ])
    ],
    writableRoots: [
      ...new Set([
        ...manifest.declaredWriteRoots,
        manifest.trust.outbox.path,
        manifest.trust.scratch.path
      ])
    ],
    unreadableRoots: manifest.access.unreadableRoots,
    immutableRoots: manifest.access.immutableRoots,
    completionExecutablePath: manifest.access.completionExecutablePath
  }
  if (
    JSON.stringify(expectedAccess.readableRoots) !==
      JSON.stringify(manifest.access.readableRoots) ||
    JSON.stringify(expectedAccess.writableRoots) !==
      JSON.stringify(manifest.access.writableRoots) ||
    !manifest.access.unreadableRoots.every((root) => manifest.access.immutableRoots.includes(root))
  ) {
    throw new Error("Attempt capability access policy is internally inconsistent.")
  }
  for (const candidate of [
    ...manifest.access.readableRoots,
    ...manifest.access.writableRoots,
    ...manifest.access.unreadableRoots,
    ...manifest.access.immutableRoots
  ]) {
    if ((await canonicalPathThroughExistingAncestor(candidate)) !== candidate) {
      throw new Error(`Attempt capability access path "${candidate}" is not canonical.`)
    }
  }
  const completionExecutable = await lstat(manifest.access.completionExecutablePath)
  if (!completionExecutable.isFile() || (completionExecutable.mode & 0o111) === 0) {
    throw new Error("Attempt capability completion executable is not executable.")
  }
  const core = {
    version: manifest.version,
    attempt: manifest.attempt,
    trust: manifest.trust,
    sourceRoots: manifest.sourceRoots,
    declaredWriteRoots: manifest.declaredWriteRoots,
    providerControlRoot: manifest.providerControlRoot,
    lineageRoot: manifest.lineageRoot,
    providerLaunch: manifest.providerLaunch,
    providerRelay: manifest.providerRelay,
    access: manifest.access,
    projectedInputs: manifest.projectedInputs,
    assets: manifest.assets,
    completion: { contractPath: manifest.completion.contractPath }
  }
  if (digest("attempt-capability", core) !== manifest.capabilityDigest) {
    throw new Error("Attempt capability manifest digest is invalid.")
  }
  await verifyAttemptTrustIdentities(manifest.trust)
  const loadedContract = await loadAttemptCompletionContract(runId, nodeId, token)
  if (
    loadedContract.sha256 !== manifest.completion.contractSha256 ||
    loadedContract.contract.capabilityDigest !== manifest.capabilityDigest
  ) {
    throw new Error("Attempt completion contract is not bound to its capability manifest.")
  }
  await assertProjectedInputs(
    {
      ...manifest.attempt,
      sourceRoots: manifest.sourceRoots,
      declaredWriteRoots: manifest.declaredWriteRoots,
      providerControlRoot: manifest.providerControlRoot,
      lineageRoot: manifest.lineageRoot,
      providerLaunch: manifest.providerLaunch,
      providerRelay: manifest.providerRelay,
      unreadableRoots: manifest.access.unreadableRoots,
      immutableRoots: manifest.access.immutableRoots,
      completionExecutablePath: manifest.access.completionExecutablePath,
      projectedInputs: manifest.projectedInputs,
      output: loadedContract.contract.output
    },
    manifest.trust
  )
  if (
    (await realpath(path.dirname(loadedContract.contract.resultPath))) !==
      manifest.trust.outbox.path ||
    (await realpath(path.dirname(loadedContract.contract.envelopePath))) !==
      manifest.trust.outbox.path
  ) {
    throw new Error("Attempt completion paths are not bound to the outbox identity.")
  }
  for (const asset of manifest.policyAssets) {
    const canonicalAssetParent = await realpath(path.dirname(asset.path))
    if (canonicalAssetParent !== manifest.trust.control.path) {
      throw new Error(`Attempt ${asset.kind} policy asset escaped its compiled control root.`)
    }
    if ((await fileSha256(asset.path, `Attempt ${asset.kind} policy asset`)) !== asset.sha256) {
      throw new Error(`Attempt ${asset.kind} policy asset digest is invalid.`)
    }
  }
  return deepFreeze({ manifest, contract: loadedContract.contract })
}

export const loadExistingAttemptCapabilityManifest = loadAttemptCapabilityManifest

export function completionContractDigest(contract: AttemptCompletionContract): string {
  return digest("completion-contract", contract)
}
