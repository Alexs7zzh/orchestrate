import { Effect } from "effect"
import path from "node:path"

import type { EventRecord, RunState, WorkflowSpec } from "../types.js"

import { runProcessEffect } from "../process.js"
import { appendEvent } from "../state.js"

function now(): string {
  return new Date().toISOString()
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function promiseEffect<A>(operation: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({ try: operation, catch: asError })
}

export function desktopNotificationArgv(message: string): readonly string[] {
  return process.platform === "darwin"
    ? [
        "osascript",
        "-e",
        `display notification ${JSON.stringify(message)} with title "Orchestrate"`
      ]
    : ["notify-send", "Orchestrate", message]
}

function deliverCallbackEffect(
  workflow: WorkflowSpec,
  runDir: string,
  event: EventRecord
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const callback = workflow.heartbeat.callback
    if (callback.type === "none") {
      return
    }
    const payload = JSON.stringify(event)
    if (callback.type === "webhook") {
      const response = yield* Effect.raceFirst(
        Effect.tryPromise({
          try: (signal) =>
            fetch(callback.url, {
              method: "POST",
              headers: { "content-type": "application/json", ...callback.headers },
              body: payload,
              signal
            }),
          catch: asError
        }),
        Effect.andThen(
          Effect.sleep(callback.timeoutSeconds * 1000),
          Effect.fail(
            new Error(`Callback webhook timed out after ${callback.timeoutSeconds} seconds.`)
          )
        )
      )
      if (!response.ok) {
        yield* Effect.fail(new Error(`Callback webhook returned HTTP ${response.status}.`))
      }
      return
    }
    const argv =
      callback.type === "command"
        ? callback.argv.map((part) =>
            part.replaceAll("{{event}}", payload).replaceAll("{{runId}}", event.runId)
          )
        : desktopNotificationArgv(event.message)
    const result = yield* runProcessEffect({
      argv,
      cwd: workflow.cwd,
      stdoutPath: path.join(runDir, "callback.log"),
      stderrPath: path.join(runDir, "callback-error.log"),
      timeoutMinutes: callback.type === "command" ? callback.timeoutSeconds / 60 : 1
    })
    if (result.exitCode !== 0) {
      yield* Effect.fail(new Error(`Callback command exited with ${result.exitCode}.`))
    }
  })
}

export function appendEventEffect(
  runDir: string,
  state: RunState,
  type: string,
  message: string,
  nodeId?: string,
  data?: unknown
): Effect.Effect<EventRecord, Error> {
  const event: EventRecord = {
    timestamp: now(),
    runId: state.id,
    type,
    message,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(data === undefined ? {} : { data })
  }
  return Effect.as(
    promiseEffect(() => appendEvent(runDir, event)),
    event
  )
}

export function deliverRecordedCallbackEffect(
  workflow: WorkflowSpec,
  runDir: string,
  event: EventRecord
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const result = yield* Effect.match(deliverCallbackEffect(workflow, runDir, event), {
      onFailure: (error) => error,
      onSuccess: () => null
    })
    if (result !== null) {
      yield* promiseEffect(() =>
        appendEvent(runDir, {
          timestamp: now(),
          runId: event.runId,
          type: "callback.failed",
          message: result.message
        })
      )
    }
  })
}

export function emitEventEffect(
  workflow: WorkflowSpec,
  runDir: string,
  state: RunState,
  type: string,
  message: string,
  nodeId?: string,
  data?: unknown,
  callback = false
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const event = yield* appendEventEffect(runDir, state, type, message, nodeId, data)
    if (callback) {
      yield* deliverRecordedCallbackEffect(workflow, runDir, event)
    }
  })
}

export function emitEvent(
  workflow: WorkflowSpec,
  runDir: string,
  state: RunState,
  type: string,
  message: string,
  nodeId?: string,
  data?: unknown,
  callback = false
): Promise<void> {
  return Effect.runPromise(
    emitEventEffect(workflow, runDir, state, type, message, nodeId, data, callback)
  )
}
