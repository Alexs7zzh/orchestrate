import { Deferred, Effect } from "effect"
import { readFile, rm } from "node:fs/promises"

import { pauseRequestPath, stopRequestPath } from "../state.js"

function requestMatchesWorkerEffect(
  requestPath: string,
  workerToken: string
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const result = yield* Effect.match(
      Effect.tryPromise({
        try: () => readFile(requestPath, "utf8"),
        catch: (error) => error as NodeJS.ErrnoException
      }),
      {
        onFailure: (error) => ({ tag: "Failure" as const, error }),
        onSuccess: (raw) => ({ tag: "Success" as const, raw })
      }
    )
    if (result.tag === "Failure") {
      // An unreadable request is treated as current and safe: stop or pause is
      // preferable to silently continuing after the operator requested control.
      return result.error.code !== "ENOENT"
    }
    try {
      const request = JSON.parse(result.raw) as { readonly workerToken?: unknown }
      return request.workerToken === workerToken
    } catch {
      return true
    }
  })
}

export function pollControlRequestsEffect(
  runDir: string,
  workerToken: string,
  stopSignal: Deferred.Deferred<void>,
  pauseSignal: Deferred.Deferred<void>
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (yield* requestMatchesWorkerEffect(stopRequestPath(runDir), workerToken)) {
      Deferred.doneUnsafe(stopSignal, Effect.succeed(undefined))
    }
    if (yield* requestMatchesWorkerEffect(pauseRequestPath(runDir), workerToken)) {
      Deferred.doneUnsafe(pauseSignal, Effect.succeed(undefined))
    }
  })
}

export function removeControlRequestsEffect(runDir: string): Effect.Effect<void, Error> {
  return Effect.asVoid(
    Effect.all(
      [stopRequestPath(runDir), pauseRequestPath(runDir)].map((requestPath) =>
        Effect.tryPromise({
          try: () => rm(requestPath, { force: true }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error)))
        })
      ),
      { concurrency: 2 }
    )
  )
}
