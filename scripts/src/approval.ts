import type {
  AgentNode,
  FieldOrigin,
  WorkflowNode,
  WorkflowProvenance,
  WorkflowSpec
} from "./types.js"

export class InvalidWorkflowProvenanceError extends Error {
  readonly code = "invalid-provenance"
}

const REDACTED = "[redacted]"
const SENSITIVE_NAME =
  /(?:^|[-_.])(auth(?:orization)?|credential|key|password|secret|token)(?:$|[-_.])/i

function isSensitiveName(name: string): boolean {
  if (SENSITIVE_NAME.test(name)) {
    return true
  }
  const compact = name.toLowerCase().replaceAll(/[-_.]/g, "")
  return /^(?:api|access|private|client)?(?:key|secret|token|password|credential)$/.test(compact)
}

function redactHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null
    }
    url.username = ""
    url.password = ""
    for (const name of url.searchParams.keys()) {
      if (isSensitiveName(name)) {
        url.searchParams.set(name, REDACTED)
      }
    }
    return url.toString()
  } catch {
    return null
  }
}

function redactHeaderValue(value: string): string {
  const header = /^(\s*([^:\r\n]+):)([ \t]*)(.*)$/s.exec(value)
  if (header === null) {
    return value
  }
  const name = header[2] ?? ""
  const sensitive =
    isSensitiveName(name) || /^(?:(?:proxy-)?authorization|(?:set-)?cookie)$/i.test(name.trim())
  return sensitive ? `${header[1]}${header[3]}${REDACTED}` : value
}

function redactCommandArgument(argument: string): string {
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(argument)
  if (assignment !== null) {
    return `${assignment[1]}=${REDACTED}`
  }
  const option = /^(--?[^=]+)=(.*)$/s.exec(argument)
  if (option !== null && isSensitiveName(option[1] ?? "")) {
    return `${option[1]}=${REDACTED}`
  }
  return redactHttpUrl(argument) ?? argument
}

function callbackArgvPreview(argv: readonly string[]): readonly string[] {
  return argv.map((argument, index) => {
    const previous = argv[index - 1]
    if (previous === "-H" || previous === "--header") {
      return redactHeaderValue(argument)
    }
    if (previous === "-u" || previous === "--user") {
      return REDACTED
    }
    if (previous === "--url") {
      return redactHttpUrl(argument) ?? argument
    }
    if (previous !== undefined && /^--?[^=]+$/.test(previous) && isSensitiveName(previous)) {
      return REDACTED
    }
    const option = /^(--?[^=]+)=(.*)$/s.exec(argument)
    if (option !== null) {
      const [, name = "", value = ""] = option
      if (name === "-H" || name === "--header") {
        return `${name}=${redactHeaderValue(value)}`
      }
      if (name === "-u" || name === "--user") {
        return `${name}=${REDACTED}`
      }
      if (name === "--url") {
        return `${name}=${redactHttpUrl(value) ?? value}`
      }
    }
    return redactCommandArgument(argument)
  })
}

function callbackPreview(callback: WorkflowSpec["callback"]) {
  if (callback.type === "command") {
    return {
      type: callback.type,
      argv: callbackArgvPreview(callback.argv),
      timeoutSeconds: callback.timeoutSeconds
    }
  }
  if (callback.type === "webhook") {
    const url = new URL(callback.url)
    url.username = ""
    url.password = ""
    const query = [...url.searchParams.entries()].map(([name, value]) => ({
      name,
      value: isSensitiveName(name) ? REDACTED : value
    }))
    url.search = ""
    url.hash = ""
    return {
      type: callback.type,
      endpoint: url.toString(),
      query,
      headerNames: Object.keys(callback.headers).toSorted(),
      timeoutSeconds: callback.timeoutSeconds
    }
  }
  return callback
}

