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

describe("OpenTUI board viewport", () => {
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
})
