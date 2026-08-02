import { Effect, SynchronizedRef } from "effect"

import type { RunState } from "../types.js"

import { writeRunState } from "../state.js"

export class StatePersistenceError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super(`Could not persist run state: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "StatePersistenceError"
    this.cause = cause
  }
}

interface PersistenceCell {
  readonly state: RunState
  readonly failure: StatePersistenceError | null
}

type WriteResult =
  | { readonly tag: "Written"; readonly state: RunState }
  | { readonly tag: "Failed"; readonly error: StatePersistenceError }

export interface RunStore {
  readonly read: Effect.Effect<RunState>
  readonly update: (
    mutate: (current: RunState) => RunState,
    options?: { readonly recoverPersistence?: boolean }
  ) => Effect.Effect<RunState, StatePersistenceError>
}

export interface RunStoreOptions {
  readonly write?: (runDir: string, state: RunState) => Promise<void>
}

export const makeRunStore = (
  runDir: string,
  initialState: RunState,
  options: RunStoreOptions = {}
): Effect.Effect<RunStore> =>
  Effect.gen(function* () {
    const write = options.write ?? writeRunState
    const ref = yield* SynchronizedRef.make<PersistenceCell>({
      state: initialState,
      failure: null
    })

    const update: RunStore["update"] = (mutate, updateOptions) =>
      Effect.uninterruptible(
        Effect.flatMap(
          SynchronizedRef.modifyEffect(ref, (cell) => {
            if (cell.failure !== null && updateOptions?.recoverPersistence !== true) {
              return Effect.succeed([
                { tag: "Failed", error: cell.failure } satisfies WriteResult,
                cell
              ] as const)
            }
            const next = {
              ...mutate(cell.state),
              updatedAt: new Date().toISOString()
            }
            return Effect.match(
              Effect.tryPromise({
                try: () => write(runDir, next),
                catch: (error) => new StatePersistenceError(error)
              }),
              {
                onFailure: (error): readonly [WriteResult, PersistenceCell] => [
                  { tag: "Failed", error },
                  { state: cell.state, failure: error }
                ],
                onSuccess: (): readonly [WriteResult, PersistenceCell] => [
                  { tag: "Written", state: next },
                  { state: next, failure: null }
                ]
              }
            )
          }),
          (result) =>
            result.tag === "Written" ? Effect.succeed(result.state) : Effect.fail(result.error)
        )
      )

    return {
      read: Effect.map(SynchronizedRef.get(ref), (cell) => cell.state),
      update
    }
  })
