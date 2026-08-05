import { describe, expect, test } from "bun:test"

import type {
  AgentNode,
  CommandNode,
  NodeMatcher,
  NodeRunState,
  PaneReference,
  PlacementRule,
  UiPreferences,
  WorkflowNode,
  WorkflowSpec
} from "../src/types.js"

import {
  matchesNodeGlob,
  nearestRootAncestor,
  placementBaseGroup,
  placementGroupKey,
  resolveAutoContinue,
  resolvePlacement,
  workroomPlacementGroupKey,
  type LivePlacement
} from "../src/placement.js"

const anyMatcher: NodeMatcher = {
  type: "any",
  provider: "any",
  level: "any",
  origin: "any",
  id: "*"
}

function workspace() {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "none" as const,
    writes: [],
    exclusiveResources: []
  }
}

function agent(
  id: string,
  needs: readonly string[] = [],
  provider: "codex" | "claude" = "codex"
): AgentNode {
  const common = {
    id,
    type: "agent" as const,
    title: id,
    needs,
    cwd: null,
    workspace: workspace(),
    inputs: [],
    retry: { maxAttempts: 2 },
    gate: "none" as const,
    model: "provider-default",
    effort: null,
    prompt: id,
    session: { mode: "fresh" as const, from: null, saveAs: null },
    output: { format: "text" as const, schema: null }
  }
  return provider === "codex"
    ? {
        ...common,
        provider,
        permissions: {
          execution: { sandbox: "read-only" },
          escalation: "deny",
          extraArgs: [],
          inheritEnv: [],
          env: {}
        }
      }
    : {
        ...common,
        provider,
        permissions: {
          execution: { permissionMode: "manual" },
          escalation: "ask-user",
          extraArgs: [],
          inheritEnv: [],
          env: {}
        }
      }
}

function command(id: string, needs: readonly string[] = []): CommandNode {
  return {
    id,
    type: "command",
    title: id,
    needs,
    cwd: null,
    workspace: workspace(),
    inputs: [],
    retry: { maxAttempts: 2 },
    gate: "none",
    argv: ["true"],
    mutates: false,
    inheritEnv: [],
    env: {},
    allowedExitCodes: [0]
  }
}

function workflow(nodes: readonly WorkflowNode[]): WorkflowSpec {
  return {
    name: "placement-test",
    objective: "Exercise placement.",
    cwd: "/tmp/placement-test",
    concurrency: 4,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes,
    repeats: []
  }
}

function runtimeNode(
  id: string,
  templateId = id,
  origin: NodeRunState["origin"] = "initial",
  node: WorkflowNode | null = null
): NodeRunState {
  const type = node?.type ?? "agent"
  return {
    id,
    templateId,
    title: id,
    type,
    provider: type === "agent" ? (node?.type === "agent" ? node.provider : "codex") : null,
    needs: node?.needs ?? [],
    origin,
    repeatId: origin === "loop-round" ? "review-loop" : null,
    round: origin === "loop-round" ? 2 : null,
    status: "ready",
    attempts: [],
    resultPath: null,
    result: null,
    error: null
  }
}

function preferences(
  rules: readonly PlacementRule[],
  grouping: UiPreferences["placement"]["grouping"] = { by: "root-ancestor" },
  maxSplitsPerTab = 2
): UiPreferences {
  return {
    board: "split-right",
    placement: { workspace: "dedicated", rules, grouping, maxSplitsPerTab },
    completedPanes: { agent: "keep-open", command: "close-success" },
    focus: "attention",
    continuation: { rules: [{ match: anyMatcher, autoContinue: true }] },
    notifications: { attention: "herdr", milestone: "herdr", progress: "board" }
  }
}

function pane(group: string, id: string, surface: "tab" | "split" = "split"): PaneReference {
  return {
    workspaceId: "workspace",
    tabId: `tab-${group}`,
    paneId: id,
    group,
    surface
  }
}

function context(
  runId = "run-a",
  live: readonly LivePlacement[] = [],
  retryPane: PaneReference | null = null,
  sessionPane: PaneReference | null = null
) {
  return { runId, live, retryPane, sessionPane }
}

