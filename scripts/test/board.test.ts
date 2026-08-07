import { createTestRenderer } from "@opentui/core/testing"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { BoardViewModel } from "../src/board-model.js"
import type { CliRenderer } from "@opentui/core"

import {
  boardLogicalRowAtScreenY,
  createBoardRenderables,
  mapBoardInputWhenReady,
  readBoardResultDetail,
  renderBoardFrame,
  scrollBoardRowIntoView,
  type BoardFrame
} from "../src/board.js"
import { MAX_RESULT_BYTES } from "../src/crank.js"

const renderers: CliRenderer[] = []

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    renderer.destroy()
  }
})

function model(objective: string): BoardViewModel {
  return {
    run: {
      id: "resize-run",
      name: "Resize test",
      objective,
      status: "running",
      pause: null,
      elapsedMs: 1_000
    },
    needsYou: [],
    nodes: [],
    rows: [],
    selectableNodeIds: []
  }
}

function boardNode(id: string): BoardViewModel["nodes"][number] {
  return {
    id,
    templateId: id,
    title: id,
    type: "command",
    provider: null,
    needs: [],
    depth: 0,
    status: "pending",
    glyph: "○",
    downstreamHeld: false,
    continuation: "auto",
    continuationGlyph: "▸",
    repeatId: null,
    round: null,
    currentRound: true,
    attempts: [],
    elapsedMs: null,
    pane: null,
    resultPath: null,
    skip: null,
    stalledPane: null
  }
}