function dependencyDepths(nodes: readonly WorkflowNode[]): ReadonlyMap<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depths = new Map<string, number>()
  const resolve = (id: string, active: ReadonlySet<string>): number => {
    const cached = depths.get(id)
    if (cached !== undefined) {
      return cached
    }
    const node = byId.get(id)
    if (node === undefined || node.needs.length === 0 || active.has(id)) {
      return 1
    }
    const depth = 1 + Math.max(...node.needs.map((need) => resolve(need, new Set([...active, id]))))
    depths.set(id, depth)
    return depth
  }
  nodes.forEach((node) => resolve(node.id, new Set()))
  return depths
}

function sessionLineage(workflow: WorkflowSpec, node: AgentNode) {
  const producers = new Map<string, AgentNode>()
  workflow.nodes.forEach((candidate) => {
    if (candidate.type === "agent" && candidate.session.saveAs !== null) {
      producers.set(candidate.session.saveAs, candidate)
    }
  })
  const source = node.session.from === null ? null : (producers.get(node.session.from) ?? null)
  const lineage: string[] = []
  let current = source
  const seen = new Set<string>()
  while (current !== null && !seen.has(current.id)) {
    seen.add(current.id)
    lineage.unshift(current.id)
    current = current.session.from === null ? null : (producers.get(current.session.from) ?? null)
  }
  return { sourceNode: source?.id ?? null, lineage }
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1")
}

function provenancePointers(value: unknown): {
  readonly valid: ReadonlySet<string>
  readonly required: ReadonlySet<string>
} {
  const valid = new Set<string>()
  const required = new Set<string>()
  const visit = (current: unknown, pointer: string, arrayItem: boolean): void => {
    if (pointer.length > 0) {
      valid.add(pointer)
    }
    if (arrayItem || current === null || typeof current !== "object") {
      if (pointer.length > 0) {
        required.add(pointer)
      }
    }
    if (Array.isArray(current)) {
      if (current.length === 0 && pointer.length > 0) {
        required.add(pointer)
      }
      current.forEach((entry, index) => {
        visit(entry, `${pointer}/${index}`, true)
      })
      return
    }
    if (current !== null && typeof current === "object") {
      const entries = Object.entries(current)
      if (entries.length === 0 && pointer.length > 0) {
        required.add(pointer)
      }
      entries.forEach(([key, entry]) => {
        visit(entry, `${pointer}/${escapePointer(key)}`, false)
      })
    }
  }
  visit(value, "", false)
  return { valid, required }
}

interface ExpectedInferredNeed {
  readonly node: string
  readonly reason: "input-current" | "when"
  readonly sourcePath: string
}

function inferredNeedSignature(annotation: ExpectedInferredNeed): string {
  return JSON.stringify([annotation.node, annotation.reason, annotation.sourcePath])
}

function invalidOrigin(pointer: string, message: string): never {
  throw new InvalidWorkflowProvenanceError(`Invalid final-IR origin ${pointer}: ${message}`)
}

function validateOriginLocation(
  pointer: string,
  provenance: WorkflowProvenance,
  origin: FieldOrigin
): void {
  if (origin.location.file !== provenance.source) {
    invalidOrigin(
      pointer,
      `location file ${JSON.stringify(origin.location.file)} does not match provenance source ${JSON.stringify(provenance.source)}.`
    )
  }
  const { line, column, endLine, endColumn } = origin.location
  const coordinates = [line, column, endLine, endColumn]
  if (coordinates.every((coordinate) => coordinate === null)) {
    return
  }
  if (
    !coordinates.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isInteger(coordinate) && coordinate > 0
    )
  ) {
    invalidOrigin(pointer, "location coordinates must be either all null or all positive integers.")
  }
  if (
    (line as number) > (endLine as number) ||
    (line === endLine && (column as number) > (endColumn as number))
  ) {
    invalidOrigin(pointer, "location range start must not follow its end.")
  }
}

