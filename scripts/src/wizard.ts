import type {
  EventSeverity,
  EventType,
  NodeMatcher,
  NotificationChannel,
  PlacementRule,
  UiPreferences
} from "./types.js"

import { EVENT_SEVERITIES } from "./notifications.js"
import { DEFAULT_UI_PREFERENCES, patchUiPreferenceLayer } from "./preferences.js"

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
    label: "Needs you + finishes (default) — routine stays on the board",
    channels: { attention: "herdr", milestone: "herdr", progress: "board" }
  },
  {
    label: "Needs you only — finishes land on the board, routine is silent",
    channels: { attention: "herdr", milestone: "board", progress: "silent" }
  },
  {
    label: "Every event — starts, finishes, gates, everything",
    channels: { attention: "herdr", milestone: "herdr", progress: "herdr" }
  },
  {
    label: "Board only — never notify; watch the board",
    channels: { attention: "board", milestone: "board", progress: "board" }
  },
  { label: "Custom… — pick per event group", channels: null }
]

/**
 * Plain-language description of each severity group, in terms of the events
 * it contains, so nobody has to reverse-engineer "attention" from the
 * preview.
 */
export const SEVERITY_EXPLAINERS: Readonly<Record<EventSeverity, string>> = {
  attention:
    "The run needs you: an approval or revision is waiting, workroom occupancy needs repair, the run failed, or a repeat loop hit its round limit.",
  milestone:
    "Something finished: a node completed or failed; the run completed, paused, or stopped.",
  progress: "Routine motion: nodes starting, gates approved, repeat rounds advancing."
}

/**
 * One demo run threads through every wizard screen: the release-review
 * workflow below is placed on the layout screen and its events drive the
 * notification preview.
 */
export interface DemoNode {
  readonly id: string
  readonly needs: readonly string[]
}

// Backbone nodes (plan, ui, api, docs, merge, report) carry plain ids; detail
// nodes use the "parent--sub" naming convention the nested layout keys on.
// Declaration order doubles as the run-order approximation the grouped
// mapping shows.
export const DEMO_WORKFLOW: readonly DemoNode[] = [
  { id: "plan", needs: [] },
  { id: "ui", needs: ["plan"] },
  { id: "ui--test", needs: ["ui"] },
  { id: "api", needs: ["plan"] },
  { id: "api--test", needs: ["api"] },
  { id: "api--bench", needs: ["api"] },
  { id: "docs", needs: ["plan"] },
  { id: "docs--lint", needs: ["docs"] },
  { id: "merge", needs: ["ui--test", "api--test", "api--bench", "docs--lint"] },
  { id: "report", needs: ["merge"] }
]

export interface DemoEvent {
  readonly type: EventType
  readonly detail: string
}

export const DEMO_TIMELINE: readonly DemoEvent[] = [
  { type: "run.started", detail: "release-review" },
  { type: "node.started", detail: "plan" },
  { type: "node.completed", detail: "ui--test" },
  { type: "gate.opened", detail: "merge" },
  { type: "node.started", detail: "api--bench" },
  { type: "node.failed", detail: "docs--lint" },
  { type: "repeat.max-rounds", detail: "report" },
  { type: "run.completed", detail: "release-review" }
]

export const NOTIFICATION_LEGEND = "🔔 desktop notification   ▤ status board   · journal only"

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
  return [
    "Preview — the demo run from the layout step:",
    ...lines,
    `  ${ANSI.dim}${NOTIFICATION_LEGEND}${ANSI.reset}`
  ].join("\n")
}

/**
 * Node layout maps to placement rules plus a grouping strategy:
 * - "nested": sub-nodes (ids named "parent--sub") split into their parent's
 *   tab via id-prefix grouping on "--"; every other node opens its own tab.
 *   Repeat-round instances ("review--r2") tuck in the same way.
 * - "grouped": a tab per entry node; every descendant splits into it
 *   (root-ancestor grouping makes their pane groups coincide).
 * - "per-node": a tab for every node.
 */
export type NodeLayout = "nested" | "grouped" | "per-node"

export interface PlacementChoices {
  readonly workspace: UiPreferences["placement"]["workspace"]
  readonly layout: NodeLayout
  readonly board: UiPreferences["board"]
}

export type PlacementQuestion = "workspace" | "layout" | "board"

