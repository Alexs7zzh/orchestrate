import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  CallbackCommand,
  CallbackWebhook,
  EventRecord,
  EventType,
  UiPreferences,
  WorkflowSpec
} from "../src/types.js"

import {
  EVENT_SEVERITIES,
  classifyEvent,
  dispatchEventNotification,
  milestoneCallback,
  routeNotification,
  type CallbackEffects,
  type NotificationSound
} from "../src/notifications.js"
import { DEFAULT_UI_PREFERENCES } from "../src/preferences.js"

const ALL_EVENT_TYPES = [
  "run.started",
  "run.paused",
  "run.resumed",
  "run.completed",
  "run.failed",
  "run.stopped",
  "node.ready",
  "node.spawn-planned",
  "node.started",
  "node.completed",
  "node.skipped",
  "node.failed",
  "node.retrying",
  "node.cancelled",
  "gate.opened",
  "gate.approved",
  "hold.set",
  "hold.released",
  "revision.proposed",
  "revision.approved",
  "revision.discarded",
  "repeat.round-started",
  "repeat.completed",
  "repeat.max-rounds",
  "ui.degraded"
] as const satisfies readonly EventType[]

function event(type: EventType): EventRecord {
  return {
    runtimeVersion: "test-build",
    sequence: 1,
    timestamp: "2026-08-02T00:00:00.000Z",
    runId: "run-1",
    type,
    message: `Event ${type}`,
    patch: []
  }
}

function workflow(
  callback: WorkflowSpec["callback"] = { type: "none" },
  milestones = true
): WorkflowSpec {
  return {
    name: "notification-test",
    objective: "Exercise notifications.",
    cwd: "/tmp",
    concurrency: 1,
    callback,
    milestones,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes: [],
    repeats: []
  }
}

function preferences(notifications: UiPreferences["notifications"]): UiPreferences {
  return { ...DEFAULT_UI_PREFERENCES, notifications }
}

describe("event severity", () => {
  test("classifies the complete runtime event vocabulary", () => {
    expect(Object.keys(EVENT_SEVERITIES).toSorted()).toEqual(ALL_EVENT_TYPES.toSorted())
    expect(ALL_EVENT_TYPES.map(classifyEvent)).toEqual(
      ALL_EVENT_TYPES.map((type) => EVENT_SEVERITIES[type])
    )
  })

  test("assigns attention, milestone, and progress events", () => {
    expect(classifyEvent("gate.opened")).toBe("attention")
    expect(classifyEvent("repeat.max-rounds")).toBe("attention")
    expect(classifyEvent("node.completed")).toBe("milestone")
    expect(classifyEvent("repeat.completed")).toBe("milestone")
    expect(classifyEvent("node.spawn-planned")).toBe("progress")
    expect(classifyEvent("node.skipped")).toBe("progress")
    expect(classifyEvent("ui.degraded")).toBe("progress")
  })
})

describe("notification routing", () => {
  test("uses default channels and severity sounds", () => {
    expect(routeNotification("run.failed", DEFAULT_UI_PREFERENCES)).toEqual({
      severity: "attention",
      channel: "herdr",
      sound: "request"
    })
    expect(routeNotification("node.completed", DEFAULT_UI_PREFERENCES)).toEqual({
      severity: "milestone",
      channel: "herdr",
      sound: "done"
    })
    expect(routeNotification("node.started", DEFAULT_UI_PREFERENCES)).toEqual({
      severity: "progress",
      channel: "board",
      sound: "none"
    })
  })

  test("honors board and silent preference routes", async () => {
    const calls: unknown[] = []
    const presenter = {
      notify: async (...args: readonly unknown[]) => {
        calls.push(args)
      }
    }
    const ui = preferences({ attention: "silent", milestone: "board", progress: "silent" })

    expect((await dispatchEventNotification(event("run.failed"), ui, presenter)).presentation).toBe(
      "silent"
    )
    expect(
      (await dispatchEventNotification(event("node.completed"), ui, presenter)).presentation
    ).toBe("board")
    expect(calls).toEqual([])
  })
})