function validateExactOrigin(
  pointer: string,
  origin: FieldOrigin,
  expected: { readonly kind: FieldOrigin["kind"]; readonly sourcePath: string }
): void {
  if (origin.kind !== expected.kind || origin.sourcePath !== expected.sourcePath) {
    invalidOrigin(
      pointer,
      `expected ${expected.kind} source ${JSON.stringify(expected.sourcePath)}, received ${origin.kind} source ${JSON.stringify(origin.sourcePath)}.`
    )
  }
}

function validateDefaultOrigin(
  pointer: string,
  origin: FieldOrigin,
  rule: string,
  sourcePath: string
): void {
  if (origin.kind !== "default" || origin.rule !== rule || origin.sourcePath !== sourcePath) {
    invalidOrigin(
      pointer,
      `expected default rule ${JSON.stringify(rule)} from ${JSON.stringify(sourcePath)}.`
    )
  }
}

function nodeOriginContext(workflow: WorkflowSpec, pointer: string) {
  const match = /^\/nodes\/(\d+)(\/.*)?$/.exec(pointer)
  if (match === null) {
    return null
  }
  const index = Number(match[1])
  const node = workflow.nodes[index]
  return node === undefined ? null : { index, node, base: `/nodes/${index}`, rest: match[2] ?? "" }
}

function expectedDefault(
  workflow: WorkflowSpec,
  provenance: WorkflowProvenance,
  pointer: string
): { readonly rule: string; readonly sourcePath: string } | null {
  const rootDefaults: Readonly<Record<string, readonly [string, string]>> = {
    "/concurrency": ["root.concurrency.one", ""],
    "/callback": ["root.callback.none", ""],
    "/callback/type": ["root.callback.none", ""],
    "/callback/headers": ["callback.webhook.headers.empty", "/callback"],
    "/milestones": ["root.milestones.false", ""],
    "/writeConflicts": ["root.write-conflicts.reject", ""],
    "/repeats": ["root.repeats.empty", ""]
  }
  const root = rootDefaults[pointer]
  if (root !== undefined) {
    return { rule: root[0], sourcePath: root[1] }
  }
  const context = nodeOriginContext(workflow, pointer)
  if (context === null) {
    return null
  }
  const { base, node, rest } = context
  const common: Readonly<Record<string, readonly [string, string]>> = {
    "/title": ["node.title.id", base],
    "/needs": ["node.needs.empty", base],
    "/inputs": ["node.inputs.empty", base],
    "/cwd": ["node.cwd.null", base],
    "/workspace": ["node.workspace.shared", base],
    "/workspace/mode": ["node.workspace.shared", base],
    "/workspace/path": ["workspace.path.null", `${base}/workspace`],
    "/workspace/vcs": [
      node.workspace.mode === "git-worktree" ? "workspace.vcs.git" : "workspace.vcs.none",
      `${base}/workspace`
    ],
    "/workspace/writes": ["workspace.writes.empty", `${base}/workspace`],
    "/workspace/exclusiveResources": ["workspace.exclusive-resources.empty", `${base}/workspace`],
    "/retry": ["node.retry.one", base],
    "/retry/maxAttempts": ["node.retry.one", base],
    "/gate": ["node.gate.none", base]
  }
  const inputDefault = /^\/inputs\/(\d+)\/(include|round)$/.exec(rest)
  if (inputDefault !== null) {
    const field = inputDefault[2]
    return {
      rule: field === "include" ? "input.include.content" : "input.round.current",
      sourcePath: `${base}/inputs/${inputDefault[1]}`
    }
  }
  const commonDefault = common[rest]
  if (commonDefault !== undefined) {
    return { rule: commonDefault[0], sourcePath: commonDefault[1] }
  }
  if (node.type === "command") {
    const command: Readonly<Record<string, string>> = {
      "/inheritEnv": "command.inherit-env.empty",
      "/env": "command.env.empty",
      "/allowedExitCodes": "command.allowed-exit-codes.zero",
      "/allowedExitCodes/0": "command.allowed-exit-codes.zero"
    }
    const rule = command[rest]
    return rule === undefined ? null : { rule, sourcePath: base }
  }
  if (rest === "/session" || rest.startsWith("/session/")) {
    return { rule: "agent.session.fresh", sourcePath: base }
  }
  if (rest === "/output" || rest === "/output/format" || rest === "/output/schema") {
    return node.output.format === "text" &&
      rest === "/output/schema" &&
      provenance.origins[`${base}/output`]?.kind === "explicit"
      ? { rule: "output.text.schema-null", sourcePath: `${base}/output` }
      : { rule: "agent.output.text", sourcePath: base }
  }
  const agent: Readonly<Record<string, string>> = {
    "/model": "agent.model.provider-default",
    "/effort": "agent.effort.null",
    "/permissions/escalation": "agent.escalation.deny",
    "/permissions/extraArgs": "agent.extra-args.empty",
    "/permissions/inheritEnv": "agent.inherit-env.empty",
    "/permissions/env": "agent.env.empty"
  }
  const rule = agent[rest]
  return rule === undefined ? null : { rule, sourcePath: base }
}

