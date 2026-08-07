import { Result, Schema, SchemaIssue } from "effect"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, type Node } from "yaml"

import type {
  FieldOrigin,
  SourceLocation,
  WorkflowDiagnostic,
  WorkflowProvenance,
  WorkflowSource,
  WorkflowSpec
} from "./types.js"

import { WorkflowSourceSchema } from "./schema.js"
import { validateWorkflow } from "./validation.js"

const MAX_SOURCE_BYTES = 1_048_576
const decodeSource = Schema.decodeUnknownResult(WorkflowSourceSchema, {
  errors: "all",
  onExcessProperty: "error"
})
const SCHEMA_ISSUE_KIND_PREFIX = "\0orchestrate-schema-issue:"
const formatTaggedSchemaIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => {
    // Effect exposes issue kind as the structured `_tag` discriminator.
    // eslint-disable-next-line no-underscore-dangle
    return `${SCHEMA_ISSUE_KIND_PREFIX}${issue._tag}\0${SchemaIssue.defaultLeafHook(issue)}`
  }
})

export interface WorkflowSourceLoadHooks {
  /** Test seam for deterministic growth between fstat and the bounded read. */
  readonly afterFileStat?: () => void | Promise<void>
}

interface IndexedRange {
  readonly key?: SourceLocation
  readonly value: SourceLocation
}

export type WorkflowSourceIndex = Readonly<Record<string, IndexedRange>>

export interface LoadedWorkflowSource {
  readonly source: string
  readonly workflow: WorkflowSpec | null
  readonly digest: string | null
  readonly provenance: WorkflowProvenance | null
  readonly sourceIndex: WorkflowSourceIndex
  readonly diagnostics: readonly WorkflowDiagnostic[]
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1")
}

function issuePath(parts: readonly unknown[] | undefined): string {
  return parts === undefined || parts.length === 0
    ? ""
    : `/${parts.map((part) => escapePointer(String(part))).join("/")}`
}

function nullLocation(file: string): SourceLocation {
  return { file, line: null, column: null, endLine: null, endColumn: null }
}

function rangeLocation(
  file: string,
  lineCounter: LineCounter,
  range: readonly number[] | null | undefined
): SourceLocation {
  if (range === null || range === undefined || range[0] === undefined || range[1] === undefined) {
    return nullLocation(file)
  }
  const start = lineCounter.linePos(range[0])
  const end = lineCounter.linePos(range[1])
  return {
    file,
    line: start.line,
    column: start.col,
    endLine: end.line,
    endColumn: end.col
  }
}

function nodeLocation(file: string, lineCounter: LineCounter, node: Node | null): SourceLocation {
  return rangeLocation(file, lineCounter, node?.range)
}

function diagnostic(
  source: string,
  code: string,
  message: string,
  options: {
    readonly path?: string
    readonly location?: SourceLocation
    readonly severity?: "error" | "warning"
    readonly related?: WorkflowDiagnostic["related"]
  } = {}
): WorkflowDiagnostic {
  return {
    severity: options.severity ?? "error",
    code,
    message,
    path: options.path ?? "",
    location: options.location ?? nullLocation(source),
    ...(options.related === undefined ? {} : { related: options.related })
  }
}

function buildSourceIndex(
  source: string,
  lineCounter: LineCounter,
  root: Node | null
): WorkflowSourceIndex {
  const entries: Record<string, IndexedRange> = {
    "": { value: nodeLocation(source, lineCounter, root) }
  }
  const visitNode = (node: Node | null, pointer: string): void => {
    if (node === null) {
      return
    }
    entries[pointer] ??= { value: nodeLocation(source, lineCounter, node) }
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          continue
        }
        const child = `${pointer}/${escapePointer(pair.key.value)}`
        const value = pair.value as Node | null
        entries[child] = {
          key: nodeLocation(source, lineCounter, pair.key),
          value: nodeLocation(source, lineCounter, value)
        }
        visitNode(value, child)
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => {
        const child = `${pointer}/${index}`
        const value = item as Node | null
        entries[child] = { value: nodeLocation(source, lineCounter, value) }
        visitNode(value, child)
      })
    }
  }
  visitNode(root, "")
  return entries
}

