import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { LiveDoctorSurface } from "../src/doctor.js"
import type { SpawnRequest } from "../src/herdr-surface.js"
import type { PaneReference, WorkflowSpec } from "../src/types.js"

import { digestWorkflow } from "../src/digest.js"
import {
  closeLiveDoctorPanes,
  matchesLiveDoctorResult,
  quiesceLiveDoctorRun
} from "../src/doctor.js"
import { DEFAULT_UI_PREFERENCES } from "../src/preferences.js"
import { persistNewRun, readRunState, runtimeBuild } from "../src/state.js"
import { createInitialRunState, transition, type TransitionContext } from "../src/transition.js"

const NOW = "2026-08-07T12:00:00.000Z"
const RUN_ID = "20260807120000-d0c70001"
const TOKEN = "d".repeat(64)

let temporary = ""
let previousState: string | undefined

function workflow(): WorkflowSpec {
  return {
    name: "live-doctor-shutdown-test",
    objective: "Verify failure-path pane shutdown.",
    cwd: temporary,
    concurrency: 1,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: 1 },
    writeConflicts: "reject",
    nodes: [
      {
        id: "probe",
        type: "agent",
        title: "Probe",
        needs: [],
        cwd: null,
        workspace: {
          mode: "existing",
          path: temporary,
          vcs: "none",
          writes: [],
          exclusiveResources: []
        },
        inputs: [],
        retry: { maxAttempts: 1 },
        gate: "none",
        provider: "codex",
        model: "provider-default",
        effort: null,
        prompt: "Wait for shutdown.",
        session: { mode: "fresh", from: null, saveAs: null },
        permissions: {
          access: "read-only",
          escalation: "deny",
          extraArgs: [],
          inheritEnv: [],
          env: {}
        },
        output: { format: "text", schema: null }
      }
    ],
    repeats: []
  }
}

class DiagnosticSurface implements LiveDoctorSurface {
  readonly livePanes = new Set<string>()
  closeCalls = 0

  async connect(): Promise<void> {}

  async recoverOrSpawn(_request: SpawnRequest): Promise<{
    readonly pane: PaneReference
    readonly providerSessionId: string | null
  }> {
    throw new Error("quiescence must not spawn")
  }

  async closePane(paneId: string): Promise<void> {
    this.closeCalls += 1
    this.livePanes.delete(paneId)
  }

  async paneExists(paneId: string): Promise<boolean> {
    return this.livePanes.has(paneId)
  }

  async notify(): Promise<void> {}
}

beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "orchestrate-doctor-test-"))
  previousState = process.env.ORCHESTRATE_STATE_DIR
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporary, "state")
})

afterEach(async () => {
  if (previousState === undefined) {
    delete process.env.ORCHESTRATE_STATE_DIR
  } else {
    process.env.ORCHESTRATE_STATE_DIR = previousState
  }
  await rm(temporary, { recursive: true, force: true })
})

describe("live doctor lifecycle", () => {
  test("accepts a probe token with ordinary result-file whitespace only", () => {
    expect(matchesLiveDoctorResult("CODEX-LIVE-OK\n", "CODEX-LIVE-OK")).toBe(true)
    expect(matchesLiveDoctorResult("  CODEX-LIVE-OK\r\n", "CODEX-LIVE-OK")).toBe(true)
    expect(matchesLiveDoctorResult("CODEX-LIVE-OK\nextra", "CODEX-LIVE-OK")).toBe(false)
    expect(matchesLiveDoctorResult({ token: "CODEX-LIVE-OK" }, "CODEX-LIVE-OK")).toBe(false)
  })

  test("stops an active retained run and confirms its exact pane is absent", async () => {
    const spec = workflow()
    const prepared: TransitionContext = {
      prepareNode: () => ({
        token: TOKEN,
        resultPath: path.join(temporary, "result.txt"),
        outputPath: path.join(temporary, "output.txt"),
        gate: null
      })
    }
    const initial = createInitialRunState(spec, {
      id: RUN_ID,
      runtimeVersion: runtimeBuild(),
      digest: digestWorkflow(spec),
      now: NOW,
      origin: null
    })
    const started = transition(initial, spec, { type: "run" }, NOW, prepared)
    const observed = transition(
      started.state,
      spec,
      {
        type: "spawn-observed",
        nodeId: "probe",
        intentId: "probe:a1",
        pane: {
          workspaceId: "doctor-workspace",
          tabId: "doctor-tab",
          paneId: "doctor-pane",
          group: "probe",
          surface: "tab"
        },
        providerSessionId: null
      },
      NOW
    )
    const runDir = await persistNewRun(spec, DEFAULT_UI_PREFERENCES, observed.state, [
      ...started.events,
      ...observed.events
    ])
    const surface = new DiagnosticSurface()
    surface.livePanes.add("doctor-pane")

    const finalState = await quiesceLiveDoctorRun(runDir, observed.state, surface)

    expect(finalState?.status).toBe("stopped")
    expect((await readRunState(runDir)).status).toBe("stopped")
    expect(surface.livePanes.size).toBe(0)
    expect(surface.closeCalls).toBeGreaterThanOrEqual(1)
  })

  test("retries and surfaces an unconfirmed pane shutdown", async () => {
    let attempts = 0
    await expect(
      closeLiveDoctorPanes(new Set(["stuck-pane"]), {
        async closePane() {
          attempts += 1
          throw new Error("Herdr unavailable")
        },
        async paneExists() {
          return true
        }
      })
    ).rejects.toThrow("Could not stop live diagnostic pane(s): stuck-pane")
    expect(attempts).toBe(3)
  })
})
