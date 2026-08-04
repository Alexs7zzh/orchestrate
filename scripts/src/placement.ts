import type {
  NodeMatcher,
  NodeRunState,
  PaneReference,
  PlacementRule,
  UiPreferences,
  WorkflowNode,
  WorkflowSpec
} from "./types.js"

export interface LivePlacement {
  readonly nodeId: string
  readonly pane: PaneReference
}

export interface PlacementContext {
  readonly runId: string
  readonly live: readonly LivePlacement[]
  readonly retryPane: PaneReference | null
  readonly sessionPane: PaneReference | null
}

export interface PlacementResolution {
  /** Workspace destination, independent of the ordered node surface rule. */
  readonly workspace: UiPreferences["placement"]["workspace"]
  readonly surface: "tab" | "split"
  readonly matchedRuleIndex: number
  /** Stable, run-scoped identity recorded in PaneReference.group. */
  readonly group: string
  /** Human-facing tab label. */
  readonly groupLabel: string
  readonly groupOrdinal: number
  /** An existing pane in the target tab, used as the split anchor. */
  readonly anchorPane: PaneReference | null
  /** An existing pane whose UI slot should be replaced by this attempt. */
  readonly reusePane: PaneReference | null
}

const DEFAULT_MATCHER: NodeMatcher = {
  type: "any",
  provider: "any",
  level: "any",
  origin: "any",
  id: "*"
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character
}

function characterClass(pattern: string, start: number): readonly [string, number] | null {
  let index = start + 1
  if (index >= pattern.length) {
    return null
  }

  let source = "["
  if (pattern[index] === "!" || pattern[index] === "^") {
    source += "^"
    index += 1
  }
  if (pattern[index] === "]") {
    source += "\\]"
    index += 1
  }

  const contentStart = index
  while (index < pattern.length && pattern[index] !== "]") {
    const character = pattern[index] as string
    source += character === "\\" ? "\\\\" : character
    index += 1
  }
  if (index >= pattern.length || index === contentStart) {
    return null
  }
  return [`${source}]`, index] as const
}

/** Match a complete node id with shell-style `*`, `?`, and character classes. */
export function matchesNodeGlob(pattern: string, nodeId: string): boolean {
  let source = "^"
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string
    if (character === "*") {
      source += ".*"
      continue
    }
    if (character === "?") {
      source += "."
      continue
    }
    if (character === "[") {
      const parsed = characterClass(pattern, index)
      if (parsed !== null) {
        source += parsed[0]
        index = parsed[1]
        continue
      }
    }
    if (character === "\\" && index + 1 < pattern.length) {
      index += 1
      source += escapeRegex(pattern[index] as string)
      continue
    }
    source += escapeRegex(character)
  }
  return new RegExp(`${source}$`, "u").test(nodeId)
}

function isDefaultMatcher(matcher: NodeMatcher): boolean {
  return (
    matcher.type === DEFAULT_MATCHER.type &&
    matcher.provider === DEFAULT_MATCHER.provider &&
    matcher.level === DEFAULT_MATCHER.level &&
    matcher.origin === DEFAULT_MATCHER.origin &&
    matcher.id === DEFAULT_MATCHER.id
  )
}

function assertPlacementRules(rules: readonly PlacementRule[]): void {
  if (rules.length === 0 || !isDefaultMatcher(rules[rules.length - 1]?.match ?? DEFAULT_MATCHER)) {
    throw new Error("Placement rules must end with the match-all default rule.")
  }
  if (rules.slice(0, -1).some((rule) => isDefaultMatcher(rule.match))) {
    throw new Error("Only the final placement rule may be the match-all default.")
  }
}

export function matchesNodeMatcher(matcher: NodeMatcher, runtimeNode: NodeRunState): boolean {
  return (
    (matcher.type === "any" || matcher.type === runtimeNode.type) &&
    (matcher.provider === "any" || matcher.provider === runtimeNode.provider) &&
    (matcher.level === "any" ||
      matcher.level === (runtimeNode.needs.length === 0 ? "root" : "child")) &&
    (matcher.origin === "any" || matcher.origin === runtimeNode.origin) &&
    matchesNodeGlob(matcher.id, runtimeNode.id)
  )
}

function workflowNode(workflow: WorkflowSpec, templateId: string): WorkflowNode {
  const node = workflow.nodes.find((candidate) => candidate.id === templateId)
  if (node === undefined) {
    throw new Error(`Unknown node template "${templateId}".`)
  }
  return node
}

export function nearestRootAncestor(workflow: WorkflowSpec, templateId: string): string {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]))
  const declarationOrder = new Map(workflow.nodes.map((node, index) => [node.id, index]))
  const start = workflowNode(workflow, templateId)
  if (start.needs.length === 0) {
    return start.id
  }

  const queue = start.needs.map((id) => ({ id, distance: 1 }))
  const distanceById = new Map<string, number>()
  const roots: { readonly id: string; readonly distance: number }[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index]
    if (candidate === undefined) {
      continue
    }
    const knownDistance = distanceById.get(candidate.id)
    if (knownDistance !== undefined && knownDistance <= candidate.distance) {
      continue
    }
    distanceById.set(candidate.id, candidate.distance)

    const node = byId.get(candidate.id)
    if (node === undefined) {
      throw new Error(`Node "${templateId}" depends on unknown node "${candidate.id}".`)
    }
    if (node.needs.length === 0) {
      roots.push(candidate)
      continue
    }
    for (const dependency of node.needs) {
      queue.push({ id: dependency, distance: candidate.distance + 1 })
    }
  }

  const nearest = roots.toSorted(
    (left, right) =>
      left.distance - right.distance ||
      (declarationOrder.get(left.id) as number) - (declarationOrder.get(right.id) as number)
  )[0]
  if (nearest === undefined) {
    throw new Error(`Node "${templateId}" has no root ancestor.`)
  }
  return nearest.id
}