class WorkflowJsonTreeError extends TypeError {
  constructor(
    message: string,
    readonly pointer: string
  ) {
    super(message)
  }
}

class WorkflowSourceReadError extends Error {
  constructor(
    readonly code: "workflow-size" | "workflow-file-type",
    message: string
  ) {
    super(message)
  }
}

async function readBoundedRegularFile(
  source: string,
  hooks: WorkflowSourceLoadHooks
): Promise<Uint8Array> {
  let handle
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new WorkflowSourceReadError(
        "workflow-file-type",
        "Workflow source must be a regular file; symbolic links are not supported."
      )
    }
    throw error
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new WorkflowSourceReadError(
        "workflow-file-type",
        "Workflow source must be a regular file; special files are not supported."
      )
    }
    if (metadata.size > MAX_SOURCE_BYTES) {
      throw new WorkflowSourceReadError("workflow-size", "Workflow source exceeds 1,048,576 bytes.")
    }
    await hooks.afterFileStat?.()
    const bounded = new Uint8Array(MAX_SOURCE_BYTES + 1)
    let offset = 0
    while (offset < bounded.byteLength) {
      const { bytesRead } = await handle.read(bounded, offset, bounded.byteLength - offset, null)
      if (bytesRead === 0) {
        break
      }
      offset += bytesRead
    }
    if (offset > MAX_SOURCE_BYTES) {
      throw new WorkflowSourceReadError("workflow-size", "Workflow source exceeds 1,048,576 bytes.")
    }
    return bounded.slice(0, offset)
  } finally {
    await handle.close()
  }
}

function assertJsonTree(value: unknown, seen = new Set<object>(), depth = 1, pointer = ""): void {
  if (typeof value === "number" && Object.is(value, -0)) {
    throw new WorkflowJsonTreeError("YAML numbers cannot be negative zero.", pointer)
  }
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new WorkflowJsonTreeError(
      "YAML integers must be within JavaScript's safe integer range.",
      pointer
    )
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new WorkflowJsonTreeError("YAML numbers must be finite.", pointer)
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return
  }
  if (depth > 64) {
    throw new TypeError("YAML collection depth exceeds 64.")
  }
  if (typeof value !== "object") {
    throw new TypeError(`YAML produced unsupported ${typeof value}.`)
  }
  if (seen.has(value)) {
    throw new TypeError("YAML produced a cyclic value.")
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("YAML arrays cannot contain symbol keys.")
      }
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (key === "length") {
          continue
        }
        if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError("YAML arrays cannot contain named properties.")
        }
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new TypeError(`YAML array item ${key} is an accessor.`)
        }
        if (descriptor.enumerable !== true) {
          throw new TypeError(`YAML array item ${key} is not enumerable.`)
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("YAML produced a sparse array.")
        }
        assertJsonTree(value[index], seen, depth + 1, `${pointer}/${index}`)
      }
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("YAML produced a non-plain object.")
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("YAML mappings cannot contain symbol keys.")
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new TypeError(`YAML mapping key ${JSON.stringify(key)} is an accessor.`)
      }
      if (descriptor.enumerable !== true) {
        throw new TypeError(`YAML mapping key ${JSON.stringify(key)} is not enumerable.`)
      }
      assertJsonTree(descriptor.value, seen, depth + 1, `${pointer}/${escapePointer(key)}`)
    }
  } finally {
    seen.delete(value)
  }
}

