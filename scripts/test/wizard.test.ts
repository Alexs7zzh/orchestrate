import { describe, expect, test } from "bun:test"

import type { UiPreferenceLayer } from "../src/types.js"

import { EVENT_SEVERITIES } from "../src/notifications.js"
import {
  ANSI,
  DEMO_TIMELINE,
  NOTIFICATION_PRESETS,
  parseWizardKey,
  renderNotificationPreview,
  renderPlacementSketch,
  runUiWizard,
  runWizardWithIo,
  wizardPlan,
  type PlacementChoices,
  type WizardIo,
  type WizardKey,
  type WizardSelections
} from "../src/wizard.js"

const MATCHER = {
  type: "any",
  provider: "any",
  level: "any",
  origin: "any",
  id: "*"
} as const

const DEFAULT_SELECTIONS: WizardSelections = {
  notifications: { attention: "herdr", milestone: "herdr", progress: "board" },
  workspace: "dedicated",
  surface: "tab",
  board: "split-right"
}

/** The layer the pre-wizard cli.ts implementation wrote for equivalent answers. */
function legacyWizardLayer(
  board: UiPreferenceLayer["board"],
  surface: "tab" | "split",
  workspace: "dedicated" | "origin",
  milestone: "herdr" | "board" | "silent"
): UiPreferenceLayer {
  return {
    board,
    placement: {
      workspace,
      rules: [{ match: MATCHER, surface }],
      grouping: { by: "root-ancestor" },
      maxSplitsPerTab: 4
    },
    completedPanes: { agent: "keep-open", command: "close-success" },
    focus: "attention",
    continuation: { rules: [{ match: MATCHER, autoContinue: true }] },
    notifications: { attention: "herdr", milestone, progress: "board" }
  }
}

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
  calls: { layer: UiPreferenceLayer; project: string | null }[]
  apply: (layer: UiPreferenceLayer, project: string | null) => Promise<unknown>
} {
  const calls: { layer: UiPreferenceLayer; project: string | null }[] = []
  return {
    calls,
    apply: (layer, project) => {
      calls.push({ layer, project })
      return Promise.resolve(null)
    }
  }
}

