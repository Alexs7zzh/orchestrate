import { describe, expect, test } from "bun:test"

import type { NodeRunState, WorkflowSpec } from "../src/types.js"

import { EVENT_SEVERITIES } from "../src/notifications.js"
import { nearestRootAncestor, placementBaseGroup } from "../src/placement.js"
import {
  ANSI,
  DEMO_TIMELINE,
  DEMO_WORKFLOW,
  demoTabs,
  NOTIFICATION_LEGEND,
  NOTIFICATION_PRESETS,
  parseWizardKey,
  placementGroupingForLayout,
  placementRulesForLayout,
  renderDemoWorkflow,
  renderNotificationPreview,
  renderBoardMockup,
  renderPlacementSketch,
  renderTabMapping,
  runUiWizard,
  runWizardWithIo,
  wizardPlan,
  type PlacementChoices,
  type WizardIo,
  type WizardKey,
  type WizardPreferencePatch,
  type WizardSelections
} from "../src/wizard.js"

const MATCHER = {
  type: "any",
  provider: "any",
  level: "any",
  origin: "any",
  id: "*"
} as const

const ROOT_MATCHER = { ...MATCHER, level: "root" } as const

const DEFAULT_SELECTIONS: WizardSelections = {
  notifications: { attention: "herdr", milestone: "herdr", progress: "board" },
  workspace: "origin",
  layout: "nested",
  board: "split-right"
}

const SUB_NODE_MATCHER = { ...MATCHER, id: "*--*" } as const

function stripAnsi(text: string): string {
  return Object.values(ANSI).reduce((stripped, code) => stripped.replaceAll(code, ""), text)
}

function scriptedIo(keys: readonly WizardKey[]): {
  io: WizardIo
  frames: string[]
  prints: string[]
} {
  const remaining = [...keys]
  const frames: string[] = []
  const prints: string[] = []
  return {
    io: {
      write(frame) {
        frames.push(frame)
      },
      print(text) {
        prints.push(text)
      },
      readKey() {
        return Promise.resolve(remaining.shift() ?? "escape")
      }
    },
    frames,
    prints
  }
}

function captureApply(): {
  calls: { patch: WizardPreferencePatch; project: string | null }[]
  apply: (patch: WizardPreferencePatch, project: string | null) => Promise<unknown>
} {
  const calls: { patch: WizardPreferencePatch; project: string | null }[] = []
  return {
    calls,
    apply: (patch, project) => {
      calls.push({ patch, project })
      return Promise.resolve(null)
    }
  }
}

describe("notification presets", () => {
  test("map to the exact notification records", () => {
    expect(NOTIFICATION_PRESETS.map((preset) => preset.label)).toStrictEqual([
      "Needs you + finishes (default) — routine stays on the board",
      "Needs you only — finishes land on the board, routine is silent",
      "Every event — starts, finishes, gates, everything",
      "Board only — never notify; watch the board",
      "Custom… — pick per event group"
    ])
    expect(NOTIFICATION_PRESETS[0]?.channels).toStrictEqual({
      attention: "herdr",
      milestone: "herdr",
      progress: "board"
    })
    expect(NOTIFICATION_PRESETS[1]?.channels).toStrictEqual({
      attention: "herdr",
      milestone: "board",
      progress: "silent"
    })
    expect(NOTIFICATION_PRESETS[2]?.channels).toStrictEqual({
      attention: "herdr",
      milestone: "herdr",
      progress: "herdr"
    })
    expect(NOTIFICATION_PRESETS[3]?.channels).toStrictEqual({
      attention: "board",
      milestone: "board",
      progress: "board"
    })
    expect(NOTIFICATION_PRESETS[4]?.channels).toBeNull()
  })

  test("demo timeline exercises every severity", () => {
    const severities = new Set(DEMO_TIMELINE.map((event) => EVENT_SEVERITIES[event.type]))
    expect([...severities].toSorted()).toStrictEqual(["attention", "milestone", "progress"])
  })

  test("demo timeline references only demo workflow nodes and the demo run", () => {
    const nodeIds = new Set(DEMO_WORKFLOW.map((node) => node.id))
    for (const event of DEMO_TIMELINE) {
      expect(nodeIds.has(event.detail) || event.detail === "release-review").toBe(true)
    }
  })
})

/** Preview body without the header (first line) and channel legend (last line). */
function eventLines(preview: string): readonly string[] {
  return preview.split("\n").slice(1, -1)
}