describe("notification dispatch", () => {
  test("sends attention and milestone sounds through the presenter", async () => {
    const calls: Array<readonly [string, string, NotificationSound]> = []
    const presenter = {
      notify: async (title: string, body: string, sound: NotificationSound) => {
        calls.push([title, body, sound])
      }
    }

    const attention = await dispatchEventNotification(
      event("revision.proposed"),
      DEFAULT_UI_PREFERENCES,
      presenter
    )
    const milestone = await dispatchEventNotification(
      event("run.completed"),
      DEFAULT_UI_PREFERENCES,
      presenter
    )

    expect(attention.presentation).toBe("delivered")
    expect(milestone.presentation).toBe("delivered")
    expect(calls.map((call) => call[2])).toEqual(["request", "done"])
  })

  test("treats a dead presentation surface as best effort", async () => {
    const result = await dispatchEventNotification(event("run.failed"), DEFAULT_UI_PREFERENCES, {
      notify: async () => Promise.reject(new Error("herdr is unavailable"))
    })

    expect(result.presentation).toBe("failed")
    expect(result.errors).toEqual(["herdr is unavailable"])
  })
})

describe("milestone callbacks", () => {
  test("selects callbacks only for enabled milestone events", () => {
    const configured = workflow({ type: "notification" })
    expect(milestoneCallback(configured, event("node.completed"))?.type).toBe("notification")
    expect(milestoneCallback(configured, event("run.failed"))).toBeNull()
    expect(
      milestoneCallback(workflow({ type: "notification" }, false), event("run.completed"))
    ).toBeNull()
  })

  test("routes notification callbacks through herdr and deduplicates presentation delivery", async () => {
    const calls: Array<readonly [string, string, NotificationSound]> = []
    const presenter = {
      notify: async (title: string, body: string, sound: NotificationSound) => {
        calls.push([title, body, sound])
      }
    }
    const callbackWorkflow = workflow({ type: "notification" })

    const silentPresentation = await dispatchEventNotification(
      event("node.completed"),
      preferences({ attention: "silent", milestone: "silent", progress: "silent" }),
      presenter,
      callbackWorkflow
    )
    const sharedPresentation = await dispatchEventNotification(
      event("run.completed"),
      DEFAULT_UI_PREFERENCES,
      presenter,
      callbackWorkflow
    )

    expect(silentPresentation).toMatchObject({ presentation: "silent", callback: "delivered" })
    expect(sharedPresentation).toMatchObject({ presentation: "delivered", callback: "delivered" })
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call[2] === "done")).toBe(true)
  })

  test("callback payloads exclude the internal state patch", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "orchestrate-notifications-"))
    const target = path.join(directory, "payload.json")
    const record = event("node.completed")
    const result = await dispatchEventNotification(
      record,
      preferences({ attention: "silent", milestone: "silent", progress: "silent" }),
      { notify: async () => undefined },
      workflow({
        type: "command",
        argv: ["/bin/sh", "-c", `printf %s "$0" > ${target}`, "{{event}}"],
        timeoutSeconds: 5
      })
    )
    expect(result.callback).toBe("delivered")
    const payload = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>
    expect(payload["patch"]).toBeUndefined()
    expect(payload["type"]).toBe("node.completed")
    expect(payload["runId"]).toBe(record.runId)
  })

  test("dispatches command and webhook callbacks without surfacing their failures", async () => {
    const calls: string[] = []
    const effects: CallbackEffects = {
      command: async (callback: CallbackCommand) => {
        calls.push(callback.type)
        throw new Error("command delivery failed")
      },
      webhook: async (callback: CallbackWebhook) => {
        calls.push(callback.type)
      }
    }
    const presenter = { notify: async () => undefined }
    const silent = preferences({ attention: "silent", milestone: "silent", progress: "silent" })

    const command = await dispatchEventNotification(
      event("node.completed"),
      silent,
      presenter,
      workflow({ type: "command", argv: ["/bin/true"], timeoutSeconds: 1 }),
      effects
    )
    const webhook = await dispatchEventNotification(
      event("run.completed"),
      silent,
      presenter,
      workflow({ type: "webhook", url: "https://example.test", headers: {}, timeoutSeconds: 1 }),
      effects
    )

    expect(command).toMatchObject({ callback: "failed", errors: ["command delivery failed"] })
    expect(webhook).toMatchObject({ callback: "delivered", errors: [] })
    expect(calls).toEqual(["command", "webhook"])
  })
})