describe("notification presets", () => {
  test("map to the exact notification records", () => {
    expect(NOTIFICATION_PRESETS.map((preset) => preset.label)).toStrictEqual([
      "Attention + milestones (default)",
      "Attention only",
      "Everything",
      "Board only (silent)",
      "Custom…"
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
})

describe("renderNotificationPreview", () => {
  test("styles each demo event by its routed channel, per preset", () => {
    for (const preset of NOTIFICATION_PRESETS) {
      if (preset.channels === null) {
        continue
      }
      const lines = renderNotificationPreview(preset.channels).split("\n").slice(1)
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

  test("bolds everything for the Everything preset and nothing for Board only", () => {
    const everything = renderNotificationPreview({
      attention: "herdr",
      milestone: "herdr",
      progress: "herdr"
    })
    expect(everything.split("🔔")).toHaveLength(DEMO_TIMELINE.length + 1)
    const boardOnly = renderNotificationPreview({
      attention: "board",
      milestone: "board",
      progress: "board"
    })
    expect(boardOnly).not.toContain("🔔")
    expect(boardOnly).not.toContain(ANSI.bold)
  })
})

describe("renderPlacementSketch", () => {
  const BASE: PlacementChoices = { workspace: "dedicated", surface: "tab", board: "split-right" }

  test("keeps a compact fixed geometry", () => {
    for (const active of ["workspace", "surface", "board"] as const) {
      const lines = stripAnsi(renderPlacementSketch(BASE, active)).split("\n")
      expect(lines).toHaveLength(10)
      for (const line of lines) {
        expect(line).toHaveLength(56)
      }
    }
  })

  test("marks the dedicated run entry in the workspaces rail", () => {
    const sketch = renderPlacementSketch(BASE, "workspace")
    expect(sketch).toContain(`${ANSI.inverse}run-42${ANSI.reset}`)
    expect(sketch).not.toContain(`${ANSI.inverse}[alpha-1]`)
  })

  test("marks the pane grid when runs stay in the origin workspace", () => {
    const sketch = renderPlacementSketch({ ...BASE, workspace: "origin" }, "workspace")
    expect(sketch).not.toContain("run-42")
    expect(sketch).toContain(`${ANSI.inverse}┌${"─".repeat(18)}┐${ANSI.reset}`)
  })

  test("marks the new tab for the tab surface", () => {
    const sketch = renderPlacementSketch(BASE, "surface")
    expect(sketch).toContain(`${ANSI.inverse}[alpha-1]${ANSI.reset}`)
    expect(sketch).not.toContain("beta (split)")
    expect(sketch).not.toContain("max 4 splits per tab")
  })

  test("marks the split pane and shows the split cap caption", () => {
    const sketch = renderPlacementSketch({ ...BASE, surface: "split" }, "surface")
    expect(sketch).toContain(`${ANSI.inverse} beta (split)`)
    expect(sketch).toContain("max 4 splits per tab")
    expect(sketch).not.toContain("[alpha-1]")
  })

  test("marks the board region for each board choice", () => {
    const splitRight = renderPlacementSketch(BASE, "board")
    expect(splitRight).toContain(`${ANSI.inverse} board`)

    const rail = renderPlacementSketch({ ...BASE, board: "dedicated-workspace" }, "board")
    expect(rail).toContain(`${ANSI.inverse}board${ANSI.reset}`)
    expect(rail).not.toContain("[board]")

    const tab = renderPlacementSketch({ ...BASE, board: "current-workspace" }, "board")
    expect(tab).toContain(`${ANSI.inverse}[board]${ANSI.reset}`)
  })

  test("leaves inactive regions unmarked while reflecting all choices", () => {
    const sketch = renderPlacementSketch(
      { workspace: "dedicated", surface: "tab", board: "current-workspace" },
      "surface"
    )
    expect(sketch).toContain("run-42")
    expect(sketch).toContain("[board]")
    expect(sketch).not.toContain(`${ANSI.inverse}run-42`)
    expect(sketch).not.toContain(`${ANSI.inverse}[board]`)
    expect(sketch).toContain(`${ANSI.inverse}[alpha-1]${ANSI.reset}`)
  })
})

describe("wizardPlan", () => {
  test("matches the layer the previous cli wizard wrote for equivalent answers", () => {
    const plan = wizardPlan(DEFAULT_SELECTIONS, null)
    expect(plan.layer).toStrictEqual(legacyWizardLayer("split-right", "tab", "dedicated", "herdr"))
  })

  test("keeps focus, completed panes, and continuation at the shipped defaults", () => {
    const plan = wizardPlan(
      {
        notifications: { attention: "board", milestone: "silent", progress: "silent" },
        workspace: "origin",
        surface: "split",
        board: "current-workspace"
      },
      null
    )
    expect(plan.layer.focus).toBe("attention")
    expect(plan.layer.completedPanes).toStrictEqual({
      agent: "keep-open",
      command: "close-success"
    })
    expect(plan.layer.continuation).toStrictEqual({
      rules: [{ match: MATCHER, autoContinue: true }]
    })
    expect(plan.layer.board).toBe("current-workspace")
    expect(plan.layer.placement?.workspace).toBe("origin")
    expect(plan.layer.placement?.rules).toStrictEqual([{ match: MATCHER, surface: "split" }])
    expect(plan.layer.notifications).toStrictEqual({
      attention: "board",
      milestone: "silent",
      progress: "silent"
    })
  })

  test("emits the exact ui set commands", () => {
    const plan = wizardPlan(DEFAULT_SELECTIONS, null)
    expect(plan.commands).toStrictEqual([
      `orchestrate ui set notifications '{"attention":"herdr","milestone":"herdr","progress":"board"}'`,
      `orchestrate ui set placement.workspace '"dedicated"'`,
      `orchestrate ui set placement.rules '[{"match":{"type":"any","provider":"any","level":"any","origin":"any","id":"*"},"surface":"tab"}]'`,
      `orchestrate ui set board '"split-right"'`
    ])
  })

  test("appends --project to every command for project layers", () => {
    const plan = wizardPlan(DEFAULT_SELECTIONS, "/tmp/demo-project")
    expect(plan.commands).toHaveLength(4)
    for (const command of plan.commands) {
      expect(command.endsWith(" --project /tmp/demo-project")).toBe(true)
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
    expect(calls[0]?.layer).toStrictEqual(wizardPlan(DEFAULT_SELECTIONS, "/tmp/demo-project").layer)
    expect(frames[0]).toContain("notifications (1/3)")
    expect(frames.some((frame) => frame.includes("placement (2/3)"))).toBe(true)
    expect(frames.some((frame) => frame.includes("confirm (3/3)"))).toBe(true)
    expect(prints.join("")).toContain(
      `orchestrate ui set board '"split-right"' --project /tmp/demo-project`
    )
  })

  test("arrow-key navigation reaches non-default answers", async () => {
    const { io, apply, calls } = {
      ...scriptedIo([
        "down",
        "enter", // Attention only
        "down",
        "enter", // workspace: origin
        "down",
        "enter", // surface: split
        "down",
        "down",
        "enter", // board: current-workspace
        "enter" // Apply
      ]),
      ...captureApply()
    }
    await runWizardWithIo(null, io, apply)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.layer).toStrictEqual(
      wizardPlan(
        {
          notifications: { attention: "herdr", milestone: "board", progress: "silent" },
          workspace: "origin",
          surface: "split",
          board: "current-workspace"
        },
        null
      ).layer
    )
  })

  test("custom preset drills into per-severity channel choices", async () => {
    const { io } = scriptedIo([
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
      "enter", // workspace: dedicated
      "enter", // surface: tab
      "enter", // board: split-right
      "enter" // Apply
    ])
    const { calls, apply } = captureApply()
    await runWizardWithIo(null, io, apply)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.layer.notifications).toStrictEqual({
      attention: "board",
      milestone: "herdr",
      progress: "silent"
    })
  })

  test("escape exits without writing anything", async () => {
    const { io, prints } = scriptedIo(["down", "escape"])
    const { calls, apply } = captureApply()
    await runWizardWithIo(null, io, apply)
    expect(calls).toHaveLength(0)
    expect(prints.join("")).toContain("no preferences were written")
  })

  test("escape mid-placement exits without writing anything", async () => {
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