describe("renderNotificationPreview", () => {
  test("styles each demo event by its routed channel, per preset", () => {
    for (const preset of NOTIFICATION_PRESETS) {
      if (preset.channels === null) {
        continue
      }
      const lines = eventLines(renderNotificationPreview(preset.channels))
      expect(lines).toHaveLength(DEMO_TIMELINE.length)
      DEMO_TIMELINE.forEach((event, index) => {
        const channel = preset.channels?.[EVENT_SEVERITIES[event.type]]
        const line = lines[index] ?? ""
        expect(stripAnsi(line)).toContain(`${event.type} ${event.detail}`)
        if (channel === "herdr") {
          expect(line.startsWith(`  ${ANSI.bold}🔔 `)).toBe(true)
        } else if (channel === "board") {
          expect(line.startsWith("  ▤ ")).toBe(true)
          expect(line).not.toContain(ANSI.bold)
          expect(line).not.toContain(ANSI.dim)
        } else {
          expect(line.startsWith(`  ${ANSI.dim}· `)).toBe(true)
        }
      })
    }
  })

  test("ends with the dim channel legend", () => {
    const preview = renderNotificationPreview({
      attention: "herdr",
      milestone: "herdr",
      progress: "board"
    })
    expect(preview.split("\n").at(-1)).toBe(`  ${ANSI.dim}${NOTIFICATION_LEGEND}${ANSI.reset}`)
  })

  test("bolds everything for the Everything preset and nothing for Status board only", () => {
    const everything = eventLines(
      renderNotificationPreview({ attention: "herdr", milestone: "herdr", progress: "herdr" })
    ).join("\n")
    expect(everything.split("🔔")).toHaveLength(DEMO_TIMELINE.length + 1)
    const boardOnly = eventLines(
      renderNotificationPreview({ attention: "board", milestone: "board", progress: "board" })
    ).join("\n")
    expect(boardOnly).not.toContain("🔔")
    expect(boardOnly).not.toContain(ANSI.bold)
  })
})

describe("renderDemoWorkflow", () => {
  test("draws every demo node without any marking", () => {
    const diagram = renderDemoWorkflow()
    for (const node of DEMO_WORKFLOW) {
      expect(diagram).toContain(node.id)
    }
    expect(diagram).not.toContain(ANSI.bold)
    expect(diagram).not.toContain(ANSI.inverse)
  })
})

describe("demoTabs and renderTabMapping", () => {
  test("nested groups sub-nodes under their parent's tab", () => {
    expect(demoTabs("nested")).toStrictEqual([
      { label: "plan", panes: ["plan"] },
      { label: "ui", panes: ["ui", "ui--test"] },
      { label: "api", panes: ["api", "api--test", "api--bench"] },
      { label: "docs", panes: ["docs", "docs--lint"] },
      { label: "merge", panes: ["merge"] },
      { label: "report", panes: ["report"] }
    ])
    const mapping = stripAnsi(renderTabMapping("nested"))
    expect(mapping).toContain(`tab "api"`)
    expect(mapping).toContain("api + splits: api--test, api--bench")
    expect(mapping).toContain(`tab "merge"`)
    expect(mapping).toContain(`tab "report"`)
  })

  test("nested tabs match the engine's id-prefix grouping", () => {
    const workflow = { nodes: DEMO_WORKFLOW } as unknown as WorkflowSpec
    const grouping = { by: "id-prefix", separator: "--" } as const
    for (const tab of demoTabs("nested")) {
      for (const pane of tab.panes) {
        const runtimeNode = { templateId: pane } as unknown as NodeRunState
        expect(placementBaseGroup(workflow, runtimeNode, grouping)).toBe(tab.label)
      }
    }
  })

  test("grouped packs everything under the single entry node, spilling by capacity", () => {
    const workflow = { nodes: DEMO_WORKFLOW } as unknown as WorkflowSpec
    for (const node of DEMO_WORKFLOW) {
      expect(nearestRootAncestor(workflow, node.id)).toBe("plan")
    }
    const tabs = demoTabs("grouped")
    expect(tabs.map((tab) => tab.label)).toStrictEqual(["plan", "plan 2"])
    expect(tabs.flatMap((tab) => tab.panes)).toStrictEqual(DEMO_WORKFLOW.map((node) => node.id))
    expect(tabs[0]?.panes).toHaveLength(5)
    const mapping = stripAnsi(renderTabMapping("grouped"))
    expect(mapping).toContain(`tab "plan"`)
    expect(mapping).toContain(`tab "plan 2"`)
    expect(mapping).toContain("filled in run order; max 4 splits per tab")
  })

  test("per-node lists one tab for every node", () => {
    const mapping = stripAnsi(renderTabMapping("per-node"))
    for (const node of DEMO_WORKFLOW) {
      expect(mapping).toContain(node.id)
    }
    expect(mapping).toContain("10 tabs — one per node:")
    expect(mapping).not.toContain("splits:")
  })
})

