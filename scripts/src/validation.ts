import { Ajv2020 } from "ajv/dist/2020.js"
import { Result, Schema, SchemaIssue } from "effect"
import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ProviderLaunchIdentity } from "./provider-launch.js"
import type {
  AgentNode,
  ValidationIssue,
  ValidationResult,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

import { canonicalJson, digestWorkflow } from "./digest.js"
import { isAbsoluteHttpUrl, WorkflowSchema } from "./schema.js"
import { providerSessionsRoot, stateRoot, submissionsRoot } from "./state.js"

const decodeWorkflow = Schema.decodeUnknownResult(WorkflowSchema, {
  errors: "all",
  onExcessProperty: "error"
})
const formatSchemaIssues = SchemaIssue.makeFormatterStandardSchemaV1()

function schemaIssueCode(issuePath: readonly unknown[] | undefined): string {
  const parts = issuePath?.map(String) ?? []
  const joined = parts.join(".")
  if (joined === "callback.url") {
    return "callback-url"
  }
  if (joined.startsWith("callback.headers.")) {
    return "callback-header"
  }
  if (/^nodes\.\d+\.id$/.test(joined)) {
    return "node-id"
  }
  if (/^nodes\.\d+\.cwd$/.test(joined)) {
    return "node-cwd"
  }
  if (/^nodes\.\d+\.workspace\.path$/.test(joined)) {
    return "workspace-path"
  }
  if (/^nodes\.\d+\.permissions\.(?:inheritEnv|env)/.test(joined)) {
    return "environment-name"
  }
  if (/^nodes\.\d+\.(?:inheritEnv|env)/.test(joined)) {
    return "environment-name"
  }
  if (/^repeats\.\d+\.until\.pointer$/.test(joined)) {
    return "repeat-until"
  }
  if (/^presentation\.workrooms\.\d+\.seats/.test(joined)) {
    return "workroom-seats"
  }
  if (joined.startsWith("presentation.workrooms")) {
    return "workroom"
  }
  return "schema"
}
const NODE_ID = /^[a-z0-9][a-z0-9-]*$/
const ROUND_INSTANCE_SUFFIX = /--r[1-9][0-9]*$/
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/
const LAUNCHER_ENVIRONMENT = new Set([
  "ORCHESTRATE_BIN",
  "ORCHESTRATE_STATE_DIR",
  "ORCHESTRATE_RUN_ID",
  "ORCHESTRATE_NODE_ID",
  "ORCHESTRATE_NODE_TOKEN",
  "ORCHESTRATE_COMPLETION_CONTRACT",
  "ORCHESTRATE_OUTPUT_PATH",
  "ORCHESTRATE_RESULT_PATH",
  "ORCHESTRATE_SOURCE_ROOT"
])
const AGENT_SCRATCH_ENVIRONMENT = new Set(["TMPDIR", "TMP", "TEMP"])
const PROVIDER_CONTROL_ENVIRONMENT = new Set(["PATH", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"])

export function isLauncherOwnedAgentEnvironment(name: string): boolean {
  return (
    LAUNCHER_ENVIRONMENT.has(name) ||
    AGENT_SCRATCH_ENVIRONMENT.has(name) ||
    PROVIDER_CONTROL_ENVIRONMENT.has(name)
  )
}

export const canonicalize = canonicalJson
export const workflowDigest = digestWorkflow

function addIssue(
  issues: ValidationIssue[],
  severity: ValidationIssue["severity"],
  code: string,
  message: string,
  details: {
    readonly path: string
    readonly primaryNode?: string
    readonly relatedNodes?: readonly string[]
  }
): void {
  const nodes = [
    ...(details.primaryNode === undefined ? [] : [details.primaryNode]),
    ...(details.relatedNodes ?? [])
  ]
  issues.push({
    severity,
    code,
    message,
    path: details.path,
    ...(details.primaryNode === undefined ? {} : { primaryNode: details.primaryNode }),
    ...(details.relatedNodes === undefined ? {} : { relatedNodes: details.relatedNodes }),
    ...(nodes.length === 0 ? {} : { nodes })
  })
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1")
}

function schemaPathPart(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  return JSON.stringify(value) ?? "<unknown>"
}

function graphMaps(nodes: readonly WorkflowNode[]): {
  readonly byId: ReadonlyMap<string, WorkflowNode>
  readonly ancestors: ReadonlyMap<string, ReadonlySet<string>>
  readonly cycles: readonly string[][]
} {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const ancestors = new Map<string, Set<string>>()
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []

  const visit = (id: string): Set<string> => {
    const cached = ancestors.get(id)
    if (cached !== undefined && !active.has(id)) {
      return cached
    }
    if (active.has(id)) {
      const start = stack.indexOf(id)
      cycles.push([...stack.slice(start), id])
      return new Set()
    }
    if (visited.has(id)) {
      return ancestors.get(id) ?? new Set()
    }
    visited.add(id)
    active.add(id)
    stack.push(id)
    const result = new Set<string>()
    for (const dependency of byId.get(id)?.needs ?? []) {
      result.add(dependency)
      if (byId.has(dependency)) {
        for (const ancestor of visit(dependency)) {
          result.add(ancestor)
        }
      }
    }
    stack.pop()
    active.delete(id)
    ancestors.set(id, result)
    return result
  }

  for (const node of nodes) {
    visit(node.id)
  }
  return { byId, ancestors, cycles }
}

export function normalizedStaticPrefix(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\/+/, "")
  const wildcard = normalized.search(/[*?[\]{}]/)
  const prefix = wildcard === -1 ? normalized : normalized.slice(0, wildcard)
  return prefix.replace(/\/+$/, "")
}

function absoluteWritePrefix(
  workflow: WorkflowSpec,
  node: WorkflowNode,
  pattern: string
): CanonicalPathIdentity | null {
  if (node.workspace.mode === "git-worktree" && node.workspace.path === null) {
    return null
  }
  const candidate = path.resolve(
    node.workspace.path ?? node.cwd ?? workflow.cwd,
    normalizedStaticPrefix(pattern)
  )
  return inspectDeclaredPath(node.id, pattern, candidate, true)
}

function prefixesOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}${path.sep}`) ||
    right.startsWith(`${left}${path.sep}`)
  )
}

export class PathInspectionError extends Error {
  readonly candidate: string
  readonly ancestor: string
  readonly errno: string

  constructor(candidate: string, ancestor: string, cause: unknown, errno?: string) {
    const code = errno ?? (cause as NodeJS.ErrnoException).code ?? "UNKNOWN"
    super(`Could not inspect path candidate "${candidate}" at ancestor "${ancestor}" (${code}).`, {
      cause
    })
    this.name = "PathInspectionError"
    this.candidate = candidate
    this.ancestor = ancestor
    this.errno = code
  }
}

export class DeclaredPathInspectionError extends Error {
  readonly nodeId: string
  readonly pattern: string
  readonly candidate: string
  readonly ancestor: string
  readonly errno: string

  constructor(nodeId: string, pattern: string, candidate: string, cause: PathInspectionError) {
    super(
      `Node "${nodeId}" could not inspect declared path ${JSON.stringify(pattern)} candidate "${candidate}" at ancestor "${cause.ancestor}" (${cause.errno}).`,
      { cause }
    )
    this.name = "DeclaredPathInspectionError"
    this.nodeId = nodeId
    this.pattern = pattern
    this.candidate = candidate
    this.ancestor = cause.ancestor
    this.errno = cause.errno
  }
}

let inspectPathForTests: ((ancestor: string) => void) | null = null
let caseSensitivityForTests: ((ancestor: string) => boolean | null) | null = null

export function injectPathInspectionForTests(hook: ((ancestor: string) => void) | null): void {
  inspectPathForTests = hook
}

export function injectPathCaseSensitivityForTests(
  hook: ((ancestor: string) => boolean | null) | null
): void {
  caseSensitivityForTests = hook
}

interface ResolvedPathInspection {
  readonly resolved: string
  readonly existingAncestor: string
}

interface CanonicalPathIdentity {
  readonly resolved: string
  readonly comparison: string
}

function resolvePathInspection(candidate: string): ResolvedPathInspection {
  const absoluteCandidate = path.resolve(candidate)
  let current = path.resolve(candidate)
  const suffix: string[] = []
  for (;;) {
    try {
      inspectPathForTests?.(current)
      const existingAncestor = realpathSync.native(current)
      return {
        resolved: path.join(existingAncestor, ...suffix.toReversed()),
        existingAncestor
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PathInspectionError(absoluteCandidate, current, error)
      }
      const parent = path.dirname(current)
      if (parent === current) {
        throw new PathInspectionError(absoluteCandidate, current, error)
      }
      suffix.push(path.basename(current))
      current = parent
    }
  }
}

export function resolveThroughExistingAncestor(candidate: string): string {
  return resolvePathInspection(candidate).resolved
}

export function launcherHomePath(): string {
  const configured = process.env.HOME?.trim()
  return resolveThroughExistingAncestor(
    path.resolve(configured === undefined || configured.length === 0 ? os.homedir() : configured)
  )
}

export function providerControlRoot(provider: AgentNode["provider"]): string {
  const configured =
    provider === "codex" ? process.env.CODEX_HOME?.trim() : process.env.CLAUDE_CONFIG_DIR?.trim()
  const candidate =
    configured === undefined || configured.length === 0
      ? path.join(launcherHomePath(), provider === "codex" ? ".codex" : ".claude")
      : configured
  return resolveThroughExistingAncestor(path.resolve(candidate))
}

function toggledAsciiCase(value: string): string | null {
  const index = value.search(/[A-Za-z]/)
  if (index < 0) {
    return null
  }
  const character = value[index] as string
  const toggled =
    character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()
  return `${value.slice(0, index)}${toggled}${value.slice(index + 1)}`
}

function caseSensitiveAt(candidate: string, existingAncestor: string): boolean {
  const injected = caseSensitivityForTests?.(existingAncestor)
  if (injected !== undefined && injected !== null) {
    return injected
  }
  for (let current = existingAncestor; ; current = path.dirname(current)) {
    const alternateName = toggledAsciiCase(path.basename(current))
    if (alternateName !== null) {
      const alternate = path.join(path.dirname(current), alternateName)
      try {
        inspectPathForTests?.(alternate)
        return realpathSync.native(alternate) !== realpathSync.native(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return true
        }
        throw new PathInspectionError(candidate, alternate, error)
      }
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new PathInspectionError(
        candidate,
        existingAncestor,
        new Error("No case-testable existing ancestor."),
        "ECASEUNKNOWN"
      )
    }
  }
}

function canonicalPathIdentity(candidate: string): CanonicalPathIdentity {
  const inspection = resolvePathInspection(candidate)
  const caseSensitive = caseSensitiveAt(path.resolve(candidate), inspection.existingAncestor)
  return {
    resolved: inspection.resolved,
    comparison: caseSensitive ? inspection.resolved : inspection.resolved.toLocaleLowerCase("en-US")
  }
}

function inspectDeclaredPath(
  nodeId: string,
  pattern: string,
  candidate: string,
  withCaseSemantics = false
): CanonicalPathIdentity {
  try {
    if (withCaseSemantics) {
      return canonicalPathIdentity(candidate)
    }
    const resolved = resolveThroughExistingAncestor(candidate)
    return { resolved, comparison: resolved }
  } catch (error) {
    if (error instanceof PathInspectionError) {
      throw new DeclaredPathInspectionError(nodeId, pattern, path.resolve(candidate), error)
    }
    throw error
  }
}

export interface OrchestrateAuthorityPolicy {
  /** Durable runtime state and cross-attempt transport that workflow agents must never read. */
  readonly denyReadRoots: readonly string[]
  /** Launcher-owned state, credentials, installation, and skill assets that agents cannot mutate. */
  readonly denyWriteRoots: readonly string[]
}

export function orchestrateAuthorityPolicy(): OrchestrateAuthorityPolicy {
  const home = launcherHomePath()
  const configuredBinary = process.env.ORCHESTRATE_BIN?.trim()
  const embeddedExecutable = path.basename(process.execPath).startsWith("orchestrate")
    ? process.execPath
    : null
  // Provider configuration remains readable because each CLI legitimately
  // consumes credentials and account state there. It is still immutable to
  // workflow nodes. Durable Orchestrate state and cross-attempt transport are
  // both unreadable and immutable.
  const providerControlRoots = [providerControlRoot("codex"), providerControlRoot("claude")]
  const denyReadRoots = [
    ...new Set(
      [stateRoot(), submissionsRoot(), providerSessionsRoot()].map(resolveThroughExistingAncestor)
    )
  ]
  const denyWriteRoots = [
    ...new Set(
      [
        ...denyReadRoots,
        ...providerControlRoots,
        path.join(home, ".local", "share", "orchestrate"),
        path.join(home, ".local", "bin", "orchestrate"),
        path.join(home, ".agents", "skills", "orchestrate"),
        path.join(home, ".codex", "skills", "orchestrate"),
        path.join(home, ".claude", "skills", "orchestrate"),
        ...(configuredBinary === undefined || configuredBinary.length === 0
          ? []
          : [configuredBinary]),
        ...(embeddedExecutable === null ? [] : [embeddedExecutable])
      ].map(resolveThroughExistingAncestor)
    )
  ]
  return { denyReadRoots, denyWriteRoots }
}

export function orchestrateAuthorityPaths(): readonly string[] {
  return orchestrateAuthorityPolicy().denyWriteRoots
}

export function isMutatingProviderNode(node: WorkflowNode): node is AgentNode {
  return (
    node.type === "agent" &&
    ((node.provider === "codex" && node.permissions.execution.sandbox === "workspace-write") ||
      (node.provider === "claude" && node.permissions.execution.permissionMode !== "plan"))
  )
}

export function providerAuthorityOverlaps(
  workflow: WorkflowSpec,
  node: WorkflowNode,
  effectiveRoot = node.workspace.mode === "git-worktree" && node.workspace.path === null
    ? path.join(os.tmpdir(), "orchestrate-worktrees", "validation", node.id)
    : (node.workspace.path ?? node.cwd ?? workflow.cwd),
  additionalAuthorityPaths: readonly string[] = []
): readonly string[] {
  if (!isMutatingProviderNode(node)) {
    return []
  }
  const roots = [
    ...node.workspace.writes.map(
      (pattern) =>
        [
          `declared write ${JSON.stringify(pattern)}`,
          path.resolve(effectiveRoot, normalizedStaticPrefix(pattern)),
          pattern
        ] as const
    ),
    ["provider sandbox root", effectiveRoot, "provider sandbox root"] as const
  ]
  let protectedPaths: readonly string[]
  try {
    protectedPaths = [
      ...orchestrateAuthorityPaths(),
      ...additionalAuthorityPaths.map(resolveThroughExistingAncestor)
    ]
  } catch (error) {
    if (error instanceof PathInspectionError) {
      const [, candidate, pattern] = roots[0] as readonly [string, string, string]
      throw new DeclaredPathInspectionError(node.id, pattern, candidate, error)
    }
    throw error
  }
  return roots.flatMap(([label, candidate, pattern]) => {
    const resolved = inspectDeclaredPath(node.id, pattern, candidate).resolved
    const authority = protectedPaths.find((protectedPath) =>
      prefixesOverlap(resolved, protectedPath)
    )
    return authority === undefined ? [] : [`${label} ${resolved} overlaps ${authority}`]
  })
}

export function providerNonCanonicalWritePrefixes(
  workflow: WorkflowSpec,
  node: WorkflowNode
): readonly string[] {
  if (!isMutatingProviderNode(node)) {
    return []
  }
  if (node.workspace.mode === "git-worktree" && node.workspace.path === null) {
    return []
  }
  const rootCandidate = node.workspace.path ?? node.cwd ?? workflow.cwd
  const effectiveRoot = inspectDeclaredPath(node.id, "provider root", rootCandidate).resolved
  return node.workspace.writes.flatMap((pattern) => {
    const unresolved = path.resolve(effectiveRoot, normalizedStaticPrefix(pattern))
    const resolved = inspectDeclaredPath(node.id, pattern, unresolved).resolved
    return resolved === unresolved
      ? []
      : [`declared write ${JSON.stringify(pattern)} resolves through a symlink to ${resolved}`]
  })
}

export function assertProviderAuthorityIsolation(
  workflow: WorkflowSpec,
  node: WorkflowNode,
  effectiveRoot?: string,
  additionalAuthorityPaths: readonly string[] = []
): void {
  const overlaps = providerAuthorityOverlaps(
    workflow,
    node,
    effectiveRoot,
    additionalAuthorityPaths
  )
  if (overlaps.length > 0) {
    throw new Error(
      `Mutating provider node "${node.id}" overlaps Orchestrate-owned authority: ${overlaps.join("; ")}.`
    )
  }
}

export function assertWorkflowProviderLaunchIsolation(
  workflow: WorkflowSpec,
  identities: readonly ProviderLaunchIdentity[]
): void {
  for (const node of workflow.nodes) {
    if (node.type === "command" ? !node.mutates : !isMutatingProviderNode(node)) {
      continue
    }
    const effectiveRoot =
      node.workspace.mode === "git-worktree" && node.workspace.path === null
        ? path.join(os.tmpdir(), "orchestrate-worktrees", "validation", node.id)
        : (node.workspace.path ?? node.cwd ?? workflow.cwd)
    const writeAuthorities = node.workspace.writes.map((pattern) => {
      const candidate = path.resolve(effectiveRoot, normalizedStaticPrefix(pattern))
      return {
        label: `declared write ${JSON.stringify(pattern)}`,
        resolved: inspectDeclaredPath(node.id, pattern, candidate).resolved
      }
    })
    const rootLabel = node.type === "command" ? "mutating command root" : "provider sandbox root"
    writeAuthorities.push({
      label: rootLabel,
      resolved: inspectDeclaredPath(node.id, rootLabel, effectiveRoot).resolved
    })
    for (const identity of identities) {
      for (const launchAuthority of identity.authorityEntries) {
        const overlaps = writeAuthorities.filter(({ resolved }) =>
          prefixesOverlap(resolved, launchAuthority.path)
        )
        if (overlaps.length > 0) {
          throw new Error(
            `Mutating node "${node.id}" overlaps ${identity.provider} ${launchAuthority.label} "${launchAuthority.path}": ${overlaps.map(({ label, resolved }) => `${label} ${resolved}`).join("; ")}.`
          )
        }
      }
    }
  }
}

export function overlappingMutableNodes(workflow: WorkflowSpec): readonly [string, string][] {
  const { ancestors } = graphMaps(workflow.nodes)
  const overlaps: [string, string][] = []
  for (let leftIndex = 0; leftIndex < workflow.nodes.length; leftIndex += 1) {
    const left = workflow.nodes[leftIndex]
    if (left === undefined || left.workspace.writes.length === 0) {
      continue
    }
    for (let rightIndex = leftIndex + 1; rightIndex < workflow.nodes.length; rightIndex += 1) {
      const right = workflow.nodes[rightIndex]
      if (right === undefined || right.workspace.writes.length === 0) {
        continue
      }
      if (
        ancestors.get(left.id)?.has(right.id) === true ||
        ancestors.get(right.id)?.has(left.id) === true
      ) {
        continue
      }
      const overlap = left.workspace.writes.some((leftPattern) =>
        right.workspace.writes.some((rightPattern) => {
          const a = absoluteWritePrefix(workflow, left, leftPattern)
          const b = absoluteWritePrefix(workflow, right, rightPattern)
          return a !== null && b !== null && prefixesOverlap(a.comparison, b.comparison)
        })
      )
      if (overlap) {
        overlaps.push([left.id, right.id])
      }
    }
  }
  return overlaps
}

function validateEnvironment(
  issues: ValidationIssue[],
  nodeId: string,
  inherited: readonly string[],
  explicit: Readonly<Record<string, string>>,
  fieldBase: string,
  agentEnvironment: boolean
): void {
  const invalid = [...inherited, ...Object.keys(explicit)].find(
    (name) => !ENVIRONMENT_NAME.test(name)
  )
  if (invalid !== undefined) {
    const inheritedIndex = inherited.indexOf(invalid)
    addIssue(
      issues,
      "error",
      "environment-name",
      `Node "${nodeId}" has invalid environment variable name "${invalid}".`,
      {
        path:
          inheritedIndex >= 0
            ? `${fieldBase}/inheritEnv/${inheritedIndex}`
            : `${fieldBase}/env/${pointerSegment(invalid)}`,
        primaryNode: nodeId
      }
    )
  }
  if (new Set(inherited).size !== inherited.length) {
    addIssue(
      issues,
      "error",
      "environment-name",
      `Node "${nodeId}" repeats an inherited environment variable.`,
      { path: `${fieldBase}/inheritEnv`, primaryNode: nodeId }
    )
  }
  const isReserved = (name: string): boolean =>
    agentEnvironment ? isLauncherOwnedAgentEnvironment(name) : LAUNCHER_ENVIRONMENT.has(name)
  for (const [index, name] of inherited.entries()) {
    if (!isReserved(name)) {
      continue
    }
    issues.push({
      severity: "error",
      code: "reserved-environment",
      message: `Node "${nodeId}" inheritEnv contains launcher-owned environment variable "${name}".`,
      path: `${fieldBase}/inheritEnv/${index}`,
      nodes: [nodeId],
      primaryNode: nodeId
    })
  }
  for (const name of Object.keys(explicit)) {
    if (!isReserved(name)) {
      continue
    }
    issues.push({
      severity: "error",
      code: "reserved-environment",
      message: `Node "${nodeId}" env contains launcher-owned environment variable "${name}".`,
      path: `${fieldBase}/env/${pointerSegment(name)}`,
      nodes: [nodeId],
      primaryNode: nodeId
    })
  }
}

function validateProviderArguments(
  node: AgentNode,
  issues: ValidationIssue[],
  nodePointer: string
): void {
  const reserved =
    node.provider === "codex"
      ? [
          "--sandbox",
          "-s",
          "--dangerously-bypass-approvals-and-sandbox",
          "--dangerously-bypass-hook-trust",
          "--full-auto",
          "--ask-for-approval",
          "-a",
          "--add-dir",
          "--profile",
          "-p",
          "--cd",
          "--model",
          "-m",
          "--config",
          "-c",
          "--enable",
          "--disable",
          "--remote",
          "--remote-auth-token-env",
          "--search",
          "--oss",
          "--local-provider",
          "--output-schema",
          "--json",
          "--session-id",
          "--"
        ]
      : [
          "--permission-mode",
          "--dangerously-skip-permissions",
          "--allow-dangerously-skip-permissions",
          "--allowedtools",
          "--allowed-tools",
          "--disallowedtools",
          "--disallowed-tools",
          "--tools",
          "--add-dir",
          "--settings",
          "--setting-sources",
          "--safe-mode",
          "--bare",
          "--mcp-config",
          "--strict-mcp-config",
          "--agent",
          "--agents",
          "--plugin-dir",
          "--plugin-url",
          "--worktree",
          "-w",
          "--tmux",
          "--chrome",
          "--ide",
          "--remote-control",
          "--system-prompt",
          "--system-prompt-file",
          "--append-system-prompt",
          "--append-system-prompt-file",
          "--model",
          "--effort",
          "--resume",
          "-r",
          "--continue",
          "-c",
          "--fork-session",
          "--session-id",
          "--json-schema",
          "--output-format",
          "--print",
          "-p",
          "--add-dir",
          "--"
        ]
  if (node.provider === "claude" && node.permissions.extraArgs.length > 0) {
    addIssue(
      issues,
      "error",
      "reserved-provider-argument",
      `Node "${node.id}" cannot use Claude extraArgs; the launcher reserves the complete permission and sandbox surface.`,
      { path: `${nodePointer}/permissions/extraArgs`, primaryNode: node.id }
    )
    return
  }
  const conflict = node.permissions.extraArgs.find((argument) => {
    const normalized = argument.toLowerCase()
    return reserved.some(
      (flag) =>
        normalized === flag ||
        normalized.startsWith(`${flag}=`) ||
        (/^-[a-z]$/.test(flag) && normalized.startsWith(flag) && normalized.length > 2)
    )
  })
  if (conflict !== undefined) {
    addIssue(
      issues,
      "error",
      "reserved-provider-argument",
      `Node "${node.id}" extraArgs contains reserved argument "${conflict}"; use the explicit contract field.`,
      { path: `${nodePointer}/permissions/extraArgs`, primaryNode: node.id }
    )
  }
}

function validateNode(workflow: WorkflowSpec, node: WorkflowNode, issues: ValidationIssue[]): void {
  const nodePointer = `/nodes/${workflow.nodes.indexOf(node)}`
  if (!NODE_ID.test(node.id) || ROUND_INSTANCE_SUFFIX.test(node.id)) {
    addIssue(
      issues,
      "error",
      "node-id",
      `Node "${node.id}" must use lowercase letters, digits, and hyphens and must not end in reserved --r<N>.`,
      { path: `${nodePointer}/id`, primaryNode: node.id }
    )
  }
  if (node.cwd !== null && !path.isAbsolute(node.cwd)) {
    addIssue(issues, "error", "node-cwd", `Node "${node.id}" cwd must be absolute or null.`, {
      path: `${nodePointer}/cwd`,
      primaryNode: node.id
    })
  }
  if (node.workspace.path !== null && !path.isAbsolute(node.workspace.path)) {
    addIssue(
      issues,
      "error",
      "workspace-path",
      `Node "${node.id}" workspace path must be absolute or null.`,
      { path: `${nodePointer}/workspace/path`, primaryNode: node.id }
    )
  }
  const canMutate =
    node.type === "command"
      ? node.mutates
      : (node.provider === "codex" && node.permissions.execution.sandbox !== "read-only") ||
        (node.provider === "claude" && node.permissions.execution.permissionMode !== "plan")
  if (canMutate && node.workspace.writes.length === 0) {
    addIssue(
      issues,
      "warning",
      "unknown-writes",
      `Potentially mutating node "${node.id}" declares no write set.`,
      { path: `${nodePointer}/workspace/writes`, primaryNode: node.id }
    )
  }
  try {
    const authorityOverlaps = providerAuthorityOverlaps(workflow, node)
    if (authorityOverlaps.length > 0) {
      addIssue(
        issues,
        "error",
        "protected-path",
        `Mutating provider node "${node.id}" overlaps Orchestrate-owned authority: ${authorityOverlaps.join("; ")}.`,
        { path: `${nodePointer}/workspace`, primaryNode: node.id }
      )
    }
    const nonCanonicalWrites = providerNonCanonicalWritePrefixes(workflow, node)
    if (nonCanonicalWrites.length > 0) {
      addIssue(
        issues,
        "error",
        "workspace-write-symlink",
        `Mutating provider node "${node.id}" has a non-canonical write prefix: ${nonCanonicalWrites.join("; ")}. Use the canonical target.`,
        { path: `${nodePointer}/workspace/writes`, primaryNode: node.id }
      )
    }
  } catch (error) {
    if (!(error instanceof DeclaredPathInspectionError)) {
      throw error
    }
    addIssue(issues, "error", "workspace-path-inspection", error.message, {
      path: `${nodePointer}/workspace/writes`,
      primaryNode: node.id
    })
  }
  if (
    canMutate &&
    node.workspace.vcs === "plastic" &&
    node.workspace.writes.length > 0 &&
    !node.workspace.exclusiveResources.includes("plastic-scm")
  ) {
    addIssue(
      issues,
      "warning",
      "plastic-resource",
      `Mutating Plastic node "${node.id}" should reserve "plastic-scm".`,
      { path: `${nodePointer}/workspace/exclusiveResources`, primaryNode: node.id }
    )
  }
  const inputLabels = new Set<string>()
  for (const [inputIndex, input] of node.inputs.entries()) {
    if (inputLabels.has(input.as)) {
      addIssue(
        issues,
        "error",
        "input-label",
        `Node "${node.id}" repeats input label "${input.as}".`,
        { path: `${nodePointer}/inputs/${inputIndex}/as`, primaryNode: node.id }
      )
    }
    inputLabels.add(input.as)
  }

  if (node.type === "command") {
    if (
      !node.inheritEnv.includes("PATH") &&
      !Object.hasOwn(node.env, "PATH") &&
      !path.isAbsolute(node.argv[0] as string)
    ) {
      addIssue(
        issues,
        "error",
        "command-path",
        `Command node "${node.id}" argv[0] must be absolute unless PATH is explicitly provided.`,
        { path: `${nodePointer}/argv/0`, primaryNode: node.id }
      )
    }
    if (!node.mutates && node.workspace.writes.length > 0) {
      addIssue(
        issues,
        "error",
        "command-writes",
        `Command node "${node.id}" declares writes while mutates=false.`,
        { path: `${nodePointer}/workspace/writes`, primaryNode: node.id }
      )
    }
    validateEnvironment(issues, node.id, node.inheritEnv, node.env, nodePointer, false)
    return
  }

  validateProviderArguments(node, issues, nodePointer)
  if (node.provider === "claude") {
    const mode = node.permissions.execution.permissionMode
    if (mode !== "dontAsk") {
      addIssue(
        issues,
        "error",
        "unsupported-permission-mode",
        `Claude permission mode "${mode}" is not confined enough for workflow execution; use dontAsk with the launcher-owned fail-closed sandbox.`,
        { path: `${nodePointer}/permissions/execution/permissionMode`, primaryNode: node.id }
      )
    }
    const requiredEscalation =
      mode === "dontAsk" || mode === "bypassPermissions"
        ? "deny"
        : mode === "auto"
          ? "auto-review"
          : "ask-user"
    if (node.permissions.escalation !== requiredEscalation) {
      addIssue(
        issues,
        "error",
        "permission-escalation",
        `Claude permission mode "${mode}" requires escalation="${requiredEscalation}" for node "${node.id}".`,
        { path: `${nodePointer}/permissions/escalation`, primaryNode: node.id }
      )
    }
  }
  validateEnvironment(
    issues,
    node.id,
    node.permissions.inheritEnv,
    node.permissions.env,
    `${nodePointer}/permissions`,
    true
  )
  if (node.model.toLowerCase().startsWith("provider-") && node.model !== "provider-default") {
    addIssue(
      issues,
      "error",
      "model",
      `Node "${node.id}" must use exactly "provider-default" or a real model name.`,
      { path: `${nodePointer}/model`, primaryNode: node.id }
    )
  }
  if (node.session.mode === "fresh" && node.session.from !== null) {
    addIssue(
      issues,
      "error",
      "session-source",
      `Fresh node "${node.id}" must set session.from to null.`,
      { path: `${nodePointer}/session/from`, primaryNode: node.id }
    )
  }
  if (node.session.mode !== "fresh" && node.session.from === null) {
    addIssue(
      issues,
      "error",
      "session-source",
      `Node "${node.id}" must name the session it resumes or forks.`,
      { path: `${nodePointer}/session/from`, primaryNode: node.id }
    )
  }
  if (node.output.format === "text" && node.output.schema !== null) {
    addIssue(
      issues,
      "error",
      "output-schema",
      `Text node "${node.id}" must set output.schema to null.`,
      { path: `${nodePointer}/output/schema`, primaryNode: node.id }
    )
  }
  if (node.output.format === "json" && node.output.schema === null) {
    addIssue(
      issues,
      "error",
      "output-schema",
      `JSON node "${node.id}" must provide an output schema.`,
      { path: `${nodePointer}/output/schema`, primaryNode: node.id }
    )
  }
  if (node.output.schema !== null) {
    try {
      new Ajv2020({ strict: false }).compile(node.output.schema)
    } catch (error) {
      addIssue(
        issues,
        "error",
        "output-schema",
        `Node "${node.id}" output schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
        { path: `${nodePointer}/output/schema`, primaryNode: node.id }
      )
    }
  }
}