function astViolation(
  root: Node | null
): { readonly code: string; readonly message: string; readonly node: Node | null } | null {
  let found: {
    readonly code: string
    readonly message: string
    readonly node: Node | null
  } | null = null
  const walk = (node: Node | null, depth: number): void => {
    if (node === null || found !== null) {
      return
    }
    if (isAlias(node)) {
      found = { code: "workflow-yaml-alias", message: "YAML aliases are not supported.", node }
      return
    }
    if ("anchor" in node && typeof node.anchor === "string" && node.anchor.length > 0) {
      found = { code: "workflow-yaml-anchor", message: "YAML anchors are not supported.", node }
      return
    }
    if (node.tag !== undefined) {
      found = { code: "workflow-yaml-tag", message: "Explicit YAML tags are not supported.", node }
      return
    }
    if ((isMap(node) || isSeq(node)) && depth > 64) {
      found = { code: "workflow-yaml-depth", message: "YAML collection depth exceeds 64.", node }
      return
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        walk(pair.key as Node, depth)
        if (found !== null) {
          return
        }
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          found = {
            code: "workflow-yaml-key",
            message: "YAML mapping keys must be string scalars.",
            node: pair.key as Node
          }
          return
        }
        if (pair.key.value === "<<") {
          found = {
            code: "workflow-yaml-merge",
            message: "YAML merge keys are not supported.",
            node: pair.key
          }
          return
        }
        walk(pair.value as Node | null, depth + (isMap(pair.value) || isSeq(pair.value) ? 1 : 0))
      }
    } else if (isSeq(node)) {
      for (const item of node.items) {
        walk(item as Node | null, depth + (isMap(item) || isSeq(item) ? 1 : 0))
      }
    }
  }
  walk(root, isMap(root) || isSeq(root) ? 1 : 0)
  return found
}

function has(value: object, key: string): boolean {
  return Object.hasOwn(value, key)
}

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function locationFor(index: WorkflowSourceIndex, source: string, pointer: string): SourceLocation {
  let current = pointer
  for (;;) {
    const located = index[current]
    if (located !== undefined) {
      return located.value
    }
    if (current.length === 0) {
      return nullLocation(source)
    }
    current = current.slice(0, Math.max(0, current.lastIndexOf("/")))
  }
}