function expectedExpanded(
  workflow: WorkflowSpec,
  pointer: string
): {
  readonly shorthand: Extract<FieldOrigin, { kind: "expanded" }>["shorthand"]
  readonly sourcePath: string
} | null {
  const context = nodeOriginContext(workflow, pointer)
  if (context === null) {
    return null
  }
  const { base, node, rest } = context
  if (rest === "/retry" || rest.startsWith("/retry/")) {
    return { shorthand: "retry-map", sourcePath: `${base}/retry` }
  }
  if (node.type === "command") {
    if (rest === "/type") {
      return { shorthand: "command-discriminator", sourcePath: `${base}/command` }
    }
    if (rest === "/argv" || rest.startsWith("/argv/")) {
      return {
        shorthand: "command-discriminator",
        sourcePath: `${base}/command${rest.slice("/argv".length)}`
      }
    }
    return null
  }
  if (rest === "/type" || rest === "/provider") {
    return { shorthand: "agent-discriminator", sourcePath: `${base}/agent` }
  }
  if (rest === "/permissions/access") {
    return { shorthand: "access-profile", sourcePath: `${base}/access` }
  }
  if (rest === "/session" || rest.startsWith("/session/")) {
    return {
      shorthand:
        node.session.mode === "fresh" && node.session.saveAs === null
          ? "session-scalar"
          : "session-map",
      sourcePath: `${base}/session`
    }
  }
  return null
}

function explicitSourcePath(workflow: WorkflowSpec, pointer: string): string | null {
  const context = nodeOriginContext(workflow, pointer)
  if (context === null) {
    return pointer
  }
  const { base, node, rest } = context
  if (rest === "") {
    return pointer
  }
  if (
    rest === "/type" ||
    rest === "/retry" ||
    rest.startsWith("/retry/") ||
    rest === "/permissions" ||
    rest === "/permissions/access" ||
    (node.type === "agent" &&
      (rest === "/provider" || rest === "/session" || rest.startsWith("/session/"))) ||
    (node.type === "command" && (rest === "/argv" || rest.startsWith("/argv/")))
  ) {
    return null
  }
  if (node.type === "agent" && rest.startsWith("/permissions/")) {
    const match = /^\/permissions\/(escalation|extraArgs|inheritEnv|env)(\/.*)?$/.exec(rest)
    return match === null ? null : `${base}/${match[1]}${match[2] ?? ""}`
  }
  return pointer
}

