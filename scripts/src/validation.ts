import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js"
import { createHash } from "node:crypto"
import path from "node:path"

import type {
  AgentNode,
  ValidationIssue,
  ValidationResult,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

import workflowJsonSchema from "../../references/workflow.schema.json" with { type: "json" }
import internalWorkflowJsonSchema from "./generated/workflow.internal.schema.json" with { type: "json" }

// Exported for revision diffing: two values are revision-identical exactly
// when their canonical forms (the digest input encoding) are equal.
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    // Sort by UTF-16 code unit, never by locale: the digest must be identical
    // across machines, locales, and ICU builds.
    const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function workflowDigest(workflow: WorkflowSpec): string {
  return createHash("sha256").update(canonicalize(workflow)).digest("hex")
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function isNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function validateEnvironmentNames(
  issues: ValidationIssue[],
  nodeId: string,
  names: readonly string[]
): void {
  const invalidName = names.find((name) => !ENVIRONMENT_NAME_PATTERN.test(name))
  if (invalidName !== undefined) {
    addIssue(
      issues,
      "error",
      "provider-environment",
      `Node "${nodeId}" has invalid inherited environment name "${invalidName}".`
    )
  }
  if (new Set(names).size !== names.length) {
    addIssue(
      issues,
      "error",
      "provider-environment",
      `Node "${nodeId}" repeats an inherited environment name.`
    )
  }
}

// Keys of env records become child environment entries verbatim; an empty or
// "="-bearing key would produce a malformed child environment, so they follow
// the same name rules as inherited environment names.
function validateEnvironmentRecordKeys(
  issues: ValidationIssue[],
  nodeId: string,
  field: string,
  record: Readonly<Record<string, string>>
): void {
  const invalidKey = Object.keys(record).find((key) => !ENVIRONMENT_NAME_PATTERN.test(key))
  if (invalidKey !== undefined) {
    addIssue(
      issues,
      "error",
      "provider-environment",
      `Node "${nodeId}" has invalid environment variable name "${invalidKey}" in ${field}.`
    )
  }
}

function addIssue(
  issues: ValidationIssue[],
  severity: "error" | "warning",
  code: string,
  message: string,
  nodes?: readonly string[]
): void {
  issues.push(
    nodes === undefined ? { severity, code, message } : { severity, code, message, nodes }
  )
}

function graphMaps(nodes: readonly WorkflowNode[]): {
  byId: Map<string, WorkflowNode>
  ancestors: Map<string, Set<string>>
} {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const ancestors = new Map<string, Set<string>>()

  const visit = (id: string, active: Set<string>): Set<string> => {
    const cached = ancestors.get(id)
    if (cached !== undefined) {
      return cached
    }
    if (active.has(id)) {
      return new Set()
    }
    active.add(id)
    const result = new Set<string>()
    const node = byId.get(id)
    for (const dependency of node?.needs ?? []) {
      result.add(dependency)
      for (const ancestor of visit(dependency, active)) {
        result.add(ancestor)
      }
    }
    active.delete(id)
    ancestors.set(id, result)
    return result
  }

  for (const node of nodes) {
    visit(node.id, new Set())
  }
  return { byId, ancestors }
}

function findCycles(nodes: readonly WorkflowNode[]): readonly string[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []
  const cycles: string[][] = []

  const visit = (id: string): void => {
    if (active.has(id)) {
      const start = stack.indexOf(id)
      cycles.push([...stack.slice(start), id])
      return
    }
    if (visited.has(id)) {
      return
    }
    visited.add(id)
    active.add(id)
    stack.push(id)
    for (const dependency of byId.get(id)?.needs ?? []) {
      if (byId.has(dependency)) {
        visit(dependency)
      }
    }
    stack.pop()
    active.delete(id)
  }

  for (const node of nodes) {
    visit(node.id)
  }
  return cycles
}

// The canonical static-prefix reduction for write patterns: normalizes
// backslashes and a leading "./" before cutting at the first wildcard, so
// equivalent spellings ("./src/**", "src\\**") reduce to the same prefix.
// Exported as the single implementation overlap checks should share.
export function normalizedStaticPrefix(pattern: string): string {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\/+/, "")
  const wildcard = normalized.search(/[*?[\]{}]/)
  const prefix = wildcard === -1 ? normalized : normalized.slice(0, wildcard)
  return prefix.replace(/\/+$/, "")
}

function writePatternsOverlap(left: string, right: string): boolean {
  // Both callers pass already-resolved absolute prefixes, so only prefix
  // containment can decide an overlap.
  const a = normalizedStaticPrefix(left)
  const b = normalizedStaticPrefix(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function absoluteWritePrefix(
  workflow: WorkflowSpec,
  node: WorkflowNode,
  pattern: string
): string | null {
  if (node.workspace.mode === "git-worktree" && node.workspace.path === null) {
    return null
  }
  const workspace = path.resolve(node.workspace.path ?? node.cwd ?? workflow.cwd)
  return path.resolve(workspace, normalizedStaticPrefix(pattern))
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
      const ordered =
        ancestors.get(left.id)?.has(right.id) === true ||
        ancestors.get(right.id)?.has(left.id) === true
      if (ordered) {
        continue
      }
      if (
        left.workspace.writes.some((a) =>
          right.workspace.writes.some((b) => {
            const leftPrefix = absoluteWritePrefix(workflow, left, a)
            const rightPrefix = absoluteWritePrefix(workflow, right, b)
            if (leftPrefix === null || rightPrefix === null) {
              return false
            }
            return writePatternsOverlap(leftPrefix, rightPrefix)
          })
        )
      ) {
        overlaps.push([left.id, right.id])
      }
    }
  }
  return overlaps
}

function validateNode(
  workflow: WorkflowSpec,
  node: WorkflowNode,
  issues: ValidationIssue[],
  ancestors: Map<string, Set<string>>
): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(node.id)) {
    addIssue(
      issues,
      "error",
      "node-id",
      `Node "${node.id}" must use lowercase letters, digits, and hyphens.`
    )
  }
  if (node.title.trim().length === 0) {
    addIssue(issues, "error", "node-title", `Node "${node.id}" has an empty title.`)
  }
  if (node.cwd !== null && !path.isAbsolute(node.cwd)) {
    addIssue(issues, "error", "node-cwd", `Node "${node.id}" cwd must be absolute or null.`)
  }
  if (node.workspace.path !== null && !path.isAbsolute(node.workspace.path)) {
    addIssue(
      issues,
      "error",
      "workspace-path",
      `Node "${node.id}" workspace path must be absolute or null.`
    )
  }
  const canMutate =
    node.type === "command"
      ? node.mutates
      : (node.provider === "codex" && node.permissions.sandbox !== "read-only") ||
        (node.provider === "claude" && node.permissions.permissionMode !== "plan")
  if (canMutate && node.workspace.vcs === "plastic" && node.workspace.writes.length > 0) {
    if (!node.workspace.exclusiveResources.includes("plastic-scm")) {
      addIssue(
        issues,
        "warning",
        "plastic-resource",
        `Mutating Plastic node "${node.id}" should normally reserve "plastic-scm" for version-control operations.`,
        [node.id]
      )
    }
  }
  if (canMutate && node.workspace.writes.length === 0) {
    addIssue(
      issues,
      "warning",
      "unknown-writes",
      `Potentially mutating node "${node.id}" declares no write set; parallel safety cannot be proven.`,
      [node.id]
    )
  }
  if (!isPositiveInteger(node.retry.maxAttempts)) {
    addIssue(
      issues,
      "error",
      "retry-attempts",
      `Node "${node.id}" retry.maxAttempts must be a positive integer.`
    )
  }
  if (!isNonNegative(node.retry.delaySeconds)) {
    addIssue(
      issues,
      "error",
      "retry-delay",
      `Node "${node.id}" retry.delaySeconds must be non-negative.`
    )
  }
  if (node.timeoutMinutes !== null && !isPositive(node.timeoutMinutes)) {
    addIssue(
      issues,
      "error",
      "node-timeout",
      `Node "${node.id}" timeoutMinutes must be positive or null; zero would kill the node immediately.`
    )
  }
  const inputLabels = new Set<string>()
  for (const input of node.inputs) {
    if (input.from === node.id || ancestors.get(node.id)?.has(input.from) !== true) {
      addIssue(
        issues,
        "error",
        "input-order",
        `Node "${node.id}" input "${input.from}" must be an ancestor dependency.`
      )
    }
    if (inputLabels.has(input.as)) {
      addIssue(
        issues,
        "error",
        "input-label",
        `Node "${node.id}" repeats input label "${input.as}"; each input needs a distinct "as" heading.`
      )
    }
    inputLabels.add(input.as)
  }

  if (node.type === "command") {
    if (node.argv.length === 0 || node.argv[0]?.trim().length === 0) {
      addIssue(issues, "error", "command-argv", `Command node "${node.id}" needs a non-empty argv.`)
    } else if (
      !node.inheritEnv.includes("PATH") &&
      !Object.hasOwn(node.env, "PATH") &&
      !path.isAbsolute(node.argv[0] as string)
    ) {
      addIssue(
        issues,
        "error",
        "command-path",
        `Command node "${node.id}" argv[0] must be an absolute path because neither inheritEnv nor env provides PATH.`
      )
    }
    if (node.allowedExitCodes.length === 0) {
      addIssue(
        issues,
        "error",
        "command-exit-codes",
        `Command node "${node.id}" must declare at least one allowed exit code.`
      )
    }
    if (!node.mutates && node.workspace.writes.length > 0) {
      addIssue(
        issues,
        "error",
        "command-writes",
        `Command node "${node.id}" declares mutates=false but lists write patterns; either declare mutates=true or remove the writes.`
      )
    }
    validateEnvironmentNames(issues, node.id, node.inheritEnv)
    validateEnvironmentRecordKeys(issues, node.id, "env", node.env)
    return
  }

  validateAgentLikeNode(node, issues)

  if (node.type === "agent" && node.interactive) {
    if (node.provider === "mock") {
      addIssue(
        issues,
        "error",
        "interactive-provider",
        `Node "${node.id}" uses the test-only mock provider, which is headless-only and cannot run interactively.`
      )
    }
    if (node.output.format === "json" || node.output.schema !== null) {
      addIssue(
        issues,
        "error",
        "interactive-output",
        `Interactive node "${node.id}" cannot declare structured output; a live TUI cannot enforce output.format "json" or an output schema. Keep structured-output nodes headless.`
      )
    }
    if (node.provider === "codex" && node.session.saveAs !== null) {
      addIssue(
        issues,
        "error",
        "interactive-session",
        `Interactive Codex node "${node.id}" cannot save a session alias: an interactive codex TUI exposes no reliable native session id to record. Use a headless node or drop saveAs.`
      )
    }
    if (
      node.provider === "claude" &&
      node.session.mode === "fork" &&
      node.session.saveAs !== null
    ) {
      addIssue(
        issues,
        "error",
        "interactive-session",
        `Interactive Claude node "${node.id}" cannot save a forked session alias: the fork's new session id cannot be pinned at interactive spawn. Resume instead of forking, or drop saveAs.`
      )
    }
  }

  if (node.type === "supervisor") {
    if (node.termination.maxRounds !== null && !isPositiveInteger(node.termination.maxRounds)) {
      addIssue(
        issues,
        "error",
        "goal-rounds",
        `Supervisor "${node.id}" maxRounds must be a positive integer or null.`
      )
    }
    if (
      node.termination.maxWallTimeMinutes !== null &&
      !isPositive(node.termination.maxWallTimeMinutes)
    ) {
      addIssue(
        issues,
        "error",
        "goal-wall-time",
        `Supervisor "${node.id}" maxWallTimeMinutes must be positive or null.`
      )
    }
    if (
      node.envelope.maxAddedNodesPerRound !== null &&
      !isPositiveInteger(node.envelope.maxAddedNodesPerRound)
    ) {
      addIssue(
        issues,
        "error",
        "goal-added-nodes",
        `Supervisor "${node.id}" maxAddedNodesPerRound must be positive or null.`
      )
    }
    for (const root of [...node.envelope.cwdRoots, ...node.envelope.writeRoots]) {
      if (!path.isAbsolute(root)) {
        addIssue(
          issues,
          "error",
          "goal-envelope-path",
          `Supervisor "${node.id}" envelope roots must be absolute.`
        )
      }
    }
    for (const allowed of node.envelope.allowedProviderEnv) {
      validateEnvironmentRecordKeys(issues, node.id, "envelope.allowedProviderEnv", allowed)
    }
    for (const allowed of node.envelope.allowedCommandEnv) {
      validateEnvironmentRecordKeys(issues, node.id, "envelope.allowedCommandEnv", allowed)
    }
    if (
      node.envelope.allowCommands &&
      (node.envelope.commandArgvPrefixes.length === 0 ||
        node.envelope.commandArgvPrefixes.some((prefix) => prefix.length === 0))
    ) {
      addIssue(
        issues,
        "error",
        "goal-command-envelope",
        `Supervisor "${node.id}" allows commands but does not declare approved argv prefixes. An empty allowedCommandEnv is valid and means commands may not set environment variables.`
      )
    }
    if (
      !node.envelope.allowCommands &&
      (node.envelope.commandArgvPrefixes.length > 0 || node.envelope.allowedCommandEnv.length > 0)
    ) {
      addIssue(
        issues,
        "error",
        "goal-command-envelope",
        `Supervisor "${node.id}" declares command authority while allowCommands=false.`
      )
    }
    if (
      node.envelope.gitWorktree.allowed &&
      (!node.envelope.workspaceModes.includes("git-worktree") ||
        !node.envelope.vcs.includes("git") ||
        node.envelope.gitWorktree.branchPrefixes.length === 0 ||
        node.envelope.gitWorktree.startPoints.length === 0)
    ) {
      addIssue(
        issues,
        "error",
        "goal-worktree-envelope",
        `Supervisor "${node.id}" allows Git worktrees without approved mode, VCS, branch prefixes, and start points.`
      )
    }
    if (
      !node.envelope.gitWorktree.allowed &&
      (node.envelope.gitWorktree.branchPrefixes.length > 0 ||
        node.envelope.gitWorktree.startPoints.length > 0 ||
        node.envelope.gitWorktree.allowRemoveOnClean)
    ) {
      addIssue(
        issues,
        "error",
        "goal-worktree-envelope",
        `Supervisor "${node.id}" declares Git worktree authority while gitWorktree.allowed=false.`
      )
    }
  }
}