function normalizeWorkflow(
  source: WorkflowSource,
  sourceFile: string,
  sourceIndex: WorkflowSourceIndex
): {
  readonly workflow: WorkflowSpec
  readonly digest: string
  readonly provenance: WorkflowProvenance
  readonly diagnostics: readonly WorkflowDiagnostic[]
} {
  const input = record(source)
  const origins: Record<string, FieldOrigin> = {}
  const inferredNeeds: Record<
    string,
    { node: string; reason: "input-current" | "when"; sourcePath: string }[]
  > = {}
  const diagnostics: WorkflowDiagnostic[] = []

  const explicit = (sourcePath: string): FieldOrigin => ({
    kind: "explicit",
    sourcePath,
    location: locationFor(sourceIndex, sourceFile, sourcePath)
  })
  const defaulted = (rule: string, sourcePath: string): FieldOrigin => ({
    kind: "default",
    rule,
    sourcePath,
    location: locationFor(sourceIndex, sourceFile, sourcePath)
  })
  const expanded = (
    shorthand: Extract<FieldOrigin, { kind: "expanded" }>["shorthand"],
    sourcePath: string
  ): FieldOrigin => ({
    kind: "expanded",
    shorthand,
    sourcePath,
    location: locationFor(sourceIndex, sourceFile, sourcePath)
  })
  const inferred = (reason: "input-current" | "when", sourcePath: string): FieldOrigin => ({
    kind: "inferred",
    reason,
    sourcePath,
    location: locationFor(sourceIndex, sourceFile, sourcePath)
  })
  const markTree = (
    pointer: string,
    value: unknown,
    origin: FieldOrigin,
    mapSourceChildren = origin.kind === "explicit",
    sourcePointer = origin.sourcePath
  ): void => {
    origins[pointer] = mapSourceChildren
      ? {
          ...origin,
          sourcePath: sourcePointer,
          location: locationFor(sourceIndex, sourceFile, sourcePointer)
        }
      : origin
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        markTree(
          `${pointer}/${index}`,
          entry,
          origin,
          mapSourceChildren,
          `${sourcePointer}/${index}`
        )
      })
    } else if (value !== null && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        const segment = escapePointer(key)
        markTree(
          `${pointer}/${segment}`,
          nested,
          origin,
          mapSourceChildren,
          `${sourcePointer}/${segment}`
        )
      }
    }
  }
  const deleteOriginSubtree = (pointer: string): void => {
    for (const candidate of Object.keys(origins)) {
      if (candidate === pointer || candidate.startsWith(`${pointer}/`)) {
        Reflect.deleteProperty(origins, candidate)
      }
    }
  }

  const rootValue = <T>(key: string, fallback: T, rule: string): T => {
    const pointer = `/${key}`
    const value = (has(input, key) ? input[key] : fallback) as T
    markTree(pointer, value, has(input, key) ? explicit(pointer) : defaulted(rule, ""))
    return value
  }

  const callback = rootValue("callback", { type: "none" }, "root.callback.none")
  if (record(callback).type === "webhook" && !has(record(callback), "headers")) {
    record(callback).headers = {}
    markTree("/callback/headers", {}, defaulted("callback.webhook.headers.empty", "/callback"))
  }

  // The returned records are fresh normalized IR objects; source values are never mutated here.
  // oxlint-disable-next-line oxc/no-map-spread
  const nodes = (source.nodes as readonly unknown[]).map((rawNode, index) => {
    const node = record(rawNode)
    const sourceBase = `/nodes/${index}`
    const irBase = sourceBase
    const nodeValue = <T>(key: string, fallback: T, rule: string): T => {
      const pointer = `${sourceBase}/${key}`
      const value = (has(node, key) ? node[key] : fallback) as T
      markTree(
        `${irBase}/${key}`,
        value,
        has(node, key) ? explicit(pointer) : defaulted(rule, sourceBase)
      )
      return value
    }
    const explicitNeeds = nodeValue<readonly string[]>("needs", [], "node.needs.empty")
    const inputs = nodeValue<readonly Record<string, unknown>[]>(
      "inputs",
      [],
      "node.inputs.empty"
    ).map((entry, inputIndex) => {
      const sourceInput = record(entry)
      const pointer = `${sourceBase}/inputs/${inputIndex}`
      const normalized = {
        from: sourceInput.from,
        as: sourceInput.as,
        include: has(sourceInput, "include") ? sourceInput.include : "content",
        round: has(sourceInput, "round") ? sourceInput.round : "current"
      }
      markTree(`${irBase}/inputs/${inputIndex}`, normalized, explicit(pointer))
      if (!has(sourceInput, "include")) {
        markTree(
          `${irBase}/inputs/${inputIndex}/include`,
          "content",
          defaulted("input.include.content", pointer)
        )
      }
      if (!has(sourceInput, "round")) {
        markTree(
          `${irBase}/inputs/${inputIndex}/round`,
          "current",
          defaulted("input.round.current", pointer)
        )
      }
      return normalized
    })
    const when = has(node, "when") ? node.when : undefined
    const effectiveNeeds = [...explicitNeeds]
    inputs.forEach((entry, inputIndex) => {
      if (entry.round === "current" && !effectiveNeeds.includes(entry.from as string)) {
        const sourcePath = `${sourceBase}/inputs/${inputIndex}/from`
        const itemIndex = effectiveNeeds.length
        effectiveNeeds.push(entry.from as string)
        origins[`${irBase}/needs/${itemIndex}`] = inferred("input-current", sourcePath)
        inferredNeeds[String(node.id)] ??= []
        inferredNeeds[String(node.id)]?.push({
          node: entry.from as string,
          reason: "input-current",
          sourcePath
        })
      }
    })
    if (when !== undefined) {
      const conditionNode = record(when).node as string
      if (!effectiveNeeds.includes(conditionNode)) {
        const sourcePath = `${sourceBase}/when/node`
        const itemIndex = effectiveNeeds.length
        effectiveNeeds.push(conditionNode)
        origins[`${irBase}/needs/${itemIndex}`] = inferred("when", sourcePath)
        inferredNeeds[String(node.id)] ??= []
        inferredNeeds[String(node.id)]?.push({ node: conditionNode, reason: "when", sourcePath })
      }
      markTree(`${irBase}/when`, when, explicit(`${sourceBase}/when`))
    }
    origins[`${irBase}/needs`] = has(node, "needs")
      ? explicit(`${sourceBase}/needs`)
      : defaulted("node.needs.empty", sourceBase)

    const workspaceRaw = nodeValue<Record<string, unknown>>(
      "workspace",
      { mode: "shared" },
      "node.workspace.shared"
    )
    const workspace: Record<string, unknown> = {
      ...workspaceRaw,
      path: has(workspaceRaw, "path") ? workspaceRaw.path : null,
      vcs:
        workspaceRaw.mode === "git-worktree"
          ? "git"
          : has(workspaceRaw, "vcs")
            ? workspaceRaw.vcs
            : "none",
      writes: has(workspaceRaw, "writes") ? workspaceRaw.writes : [],
      exclusiveResources: has(workspaceRaw, "exclusiveResources")
        ? workspaceRaw.exclusiveResources
        : []
    }
    markTree(
      `${irBase}/workspace`,
      workspace,
      has(node, "workspace")
        ? explicit(`${sourceBase}/workspace`)
        : defaulted("node.workspace.shared", sourceBase)
    )
    for (const [key, rule] of [
      ["path", "workspace.path.null"],
      ["vcs", workspace.mode === "git-worktree" ? "workspace.vcs.git" : "workspace.vcs.none"],
      ["writes", "workspace.writes.empty"],
      ["exclusiveResources", "workspace.exclusive-resources.empty"]
    ] as const) {
      if (!has(workspaceRaw, key)) {
        markTree(
          `${irBase}/workspace/${key}`,
          workspace[key],
          defaulted(rule, `${sourceBase}/workspace`)
        )
      }
    }

    const retryRaw = nodeValue<unknown>("retry", 1, "node.retry.one")
    const retry = typeof retryRaw === "number" ? { maxAttempts: retryRaw } : retryRaw
    markTree(
      `${irBase}/retry`,
      retry,
      has(node, "retry")
        ? expanded(
            typeof retryRaw === "number" ? "retry-integer" : "retry-map",
            `${sourceBase}/retry`
          )
        : defaulted("node.retry.one", sourceBase)
    )

    const common = {
      id: node.id,
      title: nodeValue("title", node.id, "node.title.id"),
      needs: effectiveNeeds,
      ...(has(node, "workroom") ? { workroom: node.workroom } : {}),
      ...(has(node, "seat") ? { seat: node.seat } : {}),
      cwd: nodeValue("cwd", null, "node.cwd.null"),
      workspace,
      inputs,
      retry,
      gate: nodeValue("gate", "none", "node.gate.none"),
      ...(when === undefined ? {} : { when })
    }
    markTree(`${irBase}/id`, node.id, explicit(`${sourceBase}/id`))
    if (has(node, "workroom")) {
      markTree(`${irBase}/workroom`, node.workroom, explicit(`${sourceBase}/workroom`))
    }
    if (has(node, "seat")) {
      markTree(`${irBase}/seat`, node.seat, explicit(`${sourceBase}/seat`))
    }

    if (has(node, "command")) {
      const command = {
        ...common,
        type: "command",
        argv: node.command,
        mutates: node.mutates,
        inheritEnv: nodeValue("inheritEnv", [], "command.inherit-env.empty"),
        env: nodeValue("env", {}, "command.env.empty"),
        allowedExitCodes: nodeValue("allowedExitCodes", [0], "command.allowed-exit-codes.zero")
      }
      markTree(
        `${irBase}/type`,
        "command",
        expanded("command-discriminator", `${sourceBase}/command`)
      )
      markTree(
        `${irBase}/argv`,
        node.command,
        expanded("command-discriminator", `${sourceBase}/command`),
        true
      )
      markTree(`${irBase}/mutates`, node.mutates, explicit(`${sourceBase}/mutates`))
      return command
    }

    const provider = node.agent as "codex" | "claude"
    const sessionRaw = nodeValue<unknown>("session", "fresh", "agent.session.fresh")
    let session: Record<string, unknown>
    if (typeof sessionRaw === "string") {
      session = { mode: "fresh", from: null, saveAs: null }
    } else if (has(record(sessionRaw), "fresh")) {
      session = { mode: "fresh", from: null, saveAs: record(sessionRaw).fresh }
    } else if (has(record(sessionRaw), "resume")) {
      session = {
        mode: "resume",
        from: record(sessionRaw).resume,
        saveAs: record(sessionRaw).saveAs ?? null
      }
    } else {
      session = {
        mode: "fork",
        from: record(sessionRaw).fork,
        saveAs: record(sessionRaw).saveAs ?? null
      }
    }
    deleteOriginSubtree(`${irBase}/session`)
    markTree(
      `${irBase}/session`,
      session,
      has(node, "session")
        ? expanded(
            typeof sessionRaw === "string" ? "session-scalar" : "session-map",
            `${sourceBase}/session`
          )
        : defaulted("agent.session.fresh", sourceBase)
    )
    const outputRaw = nodeValue<Record<string, unknown>>(
      "output",
      { format: "text" },
      "agent.output.text"
    )
    const output = outputRaw.format === "text" ? { format: "text", schema: null } : outputRaw
    markTree(
      `${irBase}/output`,
      output,
      has(node, "output")
        ? explicit(`${sourceBase}/output`)
        : defaulted("agent.output.text", sourceBase)
    )
    if (outputRaw.format === "text") {
      markTree(
        `${irBase}/output/schema`,
        null,
        has(node, "output")
          ? defaulted("output.text.schema-null", `${sourceBase}/output`)
          : defaulted("agent.output.text", sourceBase)
      )
    }
    const permissions = {
      execution: provider === "codex" ? { sandbox: node.execution } : { permissionMode: "dontAsk" },
      escalation: nodeValue("escalation", "deny", "agent.escalation.deny"),
      extraArgs: nodeValue("extraArgs", [], "agent.extra-args.empty"),
      inheritEnv: nodeValue("inheritEnv", [], "agent.inherit-env.empty"),
      env: nodeValue("env", {}, "agent.env.empty")
    }
    markTree(
      `${irBase}/permissions/execution`,
      permissions.execution,
      expanded("execution-profile", `${sourceBase}/execution`)
    )
    markTree(
      `${irBase}/permissions/escalation`,
      permissions.escalation,
      origins[`${irBase}/escalation`] ?? defaulted("agent.escalation.deny", sourceBase)
    )
    markTree(
      `${irBase}/permissions/extraArgs`,
      permissions.extraArgs,
      origins[`${irBase}/extraArgs`] ?? defaulted("agent.extra-args.empty", sourceBase)
    )
    markTree(
      `${irBase}/permissions/inheritEnv`,
      permissions.inheritEnv,
      origins[`${irBase}/inheritEnv`] ?? defaulted("agent.inherit-env.empty", sourceBase)
    )
    markTree(
      `${irBase}/permissions/env`,
      permissions.env,
      origins[`${irBase}/env`] ?? defaulted("agent.env.empty", sourceBase)
    )
    deleteOriginSubtree(`${irBase}/escalation`)
    deleteOriginSubtree(`${irBase}/extraArgs`)
    deleteOriginSubtree(`${irBase}/inheritEnv`)
    deleteOriginSubtree(`${irBase}/env`)
    const agent = {
      ...common,
      type: "agent",
      provider,
      model: nodeValue("model", "provider-default", "agent.model.provider-default"),
      effort: nodeValue("effort", null, "agent.effort.null"),
      prompt: node.prompt,
      session,
      output,
      permissions
    }
    markTree(`${irBase}/type`, "agent", expanded("agent-discriminator", `${sourceBase}/agent`))
    markTree(`${irBase}/provider`, provider, expanded("agent-discriminator", `${sourceBase}/agent`))
    markTree(`${irBase}/prompt`, node.prompt, explicit(`${sourceBase}/prompt`))
    return agent
  })

  const presentation = has(input, "presentation") ? input.presentation : undefined
  if (presentation !== undefined) {
    markTree("/presentation", presentation, explicit("/presentation"))
  }
  const workflowCandidate = {
    name: rootValue("name", "", "required.name"),
    objective: rootValue("objective", "", "required.objective"),
    cwd: rootValue("cwd", "", "required.cwd"),
    concurrency: rootValue("concurrency", 1, "root.concurrency.one"),
    callback,
    milestones: rootValue("milestones", false, "root.milestones.false"),
    limits: rootValue("limits", { maxStarts: null }, "required.limits"),
    writeConflicts: rootValue("writeConflicts", "reject", "root.write-conflicts.reject"),
    ...(presentation === undefined ? {} : { presentation }),
    nodes,
    repeats: rootValue("repeats", [], "root.repeats.empty")
  }
  origins["/nodes"] = explicit("/nodes")
  nodes.forEach((_node, index) => {
    // Targeted field origins above override this broad collection origin.
    origins[`/nodes/${index}`] = explicit(`/nodes/${index}`)
  })
  const validated = validateWorkflow(workflowCandidate)
  for (const issue of validated.issues) {
    let pointer = issue.path
    while (pointer.length > 0 && origins[pointer] === undefined) {
      pointer = pointer.slice(0, pointer.lastIndexOf("/"))
    }
    const origin = origins[pointer] ?? explicit("")
    const relatedNodeIds = issue.relatedNodes ?? issue.nodes?.slice(1)
    const related = relatedNodeIds?.flatMap((nodeId) => {
      const nodeIndex = nodes.findIndex((node) => node.id === nodeId)
      if (nodeIndex < 0) {
        return []
      }
      const relatedOrigin = origins[`/nodes/${nodeIndex}`] ?? explicit(`/nodes/${nodeIndex}`)
      return [
        {
          path: relatedOrigin.sourcePath,
          location: relatedOrigin.location,
          message: `Related node ${JSON.stringify(nodeId)}.`
        }
      ]
    })
    diagnostics.push({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      path: origin.sourcePath,
      location: origin.location,
      ...(issue.nodes === undefined ? {} : { nodes: issue.nodes }),
      ...(issue.primaryNode === undefined ? {} : { primaryNode: issue.primaryNode }),
      ...(issue.relatedNodes === undefined ? {} : { relatedNodes: issue.relatedNodes }),
      ...(related === undefined || related.length === 0 ? {} : { related })
    })
  }
  if (validated.workflow === null || validated.digest === null) {
    throw new WorkflowNormalizationFailure(diagnostics)
  }
  return {
    workflow: validated.workflow,
    digest: validated.digest,
    provenance: { source: sourceFile, origins, inferredNeeds },
    diagnostics
  }
}

