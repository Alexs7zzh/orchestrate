import { Effect } from "effect"
import { randomBytes } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type {
  AgentNode,
  InteractiveAttemptState,
  NodeRunState,
  RunState,
  SessionState,
  WorkflowSpec
} from "../types.js"
import type { RunStore, StatePersistenceError } from "./run-store.js"

import {
  interactiveContractText,
  interactiveProviderCommand,
  orchestrateBinShellTokens,
  providerEnvironment,
  renderAgentPromptText
} from "../providers.js"
import { emitEventEffect } from "./event-journal.js"
import {
  herdrCliAvailable,
  mirrorInfoPath,
  parseHerdrJson,
  readRecordedWorkspaceId,
  runHerdr,
  stringAt
} from "./mirror.js"
import { terminalNode } from "./scheduler.js"

// Interactive agent nodes run as the provider's real TUI inside a herdr pane.
// Unlike runtime/mirror.ts — which is presentation-only and fire-and-forget —
// herdr is the execution substrate here: spawning, hosting, and killing the
// TUI go through the herdr CLI and a failure fails the attempt. Completion is
// never scraped from the screen; it is signaled exclusively by the prompt
// contract calling `orchestrate node-done` with the attempt's one-time token.

const DONE_POLL_MILLISECONDS = 500

// Idle nudges are display-only, checked every ~30 seconds of done polling.
// The tick count is env-overridable so the bundled tests can exercise the
// nudge without waiting 30 real seconds.
function idlePollTicks(): number {
  const raw = Number(process.env.ORCHESTRATE_INTERACTIVE_IDLE_TICKS)
  return Number.isInteger(raw) && raw > 0 ? raw : 60
}

function now(): string {
  return new Date().toISOString()
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function promiseEffect<A>(operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: operation, catch: asError })
}

export function interactiveDonePath(nodeDir: string): string {
  return path.join(nodeDir, "interactive-done.json")
}

export function interactiveResultPath(nodeDir: string): string {
  return path.join(nodeDir, "result.txt")
}

export function interactivePromptPath(nodeDir: string): string {
  return path.join(nodeDir, "prompt.txt")
}

// The exact node-done command the contract instructs the agent to run,
// without the trailing --outcome value.
export function nodeDoneCommandText(runId: string, nodeId: string, token: string): string {
  return `${orchestrateBinShellTokens().join(" ")} node-done ${runId} ${nodeId} --token ${token}`
}

// Interactive workflow nodes whose run-state is not yet terminal: these are
// the nodes that still (or again) need a herdr pane if the run proceeds.
export function liveInteractiveNodes(
  workflow: WorkflowSpec,
  state: RunState
): readonly AgentNode[] {
  return workflow.nodes.filter(
    (node): node is AgentNode =>
      node.type === "agent" &&
      node.interactive &&
      !terminalNode(state.nodes[node.id]?.status ?? "pending")
  )
}

export interface InteractivePaneRequest {
  readonly label: string
  readonly title: string
  readonly cwd: string
  readonly commandTokens: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface InteractiveHost {
  readonly workspaceId: string
  readonly openPane: (request: InteractivePaneRequest) => Promise<string>
  // Best-effort: used for timeout/stop cleanup; failures are swallowed.
  readonly closePane: (paneId: string) => Promise<void>
  // Best-effort: herdr's view of the pane agent, or null when unavailable.
  readonly agentStatus: (paneId: string) => Promise<string | null>
}

const HERDR_AGENT_STATES: ReadonlySet<string> = new Set([
  "idle",
  "working",
  "blocked",
  "done",
  "unknown"
])

function findAgentState(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of ["status", "state"]) {
    const candidate = record[key]
    if (typeof candidate === "string" && HERDR_AGENT_STATES.has(candidate)) {
      return candidate
    }
  }
  for (const nested of Object.values(record)) {
    const found = findAgentState(nested)
    if (found !== null) {
      return found
    }
  }
  return null
}