describe("renderBoardMockup", () => {
  test("shows the demo run with real board glyphs at a fixed width", () => {
    const mockup = renderBoardMockup()
    expect(mockup).toContain("board · release-review")
    expect(mockup).toContain("✓ plan")
    expect(mockup).toContain("● ui--test")
    expect(mockup).toContain("◆ merge")
    expect(mockup).toContain("awaiting approval")
    const lines = mockup.split("\n")
    for (const line of lines) {
      expect(line).toHaveLength(lines[0]?.length ?? 0)
    }
  })
})

describe("renderPlacementSketch", () => {
  const BASE: PlacementChoices = { workspace: "origin", layout: "grouped", board: "split-right" }

  test("keeps a compact fixed geometry across every choice combination", () => {
    for (const active of ["workspace", "board"] as const) {
      for (const board of ["split-right", "dedicated-workspace", "current-workspace"] as const) {
        for (const workspace of ["dedicated", "origin"] as const) {
          const sketch = renderPlacementSketch({ workspace, layout: "grouped", board }, active)
          const lines = stripAnsi(sketch).split("\n")
          expect(lines).toHaveLength(10)
          for (const line of lines) {
            expect(line).toHaveLength(56)
          }
        }
      }
    }
  })

  test("marks the current workspace rail entry when the run stays put", () => {
    const sketch = renderPlacementSketch(BASE, "workspace")
    expect(sketch).toContain(`${ANSI.inverse}current${ANSI.reset}`)
    expect(sketch).not.toContain("release-…")
    expect(stripAnsi(sketch)).toContain("[main] [run tabs…]")
  })

  test("marks the run workspace entry and moves run tabs out of the strip", () => {
    const sketch = renderPlacementSketch({ ...BASE, workspace: "dedicated" }, "workspace")
    expect(sketch).toContain(`${ANSI.inverse}release-…${ANSI.reset}`)
    expect(sketch).not.toContain(`${ANSI.inverse}current`)
    expect(stripAnsi(sketch)).not.toContain("[run tabs…]")
    expect(stripAnsi(sketch)).toContain("run tabs open in release-…")
  })

  test("split-right draws the board beside the launch pane and marks it", () => {
    const sketch = renderPlacementSketch(BASE, "board")
    expect(stripAnsi(sketch)).toContain(" you")
    expect(sketch).toContain(`${ANSI.inverse} board${ANSI.reset}`)
    expect(stripAnsi(sketch)).not.toContain("[board]")
  })

  test("current-workspace board is a marked tab, not a split", () => {
    const sketch = renderPlacementSketch({ ...BASE, board: "current-workspace" }, "board")
    expect(sketch).toContain(`${ANSI.inverse}[board]${ANSI.reset}`)
    expect(stripAnsi(sketch)).not.toContain(" board ")
  })

  test("dedicated board marks the run workspace and explains itself", () => {
    const sketch = renderPlacementSketch({ ...BASE, board: "dedicated-workspace" }, "board")
    expect(sketch).toContain(`${ANSI.inverse}release-…${ANSI.reset}`)
    expect(stripAnsi(sketch)).toContain("the board tab lives in release-…")
    expect(stripAnsi(sketch)).not.toContain("[board]")
  })

  test("leaves the other question's region unmarked", () => {
    const sketch = renderPlacementSketch(
      { workspace: "dedicated", layout: "grouped", board: "current-workspace" },
      "board"
    )
    expect(sketch).toContain("release-…")
    expect(sketch).not.toContain(`${ANSI.inverse}release-…`)
    expect(sketch).toContain(`${ANSI.inverse}[board]${ANSI.reset}`)
  })

  test("dedicated board plus dedicated run share one caption", () => {
    const sketch = renderPlacementSketch(
      { workspace: "dedicated", layout: "grouped", board: "dedicated-workspace" },
      "workspace"
    )
    expect(stripAnsi(sketch)).toContain("board + run tabs live in release-…")
  })
})

