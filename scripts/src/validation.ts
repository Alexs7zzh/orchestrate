import { Ajv2020 } from "ajv/dist/2020.js"
import { Result, Schema, SchemaIssue } from "effect"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type {
  AgentNode,
  ValidationIssue,
  ValidationResult,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

import { WorkflowSchema } from "./schema.js"
import { stateRoot, submissionsRoot } from "./state.js"

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
  return "schema"
}
const NODE_ID = /^[a-z0-9][a-z0-9-]*$/
const ROUND_INSTANCE_SUFFIX = /--r[1-9][0-9]*$/
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
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

function addIssue(
  issues: ValidationIssue[],
  severity: ValidationIssue["severity"],
  code: string,
  message: string,
  nodes?: readonly string[]
): void {
  issues.push(
    nodes === undefined ? { severity, code, message } : { severity, code, message, nodes }
  )
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
): string | null {
  if (node.workspace.mode === "git-worktree" && node.workspace.path === null) {
    return null
  }
  return path.resolve(
    node.workspace.path ?? node.cwd ?? workflow.cwd,
    normalizedStaticPrefix(pattern)
  )
}

function prefixesOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}${path.sep}`) ||
    right.startsWith(`${left}${path.sep}`)
  )
}

export function resolveThroughExistingAncestor(candidate: string): string {
  let current = path.resolve(candidate)
  const suffix: string[] = []
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...suffix.toReversed())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return path.resolve(candidate)
      }
      const parent = path.dirname(current)
      if (parent === current) {
        return path.resolve(candidate)
      }
      suffix.push(path.basename(current))
      current = parent
    }
  }
}

export function orchestrateAuthorityPaths(): readonly string[] {
  const configuredHome = process.env.HOME?.trim()
  const home = path.resolve(
    configuredHome === undefined || configuredHome.length === 0 ? os.homedir() : configuredHome
  )
  const configuredBinary = process.env.ORCHESTRATE_BIN?.trim()
  const embeddedExecutable = path.basename(process.execPath).startsWith("orchestrate")
    ? process.execPath
    : null
  return [
    ...new Set(
      [
        stateRoot(),
        submissionsRoot(),
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
    : (node.workspace.path ?? node.cwd ?? workflow.cwd)
): readonly string[] {
  if (!isMutatingProviderNode(node)) {
    return []
  }
  const roots = [
    ["provider sandbox root", effectiveRoot] as const,
    ...node.workspace.writes.map(
      (pattern) =>
        [
          `declared write ${JSON.stringify(pattern)}`,
          path.resolve(effectiveRoot, normalizedStaticPrefix(pattern))
        ] as const
    )
  ]
  const protectedPaths = orchestrateAuthorityPaths()
  return roots.flatMap(([label, candidate]) => {
    const resolved = resolveThroughExistingAncestor(candidate)
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
  const effectiveRoot = resolveThroughExistingAncestor(
    node.workspace.path ?? node.cwd ?? workflow.cwd
  )
  return node.workspace.writes.flatMap((pattern) => {
    const unresolved = path.resolve(effectiveRoot, normalizedStaticPrefix(pattern))
    const resolved = resolveThroughExistingAncestor(unresolved)
    return resolved === unresolved
      ? []
      : [`declared write ${JSON.stringify(pattern)} resolves through a symlink to ${resolved}`]
  })
}

export function assertProviderAuthorityIsolation(
  workflow: WorkflowSpec,
  node: WorkflowNode,
  effectiveRoot?: string
): void {
  const overlaps = providerAuthorityOverlaps(workflow, node, effectiveRoot)
  if (overlaps.length > 0) {
    throw new Error(
      `Mutating provider node "${node.id}" overlaps Orchestrate-owned authority: ${overlaps.join("; ")}.`
    )
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
          return a !== null && b !== null && prefixesOverlap(a, b)
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
  explicit: Readonly<Record<string, string>>
): void {
  const invalid = [...inherited, ...Object.keys(explicit)].find(
    (name) => !ENVIRONMENT_NAME.test(name)
  )
  if (invalid !== undefined) {
    addIssue(
      issues,
      "error",
      "environment-name",
      `Node "${nodeId}" has invalid environment variable name "${invalid}".`
    )
  }
  if (new Set(inherited).size !== inherited.length) {
    addIssue(
      issues,
      "error",
      "environment-name",
      `Node "${nodeId}" repeats an inherited environment variable.`
    )
  }
}

function validateProviderArguments(node: AgentNode, issues: ValidationIssue[]): void {
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
      `Node "${node.id}" cannot use Claude extraArgs; the launcher reserves the complete permission and sandbox surface.`
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
      `Node "${node.id}" extraArgs contains reserved argument "${conflict}"; use the explicit contract field.`
    )
  }
}

function validateNode(workflow: WorkflowSpec, node: WorkflowNode, issues: ValidationIssue[]): void {
  if (!NODE_ID.test(node.id) || ROUND_INSTANCE_SUFFIX.test(node.id)) {
    addIssue(
      issues,
      "error",
      "node-id",
      `Node "${node.id}" must use lowercase letters, digits, and hyphens and must not end in reserved --r<N>.`
    )
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
      : (node.provider === "codex" && node.permissions.execution.sandbox !== "read-only") ||
        (node.provider === "claude" && node.permissions.execution.permissionMode !== "plan")
  if (canMutate && node.workspace.writes.length === 0) {
    addIssue(
      issues,
      "warning",
      "unknown-writes",
      `Potentially mutating node "${node.id}" declares no write set.`,
      [node.id]
    )
  }
  const authorityOverlaps = providerAuthorityOverlaps(workflow, node)
  if (authorityOverlaps.length > 0) {
    addIssue(
      issues,
      "error",
      "protected-path",
      `Mutating provider node "${node.id}" overlaps Orchestrate-owned authority: ${authorityOverlaps.join("; ")}.`,
      [node.id]
    )
  }
  const nonCanonicalWrites = providerNonCanonicalWritePrefixes(workflow, node)
  if (nonCanonicalWrites.length > 0) {
    addIssue(
      issues,
      "error",
      "workspace-write-symlink",
      `Mutating provider node "${node.id}" has a non-canonical write prefix: ${nonCanonicalWrites.join("; ")}. Use the canonical target.`,
      [node.id]
    )
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
      [node.id]
    )
  }
  const inputLabels = new Set<string>()
  for (const input of node.inputs) {
    if (inputLabels.has(input.as)) {
      addIssue(
        issues,
        "error",
        "input-label",
        `Node "${node.id}" repeats input label "${input.as}".`
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
        `Command node "${node.id}" argv[0] must be absolute unless PATH is explicitly provided.`
      )
    }
    if (!node.mutates && node.workspace.writes.length > 0) {
      addIssue(
        issues,
        "error",
        "command-writes",
        `Command node "${node.id}" declares writes while mutates=false.`
      )
    }
    validateEnvironment(issues, node.id, node.inheritEnv, node.env)
    return
  }

  validateProviderArguments(node, issues)
  if (node.provider === "claude") {
    const mode = node.permissions.execution.permissionMode
    if (mode !== "dontAsk") {
      addIssue(
        issues,
        "error",
        "unsupported-permission-mode",
        `Claude permission mode "${mode}" is not confined enough for workflow execution; use dontAsk with the launcher-owned fail-closed sandbox.`
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
        `Claude permission mode "${mode}" requires escalation="${requiredEscalation}" for node "${node.id}".`
      )
    }
  }
  validateEnvironment(issues, node.id, node.permissions.inheritEnv, node.permissions.env)
  if (node.model.toLowerCase().startsWith("provider-") && node.model !== "provider-default") {
    addIssue(
      issues,
      "error",
      "model",
      `Node "${node.id}" must use exactly "provider-default" or a real model name.`
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
  if (node.output.format === "text" && node.output.schema !== null) {
    addIssue(
      issues,
      "error",
      "output-schema",
      `Text node "${node.id}" must set output.schema to null.`
    )
  }
  if (node.output.format === "json" && node.output.schema === null) {
    addIssue(
      issues,
      "error",
      "output-schema",
      `JSON node "${node.id}" must provide an output schema.`
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
        `Node "${node.id}" output schema is invalid: ${error instanceof Error ? error.message : String(error)}`
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
  for (const repeat of workflow.repeats) {
    if (!NODE_ID.test(repeat.id) || ROUND_INSTANCE_SUFFIX.test(repeat.id)) {
      addIssue(
        issues,
        "error",
        "repeat-id",
        `Repeat "${repeat.id}" must use an unreserved lowercase id.`
      )
    }
    if (repeatIds.has(repeat.id) || byId.has(repeat.id)) {
      addIssue(issues, "error", "repeat-id", `Repeat id "${repeat.id}" is not unique.`)
    }
    repeatIds.add(repeat.id)
    if (new Set(repeat.members).size !== repeat.members.length) {
      addIssue(issues, "error", "repeat-members", `Repeat "${repeat.id}" repeats a member id.`)
    }
    for (const member of repeat.members) {
      const node = byId.get(member)
      if (node === undefined) {
        addIssue(
          issues,
          "error",
          "repeat-members",
          `Repeat "${repeat.id}" names unknown member "${member}".`
        )
        continue
      }
      const owner = memberToRepeat.get(member)
      if (owner !== undefined) {
        addIssue(
          issues,
          "error",
          "repeat-members",
          `Node "${member}" belongs to both repeat "${owner}" and "${repeat.id}".`
        )
      }
      memberToRepeat.set(member, repeat.id)
      if (
        node.workspace.mode === "git-worktree" &&
        !node.workspace.git.branch.includes("{{nodeId}}")
      ) {
        addIssue(
          issues,
          "error",
          "repeat-worktree-branch",
          `Repeat member "${member}" Git worktree branch must include {{nodeId}} so every runtime round has a unique branch.`
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
          `Repeat member "${member}" explicit Git worktree path must include {{nodeId}} so every runtime round has a unique directory.`
        )
      }
    }
    if (!repeat.members.includes(repeat.until.node)) {
      addIssue(
        issues,
        "error",
        "repeat-until",
        `Repeat "${repeat.id}" until node "${repeat.until.node}" must be a member.`
      )
      continue
    }
    const untilNode = byId.get(repeat.until.node)
    if (repeat.until.type === "command-success" && untilNode?.type !== "command") {
      addIssue(
        issues,
        "error",
        "repeat-until",
        `Repeat "${repeat.id}" command-success condition must name a command node.`
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
          `Repeat "${repeat.id}" agent-output condition must name a schema-validated JSON agent node.`
        )
      }
      if (!JSON_POINTER.test(repeat.until.pointer)) {
        addIssue(
          issues,
          "error",
          "repeat-until",
          `Repeat "${repeat.id}" pointer must be an RFC 6901 JSON pointer.`
        )
      }
    }
  }

  for (const node of workflow.nodes) {
    const nodeRepeat = memberToRepeat.get(node.id)
    for (const dependency of node.needs) {
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
          `Repeat member "${node.id}" cannot depend on member "${dependency}" from another repeat.`
        )
      }
    }
    for (const input of node.inputs) {
      if (input.round === "previous") {
        const sourceRepeat = memberToRepeat.get(input.from)
        if (nodeRepeat === undefined || sourceRepeat !== nodeRepeat) {
          addIssue(
            issues,
            "error",
            "input-round",
            `Node "${node.id}" previous-round input "${input.from}" must come from the same repeat.`
          )
        }
      } else if (input.from === node.id || ancestors.get(node.id)?.has(input.from) !== true) {
        addIssue(
          issues,
          "error",
          "input-order",
          `Node "${node.id}" current-round input "${input.from}" must be an ancestor dependency.`
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
  for (const node of workflow.nodes) {
    if (
      node.type === "agent" &&
      node.prompt.includes("{{round}}") &&
      memberToRepeat.get(node.id) === undefined
    ) {
      addIssue(
        issues,
        "error",
        "prompt-round",
        `Node "${node.id}" uses {{round}} but is not a repeat member.`
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
          `Node "${node.id}" when condition must name a direct dependency.`
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
          `Node "${node.id}" when condition must name a schema-validated JSON agent node.`
        )
      }
      if (verdictNodes.has(node.id)) {
        addIssue(
          issues,
          "error",
          "condition-verdict",
          `Repeat verdict node "${node.id}" cannot be conditional.`
        )
      }
      if (node.type === "agent" && node.session.saveAs !== null) {
        addIssue(
          issues,
          "error",
          "condition-session",
          `Conditional node "${node.id}" cannot produce session alias "${node.session.saveAs}".`
        )
      }
      const nodeRepeat = memberToRepeat.get(node.id)
      const sourceRepeat = memberToRepeat.get(condition.node)
      if (nodeRepeat !== undefined && sourceRepeat !== undefined && nodeRepeat !== sourceRepeat) {
        addIssue(
          issues,
          "error",
          "condition-repeat",
          `Repeat member "${node.id}" cannot be conditioned by member "${condition.node}" from another repeat.`
        )
      }
    }
    for (const input of node.inputs) {
      if (input.include === "path" && byId.get(input.from)?.when !== undefined) {
        addIssue(
          issues,
          "error",
          "conditional-input-path",
          `Node "${node.id}" cannot request a path input from conditional node "${input.from}".`
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
  for (const node of workflow.nodes) {
    if (node.type !== "agent" || node.session.saveAs === null) {
      continue
    }
    const existing = aliases.get(node.session.saveAs)
    if (existing !== undefined) {
      addIssue(
        issues,
        "error",
        "session-alias",
        `Session alias "${node.session.saveAs}" is produced by both "${existing.id}" and "${node.id}".`
      )
    } else {
      aliases.set(node.session.saveAs, node)
    }
  }
  for (const node of workflow.nodes) {
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
        `Persistent repeat member "${node.id}" must resume an existing session; fork is not supported.`
      )
    }
    if (node.session.saveAs !== null) {
      addIssue(
        issues,
        "error",
        "repeat-session",
        `Persistent repeat member "${node.id}" cannot create session alias "${node.session.saveAs}".`
      )
    }
    if (source !== undefined && memberToRepeat.get(source.id) !== undefined) {
      addIssue(
        issues,
        "error",
        "repeat-session-source",
        `Persistent repeat member "${node.id}" must resume a session seeded outside its repeat.`
      )
    }
    if (source?.when !== undefined) {
      addIssue(
        issues,
        "error",
        "repeat-session-source",
        `Persistent repeat member "${node.id}" cannot resume conditionally produced session alias "${node.session.from ?? ""}".`
      )
    }
  }
  for (const node of workflow.nodes) {
    if (node.type !== "agent" || node.session.mode === "fresh" || node.session.from === null) {
      continue
    }
    const source = aliases.get(node.session.from)
    if (source === undefined) {
      addIssue(
        issues,
        "error",
        "session-source",
        `Node "${node.id}" names unknown session alias "${node.session.from}".`
      )
    } else if (source.provider !== node.provider) {
      addIssue(
        issues,
        "error",
        "session-provider",
        `Node "${node.id}" cannot continue a ${source.provider} session with ${node.provider}.`
      )
    } else if (ancestors.get(node.id)?.has(source.id) !== true) {
      addIssue(
        issues,
        "error",
        "session-order",
        `Node "${node.id}" session source "${source.id}" must be an ancestor dependency.`
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
            `Nodes "${left.id}" and "${right.id}" resume the same mutable session without an ordering dependency; use a linear chain or fork.`
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
        message: issuePath.length === 0 ? issue.message : `${issuePath}: ${issue.message}`
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
    addIssue(issues, "error", "workflow-cwd", "Workflow cwd must be absolute.")
  }
  if (workflow.callback.type === "webhook") {
    let valid = false
    try {
      const callbackUrl = new URL(workflow.callback.url)
      valid =
        (callbackUrl.protocol === "https:" || callbackUrl.protocol === "http:") &&
        callbackUrl.hostname.length > 0
    } catch {
      valid = false
    }
    if (!valid) {
      addIssue(
        issues,
        "error",
        "callback-url",
        "Webhook callback URL must be a valid absolute http or https URL."
      )
    }
  }
  const ids = new Set<string>()
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) {
      addIssue(issues, "error", "duplicate-node", `Node id "${node.id}" is duplicated.`)
    }
    ids.add(node.id)
    if (new Set(node.needs).size !== node.needs.length) {
      addIssue(issues, "error", "dependency", `Node "${node.id}" repeats a dependency.`)
    }
    for (const dependency of node.needs) {
      if (!workflow.nodes.some((candidate) => candidate.id === dependency)) {
        addIssue(
          issues,
          "error",
          "dependency",
          `Node "${node.id}" needs unknown node "${dependency}".`
        )
      }
    }
    validateNode(workflow, node, issues)
  }
  const { byId, ancestors, cycles } = graphMaps(workflow.nodes)
  for (const cycle of cycles) {
    addIssue(issues, "error", "cycle", `Dependency cycle: ${cycle.join(" -> ")}.`)
  }
  const memberToRepeat = validateRepeats(workflow, issues, byId, ancestors)
  validateConditions(workflow, issues, byId, memberToRepeat)
  const unrolled = unrolledRoundGroups(workflow)
  if (unrolled.length >= 2) {
    const sample = (unrolled[0] as readonly string[]).slice(0, 2)
    addIssue(
      issues,
      "warning",
      "unrolled-rounds",
      `Nodes look like hand-unrolled repeat rounds (e.g. ${sample.map((id) => `"${id}"`).join(", ")}). Declare a repeat with members, maxRounds, and an until condition instead: rounds then instantiate on demand and the board renders them as one loop.`,
      unrolled.flat()
    )
  }
  validateSessions(workflow, issues, ancestors, memberToRepeat)
  const overlaps = overlappingMutableNodes(workflow)
  if (overlaps.length > 0) {
    addIssue(
      issues,
      workflow.writeConflicts === "reject" ? "error" : "warning",
      "write-conflict",
      `Unordered mutable nodes overlap: ${overlaps.map(([a, b]) => `${a}/${b}`).join(", ")}.`,
      [...new Set(overlaps.flat())]
    )
  }
  const errors = issues.some((issue) => issue.severity === "error")
  return {
    workflow: errors ? null : workflow,
    issues,
    digest: errors ? null : workflowDigest(workflow)
  }
}