function validateAgentLikeNode(
  node: AgentNode | Extract<WorkflowNode, { readonly type: "supervisor" }>,
  issues: ValidationIssue[]
): void {
  const reserved =
    node.provider === "codex"
      ? [
          "--sandbox",
          "-s",
          "--dangerously-bypass-approvals-and-sandbox",
          "--full-auto",
          "--ask-for-approval",
          "-a",
          "--profile",
          "-p",
          "--oss",
          "--cd",
          "--model",
          "-m",
          "--config",
          "-c",
          "--output-schema",
          "--json",
          "--output-last-message",
          "-o",
          "--ephemeral",
          "--",
          "-"
        ]
      : node.provider === "claude"
        ? [
            "--permission-mode",
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "--settings",
            "--setting-sources",
            "--mcp-config",
            "--strict-mcp-config",
            "--agents",
            "--model",
            "--effort",
            "--resume",
            "-r",
            "--continue",
            "-c",
            "--fork-session",
            "--session-id",
            "--no-session-persistence",
            "--json-schema",
            "--output-format",
            "--verbose",
            "--print",
            "-p",
            "--allowedtools",
            "--disallowedtools",
            "--tools",
            "--add-dir",
            "--",
            "-"
          ]
        : []
  const conflicting = node.permissions.extraArgs.find((argument) => {
    const normalized = argument.toLowerCase()
    return reserved.some(
      (flag) =>
        normalized === flag ||
        normalized.startsWith(`${flag}=`) ||
        // Short options accept attached values ("-mgpt-5" means "-m gpt-5"),
        // which would otherwise bypass the reserved-flag rule.
        (/^-[a-z]$/.test(flag) && normalized.length > flag.length && normalized.startsWith(flag))
    )
  })
  if (conflicting !== undefined) {
    addIssue(
      issues,
      "error",
      "reserved-provider-argument",
      `Node "${node.id}" extraArgs contains reserved argument "${conflicting}"; use the explicit model, session, permission, output, or environment fields instead.`
    )
  }
  validateEnvironmentNames(issues, node.id, node.permissions.inheritEnv)
  validateEnvironmentRecordKeys(issues, node.id, "permissions.env", node.permissions.env)
  if (node.model.trim().length === 0) {
    addIssue(issues, "error", "model", `Node "${node.id}" must explicitly select a model.`)
  }
  // Case-insensitive prefix check: "Provider-default" is a likely typo, not a
  // real model, and only the exact lowercase sentinel is accepted.
  if (node.model.toLowerCase().startsWith("provider-") && node.model !== "provider-default") {
    addIssue(
      issues,
      "error",
      "model",
      `Node "${node.id}" model "${node.model}" looks like a misspelled sentinel; use exactly "provider-default" or a real model name.`
    )
  }
  if (node.session.mode === "fresh" && node.session.from !== null) {
    addIssue(
      issues,
      "error",
      "session-source",
      `Fresh node "${node.id}" must set session.from to null.`
    )
  }
  if (node.session.mode !== "fresh" && node.session.from === null) {
    addIssue(
      issues,
      "error",
      "session-source",
      `Node "${node.id}" must name the session it resumes or forks.`
    )
  }
  if (node.session.mode === "fork" && node.provider !== "claude") {
    addIssue(
      issues,
      "error",
      "unsupported-fork",
      `Node "${node.id}" requests fork, but only the Claude adapter currently supports it.`
    )
  }
  if (node.session.mode !== "fresh" && !node.session.retain) {
    addIssue(
      issues,
      "warning",
      "session-retention",
      `Node "${node.id}" continues a session but does not retain the resulting session.`
    )
  }
  if (node.session.saveAs !== null && !node.session.retain) {
    addIssue(
      issues,
      "error",
      "session-retention",
      `Node "${node.id}" names a session but sets retain=false.`
    )
  }
  if (node.session.reuseOnRepeat && node.session.saveAs === null) {
    addIssue(
      issues,
      "error",
      "session-repeat",
      `Node "${node.id}" sets reuseOnRepeat=true without a saveAs alias.`
    )
  }
}