export interface DemoTab {
  readonly label: string
  readonly panes: readonly string[]
}

const SUB_NODE_SEPARATOR = "--"
const MAX_SPLITS_PER_TAB = 4

/**
 * The tabs the demo workflow produces under each layout. Wizard tests
 * cross-check these against the real placement engine (id-prefix grouping for
 * nested, root-ancestor grouping for grouped).
 */
export function demoTabs(layout: NodeLayout): readonly DemoTab[] {
  if (layout === "per-node") {
    return DEMO_WORKFLOW.map((node) => ({ label: node.id, panes: [node.id] }))
  }
  if (layout === "nested") {
    const byPrefix = new Map<string, string[]>()
    for (const node of DEMO_WORKFLOW) {
      const separatorIndex = node.id.indexOf(SUB_NODE_SEPARATOR)
      const prefix = separatorIndex === -1 ? node.id : node.id.slice(0, separatorIndex)
      const panes = byPrefix.get(prefix) ?? []
      panes.push(node.id)
      byPrefix.set(prefix, panes)
    }
    return [...byPrefix.entries()].map(([label, panes]) => ({ label, panes }))
  }
  // Grouped: the demo has one entry node, so everything packs into its tab
  // family, spilling over once each tab is full.
  const [root, ...rest] = DEMO_WORKFLOW.map((node) => node.id)
  const tabs: DemoTab[] = [
    { label: root ?? "", panes: [root ?? "", ...rest.slice(0, MAX_SPLITS_PER_TAB)] }
  ]
  // Overflow tabs seat one extra pane: their first member opens the tab
  // itself and does not count against the split cap.
  for (let index = MAX_SPLITS_PER_TAB, ordinal = 2; index < rest.length; ordinal += 1) {
    tabs.push({ label: `${root} ${ordinal}`, panes: rest.slice(index, index + 5) })
    index += MAX_SPLITS_PER_TAB + 1
  }
  return tabs
}

/** Plain ASCII sketch of the demo DAG, shown only where structure matters. */
export function renderDemoWorkflow(): string {
  return [
    "Demo workflow:",
    "  plan ─┬─ ui ─── ui--test ────┬─ merge ─ report",
    "        ├─ api ─┬─ api--test ──┤",
    "        │       └─ api--bench ─┤",
    "        └─ docs ── docs--lint ─┘"
  ].join("\n")
}

/**
 * The node-to-tab mapping the highlighted layout answer produces, spelled out
 * for every node so nothing is left to infer.
 */
export function renderTabMapping(layout: NodeLayout): string {
  const tabs = demoTabs(layout)
  if (layout === "per-node") {
    const names = tabs.map((tab) => tab.label)
    return [
      "Its tabs, with this choice:",
      `  ${ANSI.bold}${tabs.length} tabs${ANSI.reset} — one per node:`,
      `  ${names.slice(0, 5).join(" · ")}`,
      `  ${names.slice(5).join(" · ")}`
    ].join("\n")
  }
  const labelWidth = Math.max(...tabs.map((tab) => tab.label.length)) + 6
  const lines = tabs.map(({ label, panes }) => {
    const [first, ...splits] = panes
    const title = `tab "${label}"`
    const padding = " ".repeat(Math.max(1, labelWidth - title.length + 2))
    const body = splits.length === 0 ? first : `${first} + splits: ${splits.join(", ")}`
    return `  ${ANSI.bold}${title}${ANSI.reset}${padding}${body}`
  })
  const caption =
    layout === "grouped"
      ? [`  ${ANSI.dim}filled in run order; max 4 splits per tab${ANSI.reset}`]
      : []
  return ["Its tabs, with this choice:", ...lines, ...caption].join("\n")
}

const BOARD_MOCKUP_ROWS: readonly (readonly [string, string])[] = [
  ["✓ plan", "completed"],
  ["● ui--test", "running"],
  ["◆ merge", "awaiting approval"],
  ["○ report", "pending   (+6 more)"]
]

/**
 * A miniature of the status board TUI itself (real status glyphs, demo run),
 * so the board question introduces the thing before asking where to put it.
 */