export function placementBaseGroup(
  workflow: WorkflowSpec,
  runtimeNode: NodeRunState,
  grouping: UiPreferences["placement"]["grouping"]
): string {
  if (grouping.by === "root-ancestor") {
    return nearestRootAncestor(workflow, runtimeNode.templateId)
  }
  const separatorIndex = runtimeNode.templateId.indexOf(grouping.separator)
  return separatorIndex === -1
    ? runtimeNode.templateId
    : runtimeNode.templateId.slice(0, separatorIndex)
}

function encodedSegment(value: string): string {
  return encodeURIComponent(value)
}

export function placementGroupKey(runId: string, baseGroup: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error("Placement group ordinal must be a positive integer.")
  }
  return `orchestrate/${encodedSegment(runId)}/${encodedSegment(baseGroup)}/${ordinal}`
}

function groupLabel(baseGroup: string, ordinal: number): string {
  return ordinal === 1 ? baseGroup : `${baseGroup} ${ordinal}`
}

function groupOrdinal(runId: string, baseGroup: string, group: string): number | null {
  const prefix = `orchestrate/${encodedSegment(runId)}/${encodedSegment(baseGroup)}/`
  if (!group.startsWith(prefix)) {
    return null
  }
  const ordinal = Number(group.slice(prefix.length))
  return Number.isInteger(ordinal) && ordinal >= 1 ? ordinal : null
}

function paneForGroup(live: readonly LivePlacement[], group: string): PaneReference | null {
  return live.find((placement) => placement.pane.group === group)?.pane ?? null
}

function splitGroup(
  runId: string,
  baseGroup: string,
  maxSplitsPerTab: number,
  live: readonly LivePlacement[]
): { readonly group: string; readonly ordinal: number; readonly anchor: PaneReference | null } {
  if (!Number.isInteger(maxSplitsPerTab) || maxSplitsPerTab < 1) {
    throw new Error("maxSplitsPerTab must be a positive integer.")
  }
  for (let ordinal = 1; ; ordinal += 1) {
    const group = placementGroupKey(runId, baseGroup, ordinal)
    const groupPanes = live.filter((placement) => placement.pane.group === group)
    const splitOccupants = groupPanes.filter((placement) => placement.pane.surface === "split")
    if (splitOccupants.length < maxSplitsPerTab) {
      // The first member of a split group creates the tab's root pane. It is
      // physically a tab, but remains the anchor for later split children and
      // does not consume the configured split-child capacity.
      return { group, ordinal, anchor: groupPanes[0]?.pane ?? null }
    }
  }
}

export function resolvePlacement(
  workflow: WorkflowSpec,
  runtimeNode: NodeRunState,
  preferences: UiPreferences,
  context: PlacementContext
): PlacementResolution {
  assertPlacementRules(preferences.placement.rules)
  workflowNode(workflow, runtimeNode.templateId)
  const matchedRuleIndex = preferences.placement.rules.findIndex((rule) =>
    matchesNodeMatcher(rule.match, runtimeNode)
  )
  const rule = preferences.placement.rules[matchedRuleIndex]
  if (rule === undefined) {
    throw new Error(`No placement rule matches node "${runtimeNode.id}".`)
  }

  const baseGroup =
    rule.surface === "tab"
      ? runtimeNode.id
      : placementBaseGroup(workflow, runtimeNode, preferences.placement.grouping)
  if (context.retryPane !== null) {
    const ordinal = groupOrdinal(context.runId, baseGroup, context.retryPane.group)
    const retrySurfaceMatches =
      context.retryPane.surface === rule.surface ||
      (rule.surface === "split" && context.retryPane.surface === "tab")
    if (ordinal === null || !retrySurfaceMatches) {
      throw new Error(`Retry pane for node "${runtimeNode.id}" does not match its placement.`)
    }
    return {
      workspace: preferences.placement.workspace,
      surface: rule.surface,
      matchedRuleIndex,
      group: context.retryPane.group,
      groupLabel: groupLabel(baseGroup, ordinal),
      groupOrdinal: ordinal,
      anchorPane: context.retryPane,
      reusePane: context.retryPane
    }
  }

  if (rule.surface === "tab") {
    const group = placementGroupKey(context.runId, baseGroup, 1)
    return {
      workspace: preferences.placement.workspace,
      surface: "tab",
      matchedRuleIndex,
      group,
      groupLabel: baseGroup,
      groupOrdinal: 1,
      anchorPane: paneForGroup(context.live, group),
      reusePane: context.sessionPane
    }
  }

  const target = splitGroup(
    context.runId,
    baseGroup,
    preferences.placement.maxSplitsPerTab,
    context.live
  )
  return {
    workspace: preferences.placement.workspace,
    surface: "split",
    matchedRuleIndex,
    group: target.group,
    groupLabel: groupLabel(baseGroup, target.ordinal),
    groupOrdinal: target.ordinal,
    anchorPane: target.anchor,
    reusePane: context.sessionPane
  }
}

export function resolveAutoContinue(
  runtimeNode: NodeRunState,
  preferences: UiPreferences
): boolean {
  const rules = preferences.continuation.rules
  if (rules.length === 0 || !isDefaultMatcher(rules.at(-1)?.match ?? DEFAULT_MATCHER)) {
    throw new Error("Continuation rules must end with the match-all default rule.")
  }
  const rule = rules.find((candidate) => matchesNodeMatcher(candidate.match, runtimeNode))
  if (rule === undefined) {
    throw new Error(`No continuation rule matches node "${runtimeNode.id}".`)
  }
  return rule.autoContinue
}
