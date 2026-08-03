import {
  BoxRenderable,
  createCliRenderer,
  RGBA,
  TextRenderable,
  type BoxOptions,
  type CliRenderer
} from "@opentui/core"
import { Effect } from "effect"
import { watch, type FSWatcher } from "node:fs"
import { readFile } from "node:fs/promises"

import type { BoardAction, BoardInput, BoardViewModel, PaneGarnish } from "./board-model.js"
import type { CrankEvent, RunState } from "./types.js"

import { buildBoardModel, mapBoardInput } from "./board-model.js"
import { crankRun } from "./crank.js"
import { HerdrSurface, type HerdrAgentStatus } from "./herdr-surface.js"
import { installedBuild } from "./setup.js"
import { readEvents, readRunState } from "./state.js"

export interface BoardFrame {
  readonly text: string
  readonly rowNodeIds: Readonly<Record<number, string>>
}

export interface BoardRenderables {
  readonly root: BoxRenderable
  readonly text: TextRenderable
}

export interface LivePaneSample {
  readonly condition: "live" | "blocked" | "done" | "gone"
  readonly detail: string | null
}

export interface ClockRefreshLoop {
  stop(): void
}

export function mapBoardInputWhenReady(
  model: BoardViewModel | null,
  selectedNodeId: string | null,
  input: BoardInput
): BoardAction {
  return model === null ? { type: "none" } : mapBoardInput(model, selectedNodeId, input)
}

export interface ClockRefreshOptions {
  readonly intervalMs?: number
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  readonly onError?: (error: unknown) => void
}

const BOARD_REFRESH_INTERVAL_MS = 1_000
const BLOCKED_DETAIL = "Agent is blocked — human needed."
const DONE_DETAIL =
  "Result missing: agent finished without authenticated node-done — recovery needed."

export function classifyLivePane(
  live: boolean,
  nodeType: RunState["nodes"][string]["type"],
  agentStatus: HerdrAgentStatus | null
): LivePaneSample {
  if (!live) {
    return { condition: "gone", detail: "Pane gone — human needed." }
  }
  if (nodeType === "agent" && agentStatus === "blocked") {
    return { condition: "blocked", detail: BLOCKED_DETAIL }
  }
  if (nodeType === "agent" && agentStatus === "done") {
    return { condition: "done", detail: DONE_DETAIL }
  }
  // Herdr 0.7 reports idle, working, blocked, unknown, and done. Idle,
  // unknown, and unrecognized startup samples are transient. Done means the
  // provider finished while durable state still says running, so node-done
  // was not submitted and authenticated recovery is actionable.
  return { condition: "live", detail: null }
}

export function startClockRefresh(
  refresh: () => Promise<void>,
  options: ClockRefreshOptions = {}
): ClockRefreshLoop {
  const intervalMs = options.intervalMs ?? BOARD_REFRESH_INTERVAL_MS
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Board refresh interval must be a positive integer.")
  }
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = (): void => {
    if (stopped || timer !== null) {
      return
    }
    timer = setTimer(() => {
      timer = null
      void tick()
    }, intervalMs)
  }
  const tick = async (): Promise<void> => {
    if (stopped) {
      return
    }
    try {
      await refresh()
    } catch (error) {
      options.onError?.(error)
    } finally {
      schedule()
    }
  }

  schedule()
  return {
    stop(): void {
      stopped = true
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
    }
  }
}

export function createBoardRenderables(
  renderer: CliRenderer,
  onMouseDown: NonNullable<BoxOptions["onMouseDown"]>
): BoardRenderables {
  const root = new BoxRenderable(renderer, {
    id: "board",
    width: "100%",
    height: "100%",
    padding: 1,
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: RGBA.defaultBackground(),
    onMouseDown
  })
  const text = new TextRenderable(renderer, {
    id: "board-text",
    width: "100%",
    height: "100%",
    content: "Loading…",
    fg: RGBA.defaultForeground(),
    wrapMode: "word",
    overflow: "hidden"
  })
  root.add(text)
  return { root, text }
}

export function boardLogicalRowAtScreenY(text: TextRenderable, screenY: number): number | null {
  const viewportRow = screenY - text.screenY
  if (viewportRow < 0 || viewportRow >= text.height) {
    return null
  }
  return text.lineInfo.lineSources[text.scrollY + viewportRow] ?? null
}

export function scrollBoardRowIntoView(text: TextRenderable, logicalRow: number): void {
  const firstVisualRow = text.lineInfo.lineSources.indexOf(logicalRow)
  if (firstVisualRow === -1 || text.height < 1) {
    return
  }
  const lastVisualRow = text.lineInfo.lineSources.lastIndexOf(logicalRow)
  const rowHeight = lastVisualRow - firstVisualRow + 1
  if (rowHeight >= text.height || firstVisualRow < text.scrollY) {
    text.scrollY = firstVisualRow
    return
  }
  const viewportBottom = text.scrollY + text.height - 1
  if (lastVisualRow > viewportBottom) {
    text.scrollY = lastVisualRow - text.height + 1
  }
}