function validateStructuralOrigins(workflow: WorkflowSpec, provenance: WorkflowProvenance): void {
  for (const [pointer, origin] of Object.entries(provenance.origins)) {
    validateOriginLocation(pointer, provenance, origin)
    if (origin.kind === "explicit") {
      const sourcePath = explicitSourcePath(workflow, pointer)
      if (sourcePath === null) {
        invalidOrigin(pointer, "the field exists only in normalized IR and cannot be explicit.")
      }
      validateExactOrigin(pointer, origin, { kind: "explicit", sourcePath })
      continue
    }
    if (origin.kind === "default") {
      const expected = expectedDefault(workflow, provenance, pointer)
      if (expected === null) {
        invalidOrigin(
          pointer,
          `default rule ${JSON.stringify(origin.rule)} cannot produce this field.`
        )
      }
      validateDefaultOrigin(pointer, origin, expected.rule, expected.sourcePath)
      continue
    }
    if (origin.kind === "expanded") {
      const expected = expectedExpanded(workflow, pointer)
      if (expected === null) {
        invalidOrigin(
          pointer,
          `shorthand ${JSON.stringify(origin.shorthand)} cannot produce this field.`
        )
      }
      if (origin.shorthand === "retry-integer" && expected.shorthand === "retry-map") {
        validateExactOrigin(pointer, origin, { kind: "expanded", sourcePath: expected.sourcePath })
      } else if (
        origin.shorthand !== expected.shorthand ||
        origin.sourcePath !== expected.sourcePath
      ) {
        invalidOrigin(
          pointer,
          `expected ${expected.shorthand} expansion from ${JSON.stringify(expected.sourcePath)}.`
        )
      }
      continue
    }
    const context = nodeOriginContext(workflow, pointer)
    if (context === null || !/^\/needs\/\d+$/.test(context.rest)) {
      invalidOrigin(pointer, "inferred origins are permitted only on effective need items.")
    }
    const needIndex = Number(context.rest.slice("/needs/".length))
    const need = context.node.needs[needIndex]
    if (origin.reason === "input-current") {
      const input = context.node.inputs.findIndex(
        (candidate) => candidate.from === need && candidate.round === "current"
      )
      if (input < 0 || origin.sourcePath !== `${context.base}/inputs/${input}/from`) {
        invalidOrigin(pointer, "input-current source does not identify the matching current input.")
      }
    } else if (
      context.node.when === undefined ||
      context.node.when.node !== need ||
      origin.sourcePath !== `${context.base}/when/node`
    ) {
      invalidOrigin(pointer, "when source does not identify the matching condition node.")
    }
  }
}

function validateInferredNeeds(workflow: WorkflowSpec, provenance: WorkflowProvenance): void {
  const workflowNodeIds = new Set(workflow.nodes.map((node) => node.id))
  const expected = new Map<string, ExpectedInferredNeed[]>()
  workflow.nodes.forEach((node, nodeIndex) => {
    node.needs.forEach((need, needIndex) => {
      const origin = provenance.origins[`/nodes/${nodeIndex}/needs/${needIndex}`]
      if (origin?.kind !== "inferred") {
        return
      }
      const annotations = expected.get(node.id) ?? []
      annotations.push({ node: need, reason: origin.reason, sourcePath: origin.sourcePath })
      expected.set(node.id, annotations)
    })
  })

  for (const nodeId of Object.keys(provenance.inferredNeeds)) {
    if (!workflowNodeIds.has(nodeId)) {
      throw new InvalidWorkflowProvenanceError(
        `Unknown inferredNeeds node ${JSON.stringify(nodeId)}.`
      )
    }
    if (!expected.has(nodeId)) {
      throw new InvalidWorkflowProvenanceError(
        `Unexpected inferredNeeds annotations for node ${JSON.stringify(nodeId)}.`
      )
    }
  }

  for (const [nodeId, expectedAnnotations] of expected) {
    const actualAnnotations = provenance.inferredNeeds[nodeId]
    if (actualAnnotations === undefined) {
      throw new InvalidWorkflowProvenanceError(
        `Missing inferredNeeds annotations for node ${JSON.stringify(nodeId)}.`
      )
    }
    const expectedCounts = new Map<string, number>()
    const actualCounts = new Map<string, number>()
    expectedAnnotations.forEach((annotation) => {
      const signature = inferredNeedSignature(annotation)
      expectedCounts.set(signature, (expectedCounts.get(signature) ?? 0) + 1)
    })
    actualAnnotations.forEach((annotation) => {
      const signature = inferredNeedSignature(annotation)
      actualCounts.set(signature, (actualCounts.get(signature) ?? 0) + 1)
    })
    const signatures = new Set([...expectedCounts.keys(), ...actualCounts.keys()])
    const mismatch = [...signatures].find(
      (signature) => expectedCounts.get(signature) !== actualCounts.get(signature)
    )
    if (mismatch !== undefined) {
      throw new InvalidWorkflowProvenanceError(
        `InferredNeeds annotations for node ${JSON.stringify(nodeId)} do not exactly match final needs origins.`
      )
    }
  }
}