const NODE_UNION_SCHEMA_PATH = "#/properties/nodes/items/anyOf"

// The enforced schema document: the published contract by default, or the
// internal variant that additionally admits the test-only mock provider when
// ORCHESTRATE_ENABLE_MOCK_PROVIDER=1. Compiled lazily so tests can set the
// environment variable before the first validation.
let activeSchemaDocument: Record<string, unknown> | null = null
let activeSchemaValidator: ReturnType<Ajv2020["compile"]> | null = null

function enforcedSchemaDocument(): Record<string, unknown> {
  activeSchemaDocument ??=
    process.env.ORCHESTRATE_ENABLE_MOCK_PROVIDER === "1"
      ? internalWorkflowJsonSchema
      : workflowJsonSchema
  return activeSchemaDocument
}

function enforcedSchemaValidator(): ReturnType<Ajv2020["compile"]> {
  activeSchemaValidator ??= new Ajv2020({ allErrors: true, strict: false }).compile(
    enforcedSchemaDocument()
  )
  return activeSchemaValidator
}

interface NodeUnionBranch {
  readonly index: number
  readonly type: string | undefined
  readonly providers: readonly string[] | undefined
  readonly schema: Readonly<Record<string, unknown>>
}

function literalValues(candidate: unknown): readonly string[] | undefined {
  if (candidate === null || typeof candidate !== "object") {
    return undefined
  }
  const record = candidate as { readonly enum?: unknown; readonly const?: unknown }
  if (Array.isArray(record.enum)) {
    const values = record.enum.filter((value): value is string => typeof value === "string")
    return values.length > 0 ? values : undefined
  }
  return typeof record.const === "string" ? [record.const] : undefined
}