function validateRepeats(
  workflow: WorkflowSpec,
  issues: ValidationIssue[],
  byId: ReadonlyMap<string, WorkflowNode>,
  ancestors: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyMap<string, string> {
  const memberToRepeat = new Map<string, string>()
  const repeatIds = new Set<string>()
  for (const [repeatIndex, repeat] of workflow.repeats.entries()) {
    const repeatPointer = `/repeats/${repeatIndex}`
    if (!NODE_ID.test(repeat.id) || ROUND_INSTANCE_SUFFIX.test(repeat.id)) {
      addIssue(
        issues,
        "error",
        "repeat-id",
        `Repeat "${repeat.id}" must use an unreserved lowercase id.`,
        { path: `${repeatPointer}/id` }
      )
    }
    if (repeatIds.has(repeat.id) || byId.has(repeat.id)) {
      addIssue(issues, "error", "repeat-id", `Repeat id "${repeat.id}" is not unique.`, {
        path: `${repeatPointer}/id`,
        ...(byId.has(repeat.id) ? { relatedNodes: [repeat.id] } : {})
      })
    }
    repeatIds.add(repeat.id)
    if (new Set(repeat.members).size !== repeat.members.length) {
      addIssue(issues, "error", "repeat-members", `Repeat "${repeat.id}" repeats a member id.`, {
        path: `${repeatPointer}/members`
      })
    }
    for (const [memberIndex, member] of repeat.members.entries()) {
      const node = byId.get(member)
      if (node === undefined) {
        addIssue(
          issues,
          "error",
          "repeat-members",
          `Repeat "${repeat.id}" names unknown member "${member}".`,
          { path: `${repeatPointer}/members/${memberIndex}` }
        )
        continue
      }
      const owner = memberToRepeat.get(member)
      if (owner !== undefined) {
        addIssue(
          issues,
          "error",
          "repeat-members",
          `Node "${member}" belongs to both repeat "${owner}" and "${repeat.id}".`,
          {
            path: `${repeatPointer}/members/${memberIndex}`,
            relatedNodes: [member]
          }
        )
      }
      memberToRepeat.set(member, repeat.id)
      const memberPointer = `/nodes/${workflow.nodes.indexOf(node)}`
      if (
        node.workspace.mode === "git-worktree" &&
        !node.workspace.git.branch.includes("{{nodeId}}")
      ) {
        addIssue(
          issues,
          "error",
          "repeat-worktree-branch",
          `Repeat member "${member}" Git worktree branch must include {{nodeId}} so every runtime round has a unique branch.`,
          { path: `${memberPointer}/workspace/git/branch`, primaryNode: member }
        )
      }
      if (
        node.workspace.mode === "git-worktree" &&
        node.workspace.path !== null &&
        !node.workspace.path.includes("{{nodeId}}")
      ) {
        addIssue(
          issues,
          "error",
          "repeat-worktree-path",
          `Repeat member "${member}" explicit Git worktree path must include {{nodeId}} so every runtime round has a unique directory.`,
          { path: `${memberPointer}/workspace/path`, primaryNode: member }
        )
      }
    }
    if (!repeat.members.includes(repeat.until.node)) {
      addIssue(
        issues,
        "error",
        "repeat-until",
        `Repeat "${repeat.id}" until node "${repeat.until.node}" must be a member.`,
        {
          path: `${repeatPointer}/until/node`,
          ...(byId.has(repeat.until.node) ? { relatedNodes: [repeat.until.node] } : {})
        }
      )
      continue
    }
    const untilNode = byId.get(repeat.until.node)
    if (repeat.until.type === "command-success" && untilNode?.type !== "command") {
      addIssue(
        issues,
        "error",
        "repeat-until",
        `Repeat "${repeat.id}" command-success condition must name a command node.`,
        { path: `${repeatPointer}/until/node`, relatedNodes: [repeat.until.node] }
      )
    }
    if (repeat.until.type === "agent-output") {
      if (
        untilNode?.type !== "agent" ||
        untilNode.output.format !== "json" ||
        untilNode.output.schema === null
      ) {
        addIssue(
          issues,
          "error",
          "repeat-until",
          `Repeat "${repeat.id}" agent-output condition must name a schema-validated JSON agent node.`,
          { path: `${repeatPointer}/until/node`, relatedNodes: [repeat.until.node] }
        )
      }
      if (!JSON_POINTER.test(repeat.until.pointer)) {
        addIssue(
          issues,
          "error",
          "repeat-until",
          `Repeat "${repeat.id}" pointer must be an RFC 6901 JSON pointer.`,
          { path: `${repeatPointer}/until/pointer`, relatedNodes: [repeat.until.node] }
        )
      }
    }
  }

  for (const [nodeIndex, node] of workflow.nodes.entries()) {
    const nodePointer = `/nodes/${nodeIndex}`
    const nodeRepeat = memberToRepeat.get(node.id)
    for (const [dependencyIndex, dependency] of node.needs.entries()) {
      const dependencyRepeat = memberToRepeat.get(dependency)
      if (
        nodeRepeat !== undefined &&
        dependencyRepeat !== undefined &&
        nodeRepeat !== dependencyRepeat
      ) {
        addIssue(
          issues,
          "error",
          "repeat-dependency",
          `Repeat member "${node.id}" cannot depend on member "${dependency}" from another repeat.`,
          {
            path: `${nodePointer}/needs/${dependencyIndex}`,
            primaryNode: node.id,
            relatedNodes: [dependency]
          }
        )
      }
    }
    for (const [inputIndex, input] of node.inputs.entries()) {
      if (input.round === "previous") {
        const sourceRepeat = memberToRepeat.get(input.from)
        if (nodeRepeat === undefined || sourceRepeat !== nodeRepeat) {
          addIssue(
            issues,
            "error",
            "input-round",
            `Node "${node.id}" previous-round input "${input.from}" must come from the same repeat.`,
            {
              path: `${nodePointer}/inputs/${inputIndex}/from`,
              primaryNode: node.id,
              relatedNodes: [input.from]
            }
          )
        }
      } else if (input.from === node.id || ancestors.get(node.id)?.has(input.from) !== true) {
        addIssue(
          issues,
          "error",
          "input-order",
          `Node "${node.id}" current-round input "${input.from}" must be an ancestor dependency.`,
          {
            path: `${nodePointer}/inputs/${inputIndex}/from`,
            primaryNode: node.id,
            relatedNodes: [input.from]
          }
        )
      }
    }
  }
  return memberToRepeat
}

function validateConditions(
  workflow: WorkflowSpec,
  issues: ValidationIssue[],
  byId: ReadonlyMap<string, WorkflowNode>,
  memberToRepeat: ReadonlyMap<string, string>
): void {
  const verdictNodes = new Set(workflow.repeats.map((repeat) => repeat.until.node))
  for (const [nodeIndex, node] of workflow.nodes.entries()) {
    const nodePointer = `/nodes/${nodeIndex}`
    if (
      node.type === "agent" &&
      node.prompt.includes("{{round}}") &&
      memberToRepeat.get(node.id) === undefined
    ) {
      addIssue(
        issues,
        "error",
        "prompt-round",
        `Node "${node.id}" uses {{round}} but is not a repeat member.`,
        { path: `${nodePointer}/prompt`, primaryNode: node.id }
      )
    }
    const condition = node.when
    if (condition !== undefined) {
      const source = byId.get(condition.node)
      if (!node.needs.includes(condition.node)) {
        addIssue(
          issues,
          "error",
          "condition-order",
          `Node "${node.id}" when condition must name a direct dependency.`,
          { path: `${nodePointer}/when/node`, primaryNode: node.id, relatedNodes: [condition.node] }
        )
      }
      if (
        source?.type !== "agent" ||
        source.output.format !== "json" ||
        source.output.schema === null
      ) {
        addIssue(
          issues,
          "error",
          "condition-source",
          `Node "${node.id}" when condition must name a schema-validated JSON agent node.`,
          { path: `${nodePointer}/when/node`, primaryNode: node.id, relatedNodes: [condition.node] }
        )
      }
      if (verdictNodes.has(node.id)) {
        addIssue(
          issues,
          "error",
          "condition-verdict",
          `Repeat verdict node "${node.id}" cannot be conditional.`,
          { path: `${nodePointer}/when`, primaryNode: node.id }
        )
      }
      if (node.type === "agent" && node.session.saveAs !== null) {
        addIssue(
          issues,
          "error",
          "condition-session",
          `Conditional node "${node.id}" cannot produce session alias "${node.session.saveAs}".`,
          { path: `${nodePointer}/session/saveAs`, primaryNode: node.id }
        )
      }
      const nodeRepeat = memberToRepeat.get(node.id)
      const sourceRepeat = memberToRepeat.get(condition.node)
      if (nodeRepeat !== undefined && sourceRepeat !== undefined && nodeRepeat !== sourceRepeat) {
        addIssue(
          issues,
          "error",
          "condition-repeat",
          `Repeat member "${node.id}" cannot be conditioned by member "${condition.node}" from another repeat.`,
          { path: `${nodePointer}/when/node`, primaryNode: node.id, relatedNodes: [condition.node] }
        )
      }
    }
    for (const [inputIndex, input] of node.inputs.entries()) {
      if (input.include === "path" && byId.get(input.from)?.when !== undefined) {
        addIssue(
          issues,
          "error",
          "conditional-input-path",
          `Node "${node.id}" cannot request a path input from conditional node "${input.from}".`,
          {
            path: `${nodePointer}/inputs/${inputIndex}/from`,
            primaryNode: node.id,
            relatedNodes: [input.from]
          }
        )
      }
    }
  }
}

function validateSessions(
  workflow: WorkflowSpec,
  issues: ValidationIssue[],
  ancestors: ReadonlyMap<string, ReadonlySet<string>>,
  memberToRepeat: ReadonlyMap<string, string>
): void {
  const aliases = new Map<string, AgentNode>()
  for (const [nodeIndex, node] of workflow.nodes.entries()) {
    if (node.type !== "agent" || node.session.saveAs === null) {
      continue
    }
    const existing = aliases.get(node.session.saveAs)
    if (existing !== undefined) {
      addIssue(
        issues,
        "error",
        "session-alias",
        `Session alias "${node.session.saveAs}" is produced by both "${existing.id}" and "${node.id}".`,
        {
          path: `/nodes/${nodeIndex}/session/saveAs`,
          primaryNode: node.id,
          relatedNodes: [existing.id]
        }
      )
    } else {
      aliases.set(node.session.saveAs, node)
    }
  }
  for (const [nodeIndex, node] of workflow.nodes.entries()) {
    if (
      node.type !== "agent" ||
      memberToRepeat.get(node.id) === undefined ||
      node.session.mode === "fresh"
    ) {
      continue
    }
    const source = node.session.from === null ? undefined : aliases.get(node.session.from)
    if (node.session.mode !== "resume") {
      addIssue(
        issues,
        "error",
        "repeat-session",
        `Persistent repeat member "${node.id}" must resume an existing session; fork is not supported.`,
        { path: `/nodes/${nodeIndex}/session/mode`, primaryNode: node.id }
      )
    }
    if (node.session.saveAs !== null) {
      addIssue(
        issues,
        "error",
        "repeat-session",
        `Persistent repeat member "${node.id}" cannot create session alias "${node.session.saveAs}".`,
        { path: `/nodes/${nodeIndex}/session/saveAs`, primaryNode: node.id }
      )
    }
    if (source !== undefined && memberToRepeat.get(source.id) !== undefined) {
      addIssue(
        issues,
        "error",
        "repeat-session-source",
        `Persistent repeat member "${node.id}" must resume a session seeded outside its repeat.`,
        {
          path: `/nodes/${nodeIndex}/session/from`,
          primaryNode: node.id,
          relatedNodes: [source.id]
        }
      )
    }
    if (source?.when !== undefined) {
      addIssue(
        issues,
        "error",
        "repeat-session-source",
        `Persistent repeat member "${node.id}" cannot resume conditionally produced session alias "${node.session.from ?? ""}".`,
        {
          path: `/nodes/${nodeIndex}/session/from`,
          primaryNode: node.id,
          relatedNodes: [source.id]
        }
      )
    }
  }
  for (const [nodeIndex, node] of workflow.nodes.entries()) {
    if (node.type !== "agent" || node.session.mode === "fresh" || node.session.from === null) {
      continue
    }
    const source = aliases.get(node.session.from)
    if (source === undefined) {
      addIssue(
        issues,
        "error",
        "session-source",
        `Node "${node.id}" names unknown session alias "${node.session.from}".`,
        { path: `/nodes/${nodeIndex}/session/from`, primaryNode: node.id }
      )
    } else if (source.provider !== node.provider) {
      addIssue(
        issues,
        "error",
        "session-provider",
        `Node "${node.id}" cannot continue a ${source.provider} session with ${node.provider}.`,
        {
          path: `/nodes/${nodeIndex}/session/from`,
          primaryNode: node.id,
          relatedNodes: [source.id]
        }
      )
    } else if (ancestors.get(node.id)?.has(source.id) !== true) {
      addIssue(
        issues,
        "error",
        "session-order",
        `Node "${node.id}" session source "${source.id}" must be an ancestor dependency.`,
        {
          path: `/nodes/${nodeIndex}/session/from`,
          primaryNode: node.id,
          relatedNodes: [source.id]
        }
      )
    } else if (source.workroom !== node.workroom || source.seat !== node.seat) {
      addIssue(
        issues,
        "error",
        "session-presentation",
        `Node "${node.id}" cannot continue session source "${source.id}" across workrooms or seats.`,
        {
          path: `/nodes/${nodeIndex}/session/from`,
          primaryNode: node.id,
          relatedNodes: [source.id]
        }
      )
    }
  }

  const lineageMemo = new Map<string, string>()
  const activeLineage = new Set<string>()
  const lineageFor = (node: AgentNode): string => {
    const cached = lineageMemo.get(node.id)
    if (cached !== undefined) {
      return cached
    }
    if (activeLineage.has(node.id)) {
      return `invalid-cycle:${node.id}`
    }
    activeLineage.add(node.id)
    if (node.session.mode !== "resume" || node.session.from === null) {
      const own = node.session.saveAs ?? `node:${node.id}`
      lineageMemo.set(node.id, own)
      activeLineage.delete(node.id)
      return own
    }
    const source = aliases.get(node.session.from)
    const lineage = source === undefined ? node.session.from : lineageFor(source)
    lineageMemo.set(node.id, lineage)
    activeLineage.delete(node.id)
    return lineage
  }
  const resumptions = new Map<string, AgentNode[]>()
  for (const node of workflow.nodes) {
    if (node.type !== "agent" || node.session.mode !== "resume") {
      continue
    }
    const lineage = lineageFor(node)
    resumptions.set(lineage, [...(resumptions.get(lineage) ?? []), node])
  }
  for (const nodes of resumptions.values()) {
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex] as AgentNode
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const right = nodes[rightIndex] as AgentNode
        if (
          ancestors.get(left.id)?.has(right.id) !== true &&
          ancestors.get(right.id)?.has(left.id) !== true
        ) {
          addIssue(
            issues,
            "error",
            "session-fanout",
            `Nodes "${left.id}" and "${right.id}" resume the same mutable session without an ordering dependency; use a linear chain or fork.`,
            {
              path: `/nodes/${workflow.nodes.indexOf(left)}/session/from`,
              primaryNode: left.id,
              relatedNodes: [right.id]
            }
          )
        }
      }
    }
  }
}

