import type {
  EventSeverity,
  EventType,
  NodeMatcher,
  NotificationChannel,
  PlacementRule,
  UiPreferenceLayer,
  UiPreferences
} from "./types.js"

import { EVENT_SEVERITIES } from "./notifications.js"
import { DEFAULT_UI_PREFERENCES, replaceUiPreferenceLayer } from "./preferences.js"

// The wizard renders with attribute codes only (bold/dim/inverse, no colour
// codes), so output is already NO_COLOR-safe.
export const ANSI = {
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  inverse: "\u001B[7m",
  reset: "\u001B[0m"
} as const

export type NotificationSelection = Readonly<Record<EventSeverity, NotificationChannel>>

export interface NotificationPresetOption {
  readonly label: string
  /** null marks the "Custom…" entry, which drills into per-severity choices. */
  readonly channels: NotificationSelection | null
}

export const NOTIFICATION_PRESETS: readonly NotificationPresetOption[] = [
  {
    label: "Attention + milestones (default)",
    channels: { attention: "herdr", milestone: "herdr", progress: "board" }
  },
  {
    label: "Attention only",
    channels: { attention: "herdr", milestone: "board", progress: "silent" }
  },
  {
    label: "Everything",
    channels: { attention: "herdr", milestone: "herdr", progress: "herdr" }
  },
  {
    label: "Board only (silent)",
    channels: { attention: "board", milestone: "board", progress: "board" }
  },
  { label: "Custom…", channels: null }
]

export interface DemoEvent {
  readonly type: EventType
  readonly detail: string
}

export const DEMO_TIMELINE: readonly DemoEvent[] = [
  { type: "run.started", detail: "release-review" },
  { type: "node.started", detail: "survey" },
  { type: "node.completed", detail: "survey" },
  { type: "gate.opened", detail: "synthesis" },
  { type: "node.started", detail: "alpha-1" },
  { type: "node.failed", detail: "beta" },
  { type: "repeat.max-rounds", detail: "review" },
  { type: "run.completed", detail: "release-review" }
]

export function renderNotificationPreview(selection: NotificationSelection): string {
  const lines = DEMO_TIMELINE.map((event) => {
    const channel = selection[EVENT_SEVERITIES[event.type]]
    const label = `${event.type} ${event.detail}`
    if (channel === "herdr") {
      return `  ${ANSI.bold}🔔 ${label}${ANSI.reset}`
    }
    if (channel === "board") {
      return `  ▤ ${label}`
    }
    return `  ${ANSI.dim}· ${label}${ANSI.reset}`
  })
  return ["Preview — demo run:", ...lines].join("\n")
}

export interface PlacementChoices {
  readonly workspace: UiPreferences["placement"]["workspace"]
  readonly surface: PlacementRule["surface"]
  readonly board: UiPreferences["board"]
}

export type PlacementQuestion = "workspace" | "surface" | "board"

interface SketchPart {
  readonly text: string
  readonly marked?: boolean
}

const RAIL_WIDTH = 11
const INNER_WIDTH = 39

function renderParts(parts: readonly SketchPart[], width: number): string {
  const plainLength = parts.reduce((length, part) => length + part.text.length, 0)
  const rendered = parts
    .map((part) => (part.marked === true ? `${ANSI.inverse}${part.text}${ANSI.reset}` : part.text))
    .join("")
  return rendered + " ".repeat(Math.max(0, width - plainLength))
}

function sketchLine(rail: readonly SketchPart[], inner: readonly SketchPart[]): string {
  return `│ ${renderParts(rail, RAIL_WIDTH)}│ ${renderParts(inner, INNER_WIDTH)} │`
}

function boxRow(interior: readonly SketchPart[], width: number): readonly SketchPart[] {
  return [
    { text: "│" },
    ...interior,
    {
      text: " ".repeat(
        Math.max(0, width - interior.reduce((length, part) => length + part.text.length, 0))
      )
    },
    { text: "│" }
  ]
}

/**
 * Compact sketch of herdr: workspaces rail on the left, tab strip on top,
 * pane grid inside. The inverse-video marker sits on the region affected by
 * the currently highlighted answer to `active`.
 */