export function renderBoardMockup(): string {
  const interior = 38
  const header = " board · release-review "
  const rows = BOARD_MOCKUP_ROWS.map(([node, status]) => {
    const body = ` ${node.padEnd(11)} ${status}`
    return `  │${body}${" ".repeat(Math.max(0, interior - body.length))}│`
  })
  return [
    `  ┌${header}${"─".repeat(Math.max(0, interior - header.length))}┐`,
    ...rows,
    `  └${"─".repeat(interior)}┘`
  ].join("\n")
}

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

function dashes(count: number): string {
  return "─".repeat(count)
}

function cellRow(cells: readonly SketchPart[], widths: readonly number[]): readonly SketchPart[] {
  const parts: SketchPart[] = [{ text: "│" }]
  cells.forEach((cell, index) => {
    const width = widths[index] ?? 0
    parts.push(cell, { text: " ".repeat(Math.max(0, width - cell.text.length)) }, { text: "│" })
  })
  return parts
}

/** The two placement questions whose answers the herdr sketch can show. */
export type SketchQuestion = "workspace" | "board"

/**
 * Compact sketch of herdr from where the user sits: the workspaces rail, the
 * current workspace's tab strip, and the [main] tab holding the pane the run
 * is launched from ("you"). The board and the run's tabs are drawn only where
 * the current answers would truly put them, and the inverse-video marker sits
 * on the region the highlighted answer to `active` controls.
 */
export function renderPlacementSketch(choices: PlacementChoices, active: SketchQuestion): string {
  const markCurrent = active === "workspace" && choices.workspace === "origin"
  const markRunWorkspace = active === "workspace" && choices.workspace === "dedicated"
  const markBoardSplit = active === "board" && choices.board === "split-right"
  const markBoardTab = active === "board" && choices.board === "current-workspace"
  const markBoardWorkspace = active === "board" && choices.board === "dedicated-workspace"

  // A dedicated board opens as a tab in the run workspace, so that workspace
  // exists in the rail whenever either answer calls for it.
  const runWorkspaceVisible =
    choices.workspace === "dedicated" || choices.board === "dedicated-workspace"
  const railEntries: SketchPart[][] = [[{ text: "current", marked: markCurrent }]]
  if (runWorkspaceVisible) {
    railEntries.push([{ text: "release-…", marked: markRunWorkspace || markBoardWorkspace }])
  }
  while (railEntries.length < 6) {
    railEntries.push([{ text: "" }])
  }

  const tabs: SketchPart[] = [{ text: "tabs: " }, { text: "[main]" }]
  if (choices.workspace === "origin") {
    tabs.push({ text: " [run tabs…]" })
  }
  if (choices.board === "current-workspace") {
    tabs.push({ text: " " }, { text: "[board]", marked: markBoardTab })
  }

  // The grid is the [main] tab: your pane, plus the board split when chosen.
  const hasBoardSplit = choices.board === "split-right"
  const leftInterior = hasBoardSplit ? 22 : 37
  const rightInterior = 14
  const gridRows: (readonly SketchPart[])[] = hasBoardSplit
    ? [
        [{ text: `┌${dashes(leftInterior)}┬${dashes(rightInterior)}┐` }],
        cellRow(
          [{ text: " you" }, { text: " board", marked: markBoardSplit }],
          [leftInterior, rightInterior]
        ),
        cellRow([{ text: "" }, { text: "" }], [leftInterior, rightInterior]),
        cellRow([{ text: "" }, { text: "" }], [leftInterior, rightInterior]),
        [{ text: `└${dashes(leftInterior)}┴${dashes(rightInterior)}┘` }]
      ]
    : [
        [{ text: `┌${dashes(leftInterior)}┐` }],
        boxRow([{ text: " you" }], leftInterior),
        boxRow([], leftInterior),
        boxRow([], leftInterior),
        [{ text: `└${dashes(leftInterior)}┘` }]
      ]
  const captionText =
    choices.board === "dedicated-workspace" && choices.workspace === "dedicated"
      ? " board + run tabs live in release-…"
      : choices.board === "dedicated-workspace"
        ? " the board tab lives in release-…"
        : choices.workspace === "dedicated"
          ? " run tabs open in release-…"
          : ""
  const caption: SketchPart[] = [{ text: captionText }]

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

export type WizardPreferencePatch = Pick<UiPreferences, "board" | "placement" | "notifications">

export interface WizardPlan {
  readonly patch: WizardPreferencePatch
  readonly commands: readonly string[]
}

const WIZARD_MATCHER: NodeMatcher = {
  type: "any",
  provider: "any",
  level: "any",
  origin: "any",
  id: "*"
}

const ROOT_MATCHER: NodeMatcher = {
  type: "any",
  provider: "any",
  level: "root",
  origin: "any",
  id: "*"
}

const SUB_NODE_MATCHER: NodeMatcher = {
  type: "any",
  provider: "any",
  level: "any",
  origin: "any",
  id: `*${SUB_NODE_SEPARATOR}*`
}

export function placementRulesForLayout(layout: NodeLayout): readonly PlacementRule[] {
  if (layout === "nested") {
    return [
      { match: SUB_NODE_MATCHER, surface: "split" },
      { match: WIZARD_MATCHER, surface: "tab" }
    ]
  }
  if (layout === "grouped") {
    return [
      { match: ROOT_MATCHER, surface: "tab" },
      { match: WIZARD_MATCHER, surface: "split" }
    ]
  }
  return [{ match: WIZARD_MATCHER, surface: "tab" }]
}

export function placementGroupingForLayout(
  layout: NodeLayout
): UiPreferences["placement"]["grouping"] {
  return layout === "nested"
    ? { by: "id-prefix", separator: SUB_NODE_SEPARATOR }
    : { by: "root-ancestor" }
}

export function wizardPlan(selections: WizardSelections, project: string | null): WizardPlan {
  const rules = placementRulesForLayout(selections.layout)
  const grouping = placementGroupingForLayout(selections.layout)
  const notifications: NotificationSelection = {
    attention: selections.notifications.attention,
    milestone: selections.notifications.milestone,
    progress: selections.notifications.progress
  }
  const patch: WizardPreferencePatch = {
    board: selections.board,
    placement: {
      workspace: selections.workspace,
      rules,
      grouping,
      maxSplitsPerTab: 4
    },
    notifications
  }
  const suffix = project === null ? "" : ` --project ${shellQuote(project)}`
  const commands = [
    `orchestrate ui set board ${shellQuote(JSON.stringify(patch.board))}${suffix}`,
    `orchestrate ui set placement ${shellQuote(JSON.stringify(patch.placement))}${suffix}`,
    `orchestrate ui set notifications ${shellQuote(JSON.stringify(patch.notifications))}${suffix}`
  ]
  return { patch, commands }
}

export type WizardKey = "up" | "down" | "enter" | "escape" | "none"

export interface WizardIo {
  /** Replace the current frame (interactive re-render). */
  write(frame: string): void
  /** Persistent output once the interactive loop is over. */
  print(text: string): void
  readKey(): Promise<WizardKey>
}

export type ApplyUiPatch = (
  patch: WizardPreferencePatch,
  projectCwd: string | null
) => Promise<unknown>

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

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
    index === highlighted ? `   ${ANSI.inverse} ${option} ${ANSI.reset}` : `    ${option}`
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
    `${ANSI.bold}Orchestrate setup · notifications (4/5)${ANSI.reset}`,
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
  "board — a row on the status board only",
  "silent — recorded in the journal only"
] as const