describe("placementRulesForLayout", () => {
  test("nested splits sub-nodes and opens a tab for everything else", () => {
    expect(placementRulesForLayout("nested")).toStrictEqual([
      { match: SUB_NODE_MATCHER, surface: "split" },
      { match: MATCHER, surface: "tab" }
    ])
    expect(placementGroupingForLayout("nested")).toStrictEqual({
      by: "id-prefix",
      separator: "--"
    })
  })

  test("grouped opens a tab per entry node and splits descendants into it", () => {
    expect(placementRulesForLayout("grouped")).toStrictEqual([
      { match: ROOT_MATCHER, surface: "tab" },
      { match: MATCHER, surface: "split" }
    ])
    expect(placementGroupingForLayout("grouped")).toStrictEqual({ by: "root-ancestor" })
  })

  test("per-node opens a tab for every node", () => {
    expect(placementRulesForLayout("per-node")).toStrictEqual([{ match: MATCHER, surface: "tab" }])
    expect(placementGroupingForLayout("per-node")).toStrictEqual({ by: "root-ancestor" })
  })
})

describe("wizardPlan", () => {
  test("per-node patch contains only the choices shown by the wizard", () => {
    const plan = wizardPlan({ ...DEFAULT_SELECTIONS, layout: "per-node" }, null)
    expect(plan.patch).toStrictEqual({
      board: "split-right",
      placement: {
        workspace: "origin",
        rules: [{ match: MATCHER, surface: "tab" }],
        grouping: { by: "root-ancestor" },
        maxSplitsPerTab: 4
      },
      notifications: { attention: "herdr", milestone: "herdr", progress: "board" }
    })
  })

  test("nested writes sub-node-split rules with id-prefix grouping", () => {
    const plan = wizardPlan(DEFAULT_SELECTIONS, null)
    expect(plan.patch.placement.rules).toStrictEqual([
      { match: SUB_NODE_MATCHER, surface: "split" },
      { match: MATCHER, surface: "tab" }
    ])
    expect(plan.patch.placement.grouping).toStrictEqual({ by: "id-prefix", separator: "--" })
  })

  test("grouped writes root-tab plus descendant-split rules with root grouping", () => {
    const plan = wizardPlan({ ...DEFAULT_SELECTIONS, layout: "grouped" }, null)
    expect(plan.patch.placement.rules).toStrictEqual([
      { match: ROOT_MATCHER, surface: "tab" },
      { match: MATCHER, surface: "split" }
    ])
    expect(plan.patch.placement.grouping).toStrictEqual({ by: "root-ancestor" })
  })

  test("does not write focus, completed panes, or continuation choices it never showed", () => {
    const plan = wizardPlan(
      {
        notifications: { attention: "board", milestone: "silent", progress: "silent" },
        workspace: "origin",
        layout: "grouped",
        board: "current-workspace"
      },
      null
    )
    expect(Object.keys(plan.patch).toSorted()).toStrictEqual([
      "board",
      "notifications",
      "placement"
    ])
    expect("focus" in plan.patch).toBe(false)
    expect("completedPanes" in plan.patch).toBe(false)
    expect("continuation" in plan.patch).toBe(false)
    expect(plan.patch.board).toBe("current-workspace")
    expect(plan.patch.placement.workspace).toBe("origin")
    expect(plan.patch.notifications).toStrictEqual({
      attention: "board",
      milestone: "silent",
      progress: "silent"
    })
  })

  test("emits the exact ui set commands in screen order", () => {
    const plan = wizardPlan(DEFAULT_SELECTIONS, null)
    expect(plan.commands).toStrictEqual([
      `orchestrate ui set board '"split-right"'`,
      `orchestrate ui set placement '{"workspace":"origin","rules":[{"match":{"type":"any","provider":"any","level":"any","origin":"any","id":"*--*"},"surface":"split"},{"match":{"type":"any","provider":"any","level":"any","origin":"any","id":"*"},"surface":"tab"}],"grouping":{"by":"id-prefix","separator":"--"},"maxSplitsPerTab":4}'`,
      `orchestrate ui set notifications '{"attention":"herdr","milestone":"herdr","progress":"board"}'`
    ])
  })

  test("appends --project to every command for project layers", () => {
    const plan = wizardPlan(DEFAULT_SELECTIONS, "/tmp/demo-project")
    expect(plan.commands).toHaveLength(3)
    for (const command of plan.commands) {
      expect(command.endsWith(" --project '/tmp/demo-project'")).toBe(true)
    }
  })

  test("shell-quotes project paths in equivalent commands", () => {
    const plan = wizardPlan(DEFAULT_SELECTIONS, "/tmp/demo project's")
    for (const command of plan.commands) {
      expect(command.endsWith(` --project '/tmp/demo project'"'"'s'`)).toBe(true)
    }
  })
})