function repeatAwareAncestors(
  workflow: WorkflowSpec,
  memberToRepeat: ReadonlyMap<string, string>
): {
  readonly ancestors: ReadonlyMap<string, ReadonlySet<string>>
  readonly cycles: readonly (readonly string[])[]
} {
  const repeatById = new Map(workflow.repeats.map((repeat) => [repeat.id, repeat]))
  const dependencies = new Map(
    workflow.nodes.map((node) => {
      const nodeRepeat = memberToRepeat.get(node.id)
      const expanded = node.needs.flatMap((dependency) => {
        const dependencyRepeat = memberToRepeat.get(dependency)
        if (dependencyRepeat === undefined || dependencyRepeat === nodeRepeat) {
          return [dependency]
        }
        return repeatById.get(dependencyRepeat)?.members ?? [dependency]
      })
      return [node.id, [...new Set(expanded)]] as const
    })
  )
  const memo = new Map<string, Set<string>>()
  const active = new Set<string>()
  const stack: string[] = []
  const cycleKeys = new Set<string>()
  const cycles: string[][] = []
  const visit = (nodeId: string): Set<string> => {
    const cached = memo.get(nodeId)
    if (cached !== undefined) {
      return cached
    }
    if (active.has(nodeId)) {
      const start = stack.indexOf(nodeId)
      const cycle = [...stack.slice(start), nodeId]
      const key = [...new Set(cycle.slice(0, -1))].toSorted().join("\u0000")
      if (!cycleKeys.has(key)) {
        cycleKeys.add(key)
        cycles.push(cycle)
      }
      return new Set()
    }
    active.add(nodeId)
    stack.push(nodeId)
    const result = new Set<string>()
    for (const dependency of dependencies.get(nodeId) ?? []) {
      result.add(dependency)
      for (const ancestor of visit(dependency)) {
        result.add(ancestor)
      }
    }
    stack.pop()
    active.delete(nodeId)
    memo.set(nodeId, result)
    return result
  }
  for (const node of workflow.nodes) {
    visit(node.id)
  }
  return { ancestors: memo, cycles }
}

