import { spawn, spawnSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { RunState, WorkflowNode, WorkflowSpec } from "../types.js"

import { shellQuote } from "../providers.js"
import { appendEvent } from "../state.js"

// Presentation-only mirroring of a run into herdr panes. Nothing in this
// module may influence scheduling, state, digests, or run outcome: every
// herdr call is best-effort, bounded by a short timeout, fired-and-forgotten
// off the worker's critical path, and any failure is journaled once and then
// ignored.

const DEFAULT_TIMEOUT_MILLISECONDS = 3_000
const MAX_CONSECUTIVE_FAILURES = 3

export function mirrorDisabled(): boolean {
  return process.env.ORCHESTRATE_DISABLE_MIRROR === "1"
}

export function mirrorRequestedByEnvironment(): boolean {
  return process.env.ORCHESTRATE_MIRROR === "herdr"
}

function mirrorTimeoutMilliseconds(): number {
  const raw = Number(process.env.ORCHESTRATE_MIRROR_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MILLISECONDS
}

export function mirrorInfoPath(runDir: string): string {
  return path.join(runDir, "mirror.json")
}

export function herdrCliAvailable(): boolean {
  const probe = spawnSync("herdr", ["--version"], {
    stdio: "ignore",
    timeout: mirrorTimeoutMilliseconds(),
    // Explicit so the live process environment (and its PATH) always wins
    // over any runtime-startup snapshot.
    env: process.env
  })
  return probe.error === undefined && probe.status === 0
}

// Runs one herdr CLI call with a hard timeout. In-flight calls may hold the
// worker's event loop briefly after the run settles so trailing panes still
// open; that tail is bounded by the timeout per call plus the consecutive-
// failure fuse, and it never delays the run's own settled state.
// Also reused by runtime/interactive.ts, where — unlike mirroring — a failure
// is propagated to the caller because herdr is the execution substrate there.
export function runHerdr(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn("herdr", args, { stdio: ["ignore", "pipe", "ignore"], env: process.env })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let stdout = ""
    let settled = false
    const finish = (error: Error | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error === null) {
        resolve(stdout)
      } else {
        reject(error)
      }
    }
    const timer = setTimeout(() => {
      finish(new Error(`herdr ${args.slice(0, 2).join(" ")} timed out.`))
      child.kill("SIGKILL")
    }, mirrorTimeoutMilliseconds())
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      finish(error)
    })
    child.on("close", (code) => {
      finish(code === 0 ? null : new Error(`herdr ${args.slice(0, 2).join(" ")} exited ${code}.`))
    })
  })
}