describe("OpenTUI board viewport", () => {
  test("renders both the explanation and command for actionable attention", () => {
    const attention: BoardViewModel = {
      ...model("attention details"),
      needsYou: [
        {
          kind: "workroom",
          workroomId: "review",
          seatId: "reviewer",
          title: "review: seat reviewer needs occupancy attention",
          detail: "Inspect or repair the workroom tab, then reconcile the planned seat.",
          command: "orchestrate reconcile attention-run"
        }
      ]
    }
    const text = renderBoardFrame(attention, null).text
    expect(text).toContain(
      "review: seat reviewer needs occupancy attention\n    Inspect or repair the workroom tab, then reconcile the planned seat.\n    orchestrate reconcile attention-run"
    )
  })

  test.each(["completed", "failed", "stopped"] as const)(
    "hides mutating controls after a run is %s",
    (status) => {
      const terminal: BoardViewModel = {
        ...model("terminal controls"),
        run: { ...model("terminal controls").run, status }
      }
      const text = renderBoardFrame(terminal, null).text
      expect(text).toContain("↑/↓ select  enter open  q quit")
      expect(text).not.toContain("pause/resume")
      expect(text).not.toContain("hold/release")
      expect(text).not.toContain("s stop")
    }
  )

  test("shows bounded result content and reports oversized files instead of loading them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-board-result-"))
    try {
      const resultPath = path.join(root, "result.txt")
      await Bun.write(resultPath, "bounded result", { createPath: false })
      const detail = await readBoardResultDetail(resultPath)
      expect(renderBoardFrame(model("result display"), null, detail).text).toContain(
        "DETAIL\nbounded result"
      )

      await Bun.write(resultPath, "x".repeat(MAX_RESULT_BYTES + 1), { createPath: false })
      expect(await readBoardResultDetail(resultPath)).toContain(
        `${MAX_RESULT_BYTES}-byte result limit`
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ignores keyboard and mouse actions until the first model exists", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 })
    renderers.push(setup.renderer)
    const current: BoardViewModel | null = null
    let action = mapBoardInputWhenReady(current, null, { type: "key", key: "down" })
    const { root } = createBoardRenderables(setup.renderer, () => {
      action = mapBoardInputWhenReady(current, null, {
        type: "mouse",
        button: "left",
        action: "press",
        row: 0
      })
    })
    setup.renderer.root.add(root)
    await setup.renderOnce()
    await setup.mockMouse.click(2, 2)
    expect(action).toEqual({ type: "none" })
  })

  test("uses the terminal's semantic default colors", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 })
    renderers.push(setup.renderer)
    const { root, text } = createBoardRenderables(setup.renderer, () => {})

    expect(root.backgroundColor.intent).toBe("default")
    expect(text.fg.intent).toBe("default")
    expect(text.wrapMode).toBe("word")
  })

  test("wraps content when initially narrow", async () => {
    const setup = await createTestRenderer({ width: 24, height: 8 })
    renderers.push(setup.renderer)
    const { root, text } = createBoardRenderables(setup.renderer, () => {})
    const frame = renderBoardFrame(model("wrapped content is visible at narrow widths"), null)
    text.content = frame.text
    setup.renderer.root.add(root)

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("resize-run  wrapped")
    expect(setup.captureCharFrame()).toContain("content is visible at")
    expect(setup.captureCharFrame()).toContain("narrow widths")
    expect(text.scrollHeight).toBeGreaterThan(frame.text.split("\n").length)
    expect(text.plainText).toBe(frame.text)
  })

  test("reflows the full frame across repeated narrow-wide resize cycles", async () => {
    const setup = await createTestRenderer({ width: 24, height: 10 })
    renderers.push(setup.renderer)
    const { root, text } = createBoardRenderables(setup.renderer, () => {})
    const frame = renderBoardFrame(
      model("wrapped content becomes one physical row after terminal growth"),
      null
    )
    text.content = frame.text
    setup.renderer.root.add(root)

    await setup.renderOnce()
    expect(text.lineInfo.lineSources.filter((source) => source === 1).length).toBeGreaterThan(1)

    for (let cycle = 0; cycle < 2; cycle += 1) {
      setup.resize(80, 8)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(
        "wrapped content becomes one physical row after terminal growth"
      )
      expect(text.lineInfo.lineSources.filter((source) => source === 1)).toHaveLength(1)
      expect(text.plainText).toBe(frame.text)

      setup.resize(24, 8)
      await setup.renderOnce()
      expect(text.lineInfo.lineSources.filter((source) => source === 1).length).toBeGreaterThan(1)
      expect(text.plainText).toBe(frame.text)
    }
  })

  test("character-wraps a token longer than the viewport", async () => {
    const setup = await createTestRenderer({ width: 18, height: 8 })
    renderers.push(setup.renderer)
    const { root, text } = createBoardRenderables(setup.renderer, () => {})
    const token = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    text.content = token
    setup.renderer.root.add(root)

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("ABCDEFGHIJKLMNOP")
    expect(setup.captureCharFrame()).toContain("QRSTUVWXYZ012345")
    expect(text.lineInfo.lineSources).toEqual([0, 0, 0])
    expect(text.plainText).toBe(token)
  })

  test("keeps selection visible and maps clicks after earlier rows wrap", async () => {
    const setup = await createTestRenderer({ width: 22, height: 8 })
    renderers.push(setup.renderer)
    const frame: BoardFrame = {
      text: [
        "A heading whose wrapping adds physical rows before every node",
        "  ○ first-node  pending",
        "More ordinary board detail that also wraps before the next node",
        "  ○ second-node  pending"
      ].join("\n"),
      rowNodeIds: { 1: "first-node", 3: "second-node" }
    }
    let clickedNodeId = ""
    function recordClick(mouse: Parameters<Parameters<typeof createBoardRenderables>[1]>[0]): void {
      const logicalRow = boardLogicalRowAtScreenY(text, mouse.y)
      clickedNodeId = logicalRow === null ? "" : (frame.rowNodeIds[logicalRow] ?? "")
    }
    const renderables = createBoardRenderables(setup.renderer, recordClick)
    const text = renderables.text
    text.content = frame.text
    setup.renderer.root.add(renderables.root)

    await setup.renderOnce()
    scrollBoardRowIntoView(text, 3)
    await setup.renderOnce()

    const secondNodeVisualRow = text.lineInfo.lineSources.lastIndexOf(3)
    expect(text.scrollY).toBeGreaterThan(0)
    expect(secondNodeVisualRow).toBeGreaterThanOrEqual(text.scrollY)
    expect(secondNodeVisualRow).toBeLessThan(text.scrollY + text.height)

    const clickY = text.screenY + secondNodeVisualRow - text.scrollY
    await setup.mockMouse.click(text.screenX + 1, clickY)
    expect(clickedNodeId).toBe("second-node")
  })

  test("keeps node rows aligned after multiline gate attention", async () => {
    const first = boardNode("first-node")
    const second = boardNode("second-node")
    const attention: BoardViewModel = {
      ...model("gate row alignment"),
      needsYou: [
        {
          kind: "gate",
          nodeId: "first-node",
          digest: "gate-digest",
          content: "review content",
          title: "Approve first-node",
          detail: 'Content "review content"\nDigest gate-digest',
          command: "orchestrate approve resize-run --gate first-node --digest gate-digest"
        }
      ],
      nodes: [first, second],
      rows: [
        { kind: "node", key: first.id, depth: 0, node: first },
        { kind: "node", key: second.id, depth: 0, node: second }
      ],
      selectableNodeIds: [first.id, second.id]
    }
    const frame = renderBoardFrame(attention, first.id)
    const logicalLines = frame.text.split("\n")
    const firstRow = logicalLines.findIndex((line) => line.includes("first-node  pending"))
    const secondRow = logicalLines.findIndex((line) => line.includes("second-node  pending"))
    expect(logicalLines).toContain('    Content "review content"')
    expect(logicalLines).toContain("    Digest gate-digest")
    expect(frame.rowNodeIds).toEqual({
      [firstRow]: "first-node",
      [secondRow]: "second-node"
    })

    const setup = await createTestRenderer({ width: 80, height: 6 })
    renderers.push(setup.renderer)
    let clickedNodeId = ""
    const renderables = createBoardRenderables(setup.renderer, (mouse) => {
      const logicalRow = boardLogicalRowAtScreenY(renderables.text, mouse.y)
      clickedNodeId = logicalRow === null ? "" : (frame.rowNodeIds[logicalRow] ?? "")
    })
    renderables.text.content = frame.text
    setup.renderer.root.add(renderables.root)
    await setup.renderOnce()

    scrollBoardRowIntoView(renderables.text, secondRow)
    await setup.renderOnce()
    const visualRow = renderables.text.lineInfo.lineSources.lastIndexOf(secondRow)
    expect(visualRow).toBeGreaterThanOrEqual(renderables.text.scrollY)
    expect(visualRow).toBeLessThan(renderables.text.scrollY + renderables.text.height)
    await setup.mockMouse.click(
      renderables.text.screenX + 1,
      renderables.text.screenY + visualRow - renderables.text.scrollY
    )
    expect(clickedNodeId).toBe("second-node")
  })
})