function renderCustomScreen(
  severity: EventSeverity,
  working: NotificationSelection,
  highlighted: number
): string {
  const candidate = withChannel(working, severity, CHANNELS[highlighted] ?? "herdr")
  return [
    `${ANSI.bold}Orchestrate setup · notifications (4/5) · custom${ANSI.reset}`,
    "",
    `Where should ${severity} events go?`,
    `${ANSI.dim}${SEVERITY_EXPLAINERS[severity]}${ANSI.reset}`,
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
  explainer: string | null,
  options: readonly string[],
  highlighted: number,
  choices: PlacementChoices
): string {
  // Each question shows only what it needs: the board question introduces the
  // board itself, the tab question is the only one where workflow structure
  // matters, and the two location questions share the herdr sketch.
  const intro = question === "board" ? [renderBoardMockup(), ""] : []
  const visuals =
    question === "layout"
      ? [renderDemoWorkflow(), "", renderTabMapping(choices.layout)]
      : [renderPlacementSketch(choices, question)]
  const step = { board: "board (1/5)", workspace: "workspace (2/5)", layout: "tabs (3/5)" }[
    question
  ]
  return [
    `${ANSI.bold}Orchestrate setup · ${step}${ANSI.reset}`,
    "",
    title,
    ...(explainer === null ? [] : [`${ANSI.dim}${explainer}${ANSI.reset}`]),
    "",
    ...intro,
    ...selectorLines(options, highlighted),
    "",
    ...visuals,
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
    `${ANSI.bold}Orchestrate setup · confirm (5/5)${ANSI.reset}`,
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

const BOARD_OPTIONS = [
  {
    label: "Next to you (default) — splits right of the pane you launch from",
    value: "split-right"
  },
  { label: "A tab in your current workspace", value: "current-workspace" },
  { label: "A tab in the run's own workspace", value: "dedicated-workspace" }
] as const

const WORKSPACE_OPTIONS = [
  {
    label: "Your current workspace (recommended) — run panes and workrooms open beside your own",
    value: "origin"
  },
  {
    label: "A workspace per run — keeps your current workspace untouched",
    value: "dedicated"
  }
] as const

const LAYOUT_OPTIONS = [
  {
    label: `Ordinary panes: a node with its sub-nodes (recommended) — "api--test" tucks into the "api" tab`,
    value: "nested"
  },
  {
    label: "Ordinary panes: all related nodes — descendants of one entry node, 4 splits per tab",
    value: "grouped"
  },
  {
    label: "Ordinary panes: a single node — every ordinary/seatless node opens its own tab",
    value: "per-node"
  }
] as const

async function askPlacement<T extends PlacementChoices[keyof PlacementChoices]>(
  io: WizardIo,
  question: PlacementQuestion,
  title: string,
  explainer: string | null,
  options: readonly { readonly label: string; readonly value: T }[],
  merge: (value: T) => PlacementChoices,
  initial = 0
): Promise<PlacementChoices | null> {
  const fallback = (options[0] as { readonly value: T }).value
  const picked = await select(
    io,
    (highlighted) =>
      renderPlacementScreen(
        question,
        title,
        explainer,
        options.map((option) => option.label),
        highlighted,
        merge(options[highlighted]?.value ?? fallback)
      ),
    options.length,
    initial
  )
  if (picked === null) {
    return null
  }
  return merge(options[picked]?.value ?? fallback)
}

export async function runWizardWithIo(
  project: string | null,
  io: WizardIo,
  apply: ApplyUiPatch = patchUiPreferenceLayer
): Promise<void> {
  // Screen 1 — layout: three questions in the order a run reaches the user:
  // the board (the first thing they see), then where the run's panes live,
  // then how nodes share tabs. It runs before the notifications step so the
  // board exists on screen before events route to it.
  let choices: PlacementChoices = {
    workspace: "origin",
    layout: "nested",
    board: DEFAULT_UI_PREFERENCES.board
  }
  const afterBoard = await askPlacement(
    io,
    "board",
    "Where do you want to monitor the run?",
    "When a run starts, orchestrate opens its status board — a live view of every node:",
    BOARD_OPTIONS,
    (value) => ({ ...choices, board: value })
  )
  if (afterBoard === null) {
    io.print(CANCELLED_MESSAGE)
    return
  }
  choices = afterBoard
  // A dedicated board already lives in a run workspace, so lead with that
  // answer here (still overridable).
  const boardInRunWorkspace = choices.board === "dedicated-workspace"
  const afterWorkspace = await askPlacement(
    io,
    "workspace",
    "Where should run panes and workrooms appear?",
    boardInRunWorkspace
      ? "This changes Herdr presentation only. Your board choice already gives each run its own Herdr workspace."
      : "This changes the Herdr UI destination only; provider cwd and filesystem workspace stay workflow-defined.",
    WORKSPACE_OPTIONS,
    (value) => ({ ...choices, workspace: value }),
    boardInRunWorkspace ? 1 : 0
  )
  if (afterWorkspace === null) {
    io.print(CANCELLED_MESSAGE)
    return
  }
  choices = afterWorkspace
  const afterLayout = await askPlacement(
    io,
    "layout",
    "What goes into one tab?",
    `This applies to ordinary/seatless panes; declared seats stay in their approved workroom. A sub-node is named "parent--sub"; an entry node has no "needs".`,
    LAYOUT_OPTIONS,
    (value) => ({ ...choices, layout: value })
  )
  if (afterLayout === null) {
    io.print(CANCELLED_MESSAGE)
    return
  }
  choices = afterLayout

  // Screen 2 — notifications.
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
  await apply(plan.patch, project)
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