describe("node glob matching", () => {
  test.each([
    ["*", "review--r2", true],
    ["review-*", "review-ui", true],
    ["review-?pi", "review-api", true],
    ["review-[au]pi", "review-api", true],
    ["review-[!u]pi", "review-api", true],
    ["review-[!a]pi", "review-api", false],
    ["review-*", "build-api", false],
    ["literal\\*", "literal*", true]
  ])("matches %s against %s", (pattern, id, expected) => {
    expect(matchesNodeGlob(pattern, id)).toBe(expected)
  })
})

describe("placement rule resolution", () => {
  const graph = workflow([
    agent("root-agent"),
    command("root-command"),
    agent("child-claude", ["root-agent"], "claude"),
    agent("review")
  ])

  test("uses the first matching rule", () => {
    const rules: PlacementRule[] = [
      { match: { ...anyMatcher, type: "agent" }, surface: "split" },
      { match: { ...anyMatcher, provider: "codex" }, surface: "tab" },
      { match: anyMatcher, surface: "tab" }
    ]
    const resolved = resolvePlacement(
      graph,
      runtimeNode("root-agent"),
      preferences(rules),
      context()
    )
    expect(resolved.surface).toBe("split")
  })

  test.each([
    [{ ...anyMatcher, type: "command" }, "root-command", "root-command", "initial", true],
    [{ ...anyMatcher, provider: "claude" }, "child-claude", "child-claude", "initial", true],
    [{ ...anyMatcher, level: "child" }, "child-claude", "child-claude", "initial", true],
    [{ ...anyMatcher, level: "root" }, "root-agent", "root-agent", "initial", true],
    [{ ...anyMatcher, origin: "loop-round" }, "review--r2", "review", "loop-round", true],
    [{ ...anyMatcher, id: "review--r?" }, "review--r2", "review", "loop-round", true],
    [{ ...anyMatcher, provider: "codex" }, "root-command", "root-command", "initial", false]
  ] as const)(
    "matches one rule dimension %#",
    (matcher, runtimeId, templateId, origin, expected) => {
      const rules: PlacementRule[] = [
        { match: matcher, surface: "split" },
        { match: anyMatcher, surface: "tab" }
      ]
      const resolved = resolvePlacement(
        graph,
        runtimeNode(
          runtimeId,
          templateId,
          origin,
          graph.nodes.find((node) => node.id === templateId) ?? null
        ),
        preferences(rules),
        context()
      )
      expect(resolved.surface).toBe(expected ? "split" : "tab")
    }
  )

  test("rejects a rule list without the mandatory final default", () => {
    expect(() =>
      resolvePlacement(
        graph,
        runtimeNode("root-agent"),
        preferences([{ match: { ...anyMatcher, type: "agent" }, surface: "tab" }]),
        context()
      )
    ).toThrow("match-all default")
  })
})

describe("grouping", () => {
  const graph = workflow([
    agent("alpha"),
    agent("alpha-child", ["alpha"]),
    agent("beta"),
    agent("merge", ["alpha-child", "beta"]),
    command("api-check", ["alpha"]),
    agent("api-review", ["api-check"])
  ])

  test("chooses the nearest root ancestor and declaration order breaks ties", () => {
    expect(nearestRootAncestor(graph, "alpha")).toBe("alpha")
    expect(nearestRootAncestor(graph, "alpha-child")).toBe("alpha")
    expect(nearestRootAncestor(graph, "merge")).toBe("beta")
    const tied = workflow([agent("first"), agent("second"), agent("join", ["first", "second"])])
    expect(nearestRootAncestor(tied, "join")).toBe("first")
  })

  test("groups by template id prefix", () => {
    const grouping = { by: "id-prefix" as const, separator: "-" }
    expect(placementBaseGroup(graph, runtimeNode("api-review"), grouping)).toBe("api")
    expect(placementBaseGroup(graph, runtimeNode("alpha"), grouping)).toBe("alpha")
  })

  test("loop rounds inherit the template node group", () => {
    const loop = runtimeNode("api-review--r2", "api-review", "loop-round")
    expect(placementBaseGroup(graph, loop, { by: "root-ancestor" })).toBe("alpha")
    expect(placementBaseGroup(graph, loop, { by: "id-prefix", separator: "-" })).toBe("api")
  })
})