class WorkflowNormalizationFailure extends Error {
  constructor(readonly diagnostics: readonly WorkflowDiagnostic[]) {
    super("Workflow normalization failed.")
  }
}

export async function loadWorkflowSource(
  file: string,
  hooks: WorkflowSourceLoadHooks = {}
): Promise<LoadedWorkflowSource> {
  const source = path.resolve(file)
  const empty = (diagnostics: readonly WorkflowDiagnostic[]): LoadedWorkflowSource => ({
    source,
    workflow: null,
    digest: null,
    provenance: null,
    sourceIndex: {},
    diagnostics
  })
  if (!(file.endsWith(".yaml") || file.endsWith(".yml"))) {
    return empty([
      diagnostic(
        source,
        "workflow-extension",
        "Workflow authoring is YAML-only; use a .yaml or .yml file. JSON workflow files are not supported."
      )
    ])
  }
  let bytes: Uint8Array
  try {
    bytes = await readBoundedRegularFile(source, hooks)
  } catch (error) {
    if (error instanceof WorkflowSourceReadError) {
      return empty([diagnostic(source, error.code, error.message)])
    }
    return empty([
      diagnostic(
        source,
        "workflow-read",
        `Unable to read workflow source: ${error instanceof Error ? error.message : String(error)}`
      )
    ])
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    return empty([
      diagnostic(
        source,
        "workflow-utf8",
        `Workflow source is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`
      )
    ])
  }
  const lineCounter = new LineCounter()
  let documents
  try {
    documents = parseAllDocuments(text, {
      lineCounter,
      version: "1.2",
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      merge: false,
      customTags: [],
      resolveKnownTags: false,
      keepSourceTokens: true
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const depth =
      error instanceof RangeError ||
      /resource exhaustion|collection depth|nesting depth/i.test(message)
    return empty([
      diagnostic(
        source,
        depth ? "workflow-yaml-depth" : "workflow-yaml",
        depth ? "YAML collection depth exceeds 64." : `Unable to parse YAML: ${message}`
      )
    ])
  }
  const parserProblems = documents.flatMap((candidate) => [
    ...candidate.errors,
    ...candidate.warnings
  ])
  if (parserProblems.length > 0) {
    return empty(
      parserProblems.map((problem) => {
        const problemCode = (problem as { readonly code?: unknown }).code
        const depth =
          problemCode === "RESOURCE_EXHAUSTION" ||
          /resource exhaustion|collection depth|nesting depth/i.test(problem.message)
        return diagnostic(
          source,
          depth ? "workflow-yaml-depth" : "workflow-yaml",
          depth ? "YAML collection depth exceeds 64." : problem.message,
          { location: rangeLocation(source, lineCounter, problem.pos) }
        )
      })
    )
  }
  const document = documents[0]
  if (documents.length !== 1 || document === undefined || document.contents === null) {
    return empty([
      diagnostic(
        source,
        documents.length === 0 || document?.contents === null
          ? "workflow-yaml-empty"
          : "workflow-yaml-documents",
        documents.length === 0 || document?.contents === null
          ? "Workflow source must contain exactly one nonempty YAML document."
          : "Workflow source must contain exactly one YAML document."
      )
    ])
  }
  const violation = astViolation(document.contents)
  if (violation !== null) {
    return empty([
      diagnostic(source, violation.code, violation.message, {
        location: nodeLocation(source, lineCounter, violation.node)
      })
    ])
  }
  const sourceIndex = buildSourceIndex(source, lineCounter, document.contents)
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 0 })
    assertJsonTree(value)
  } catch (error) {
    const errorLocation =
      error instanceof WorkflowJsonTreeError ? sourceIndex[error.pointer] : undefined
    return {
      ...empty([
        diagnostic(
          source,
          "workflow-yaml-value",
          error instanceof Error ? error.message : String(error),
          {
            ...(error instanceof WorkflowJsonTreeError ? { path: error.pointer } : {}),
            ...(errorLocation === undefined ? {} : { location: errorLocation.value })
          }
        )
      ]),
      sourceIndex
    }
  }
  const decoded = decodeSource(value)
  if (Result.isFailure(decoded)) {
    const diagnostics = formatTaggedSchemaIssues(decoded.failure.issue).issues.map((issue) => {
      const pointer = issuePath(issue.path)
      const indexed = sourceIndex[pointer]
      const tagged = issue.message.startsWith(SCHEMA_ISSUE_KIND_PREFIX)
        ? issue.message.slice(SCHEMA_ISSUE_KIND_PREFIX.length).split("\0", 2)
        : null
      const location =
        tagged?.[0] === "UnexpectedKey"
          ? (indexed?.key ?? indexed?.value ?? locationFor(sourceIndex, source, pointer))
          : locationFor(sourceIndex, source, pointer)
      return diagnostic(source, "workflow-source-schema", tagged?.[1] ?? issue.message, {
        path: pointer,
        location
      })
    })
    return { ...empty(diagnostics), sourceIndex }
  }
  try {
    const normalized = normalizeWorkflow(decoded.success, source, sourceIndex)
    return {
      source,
      workflow: normalized.workflow,
      digest: normalized.digest,
      provenance: normalized.provenance,
      sourceIndex,
      diagnostics: normalized.diagnostics
    }
  } catch (error) {
    if (error instanceof WorkflowNormalizationFailure) {
      return { ...empty(error.diagnostics), sourceIndex }
    }
    return {
      ...empty([
        diagnostic(
          source,
          "workflow-normalization",
          error instanceof Error ? error.message : String(error)
        )
      ]),
      sourceIndex
    }
  }
}

export function formatWorkflowDiagnostics(diagnostics: readonly WorkflowDiagnostic[]): string {
  return diagnostics
    .flatMap((entry) => {
      const position =
        entry.location.line === null || entry.location.column === null
          ? ""
          : `:${entry.location.line}:${entry.location.column}`
      const pointer = entry.path.length === 0 ? "/" : entry.path
      return [
        `${entry.location.file}${position}: ${entry.severity === "error" ? "ERROR" : "WARN"} ${entry.code} ${pointer}: ${entry.message}`,
        ...(entry.related ?? []).map((related) => {
          const relatedPosition =
            related.location.line === null || related.location.column === null
              ? ""
              : `:${related.location.line}:${related.location.column}`
          const relatedPointer = related.path.length === 0 ? "/" : related.path
          return `  related ${related.location.file}${relatedPosition} ${relatedPointer}: ${related.message}`
        })
      ]
    })
    .join("\n")
}