// Describes the branches of the enforced schema's nodes anyOf union by their
// type and provider discriminants (provider-split unions give one node type
// several branches).
function nodeUnionBranchList(): readonly NodeUnionBranch[] {
  const union = (
    enforcedSchemaDocument() as {
      readonly properties?: {
        readonly nodes?: { readonly items?: { readonly anyOf?: readonly unknown[] } }
      }
    }
  ).properties?.nodes?.items?.anyOf
  return (union ?? []).map((branch, index) => {
    const properties = (
      branch as {
        readonly properties?: { readonly type?: unknown; readonly provider?: unknown }
      }
    ).properties
    return {
      index,
      type: literalValues(properties?.type)?.[0],
      providers: literalValues(properties?.provider),
      schema: branch as Readonly<Record<string, unknown>>
    }
  })
}

function validateNodeAgainstBranch(
  rawNode: unknown,
  branch: NodeUnionBranch
): readonly ErrorObject[] {
  const root = enforcedSchemaDocument()
  const schema = {
    $schema:
      typeof root.$schema === "string"
        ? root.$schema
        : "https://json-schema.org/draft/2020-12/schema",
    ...branch.schema,
    $defs: root.$defs as Record<string, unknown>
  }
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  validate(rawNode)
  return validate.errors ?? []
}