// Reuses the run's recorded herdr workspace (shared with --mirror through
// mirror.json) or creates one. Runs before the mirror starts so both use a
// single workspace per run.
async function ensureRunWorkspace(workflow: WorkflowSpec, runDir: string, runId: string) {
  const recorded = await readRecordedWorkspaceId(runDir)
  if (recorded !== null) {
    const stillOpen = await runHerdr(["workspace", "get", recorded]).then(
      () => true,
      () => false
    )
    if (stillOpen) {
      return recorded
    }
  }
  const created = parseHerdrJson(
    await runHerdr([
      "workspace",
      "create",
      "--cwd",
      workflow.cwd,
      "--label",
      `${workflow.name} ${runId}`,
      "--no-focus"
    ])
  )
  const workspaceId = stringAt(created, "result", "workspace", "workspace_id")
  if (workspaceId === null) {
    throw new Error("herdr workspace create returned no workspace id.")
  }
  await writeFile(mirrorInfoPath(runDir), `${JSON.stringify({ workspaceId }, null, 2)}\n`, {
    mode: 0o600
  })
  return workspaceId
}

// Builds the run's interactive host when any non-terminal interactive node
// exists, otherwise null. Failures here fail the run: a workflow with pending
// interactive nodes cannot execute without a usable herdr.
export function createInteractiveHostEffect(
  workflow: WorkflowSpec,
  runDir: string,
  state: RunState
): Effect.Effect<InteractiveHost | null, Error> {
  return Effect.gen(function* () {
    if (liveInteractiveNodes(workflow, state).length === 0) {
      return null
    }
    if (!herdrCliAvailable()) {
      return yield* Effect.fail(
        new Error(
          "This workflow has pending interactive nodes, which run as live TUIs in herdr panes; no usable herdr CLI was found on PATH (https://herdr.dev)."
        )
      )
    }
    const workspaceId = yield* promiseEffect(() => ensureRunWorkspace(workflow, runDir, state.id))
    const host: InteractiveHost = {
      workspaceId,
      openPane: async (request) => {
        const created = parseHerdrJson(
          await runHerdr([
            "tab",
            "create",
            "--workspace",
            workspaceId,
            "--cwd",
            request.cwd,
            "--label",
            request.label,
            "--no-focus",
            ...Object.entries(request.env).flatMap(([key, value]) => ["--env", `${key}=${value}`])
          ])
        )
        const paneId = stringAt(created, "result", "root_pane", "pane_id")
        if (paneId === null) {
          throw new Error("herdr tab create returned no pane id.")
        }
        await runHerdr(["pane", "rename", paneId, request.title]).catch(() => undefined)
        await runHerdr(["pane", "run", paneId, ...request.commandTokens])
        return paneId
      },
      closePane: async (paneId) => {
        await runHerdr(["pane", "close", paneId]).catch(() => undefined)
      },
      agentStatus: async (paneId) => {
        try {
          return findAgentState(parseHerdrJson(await runHerdr(["agent", "get", paneId])))
        } catch {
          return null
        }
      }
    }
    return host
  })
}

export interface InteractiveExecutionRequest {
  readonly workflow: WorkflowSpec
  readonly runDir: string
  readonly store: RunStore
  readonly host: InteractiveHost
  // The execution node (session.reuseOnRepeat already resolved by the engine).
  readonly node: AgentNode
  readonly attempt: number
  readonly nodeDir: string
  readonly cwd: string
  readonly sessions: Readonly<Record<string, SessionState>>
  readonly resultPaths: Readonly<Record<string, string>>
}

export interface InteractiveExecutionResult {
  readonly exitCode: number
  readonly resultText: string
  readonly sessionId: string | null
}

interface DoneRecord {
  readonly outcome: "completed" | "failed"
}

async function readDoneRecord(donePath: string): Promise<DoneRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(donePath, "utf8")) as { readonly outcome?: unknown }
    return { outcome: parsed.outcome === "failed" ? "failed" : "completed" }
  } catch {
    // Missing is the normal pending case; node-done publishes the file with an
    // atomic link so a torn read cannot occur, but stay defensive regardless.
    return null
  }
}