export function renderPlacementSketch(
  choices: PlacementChoices,
  active: PlacementQuestion
): string {
  const hasBoardBox = choices.board === "split-right"
  const leftInterior = hasBoardBox ? 18 : 37
  const rightInterior = 16
  const markRun = active === "workspace" && choices.workspace === "dedicated"
  const markGrid = active === "workspace" && choices.workspace === "origin"
  const markTab = active === "surface" && choices.surface === "tab"
  const markSplit = active === "surface" && choices.surface === "split"
  const markBoardBox = active === "board" && choices.board === "split-right"
  const markBoardRail = active === "board" && choices.board === "dedicated-workspace"
  const markBoardTab = active === "board" && choices.board === "current-workspace"

  const railEntries: SketchPart[][] = [[{ text: "home" }]]
  if (choices.workspace === "dedicated") {
    railEntries.push([{ text: "run-42", marked: markRun }])
  }
  if (choices.board === "dedicated-workspace") {
    railEntries.push([{ text: "board", marked: markBoardRail }])
  }
  while (railEntries.length < 6) {
    railEntries.push([{ text: "" }])
  }

  const tabs: SketchPart[] = [{ text: "tabs: " }, { text: "[main]" }]
  if (choices.surface === "tab") {
    tabs.push({ text: " " }, { text: "[alpha-1]", marked: markTab })
  }
  if (choices.board === "current-workspace") {
    tabs.push({ text: " " }, { text: "[board]", marked: markBoardTab })
  }

  const leftTop: SketchPart = { text: `┌${"─".repeat(leftInterior)}┐`, marked: markGrid }
  const leftBottom: SketchPart = { text: `└${"─".repeat(leftInterior)}┘` }
  const leftRows: (readonly SketchPart[])[] = [
    [leftTop],
    boxRow([{ text: " alpha-1" }], leftInterior),
    choices.surface === "split"
      ? [{ text: `├${"─".repeat(leftInterior)}┤` }]
      : boxRow([], leftInterior),
    choices.surface === "split"
      ? boxRow([{ text: " beta (split)", marked: markSplit }], leftInterior)
      : boxRow([], leftInterior),
    [leftBottom]
  ]
  const rightRows: (readonly SketchPart[])[] = [
    [{ text: `┌${"─".repeat(rightInterior)}┐` }],
    boxRow([{ text: " board", marked: markBoardBox }], rightInterior),
    boxRow([], rightInterior),
    boxRow([], rightInterior),
    [{ text: `└${"─".repeat(rightInterior)}┘` }]
  ]
  const gridRows = leftRows.map((leftRow, index) =>
    hasBoardBox ? leftRow.concat([{ text: " " }], rightRows[index] ?? []) : leftRow
  )
  const caption: SketchPart[] =
    choices.surface === "split" ? [{ text: " max 4 splits per tab" }] : [{ text: "" }]

  const lines = [
    `┌ herdr ${"─".repeat(47)}┐`,
    sketchLine([{ text: "workspaces" }], tabs),
    sketchLine([{ text: "─".repeat(10) }], [{ text: "─".repeat(INNER_WIDTH) }]),
    ...gridRows.map((row, index) => sketchLine(railEntries[index] ?? [{ text: "" }], row)),
    sketchLine(railEntries[5] ?? [{ text: "" }], caption),
    `└${"─".repeat(54)}┘`
  ]
  return lines.join("\n")
}

export interface WizardSelections extends PlacementChoices {
  readonly notifications: NotificationSelection
}

export interface WizardPlan {
  readonly layer: UiPreferenceLayer
  readonly commands: readonly string[]
}

const WIZARD_MATCHER: NodeMatcher = {
  type: "any",
  provider: "any",
  level: "any",
  origin: "any",
  id: "*"
}

export function wizardPlan(selections: WizardSelections, project: string | null): WizardPlan {
  const rules: readonly PlacementRule[] = [{ match: WIZARD_MATCHER, surface: selections.surface }]
  const notifications: NotificationSelection = {
    attention: selections.notifications.attention,
    milestone: selections.notifications.milestone,
    progress: selections.notifications.progress
  }
  const layer: UiPreferenceLayer = {
    board: selections.board,
    placement: {
      workspace: selections.workspace,
      rules,
      grouping: { by: "root-ancestor" },
      maxSplitsPerTab: 4
    },
    completedPanes: {
      agent: DEFAULT_UI_PREFERENCES.completedPanes.agent,
      command: DEFAULT_UI_PREFERENCES.completedPanes.command
    },
    focus: DEFAULT_UI_PREFERENCES.focus,
    continuation: DEFAULT_UI_PREFERENCES.continuation,
    notifications
  }
  const suffix = project === null ? "" : ` --project ${project}`
  const commands = [
    `orchestrate ui set notifications '${JSON.stringify(notifications)}'${suffix}`,
    `orchestrate ui set placement.workspace '${JSON.stringify(selections.workspace)}'${suffix}`,
    `orchestrate ui set placement.rules '${JSON.stringify(rules)}'${suffix}`,
    `orchestrate ui set board '${JSON.stringify(selections.board)}'${suffix}`
  ]
  return { layer, commands }
}

export type WizardKey = "up" | "down" | "enter" | "escape" | "none"

export interface WizardIo {
  /** Replace the current frame (interactive re-render). */
  write(frame: string): void
  /** Persistent output once the interactive loop is over. */
  print(text: string): void
  readKey(): Promise<WizardKey>
}