function duration(milliseconds: number | null): string {
  if (milliseconds === null) {
    return "-"
  }
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function renderBoardFrame(
  model: BoardViewModel,
  selectedNodeId: string | null,
  detail: string | null = null,
  buildWarning: string | null = null
): BoardFrame {
  const lines: string[] = [
    `ORCHESTRATE  ${model.run.name}  ${model.run.status.toUpperCase()}  ${duration(model.run.elapsedMs)}`,
    `${model.run.id}  ${model.run.objective}`,
    ...(buildWarning === null ? [] : [`! ${buildWarning}`]),
    ""
  ]
  if (model.needsYou.length > 0) {
    lines.push("NEEDS YOU")
    for (const item of model.needsYou) {
      lines.push(`  ! ${item.title}`)
      lines.push(`    ${item.command ?? item.detail}`)
    }
    lines.push("")
  }
  lines.push("WORKFLOW")
  const rowNodeIds: Record<number, string> = {}
  for (const row of model.rows) {
    if (row.kind === "repeat-history") {
      lines.push(
        `${"  ".repeat(row.depth)}… ${row.repeatId} round ${row.round}  ${row.statuses.join("/")}  ${duration(row.elapsedMs)}`
      )
      continue
    }
    const node = row.node
    const prefix = node.id === selectedNodeId ? ">" : " "
    const stalled =
      node.stalledPane === null
        ? ""
        : node.stalledPane.condition === "blocked"
          ? "  ! agent blocked"
          : node.stalledPane.condition === "done"
            ? "  ! result missing"
            : "  ! pane gone"
    const dependencyRelease = node.downstreamHeld
      ? ` ${node.continuationGlyph} downstream held`
      : ` ${node.continuationGlyph}`
    rowNodeIds[lines.length] = node.id
    lines.push(
      `${prefix} ${"  ".repeat(node.depth)}${node.glyph} ${node.id}  ${node.status}${dependencyRelease}  ${duration(node.elapsedMs)}${stalled}`
    )
  }
  lines.push("", "↑/↓ select  enter open  p pause/resume  h hold/release  s stop  q quit")
  if (detail !== null) {
    lines.push("", "DETAIL", detail)
  }
  return { text: lines.join("\n"), rowNodeIds }
}

export async function observePaneGarnish(
  state: RunState,
  surface: HerdrSurface
): Promise<Readonly<Record<string, PaneGarnish>>> {
  const observed = Object.values(state.nodes).filter(
    (node) =>
      node.status === "running" &&
      node.attempts.at(-1)?.pane !== null &&
      node.attempts.at(-1)?.pane !== undefined
  )
  // One `pane list` snapshot replaces a pane-get plus agent-get pair per node.
  const snapshot = observed.length === 0 ? new Map() : await surface.paneSnapshot()
  const entries = observed.map((node) => {
    const pane = node.attempts.at(-1)?.pane
    if (pane === null || pane === undefined) {
      return null
    }
    const observation = snapshot.get(pane.paneId)
    const live = observation !== undefined
    const agentStatus = live && node.type === "agent" ? (observation.agentStatus ?? null) : null
    const sample = classifyLivePane(live, node.type, agentStatus)
    return [
      node.id,
      sample.condition === "live"
        ? ({ condition: "live", detail: null } as const)
        : sample.condition === "blocked"
          ? ({
              condition: "blocked",
              detail: sample.detail
            } as const)
          : sample.condition === "done"
            ? ({ condition: "done", detail: sample.detail } as const)
            : ({ condition: "gone", detail: sample.detail } as const)
    ] as const
  })
  return Object.fromEntries(entries.filter((entry) => entry !== null))
}

function eventForAction(action: BoardAction): CrankEvent | null {
  if (action.type === "pause-run") {
    return { type: "pause" }
  }
  if (action.type === "resume-run") {
    return { type: "resume", overrideFuse: false, continueRounds: null, acceptRepeat: null }
  }
  if (action.type === "stop-run") {
    return { type: "stop" }
  }
  if (action.type === "hold-node") {
    return { type: "hold", nodeId: action.nodeId }
  }
  if (action.type === "release-node") {
    return { type: "release", nodeId: action.nodeId }
  }
  return null
}

async function runInteractiveBoard(runDir: string, renderer: CliRenderer): Promise<void> {
  const surface = new HerdrSurface()
  await surface.connect()
  let model: BoardViewModel | null = null
  let selectedNodeId: string | null = null
  let detail: string | null = null
  let buildWarning: string | null = null
  let frame: BoardFrame = { text: "Loading…", rowNodeIds: {} }
  const { root, text } = createBoardRenderables(renderer, function (mouse) {
    if (mouse.button !== 0) {
      return
    }
    if (model === null) {
      return
    }
    const logicalRow = boardLogicalRowAtScreenY(text, mouse.y)
    const nodeId = logicalRow === null ? undefined : frame.rowNodeIds[logicalRow]
    const row = model.rows.findIndex(
      (candidate) => candidate.kind === "node" && candidate.node.id === nodeId
    )
    if (row !== -1) {
      void act(
        mapBoardInputWhenReady(model, selectedNodeId, {
          type: "mouse",
          button: "left",
          action: "press",
          row
        })
      )
    }
  })
  const keepSelectionVisible = (): void => {
    const selectedRow = Object.entries(frame.rowNodeIds).find(
      ([, nodeId]) => nodeId === selectedNodeId
    )?.[0]
    if (selectedRow !== undefined) {
      scrollBoardRowIntoView(text, Number(selectedRow))
    }
  }
  text.on("line-info-change", keepSelectionVisible)
  renderer.root.add(root)

  let refreshRunning = false
  let refreshAgain = false
  let watcher: FSWatcher | null = null
  let clock: ClockRefreshLoop | null = null
  let closed = false
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const destroyHandler = (): void => {
    finish()
  }
  renderer.on("destroy", destroyHandler)

  const refresh = async (): Promise<void> => {
    if (closed || renderer.isDestroyed) {
      return
    }
    if (refreshRunning) {
      refreshAgain = true
      return
    }
    refreshRunning = true
    try {
      do {
        refreshAgain = false
        const state = await readRunState(runDir)
        if (closed || renderer.isDestroyed) {
          return
        }
        model = buildBoardModel(state, await readEvents(runDir), {
          now: new Date().toISOString(),
          paneGarnish: await observePaneGarnish(state, surface)
        })
        const staged = await installedBuild()
        if (closed || renderer.isDestroyed) {
          return
        }
        buildWarning =
          staged === null || staged === state.runtimeVersion
            ? null
            : `Installed build ${staged} differs from this CLI; run orchestrate setup.`
        if (selectedNodeId === null || !model.selectableNodeIds.includes(selectedNodeId)) {
          selectedNodeId = model.selectableNodeIds[0] ?? null
        }
        frame = renderBoardFrame(model, selectedNodeId, detail, buildWarning)
        text.content = frame.text
        keepSelectionVisible()
        renderer.requestRender()
      } while (refreshAgain)
    } finally {
      refreshRunning = false
    }
  }

  const act = async (action: BoardAction): Promise<void> => {
    if (action.type === "none") {
      return
    }
    if (action.type === "quit") {
      finish()
      return
    }
    if (model === null) {
      return
    }
    if (action.type === "select-node") {
      selectedNodeId = action.nodeId
      frame = renderBoardFrame(model, selectedNodeId, detail, buildWarning)
      text.content = frame.text
      keepSelectionVisible()
      return
    }
    if (action.type === "focus-node") {
      const node = model.nodes.find((candidate) => candidate.id === action.nodeId)
      if (node !== undefined) {
        await surface.focusRuntime(node.type, action.pane)
      }
      return
    }
    if (action.type === "show-result") {
      detail =
        action.resultPath === null
          ? "No result file."
          : await readFile(action.resultPath, "utf8").catch((error: unknown) => String(error))
      frame = renderBoardFrame(model, selectedNodeId, detail, buildWarning)
      text.content = frame.text
      keepSelectionVisible()
      return
    }
    const event = eventForAction(action)
    if (event !== null) {
      await crankRun(runDir, event, { surface })
      await refresh()
    }
  }

  const keyHandler = (key: { readonly name: string; readonly ctrl: boolean }): void => {
    if (key.ctrl && key.name === "c") {
      finish()
      return
    }
    const keys: Readonly<Record<string, "up" | "down" | "enter" | "p" | "r" | "s" | "h" | "q">> = {
      up: "up",
      down: "down",
      return: "enter",
      enter: "enter",
      p: "p",
      r: "r",
      s: "s",
      h: "h",
      q: "q"
    }
    const mapped = keys[key.name]
    if (mapped !== undefined && model !== null) {
      void act(mapBoardInputWhenReady(model, selectedNodeId, { type: "key", key: mapped }))
    }
  }
  renderer.keyInput.on("keypress", keyHandler)
  try {
    await refresh()
    watcher = watch(runDir, (_event, filename) => {
      if (filename === "state.json" || filename === "events.json") {
        void refresh().catch(() => undefined)
      }
    })
    clock = startClockRefresh(refresh)
    await finished
  } finally {
    closed = true
    clock?.stop()
    watcher?.close()
    text.off("line-info-change", keepSelectionVisible)
    renderer.keyInput.off("keypress", keyHandler)
    renderer.off("destroy", destroyHandler)
  }
}

// The board owns terminal resources inside an Effect scope. The interactive
// adapter stays thin; the view model and input reducer remain directly testable.
export function runBoardTui(runDir: string): Promise<void> {
  const renderer = Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createCliRenderer({
          screenMode: "alternate-screen",
          useMouse: true,
          enableMouseMovement: true,
          clearOnShutdown: true,
          exitOnCtrlC: false,
          targetFps: 20
        }),
      catch: (cause) => new Error("OpenTUI setup failed.", { cause })
    }),
    (value) =>
      Effect.sync(() => {
        value.destroy()
      })
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(renderer, (value) =>
        Effect.tryPromise(() => runInteractiveBoard(runDir, value))
      )
    )
  )
}