function describeSchemaErrors(input: unknown, errors: readonly ErrorObject[]): string {
  const reporter = new Ajv2020()
  const branchList = nodeUnionBranchList()
  const rawNodes =
    input !== null && typeof input === "object"
      ? (input as { readonly nodes?: unknown }).nodes
      : undefined
  const general: ErrorObject[] = []
  const byNode = new Map<number, ErrorObject[]>()
  for (const error of errors) {
    const match = error.instancePath.match(/^\/nodes\/(\d+)(\/|$)/)
    if (match === null) {
      general.push(error)
      continue
    }
    const index = Number(match[1])
    byNode.set(index, [...(byNode.get(index) ?? []), error])
  }
  const parts: string[] = []
  if (general.length > 0) {
    parts.push(reporter.errorsText(general, { separator: "; " }))
  }
  for (const [index, nodeErrors] of [...byNode.entries()].toSorted((a, b) => a[0] - b[0])) {
    const rawNode = Array.isArray(rawNodes) ? (rawNodes[index] as unknown) : undefined
    const rawType =
      rawNode !== null && typeof rawNode === "object"
        ? (rawNode as { readonly type?: unknown }).type
        : undefined
    const rawProvider =
      rawNode !== null && typeof rawNode === "object"
        ? (rawNode as { readonly provider?: unknown }).provider
        : undefined
    const rawWorkspaceMode =
      rawNode !== null &&
      typeof rawNode === "object" &&
      (rawNode as { readonly workspace?: unknown }).workspace !== null &&
      typeof (rawNode as { readonly workspace?: unknown }).workspace === "object"
        ? (rawNode as { readonly workspace: { readonly mode?: unknown } }).workspace.mode
        : undefined
    let candidates =
      typeof rawType === "string" ? branchList.filter((branch) => branch.type === rawType) : []
    if (candidates.length === 0) {
      parts.push(`nodes[${index}]: ${reporter.errorsText(nodeErrors, { separator: "; " })}`)
      continue
    }
    const providerMatches =
      typeof rawProvider === "string"
        ? candidates.filter((branch) => branch.providers?.includes(rawProvider) === true)
        : []
    if (providerMatches.length > 0) {
      candidates = providerMatches
    }
    // Revalidate an unambiguous type/provider match against that node branch
    // alone. Errors reached through shared $defs otherwise lose their outer
    // branch path and leak failures from nonmatching provider/workspace variants.
    let relevant =
      candidates.length === 1
        ? [...validateNodeAgainstBranch(rawNode, candidates[0] as NodeUnionBranch)]
        : nodeErrors.filter(
            (error) =>
              candidates.some((branch) =>
                error.schemaPath.startsWith(`${NODE_UNION_SCHEMA_PATH}/${branch.index}/`)
              ) || !error.schemaPath.startsWith(NODE_UNION_SCHEMA_PATH)
          )
    const workspaceBranch =
      rawWorkspaceMode === "shared"
        ? 0
        : rawWorkspaceMode === "existing"
          ? 1
          : rawWorkspaceMode === "git-worktree"
            ? 2
            : null
    if (workspaceBranch !== null) {
      const workspacePath = `/nodes/${index}/workspace`
      relevant = relevant.filter((error) => {
        const workspaceError =
          error.instancePath.startsWith(workspacePath) ||
          error.instancePath.startsWith("/workspace")
        if (!workspaceError) {
          return true
        }
        if (error.schemaPath === "#/anyOf") {
          return false
        }
        const branch = error.schemaPath.match(/^#\/anyOf\/(\d+)(\/|$)/)
        return branch === null || Number(branch[1]) === workspaceBranch
      })
    }
    const seen = new Set<string>()
    relevant = relevant.filter((error) => {
      const key = JSON.stringify([
        error.instancePath,
        error.schemaPath,
        error.keyword,
        error.params,
        error.message
      ])
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
    const kept = relevant.length > 0 ? relevant : nodeErrors
    const label =
      providerMatches.length > 0 && typeof rawProvider === "string"
        ? `${rawType as string}/${rawProvider}`
        : (rawType as string)
    parts.push(`nodes[${index}] (${label}): ${reporter.errorsText(kept, { separator: "; " })}`)
  }
  return parts.join("; ")
}

export function validateWorkflow(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = []
  const validateEnforcedSchema = enforcedSchemaValidator()
  if (validateEnforcedSchema(input) !== true) {
    return {
      workflow: null,
      digest: null,
      issues: [
        {
          severity: "error",
          code: "schema",
          message: `Workflow JSON Schema validation failed: ${describeSchemaErrors(
            input,
            validateEnforcedSchema.errors ?? []
          )}`
        }
      ]
    }
  }
  // The enforced schema document is generated from the same schema definitions
  // as WorkflowSpec and is purely structural, so a passing Ajv check makes the
  // cast sound.
  const workflow = input as WorkflowSpec

  if (!path.isAbsolute(workflow.cwd)) {
    addIssue(issues, "error", "workflow-cwd", "Workflow cwd must be an absolute path.")
  }
  if (!isPositiveInteger(workflow.concurrency)) {
    addIssue(issues, "error", "concurrency", "Workflow concurrency must be a positive integer.")
  }
  if (
    workflow.heartbeat.intervalMinutes !== null &&
    !(Number.isFinite(workflow.heartbeat.intervalMinutes) && workflow.heartbeat.intervalMinutes > 0)
  ) {
    addIssue(
      issues,
      "error",
      "heartbeat",
      "Heartbeat interval must be positive or explicitly null."
    )
  }
  if (
    workflow.heartbeat.callback.type === "command" &&
    (workflow.heartbeat.callback.argv.length === 0 ||
      workflow.heartbeat.callback.argv[0]?.trim().length === 0)
  ) {
    addIssue(
      issues,
      "error",
      "callback-command",
      "Callback command argv needs a non-empty executable."
    )
  }
  if (workflow.heartbeat.callback.type === "webhook") {
    try {
      const url = new URL(workflow.heartbeat.callback.url)
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("unsupported protocol")
      }
    } catch {
      addIssue(
        issues,
        "error",
        "callback-webhook",
        "Callback webhook URL must be an absolute HTTP or HTTPS URL."
      )
    }
  }
  for (const [key, value] of Object.entries(workflow.limits)) {
    if (value !== null && !isPositive(value)) {
      addIssue(issues, "error", "workflow-limit", `${key} must be positive or null.`)
    }
  }

  const ids = new Set<string>()
  for (const node of workflow.nodes) {
    if (
      node.type !== "command" &&
      node.provider === "mock" &&
      process.env.ORCHESTRATE_ENABLE_MOCK_PROVIDER !== "1"
    ) {
      addIssue(
        issues,
        "error",
        "mock-provider",
        `Node "${node.id}" uses the test-only mock provider.`
      )
    }
    if (ids.has(node.id)) {
      addIssue(issues, "error", "duplicate-node", `Duplicate node id "${node.id}".`)
    }
    ids.add(node.id)
  }
  for (const node of workflow.nodes) {
    for (const dependency of node.needs) {
      if (!ids.has(dependency)) {
        addIssue(
          issues,
          "error",
          "missing-dependency",
          `Node "${node.id}" depends on missing node "${dependency}".`
        )
      }
    }
  }
  for (const cycle of findCycles(workflow.nodes)) {
    addIssue(issues, "error", "cycle", `Workflow contains a cycle: ${cycle.join(" -> ")}.`)
  }

  const { ancestors } = graphMaps(workflow.nodes)
  for (const node of workflow.nodes) {
    validateNode(workflow, node, issues, ancestors)
  }

  const aliasProducers = new Map<string, WorkflowNode[]>()
  for (const node of workflow.nodes) {
    if (node.type !== "command" && node.session.saveAs !== null) {
      const producers = aliasProducers.get(node.session.saveAs) ?? []
      producers.push(node)
      aliasProducers.set(node.session.saveAs, producers)
    }
  }
  const aliases = new Map<string, WorkflowNode>()
  const ambiguousAliases = new Set<string>()
  for (const [alias, producers] of aliasProducers) {
    if (producers.length === 1) {
      aliases.set(alias, producers[0] as WorkflowNode)
      continue
    }
    ambiguousAliases.add(alias)
    const producerIds = producers.map((producer) => producer.id)
    addIssue(
      issues,
      "error",
      "duplicate-session-alias",
      `Session alias "${alias}" has multiple producers: ${producerIds
        .map((id) => `"${id}"`)
        .join(", ")}. Each alias may have exactly one producer.`,
      producerIds
    )
  }
  for (const node of workflow.nodes) {
    if (node.type === "command" || node.session.from === null) {
      continue
    }
    if (ambiguousAliases.has(node.session.from)) {
      continue
    }
    const producer = aliases.get(node.session.from)
    if (producer === undefined) {
      addIssue(
        issues,
        "error",
        "missing-session",
        `Node "${node.id}" references unknown session alias "${node.session.from}".`
      )
    } else if (ancestors.get(node.id)?.has(producer.id) !== true) {
      addIssue(
        issues,
        "error",
        "session-order",
        `Node "${node.id}" must depend on session producer "${producer.id}".`
      )
    } else if (producer.type !== "command" && producer.provider !== node.provider) {
      addIssue(
        issues,
        "error",
        "session-provider",
        `Node "${node.id}" cannot continue a ${producer.provider} session with ${node.provider}.`
      )
    }
  }

  const lineageMemo = new Map<string, string | null>()
  const sessionLineage = (alias: string, active = new Set<string>()): string | null => {
    const cached = lineageMemo.get(alias)
    if (cached !== undefined) {
      return cached
    }
    if (ambiguousAliases.has(alias)) {
      return null
    }
    if (active.has(alias)) {
      return alias
    }
    active.add(alias)
    const producer = aliases.get(alias)
    const lineage =
      producer !== undefined &&
      producer.type !== "command" &&
      producer.session.mode === "resume" &&
      producer.session.from !== null
        ? sessionLineage(producer.session.from, active)
        : `${producer?.type === "command" ? "unknown" : (producer?.provider ?? "unknown")}:${producer?.id ?? alias}`
    active.delete(alias)
    lineageMemo.set(alias, lineage)
    return lineage
  }

  const consumers = new Map<string, WorkflowNode[]>()
  for (const node of workflow.nodes) {
    if (node.type === "command" || node.session.mode !== "resume" || node.session.from === null) {
      continue
    }
    const lineage = sessionLineage(node.session.from)
    if (lineage === null) {
      continue
    }
    const list = consumers.get(lineage) ?? []
    list.push(node)
    consumers.set(lineage, list)
  }
  for (const [lineage, nodes] of consumers) {
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex] as WorkflowNode
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const right = nodes[rightIndex] as WorkflowNode
        const ordered =
          ancestors.get(left.id)?.has(right.id) === true ||
          ancestors.get(right.id)?.has(left.id) === true
        if (!ordered) {
          addIssue(
            issues,
            "error",
            "session-fanout",
            `Nodes "${left.id}" and "${right.id}" concurrently resume the same mutable session lineage "${lineage}". Use a linear resume chain, fresh sessions, or provider-native forks.`,
            [left.id, right.id]
          )
        }
      }
    }
  }

  for (const [left, right] of overlappingMutableNodes(workflow)) {
    addIssue(
      issues,
      workflow.writeConflicts === "reject" ? "error" : "warning",
      "write-conflict",
      `Potential parallel write overlap between "${left}" and "${right}".`,
      [left, right]
    )
  }

  if (workflow.nodes.length === 0) {
    addIssue(issues, "error", "empty-workflow", "Workflow must contain at least one node.")
  }

  const hasErrors = issues.some((issue) => issue.severity === "error")
  return {
    workflow,
    issues,
    digest: hasErrors ? null : workflowDigest(workflow)
  }
}