export type ApplyUiLayer = (layer: UiPreferenceLayer, projectCwd: string | null) => Promise<unknown>

export function parseWizardKey(sequence: string): WizardKey {
  if (sequence === "\u0003" || sequence === "\u001B" || sequence === "\u001B\u001B") {
    return "escape"
  }
  if (sequence === "\r" || sequence === "\n") {
    return "enter"
  }
  if (sequence === "\u001B[A") {
    return "up"
  }
  if (sequence === "\u001B[B") {
    return "down"
  }
  return "none"
}

const HINT = `${ANSI.dim}↑/↓ move · enter confirm · esc cancel${ANSI.reset}`
const CANCELLED_MESSAGE = "Wizard cancelled; no preferences were written.\n"

function selectorLines(options: readonly string[], highlighted: number): readonly string[] {
  return options.map((option, index) =>
    index === highlighted ? `  ${ANSI.inverse} ${option} ${ANSI.reset}` : `    ${option}`
  )
}

async function select(
  io: WizardIo,
  render: (highlighted: number) => string,
  count: number,
  initial = 0
): Promise<number | null> {
  let index = initial
  for (;;) {
    io.write(render(index))
    const key = await io.readKey()
    if (key === "escape") {
      return null
    }
    if (key === "enter") {
      return index
    }
    if (key === "up") {
      index = (index + count - 1) % count
    } else if (key === "down") {
      index = (index + 1) % count
    }
  }
}

const SEVERITIES = ["attention", "milestone", "progress"] as const
const CHANNELS = ["herdr", "board", "silent"] as const

function withChannel(
  base: NotificationSelection,
  severity: EventSeverity,
  channel: NotificationChannel
): NotificationSelection {
  return {
    attention: severity === "attention" ? channel : base.attention,
    milestone: severity === "milestone" ? channel : base.milestone,
    progress: severity === "progress" ? channel : base.progress
  }
}

function renderNotificationScreen(highlighted: number): string {
  const preview =
    NOTIFICATION_PRESETS[highlighted]?.channels ?? DEFAULT_UI_PREFERENCES.notifications
  return [
    `${ANSI.bold}Orchestrate setup · notifications (1/3)${ANSI.reset}`,
    "",
    "How should run events reach you?",
    "",
    ...selectorLines(
      NOTIFICATION_PRESETS.map((preset) => preset.label),
      highlighted
    ),
    "",
    renderNotificationPreview(preview),
    "",
    HINT
  ].join("\n")
}

const CHANNEL_LABELS = [
  "herdr — desktop notification",
  "board — listed on the run board only",
  "silent — recorded in the journal only"
] as const

function renderCustomScreen(
  severity: EventSeverity,
  working: NotificationSelection,
  highlighted: number
): string {
  const candidate = withChannel(working, severity, CHANNELS[highlighted] ?? "herdr")
  return [
    `${ANSI.bold}Orchestrate setup · notifications (1/3) · custom${ANSI.reset}`,
    "",
    `Where do ${severity} events go?`,
    "",
    ...selectorLines(CHANNEL_LABELS, highlighted),
    "",
    renderNotificationPreview(candidate),
    "",
    HINT
  ].join("\n")
}

function renderPlacementScreen(
  question: PlacementQuestion,
  title: string,
  options: readonly string[],
  highlighted: number,
  choices: PlacementChoices
): string {
  return [
    `${ANSI.bold}Orchestrate setup · placement (2/3)${ANSI.reset}`,
    "",
    title,
    "",
    ...selectorLines(options, highlighted),
    "",
    renderPlacementSketch(choices, question),
    "",
    HINT
  ].join("\n")
}

function renderConfirmScreen(
  plan: WizardPlan,
  project: string | null,
  highlighted: number
): string {
  const target = project === null ? "global preferences" : `--project ${project}`
  return [
    `${ANSI.bold}Orchestrate setup · confirm (3/3)${ANSI.reset}`,
    "",
    `Target: ${target}`,
    "",
    ...plan.commands.map((command) => `  ${command}`),
    "",
    ...selectorLines(["[Apply]", "[Cancel]"], highlighted),
    "",
    HINT
  ].join("\n")
}

const WORKSPACE_OPTIONS = [
  { label: "dedicated — runs live in their own run-<id> workspace", value: "dedicated" },
  { label: "origin — run panes open inside the current workspace", value: "origin" }
] as const

const SURFACE_OPTIONS = [
  { label: "tab — each node opens a new tab", value: "tab" },
  { label: "split — nodes split the current tab (max 4 splits per tab)", value: "split" }
] as const

const BOARD_OPTIONS = [
  { label: "split-right — board pane on the right of the grid", value: "split-right" },
  { label: "dedicated-workspace — board in its own workspace", value: "dedicated-workspace" },
  { label: "current-workspace — board tab in the current workspace", value: "current-workspace" }
] as const