describe("declared workroom placement", () => {
  const rules: PlacementRule[] = [{ match: anyMatcher, surface: "tab" }]
  const spec = workflow([agent("review")])
  const parked = pane("legacy", "reviewer-pane", "tab")
  const implementer = pane("legacy", "implementer-pane", "tab")

  test("bypasses matcher grouping and reuses the durable seat before its session pane", () => {
    const resolved = resolvePlacement(spec, runtimeNode("review"), preferences(rules), {
      ...context(),
      sessionPane: pane("session", "session-pane", "tab"),
      workroom: {
        id: "review-room",
        label: "Review room",
        layout: "columns",
        seatId: "reviewer",
        seatIndex: 1,
        workspaceId: "workspace",
        tabId: parked.tabId,
        seats: [
          { id: "implementer", pane: implementer },
          { id: "reviewer", pane: parked }
        ],
        seatPane: parked,
        anchorPane: implementer
      }
    })

    expect(resolved).toMatchObject({
      surface: "split",
      group: workroomPlacementGroupKey("run-a", "review-room"),
      groupLabel: "Review room",
      reusePane: parked,
      anchorPane: implementer,
      splitDirection: "right",
      workroom: { id: "review-room", seatId: "reviewer" }
    })
  })

  test("uses a retry pane before the durable seat and starts the first seat as the room tab", () => {
    const retry = pane(workroomPlacementGroupKey("run-a", "review-room"), "retry", "tab")
    const resolved = resolvePlacement(spec, runtimeNode("review"), preferences(rules), {
      ...context("run-a", [], retry),
      workroom: {
        id: "review-room",
        label: "Review room",
        layout: "rows",
        seatId: "reviewer",
        seatIndex: 0,
        workspaceId: null,
        tabId: null,
        seats: [{ id: "reviewer", pane: parked }],
        seatPane: parked,
        anchorPane: null
      }
    })
    expect(resolved.reusePane).toEqual(retry)
    expect(resolved.surface).toBe("tab")
    expect(resolved.splitDirection).toBe("down")
  })

  test("does not resurrect a cleared seat from a stale session pane", () => {
    const resolved = resolvePlacement(spec, runtimeNode("review"), preferences(rules), {
      ...context(),
      sessionPane: pane("session", "vanished-session-pane", "tab"),
      workroom: {
        id: "review-room",
        label: "Review room",
        layout: "columns",
        seatId: "reviewer",
        seatIndex: 0,
        workspaceId: null,
        tabId: null,
        seats: [{ id: "reviewer", pane: null }],
        seatPane: null,
        anchorPane: null
      }
    })

    expect(resolved.reusePane).toBeNull()
    expect(resolved.surface).toBe("tab")
  })

  test("namespaces workroom groups away from matcher-selected groups", () => {
    expect(workroomPlacementGroupKey("run-a", "review-room")).toBe(
      "orchestrate/run-a/workroom/review-room/1"
    )
    expect(workroomPlacementGroupKey("run-a", "review-room")).not.toBe(
      placementGroupKey("run-a", "review-room", 1)
    )
  })
})