function validatePresentation(
  workflow: WorkflowSpec,
  issues: ValidationIssue[],
  byId: ReadonlyMap<string, WorkflowNode>,
  memberToRepeat: ReadonlyMap<string, string>
): void {
  const workrooms = workflow.presentation?.workrooms ?? []
  const workroomById = new Map<string, (typeof workrooms)[number]>()
  const seatToWorkroom = new Map<string, string>()

  for (const [workroomIndex, workroom] of workrooms.entries()) {
    const workroomPointer = `/presentation/workrooms/${workroomIndex}`
    if (workroomById.has(workroom.id)) {
      addIssue(issues, "error", "workroom-id", `Workroom id "${workroom.id}" is duplicated.`, {
        path: `${workroomPointer}/id`
      })
    } else {
      workroomById.set(workroom.id, workroom)
    }
    if (new Set(workroom.settlesOn).size !== workroom.settlesOn.length) {
      addIssue(
        issues,
        "error",
        "workroom-settlement",
        `Workroom "${workroom.id}" repeats a settlesOn node.`,
        { path: `${workroomPointer}/settlesOn` }
      )
    }
    for (const [anchorIndex, anchor] of workroom.settlesOn.entries()) {
      if (!byId.has(anchor)) {
        addIssue(
          issues,
          "error",
          "workroom-settlement",
          `Workroom "${workroom.id}" settles on unknown node "${anchor}".`,
          { path: `${workroomPointer}/settlesOn/${anchorIndex}` }
        )
      } else if (memberToRepeat.has(anchor)) {
        addIssue(
          issues,
          "error",
          "workroom-settlement",
          `Workroom "${workroom.id}" settlesOn node "${anchor}" must not be a repeat member.`,
          { path: `${workroomPointer}/settlesOn/${anchorIndex}`, relatedNodes: [anchor] }
        )
      }
    }
    for (const [seatIndex, seat] of workroom.seats.entries()) {
      const owner = seatToWorkroom.get(seat.id)
      if (owner !== undefined) {
        addIssue(
          issues,
          "error",
          "seat-id",
          `Seat id "${seat.id}" is declared by both workroom "${owner}" and "${workroom.id}".`,
          { path: `${workroomPointer}/seats/${seatIndex}/id` }
        )
      } else {
        seatToWorkroom.set(seat.id, workroom.id)
      }
    }
  }

  const nodesBySeat = new Map<string, WorkflowNode[]>()
  for (const [nodeIndex, node] of workflow.nodes.entries()) {
    const nodePointer = `/nodes/${nodeIndex}`
    if (node.type === "command" && node.seat !== undefined) {
      addIssue(
        issues,
        "error",
        "node-seat",
        `Command node "${node.id}" cannot occupy participant seat "${node.seat}".`,
        { path: `${nodePointer}/seat`, primaryNode: node.id }
      )
      continue
    }
    if (node.seat !== undefined && node.workroom === undefined) {
      addIssue(
        issues,
        "error",
        "node-seat",
        `Node "${node.id}" assigns seat "${node.seat}" without naming its workroom.`,
        { path: `${nodePointer}/seat`, primaryNode: node.id }
      )
      continue
    }
    if (node.workroom === undefined) {
      continue
    }
    if (!workroomById.has(node.workroom)) {
      addIssue(
        issues,
        "error",
        "node-workroom",
        `Node "${node.id}" names unknown workroom "${node.workroom}".`,
        { path: `${nodePointer}/workroom`, primaryNode: node.id }
      )
      continue
    }
    if (node.seat === undefined) {
      continue
    }
    const seatWorkroom = seatToWorkroom.get(node.seat)
    if (seatWorkroom === undefined) {
      addIssue(
        issues,
        "error",
        "node-seat",
        `Node "${node.id}" names unknown seat "${node.seat}".`,
        {
          path: `${nodePointer}/seat`,
          primaryNode: node.id
        }
      )
      continue
    }
    if (seatWorkroom !== node.workroom) {
      addIssue(
        issues,
        "error",
        "node-seat",
        `Node "${node.id}" assigns seat "${node.seat}" from workroom "${seatWorkroom}", not "${node.workroom}".`,
        { path: `${nodePointer}/seat`, primaryNode: node.id }
      )
      continue
    }
    nodesBySeat.set(node.seat, [...(nodesBySeat.get(node.seat) ?? []), node])
  }

  const repeatAwareGraph = repeatAwareAncestors(workflow, memberToRepeat)
  const ancestors = repeatAwareGraph.ancestors
  for (const cycle of repeatAwareGraph.cycles) {
    addIssue(
      issues,
      "error",
      "repeat-boundary-cycle",
      `Repeat-aware dependency expansion creates a cycle: ${cycle.join(" -> ")}.`,
      { path: "/nodes", relatedNodes: [...new Set(cycle)] }
    )
  }
  for (const [workroomIndex, workroom] of workrooms.entries()) {
    const anchors = workroom.settlesOn
      .map((anchor, anchorIndex) => [anchorIndex, anchor] as const)
      .filter(([, anchor]) => byId.has(anchor) && !memberToRepeat.has(anchor))
    const assigned = workflow.nodes.filter((node) => node.workroom === workroom.id)
    for (const [anchorIndex, anchor] of anchors) {
      for (const node of assigned) {
        if (node.id !== anchor && ancestors.get(anchor)?.has(node.id) !== true) {
          addIssue(
            issues,
            "error",
            "workroom-settlement",
            `Workroom "${workroom.id}" settlesOn node "${anchor}" must be downstream of workroom node "${node.id}".`,
            {
              path: `/presentation/workrooms/${workroomIndex}/settlesOn/${anchorIndex}`,
              relatedNodes: [anchor, node.id]
            }
          )
        }
      }
    }
  }

  for (const [seat, nodes] of nodesBySeat) {
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex] as WorkflowNode
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const right = nodes[rightIndex] as WorkflowNode
        if (
          ancestors.get(left.id)?.has(right.id) !== true &&
          ancestors.get(right.id)?.has(left.id) !== true
        ) {
          addIssue(
            issues,
            "error",
            "seat-order",
            `Nodes "${left.id}" and "${right.id}" share seat "${seat}" without a total dependency order.`,
            {
              path: `/nodes/${workflow.nodes.indexOf(left)}/seat`,
              primaryNode: left.id,
              relatedNodes: [right.id]
            }
          )
        }
      }
    }
  }
}