async function askPlacement<T extends PlacementChoices[keyof PlacementChoices]>(
  io: WizardIo,
  question: PlacementQuestion,
  title: string,
  options: readonly { readonly label: string; readonly value: T }[],
  choices: PlacementChoices,
  merge: (value: T) => PlacementChoices
): Promise<PlacementChoices | null> {
  const fallback = (options[0] as { readonly value: T }).value
  const picked = await select(
    io,
    (highlighted) =>
      renderPlacementScreen(
        question,
        title,
        options.map((option) => option.label),
        highlighted,
        merge(options[highlighted]?.value ?? fallback)
      ),
    options.length
  )
  if (picked === null) {
    return null
  }
  return merge(options[picked]?.value ?? fallback)
}

export async function runWizardWithIo(
  project: string | null,
  io: WizardIo,
  apply: ApplyUiLayer = replaceUiPreferenceLayer
): Promise<void> {
  // Screen 1 — notifications.
  const presetIndex = await select(io, renderNotificationScreen, NOTIFICATION_PRESETS.length)
  if (presetIndex === null) {
    io.print(CANCELLED_MESSAGE)
    return
  }
  let notifications = NOTIFICATION_PRESETS[presetIndex]?.channels ?? null
  if (notifications === null) {
    let working: NotificationSelection = DEFAULT_UI_PREFERENCES.notifications
    for (const severity of SEVERITIES) {
      const initial = CHANNELS.indexOf(working[severity])
      const picked = await select(
        io,
        (highlighted) => renderCustomScreen(severity, working, highlighted),
        CHANNELS.length,
        initial === -1 ? 0 : initial
      )
      if (picked === null) {
        io.print(CANCELLED_MESSAGE)
        return
      }
      working = withChannel(working, severity, CHANNELS[picked] ?? "herdr")
    }
    notifications = working
  }

  // Screen 2 — placement, three sequential questions over one sketch.
  let choices: PlacementChoices = {
    workspace: DEFAULT_UI_PREFERENCES.placement.workspace,
    surface: "tab",
    board: DEFAULT_UI_PREFERENCES.board
  }
  const afterWorkspace = await askPlacement(
    io,
    "workspace",
    "Where do workflow runs live?",
    WORKSPACE_OPTIONS,
    choices,
    (value) => ({ ...choices, workspace: value })
  )
  if (afterWorkspace === null) {
    io.print(CANCELLED_MESSAGE)
    return
  }
  choices = afterWorkspace
  const afterSurface = await askPlacement(
    io,
    "surface",
    "Where do nodes open?",
    SURFACE_OPTIONS,
    choices,
    (value) => ({ ...choices, surface: value })
  )
  if (afterSurface === null) {
    io.print(CANCELLED_MESSAGE)
    return
  }
  choices = afterSurface
  const afterBoard = await askPlacement(
    io,
    "board",
    "Where does the board open?",
    BOARD_OPTIONS,
    choices,
    (value) => ({ ...choices, board: value })
  )
  if (afterBoard === null) {
    io.print(CANCELLED_MESSAGE)
    return
  }
  choices = afterBoard

  // Screen 3 — confirm and apply.
  const plan = wizardPlan({ ...choices, notifications }, project)
  const confirmed = await select(
    io,
    (highlighted) => renderConfirmScreen(plan, project, highlighted),
    2
  )
  if (confirmed === null || confirmed === 1) {
    io.print(CANCELLED_MESSAGE)
    return
  }
  await apply(plan.layer, project)
  io.print(
    [
      project === null
        ? "Applied to global preferences. Equivalent commands:"
        : `Applied to project layer ${project}. Equivalent commands:`,
      ...plan.commands.map((command) => `  ${command}`),
      ""
    ].join("\n")
  )
}

interface TerminalIo extends WizardIo {
  close(): void
}

const CLEAR = "\u001B[2J\u001B[H"

function terminalIo(): TerminalIo {
  const stdin = process.stdin
  stdin.setRawMode(true)
  stdin.resume()
  return {
    write(frame) {
      process.stdout.write(`${CLEAR}${frame}\n`)
    },
    print(text) {
      process.stdout.write(`${CLEAR}${text}`)
    },
    readKey() {
      return new Promise((resolve) => {
        stdin.once("data", (chunk: Buffer | string) => {
          resolve(parseWizardKey(chunk.toString()))
        })
      })
    },
    close() {
      stdin.setRawMode(false)
      stdin.pause()
    }
  }
}

export async function runUiWizard(project: string | null): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("ui wizard requires an interactive terminal; use ui set or setup --defaults.")
  }
  const io = terminalIo()
  try {
    await runWizardWithIo(project, io)
  } finally {
    io.close()
  }
}