describe("placement slots", () => {
  const graph = workflow([agent("root"), agent("child", ["root"])])
  const rules: PlacementRule[] = [{ match: anyMatcher, surface: "split" }]

  test("fills the earliest split group and overflows to numbered tabs", () => {
    const firstGroup = placementGroupKey("run-a", "root", 1)
    const secondGroup = placementGroupKey("run-a", "root", 2)
    const firstLive = [
      { nodeId: "one", pane: pane(firstGroup, "pane-1") },
      { nodeId: "two", pane: pane(firstGroup, "pane-2") }
    ]
    const overflow = resolvePlacement(
      graph,
      runtimeNode("child"),
      preferences(rules),
      context("run-a", firstLive)
    )
    expect(overflow).toMatchObject({
      group: secondGroup,
      groupLabel: "root 2",
      groupOrdinal: 2,
      anchorPane: null
    })

    const withSecond = [...firstLive, { nodeId: "three", pane: pane(secondGroup, "pane-3") }]
    const fillsSecond = resolvePlacement(
      graph,
      runtimeNode("child"),
      preferences(rules),
      context("run-a", withSecond)
    )
    expect(fillsSecond.group).toBe(secondGroup)
    expect(fillsSecond.anchorPane?.paneId).toBe("pane-3")
  })

  test("uses the physical tab root as the first split anchor without consuming split capacity", () => {
    const firstGroup = placementGroupKey("run-a", "root", 1)
    const rootPane = pane(firstGroup, "root-pane", "tab")
    const afterRoot = resolvePlacement(
      graph,
      runtimeNode("child"),
      preferences(rules),
      context("run-a", [{ nodeId: "root", pane: rootPane }])
    )
    expect(afterRoot).toMatchObject({
      group: firstGroup,
      groupOrdinal: 1,
      anchorPane: rootPane
    })

    const withOneSplit = [
      { nodeId: "root", pane: rootPane },
      { nodeId: "one", pane: pane(firstGroup, "split-1") }
    ]
    expect(
      resolvePlacement(
        graph,
        runtimeNode("child"),
        preferences(rules),
        context("run-a", withOneSplit)
      ).group
    ).toBe(firstGroup)

    const full = [...withOneSplit, { nodeId: "two", pane: pane(firstGroup, "split-2") }]
    expect(
      resolvePlacement(graph, runtimeNode("child"), preferences(rules), context("run-a", full))
        .groupOrdinal
    ).toBe(2)
  })

  test("reuses the previous attempt slot even when its split group is full", () => {
    const group = placementGroupKey("run-a", "root", 1)
    const previous = pane(group, "old-attempt")
    const live = [
      { nodeId: "child", pane: previous },
      { nodeId: "other", pane: pane(group, "other-pane") }
    ]
    const resolved = resolvePlacement(
      graph,
      runtimeNode("child"),
      preferences(rules),
      context("run-a", live, previous)
    )
    expect(resolved.groupOrdinal).toBe(1)
    expect(resolved.anchorPane).toBe(previous)
    expect(resolved.reusePane).toBe(previous)
  })

  test("reuses a split group's physical tab root for its retry", () => {
    const group = placementGroupKey("run-a", "root", 1)
    const previous = pane(group, "old-root", "tab")
    const resolved = resolvePlacement(
      graph,
      runtimeNode("child"),
      preferences(rules),
      context("run-a", [{ nodeId: "child", pane: previous }], previous)
    )
    expect(resolved).toMatchObject({
      surface: "split",
      groupOrdinal: 1,
      anchorPane: previous,
      reusePane: previous
    })
  })

  test("reuses a resumed session pane instead of allocating another configured surface", () => {
    const source = pane(placementGroupKey("run-a", "root", 1), "session-pane", "tab")
    const resolved = resolvePlacement(
      graph,
      runtimeNode("child"),
      preferences(rules),
      context("run-a", [{ nodeId: "root", pane: source }], null, source)
    )
    expect(resolved.reusePane).toBe(source)
  })

  test("namespaces otherwise identical groups by run", () => {
    const one = resolvePlacement(graph, runtimeNode("child"), preferences(rules), context("run-a"))
    const two = resolvePlacement(graph, runtimeNode("child"), preferences(rules), context("run-b"))
    expect(one.group).not.toBe(two.group)
    expect(one.group).toBe("orchestrate/run-a/root/1")
    expect(two.group).toBe("orchestrate/run-b/root/1")
  })
})

describe("continuation policy", () => {
  test("uses the first matching rule and requires a final default", () => {
    const node = runtimeNode("review")
    const ui = preferences([{ match: anyMatcher, surface: "tab" }])
    const configured: UiPreferences = {
      ...ui,
      continuation: {
        rules: [
          { match: { ...anyMatcher, type: "agent" }, autoContinue: false },
          { match: anyMatcher, autoContinue: true }
        ]
      }
    }
    expect(resolveAutoContinue(node, configured)).toBeFalse()
    expect(() =>
      resolveAutoContinue(node, {
        ...configured,
        continuation: { rules: configured.continuation.rules.slice(0, 1) }
      })
    ).toThrow("match-all default")
  })
})
