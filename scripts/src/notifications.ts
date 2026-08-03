import { spawn } from "node:child_process"

import type {
  CallbackCommand,
  CallbackSpec,
  CallbackWebhook,
  EventRecord,
  EventSeverity,
  EventType,
  NotificationChannel,
  UiPreferences,
  WorkflowSpec
} from "./types.js"

export const EVENT_SEVERITIES = {
  "run.started": "progress",
  "run.paused": "milestone",
  "run.resumed": "progress",
  "run.completed": "milestone",
  "run.failed": "attention",
  "run.stopped": "milestone",
  "node.ready": "progress",
  "node.spawn-planned": "progress",
  "node.started": "progress",
  "node.completed": "milestone",
  "node.failed": "milestone",
  "node.retrying": "milestone",
  "node.cancelled": "milestone",
  "gate.opened": "attention",
  "gate.approved": "progress",
  "hold.set": "progress",
  "hold.released": "progress",
  "revision.proposed": "attention",
  "revision.approved": "progress",
  "revision.discarded": "progress",
  "repeat.round-started": "progress",
  "repeat.completed": "milestone",
  "repeat.max-rounds": "attention",
  "ui.degraded": "progress"
} as const satisfies Readonly<Record<EventType, EventSeverity>>

export type NotificationSound = "none" | "done" | "request"

export interface NotificationRoute {
  readonly severity: EventSeverity
  readonly channel: NotificationChannel
  readonly sound: NotificationSound
}

export interface NotificationPresenter {
  notify(title: string, body: string, sound: NotificationSound): Promise<void>
}

export interface CallbackEffects {
  command(callback: CallbackCommand, workflow: WorkflowSpec, event: EventRecord): Promise<void>
  webhook(callback: CallbackWebhook, event: EventRecord): Promise<void>
}

export type PresentationDispatch = "delivered" | "board" | "silent" | "failed"
export type CallbackDispatch = "not-requested" | "delivered" | "failed"

export interface NotificationDispatchResult extends NotificationRoute {
  readonly presentation: PresentationDispatch
  readonly callback: CallbackDispatch
  readonly errors: readonly string[]
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function classifyEvent(type: EventType): EventSeverity {
  return EVENT_SEVERITIES[type]
}

export function soundForSeverity(severity: EventSeverity): NotificationSound {
  const sounds = {
    attention: "request",
    milestone: "done",
    progress: "none"
  } as const satisfies Readonly<Record<EventSeverity, NotificationSound>>
  return sounds[severity]
}

export function routeNotification(type: EventType, preferences: UiPreferences): NotificationRoute {
  const severity = classifyEvent(type)
  return {
    severity,
    channel: preferences.notifications[severity],
    sound: soundForSeverity(severity)
  }
}

export function milestoneCallback(
  workflow: WorkflowSpec | null,
  event: EventRecord
): Exclude<CallbackSpec, { readonly type: "none" }> | null {
  if (
    workflow === null ||
    !workflow.milestones ||
    classifyEvent(event.type) !== "milestone" ||
    workflow.callback.type === "none"
  ) {
    return null
  }
  return workflow.callback
}

function callbackPayload(event: EventRecord): string {
  // The RFC 6902 patch is internal replay detail and can embed node result content;
  // external callbacks receive event metadata only.
  const { patch: _patch, ...payload } = event
  return JSON.stringify(payload)
}

function expandCallbackArgument(argument: string, event: EventRecord): string {
  return argument
    .replaceAll("{{event}}", callbackPayload(event))
    .replaceAll("{{runId}}", event.runId)
}

async function runCallbackCommand(
  callback: CallbackCommand,
  workflow: WorkflowSpec,
  event: EventRecord
): Promise<void> {
  const argv = callback.argv.map((argument) => expandCallbackArgument(argument, event))
  const [executable, ...args] = argv
  if (executable === undefined) {
    throw new Error("Callback command has no executable.")
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workflow.cwd,
      env: process.env,
      stdio: "ignore"
    })
    let settled = false
    const finish = (result: Error | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (result === null) {
        resolve()
      } else {
        reject(result)
      }
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(new Error(`Callback command timed out after ${callback.timeoutSeconds} seconds.`))
    }, callback.timeoutSeconds * 1_000)
    timer.unref()
    child.on("error", (error) => {
      finish(error)
    })
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null)
      } else {
        finish(
          new Error(
            signal === null
              ? `Callback command exited with ${code}.`
              : `Callback command was killed by ${signal}.`
          )
        )
      }
    })
  })
}

async function postCallbackWebhook(callback: CallbackWebhook, event: EventRecord): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, callback.timeoutSeconds * 1_000)
  timer.unref()
  try {
    const response = await fetch(callback.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...callback.headers },
      body: callbackPayload(event),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`Callback webhook returned HTTP ${response.status}.`)
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Callback webhook timed out after ${callback.timeoutSeconds} seconds.`, {
        cause: error
      })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const DEFAULT_CALLBACK_EFFECTS: CallbackEffects = {
  command: runCallbackCommand,
  webhook: postCallbackWebhook
}

function notificationTitle(workflow: WorkflowSpec | null, event: EventRecord): string {
  return `${workflow?.name ?? "Orchestrate"} · ${event.type}`
}

export async function dispatchEventNotification(
  event: EventRecord,
  preferences: UiPreferences,
  presenter: NotificationPresenter,
  workflow: WorkflowSpec | null = null,
  callbackEffects: CallbackEffects = DEFAULT_CALLBACK_EFFECTS
): Promise<NotificationDispatchResult> {
  const route = routeNotification(event.type, preferences)
  const callback = milestoneCallback(workflow, event)
  const wantsPresentation = route.channel === "herdr"
  const wantsCallbackNotification = callback?.type === "notification"
  let presentation: PresentationDispatch = route.channel === "herdr" ? "failed" : route.channel
  let callbackResult: CallbackDispatch = callback === null ? "not-requested" : "delivered"
  const errors: string[] = []

  if (wantsPresentation || wantsCallbackNotification) {
    try {
      await presenter.notify(notificationTitle(workflow, event), event.message, route.sound)
      if (wantsPresentation) {
        presentation = "delivered"
      }
    } catch (error) {
      const message = asError(error).message
      errors.push(message)
      if (wantsPresentation) {
        presentation = "failed"
      }
      if (wantsCallbackNotification) {
        callbackResult = "failed"
      }
    }
  }

  if (workflow !== null && (callback?.type === "command" || callback?.type === "webhook")) {
    try {
      if (callback.type === "command") {
        await callbackEffects.command(callback, workflow, event)
      } else {
        await callbackEffects.webhook(callback, event)
      }
    } catch (error) {
      errors.push(asError(error).message)
      callbackResult = "failed"
    }
  }

  return {
    ...route,
    presentation,
    callback: callbackResult,
    errors
  }
}