export function validateWorkflowProvenance(
  workflow: WorkflowSpec,
  provenance: WorkflowProvenance
): void {
  const pointers = provenancePointers(workflow)
  const missing = [...pointers.required].find(
    (pointer) => provenance.origins[pointer] === undefined
  )
  if (missing !== undefined) {
    throw new InvalidWorkflowProvenanceError(`Missing final-IR origin ${missing}.`)
  }
  const dangling = Object.keys(provenance.origins).find((pointer) => !pointers.valid.has(pointer))
  if (dangling !== undefined) {
    throw new InvalidWorkflowProvenanceError(`Dangling final-IR origin ${dangling}.`)
  }
  validateStructuralOrigins(workflow, provenance)
  validateInferredNeeds(workflow, provenance)
}

export function approvalPreview(workflow: WorkflowSpec, provenance: WorkflowProvenance) {
  validateWorkflowProvenance(workflow, provenance)
  const depths = dependencyDepths(workflow.nodes)
  const nodes = workflow.nodes.map((node) => {
    const inferred = provenance.inferredNeeds[node.id] ?? []
    const inferredSet = new Set(inferred.map((entry) => entry.node))
    const common = {
      id: node.id,
      type: node.type,
      title: node.title,
      depth: depths.get(node.id) ?? 1,
      cwd: node.cwd,
      needs: node.needs,
      explicitNeeds: node.needs.filter((id) => !inferredSet.has(id)),
      inferredNeeds: inferred,
      inputs: node.inputs,
      retry: node.retry,
      gate: node.gate,
      when: node.when ?? null,
      workspace: node.workspace,
      workroom: node.workroom ?? null,
      seat: node.seat ?? null
    }
    if (node.type === "command") {
      return {
        ...common,
        argv: node.argv,
        mutates: node.mutates,
        inheritEnv: node.inheritEnv,
        environmentKeys: Object.keys(node.env).toSorted(),
        allowedExitCodes: node.allowedExitCodes
      }
    }
    return {
      ...common,
      provider: node.provider,
      model: node.model,
      effort: node.effort,
      prompt: node.prompt,
      session: { ...node.session, ...sessionLineage(workflow, node) },
      output: node.output,
      access: node.permissions.access,
      escalation: node.permissions.escalation,
      extraArgs: node.permissions.extraArgs,
      inheritEnv: node.permissions.inheritEnv,
      environmentKeys: Object.keys(node.permissions.env).toSorted()
    }
  })
  return {
    name: workflow.name,
    objective: workflow.objective,
    cwd: workflow.cwd,
    concurrency: workflow.concurrency,
    limits: workflow.limits,
    milestones: workflow.milestones,
    writeConflicts: workflow.writeConflicts,
    ...(workflow.presentation === undefined ? {} : { presentation: workflow.presentation }),
    repeats: workflow.repeats,
    callback: callbackPreview(workflow.callback),
    nodes,
    origins: { ...provenance.origins }
  }
}

export function originLabel(origin: FieldOrigin | undefined): string {
  if (origin === undefined) {
    return "[origin-missing]"
  }
  if (origin.kind === "explicit") {
    return "[explicit]"
  }
  if (origin.kind === "default") {
    return `[default:${origin.rule}]`
  }
  if (origin.kind === "expanded") {
    return `[expanded:${origin.shorthand}]`
  }
  return `[inferred:${origin.reason}]`
}