function unrolledRoundGroups(workflow: WorkflowSpec): readonly (readonly string[])[] {
  const members = new Set(workflow.repeats.flatMap((repeat) => repeat.members))
  const groups = new Map<string, string[]>()
  for (const node of workflow.nodes) {
    if (members.has(node.id)) {
      continue
    }
    const normalized = node.id
      .split("-")
      .map((segment) => segment.replace(/r(?:ound)?[0-9]+$/, "r#"))
      .join("-")
    if (normalized === node.id) {
      continue
    }
    const bucket = groups.get(normalized) ?? []
    bucket.push(node.id)
    groups.set(normalized, bucket)
  }
  return [...groups.values()].filter((bucket) => bucket.length >= 2)
}

export function validateWorkflow(input: unknown): ValidationResult {
  const decoded = decodeWorkflow(input)
  if (Result.isFailure(decoded)) {
    const issues = formatSchemaIssues(decoded.failure.issue).issues.map((issue) => {
      const issuePath = issue.path?.map(String).join(".") ?? ""
      return {
        severity: "error" as const,
        code: schemaIssueCode(issue.path),
        message: issuePath.length === 0 ? issue.message : `${issuePath}: ${issue.message}`,
        path:
          issue.path === undefined || issue.path.length === 0
            ? ""
            : `/${issue.path.map((part) => pointerSegment(schemaPathPart(part))).join("/")}`
      }
    })
    return {
      workflow: null,
      digest: null,
      issues
    }
  }
  const workflow: WorkflowSpec = decoded.success
  const issues: ValidationIssue[] = []
  if (!path.isAbsolute(workflow.cwd)) {
    addIssue(issues, "error", "workflow-cwd", "Workflow cwd must be absolute.", {
      path: "/cwd"
    })
  }
  if (workflow.callback.type === "webhook") {
    if (!isAbsoluteHttpUrl(workflow.callback.url)) {
      addIssue(
        issues,
        "error",
        "callback-url",
        "Webhook callback URL must be a valid absolute http or https URL.",
        { path: "/callback/url" }
      )
    }
  }
  const ids = new Set<string>()
  for (const [nodeIndex, node] of workflow.nodes.entries()) {
    const nodePointer = `/nodes/${nodeIndex}`
    if (ids.has(node.id)) {
      addIssue(issues, "error", "duplicate-node", `Node id "${node.id}" is duplicated.`, {
        path: `${nodePointer}/id`,
        primaryNode: node.id
      })
    }
    ids.add(node.id)
    if (new Set(node.needs).size !== node.needs.length) {
      addIssue(issues, "error", "dependency", `Node "${node.id}" repeats a dependency.`, {
        path: `${nodePointer}/needs`,
        primaryNode: node.id
      })
    }
    for (const [dependencyIndex, dependency] of node.needs.entries()) {
      if (!workflow.nodes.some((candidate) => candidate.id === dependency)) {
        addIssue(
          issues,
          "error",
          "dependency",
          `Node "${node.id}" needs unknown node "${dependency}".`,
          {
            path: `${nodePointer}/needs/${dependencyIndex}`,
            primaryNode: node.id
          }
        )
      }
    }
    validateNode(workflow, node, issues)
  }
  const { byId, ancestors, cycles } = graphMaps(workflow.nodes)
  for (const cycle of cycles) {
    addIssue(issues, "error", "cycle", `Dependency cycle: ${cycle.join(" -> ")}.`, {
      path: "/nodes",
      relatedNodes: [...new Set(cycle)]
    })
  }
  const memberToRepeat = validateRepeats(workflow, issues, byId, ancestors)
  validateConditions(workflow, issues, byId, memberToRepeat)
  validatePresentation(workflow, issues, byId, memberToRepeat)
  const unrolled = unrolledRoundGroups(workflow)
  if (unrolled.length >= 2) {
    const sample = (unrolled[0] as readonly string[]).slice(0, 2)
    addIssue(
      issues,
      "warning",
      "unrolled-rounds",
      `Nodes look like hand-unrolled repeat rounds (e.g. ${sample.map((id) => `"${id}"`).join(", ")}). Declare a repeat with members, maxRounds, and an until condition instead: rounds then instantiate on demand and the board renders them as one loop.`,
      { path: "/nodes", relatedNodes: unrolled.flat() }
    )
  }
  validateSessions(workflow, issues, ancestors, memberToRepeat)
  try {
    const overlaps = overlappingMutableNodes(workflow)
    if (overlaps.length > 0) {
      addIssue(
        issues,
        workflow.writeConflicts === "reject" ? "error" : "warning",
        "write-conflict",
        `Unordered mutable nodes overlap: ${overlaps.map(([a, b]) => `${a}/${b}`).join(", ")}.`,
        { path: "/writeConflicts", relatedNodes: [...new Set(overlaps.flat())] }
      )
    }
  } catch (error) {
    if (!(error instanceof DeclaredPathInspectionError)) {
      throw error
    }
    addIssue(issues, "error", "write-prefix-inspection", error.message, {
      path: "/writeConflicts",
      primaryNode: error.nodeId
    })
  }
  let digest: string | null = null
  try {
    digest = digestWorkflow(workflow)
  } catch (error) {
    addIssue(
      issues,
      "error",
      "json-value",
      `Workflow contains a value outside the fail-closed JSON contract: ${error instanceof Error ? error.message : String(error)}`,
      { path: "" }
    )
  }
  // Every returned issue is a fresh public diagnostic record.
  // oxlint-disable-next-line oxc/no-map-spread
  const locatedIssues = issues.map((issue) => ({ ...issue }))
  const errors = locatedIssues.some((issue) => issue.severity === "error")
  return {
    workflow: errors ? null : workflow,
    issues: locatedIssues,
    digest: errors ? null : digest
  }
}