describe("runWizardWithIo", () => {
  test("all-enter run applies the default plan to the given project", async () => {
    const { io, frames, prints } = scriptedIo(["enter", "enter", "enter", "enter", "enter"])
    const { calls, apply } = captureApply()
    await runWizardWithIo("/tmp/demo-project", io, apply)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.project).toBe("/tmp/demo-project")
    expect(calls[0]?.patch).toStrictEqual(wizardPlan(DEFAULT_SELECTIONS, "/tmp/demo-project").patch)
    expect(frames[0]).toContain("board (1/5)")
    expect(frames.some((frame) => frame.includes("workspace (2/5)"))).toBe(true)
    expect(frames.some((frame) => frame.includes("tabs (3/5)"))).toBe(true)
    expect(frames.some((frame) => frame.includes("notifications (4/5)"))).toBe(true)
    expect(frames.some((frame) => frame.includes("confirm (5/5)"))).toBe(true)
    expect(prints.join("")).toContain(
      `orchestrate ui set board '"split-right"' --project '/tmp/demo-project'`
    )
  })

  test("the board question comes first, introduced by the board itself", async () => {
    const { io, frames } = scriptedIo(["escape"])
    await runWizardWithIo(null, io, captureApply().apply)
    const first = frames[0] ?? ""
    expect(first).toContain("Where do you want to monitor the run?")
    expect(first).toContain("board · release-review")
    expect(first).toContain("┌ herdr")
    expect(first).not.toContain("Demo workflow:")
  })

  test("the workspace question shows the sketch but not the workflow structure", async () => {
    const { io, frames } = scriptedIo(["enter", "escape"])
    await runWizardWithIo(null, io, captureApply().apply)
    const second = frames[1] ?? ""
    expect(second).toContain("Where should run panes and workrooms appear?")
    expect(second).toContain("Herdr UI destination only")
    expect(second).toContain("filesystem workspace stay workflow-defined")
    expect(second).toContain("┌ herdr")
    expect(second).not.toContain("Demo workflow:")
    expect(second).not.toContain("board · release-review")
  })

  test("the tab question shows the workflow and its tab mapping, not the sketch", async () => {
    const { io, frames } = scriptedIo(["enter", "enter", "down", "down", "escape"])
    await runWizardWithIo(null, io, captureApply().apply)
    const nestedFrame = frames[2] ?? ""
    const groupedFrame = frames[3] ?? ""
    const perNodeFrame = frames[4] ?? ""
    expect(nestedFrame).toContain("What goes into one tab?")
    expect(nestedFrame).toContain("ordinary/seatless panes")
    expect(nestedFrame).toContain("declared seats stay in their approved workroom")
    expect(nestedFrame).toContain("Demo workflow:")
    expect(nestedFrame).not.toContain("┌ herdr")
    expect(stripAnsi(nestedFrame)).toContain("api + splits: api--test, api--bench")
    expect(stripAnsi(groupedFrame)).toContain(`tab "plan 2"`)
    expect(stripAnsi(perNodeFrame)).toContain("10 tabs — one per node:")
    expect(stripAnsi(perNodeFrame)).not.toContain("splits:")
  })

  test("a dedicated board pre-selects the dedicated run workspace", async () => {
    const { io, frames, apply, calls } = {
      ...scriptedIo([
        "down",
        "down",
        "enter", // board: a tab in the run's own workspace
        "enter", // workspace: pre-highlighted "a workspace per run"
        "enter", // layout: nested
        "enter", // notifications: default preset
        "enter" // Apply
      ]),
      ...captureApply()
    }
    await runWizardWithIo(null, io, apply)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.patch.board).toBe("dedicated-workspace")
    expect(calls[0]?.patch.placement.workspace).toBe("dedicated")
    const workspaceFrame = frames.find((frame) =>
      frame.includes("Where should run panes and workrooms appear?")
    )
    expect(workspaceFrame).toContain("already gives each run its own Herdr workspace")
  })

  test("arrow-key navigation reaches non-default answers", async () => {
    const { io, apply, calls } = {
      ...scriptedIo([
        "down",
        "enter", // board: a tab in your current workspace
        "down",
        "enter", // workspace: dedicated
        "down",
        "down",
        "enter", // layout: per-node
        "down",
        "enter", // Needs you only
        "enter" // Apply
      ]),
      ...captureApply()
    }
    await runWizardWithIo(null, io, apply)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.patch).toStrictEqual(
      wizardPlan(
        {
          notifications: { attention: "herdr", milestone: "board", progress: "silent" },
          workspace: "dedicated",
          layout: "per-node",
          board: "current-workspace"
        },
        null
      ).patch
    )
  })

  test("custom preset drills into per-severity channel choices", async () => {
    const { io, frames } = scriptedIo([
      "enter", // board: split-right
      "enter", // workspace: origin
      "enter", // layout: grouped
      "down",
      "down",
      "down",
      "down",
      "enter", // Custom…
      "down",
      "enter", // attention: herdr -> board
      "enter", // milestone: herdr
      "down",
      "enter", // progress: board -> silent
      "enter" // Apply
    ])
    const { calls, apply } = captureApply()
    await runWizardWithIo(null, io, apply)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.patch.notifications).toStrictEqual({
      attention: "board",
      milestone: "herdr",
      progress: "silent"
    })
    const attentionFrame = frames.find((frame) =>
      frame.includes("Where should attention events go?")
    )
    expect(attentionFrame).toContain("approval or revision is waiting")
    expect(attentionFrame).toContain("workroom occupancy needs repair")
  })

  test("escape exits without writing anything", async () => {
    const { io, prints } = scriptedIo(["down", "escape"])
    const { calls, apply } = captureApply()
    await runWizardWithIo(null, io, apply)
    expect(calls).toHaveLength(0)
    expect(prints.join("")).toContain("no preferences were written")
  })

  test("escape mid-flow exits without writing anything", async () => {
    const { io } = scriptedIo(["enter", "enter", "down", "escape"])
    const { calls, apply } = captureApply()
    await runWizardWithIo(null, io, apply)
    expect(calls).toHaveLength(0)
  })

  test("selecting [Cancel] on the confirm screen writes nothing", async () => {
    const { io, prints } = scriptedIo(["enter", "enter", "enter", "enter", "down", "enter"])
    const { calls, apply } = captureApply()
    await runWizardWithIo(null, io, apply)
    expect(calls).toHaveLength(0)
    expect(prints.join("")).toContain("no preferences were written")
  })

  test("confirm screen shows the target layer", async () => {
    const global = scriptedIo(["enter", "enter", "enter", "enter", "escape"])
    await runWizardWithIo(null, global.io, captureApply().apply)
    expect(global.frames.at(-1)).toContain("Target: global preferences")

    const project = scriptedIo(["enter", "enter", "enter", "enter", "escape"])
    await runWizardWithIo("/tmp/demo-project", project.io, captureApply().apply)
    expect(project.frames.at(-1)).toContain("Target: --project /tmp/demo-project")
  })

  test("selected and unselected options share the same text column", async () => {
    const { io, frames } = scriptedIo(["enter", "escape"])
    await runWizardWithIo(null, io, captureApply().apply)
    const optionLines = (frames[1] ?? "")
      .split("\n")
      .filter(
        (line) =>
          stripAnsi(line).includes("workspace per run") ||
          stripAnsi(line).includes("current workspace (recommended)")
      )
    expect(optionLines).toHaveLength(2)
    const columns = optionLines.map((line) => stripAnsi(line).search(/\S/) + 1)
    expect(new Set(columns).size).toBe(1)
  })
})

describe("runUiWizard", () => {
  test("requires an interactive terminal", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    try {
      await expect(runUiWizard(null)).rejects.toThrow(
        "ui wizard requires an interactive terminal; use ui set or setup --defaults."
      )
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(process.stdin, "isTTY")
      } else {
        Object.defineProperty(process.stdin, "isTTY", original)
      }
    }
  })
})

describe("parseWizardKey", () => {
  test("maps raw sequences to wizard keys", () => {
    expect(parseWizardKey("\u001B[A")).toBe("up")
    expect(parseWizardKey("\u001B[B")).toBe("down")
    expect(parseWizardKey("\r")).toBe("enter")
    expect(parseWizardKey("\n")).toBe("enter")
    expect(parseWizardKey("\u001B")).toBe("escape")
    expect(parseWizardKey("\u0003")).toBe("escape")
    expect(parseWizardKey("x")).toBe("none")
  })
})