export function parseHerdrJson(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout) as unknown
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function stringAt(value: unknown, ...keys: readonly string[]): string | null {
  let cursor: unknown = value
  for (const key of keys) {
    if (cursor === null || typeof cursor !== "object") {
      return null
    }
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return typeof cursor === "string" ? cursor : null
}

export async function readRecordedWorkspaceId(runDir: string): Promise<string | null> {
  try {
    const info = JSON.parse(await readFile(mirrorInfoPath(runDir), "utf8")) as unknown
    return stringAt(info, "workspaceId")
  } catch {
    return null
  }
}

// Closes the run's mirror workspace, used by `orchestrate clean`. Best-effort:
// a missing mirror.json, dead server, or absent herdr CLI is silently ignored.
export async function closeMirrorWorkspace(runDir: string): Promise<void> {
  if (mirrorDisabled()) {
    return
  }
  const workspaceId = await readRecordedWorkspaceId(runDir)
  if (workspaceId === null) {
    return
  }
  await runHerdr(["workspace", "close", workspaceId]).catch(() => undefined)
}

export interface RunMirror {
  readonly runStarted: () => void
  readonly nodeAttemptStarted: (node: WorkflowNode, attempt: number) => void
}

// Returns the run's mirror when the run recorded mirroring and it is not hard
// disabled, otherwise null. All returned methods are synchronous fire-and-
// forget: they enqueue best-effort herdr calls on an internal promise chain
// (which preserves ordering: workspace before panes) and never throw.
export function createRunMirror(
  workflow: WorkflowSpec,
  runDir: string,
  state: RunState
): RunMirror | null {
  if ((state.mirror ?? null) !== "herdr" || mirrorDisabled()) {
    return null
  }
  const runId = state.id
  let queue: Promise<void> = Promise.resolve()
  let consecutiveFailures = 0
  let dead = false
  let failureJournaled = false
  let workspaceId: string | null = null

  const journalFailure = async (cause: unknown): Promise<void> => {
    if (failureJournaled) {
      return
    }
    failureJournaled = true
    const message = cause instanceof Error ? cause.message : String(cause)
    await appendEvent(runDir, {
      timestamp: new Date().toISOString(),
      runId,
      type: "mirror.degraded",
      message: `herdr mirroring is degraded and stays best-effort; the run is unaffected: ${message}`
    }).catch(() => undefined)
  }

  const runAfter = async (
    previous: Promise<void>,
    operation: () => Promise<void>
  ): Promise<void> => {
    await previous
    if (dead) {
      return
    }
    try {
      await operation()
      consecutiveFailures = 0
    } catch (error) {
      consecutiveFailures += 1
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        dead = true
      }
      await journalFailure(error)
    }
  }

  const enqueue = (operation: () => Promise<void>): void => {
    // Serialized so the workspace exists before panes; runAfter never rejects.
    queue = runAfter(queue, operation)
  }

  const openCommandPane = async (
    label: string,
    paneTitle: string,
    commandTokens: readonly string[],
    environment: Readonly<Record<string, string>> = {}
  ): Promise<void> => {
    if (workspaceId === null) {
      throw new Error("The mirror workspace is unavailable.")
    }
    const created = parseHerdrJson(
      await runHerdr([
        "tab",
        "create",
        "--workspace",
        workspaceId,
        "--cwd",
        workflow.cwd,
        "--label",
        label,
        "--no-focus",
        ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`])
      ])
    )
    const paneId = stringAt(created, "result", "root_pane", "pane_id")
    if (paneId === null) {
      throw new Error("herdr tab create returned no pane id.")
    }
    await runHerdr(["pane", "rename", paneId, paneTitle])
    await runHerdr(["pane", "run", paneId, ...commandTokens])
  }

  // The runtime that hosts this worker also provides the `watch` command the
  // status pane runs, so mirroring works without an installed symlink.
  const orchestrateTokens = [process.execPath, process.argv[1] ?? ""]
    .filter((part) => part.length > 0)
    .map(shellQuote)

  return {
    runStarted: () => {
      enqueue(async () => {
        const recorded = await readRecordedWorkspaceId(runDir)
        if (
          recorded !== null &&
          (await runHerdr(["workspace", "get", recorded]).then(
            () => true,
            () => false
          ))
        ) {
          // A resumed run reuses its earlier mirror workspace when it is
          // still open instead of accumulating one workspace per resume.
          workspaceId = recorded
        } else {
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
          workspaceId = stringAt(created, "result", "workspace", "workspace_id")
          if (workspaceId === null) {
            throw new Error("herdr workspace create returned no workspace id.")
          }
          await writeFile(mirrorInfoPath(runDir), `${JSON.stringify({ workspaceId }, null, 2)}\n`, {
            mode: 0o600
          })
        }
        // The pane's shell does not inherit the worker's environment, so the
        // run's state root travels explicitly for the watch command.
        await openCommandPane("status", `status ${runId}`, [...orchestrateTokens, "watch", runId], {
          ORCHESTRATE_STATE_DIR: path.dirname(path.dirname(runDir))
        })
      })
    },
    nodeAttemptStarted: (node: WorkflowNode, attempt: number) => {
      enqueue(async () => {
        const stdoutPath = path.join(runDir, "nodes", node.id, `attempt-${attempt}`, "stdout.log")
        const label = attempt === 1 ? node.id : `${node.id} #${attempt}`
        await openCommandPane(label, `${node.id}: ${node.title}`.slice(0, 80), [
          "tail",
          "-n",
          "+1",
          "-F",
          shellQuote(stdoutPath)
        ])
      })
    }
  }
}