// Spawns the provider TUI in a herdr pane and waits for the prompt contract's
// node-done call. Timeout and stop arrive as fiber interruption from the
// engine; the pane is closed best-effort only then — after a successful or
// failed node-done the pane deliberately stays open so a human can keep using
// the session.
export function executeInteractiveNodeEffect(
  request: InteractiveExecutionRequest
): Effect.Effect<InteractiveExecutionResult, Error | StatePersistenceError> {
  return Effect.gen(function* () {
    const { node, store, host, workflow, runDir } = request
    const runId = (yield* store.read).id
    const token = randomBytes(32).toString("hex")
    const resultPath = interactiveResultPath(request.nodeDir)
    const promptPath = interactivePromptPath(request.nodeDir)
    const donePath = interactiveDonePath(request.nodeDir)
    const rendered = yield* promiseEffect(() => renderAgentPromptText(node, request.resultPaths))
    const contract = interactiveContractText({
      runId,
      nodeId: node.id,
      resultPath,
      doneCommand: nodeDoneCommandText(runId, node.id, token)
    })
    yield* promiseEffect(() =>
      writeFile(promptPath, `${rendered}\n\n${contract}\n`, { mode: 0o600 })
    )
    const command = interactiveProviderCommand(node, promptPath, request.sessions)

    const updateRecord = (
      mutate: (current: InteractiveAttemptState) => InteractiveAttemptState | null
    ): Effect.Effect<RunState, StatePersistenceError> =>
      store.update((current) => {
        const nodeState = current.nodes[node.id] as NodeRunState
        const record = nodeState.interactive ?? null
        // Guard against a stale fiber touching a newer attempt's record.
        if (record === null || record.token !== token) {
          return current
        }
        return {
          ...current,
          nodes: {
            ...current.nodes,
            [node.id]: { ...nodeState, interactive: mutate(record) }
          }
        }
      })

    yield* store.update((current) => ({
      ...current,
      nodes: {
        ...current.nodes,
        [node.id]: {
          ...(current.nodes[node.id] as NodeRunState),
          interactive: {
            token,
            paneId: null,
            attempt: request.attempt,
            startedAt: now(),
            idleSince: null
          }
        }
      }
    }))

    const paneId = yield* promiseEffect(() =>
      host.openPane({
        label: request.attempt === 1 ? node.id : `${node.id} #${request.attempt}`,
        title: `${node.id}: ${node.title}`.slice(0, 80),
        cwd: request.cwd,
        commandTokens: command.tokens,
        env: providerEnvironment(node.permissions)
      })
    )
    const startedState = yield* updateRecord((record) => ({ ...record, paneId }))
    yield* emitEventEffect(
      workflow,
      runDir,
      startedState,
      "node.interactive.started",
      `Interactive node "${node.id}" attempt ${request.attempt} started in herdr pane ${paneId}; it completes only via node-done.`,
      node.id,
      { paneId },
      workflow.heartbeat.milestones
    )

    // Best-effort idle nudge: journal ONE node.interactive.idle event per
    // continuous idle period and fire the callback. herdr failures and journal
    // failures are swallowed; only state persistence failures propagate.
    const idlePoll = Effect.gen(function* () {
      const status = yield* Effect.promise(() => host.agentStatus(paneId))
      const current = (yield* store.read).nodes[node.id]?.interactive ?? null
      if (current === null || current.token !== token) {
        return
      }
      if (status === "idle" || status === "blocked") {
        if (current.idleSince === null) {
          const nudged = yield* updateRecord((record) => ({ ...record, idleSince: now() }))
          yield* Effect.ignore(
            emitEventEffect(
              workflow,
              runDir,
              nudged,
              "node.interactive.idle",
              `Interactive node "${node.id}" looks ${status} in herdr pane ${paneId} with no node-done call yet. A human can join the pane and finish it, or complete it directly: ${nodeDoneCommandText(runId, node.id, token)} --outcome completed`,
              node.id,
              { paneId, status },
              true
            )
          )
        }
      } else if (status === "working" && current.idleSince !== null) {
        yield* updateRecord((record) => ({ ...record, idleSince: null }))
      }
    })

    const waitForDone = Effect.gen(function* () {
      const idleEvery = idlePollTicks()
      let ticks = 0
      for (;;) {
        yield* Effect.sleep(DONE_POLL_MILLISECONDS)
        const done = yield* promiseEffect(() => readDoneRecord(donePath))
        if (done !== null) {
          yield* updateRecord(() => null)
          if (done.outcome === "completed") {
            const resultText = yield* promiseEffect(() => readFile(resultPath, "utf8"))
            return {
              exitCode: 0,
              resultText,
              sessionId: command.sessionId
            } satisfies InteractiveExecutionResult
          }
          return yield* Effect.fail(
            new Error(
              `Interactive node "${node.id}" was reported failed via node-done; the report at ${resultPath} explains why.`
            )
          )
        }
        ticks += 1
        if (ticks % idleEvery === 0) {
          yield* idlePoll
        }
      }
    })

    // Interruption means timeout, stop, or pause-time cancellation from the
    // engine: kill the pane best-effort. Normal completion or a failed
    // node-done outcome leaves the pane open by design.
    return yield* Effect.onInterrupt(waitForDone, () =>
      Effect.ignore(promiseEffect(() => host.closePane(paneId)))
    )
  })
}
