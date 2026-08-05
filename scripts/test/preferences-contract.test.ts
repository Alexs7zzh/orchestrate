import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, open, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  DEFAULT_UI_PREFERENCES,
  preferencesPath,
  readPreferences,
  setUiPreference,
  uiPreferencesWithOrigins
} from "../src/preferences.js"

let temporaryRoot = ""

const LOCK_EX = 2
const LOCK_UN = 8

async function holdPreferencesLockWithStaleMetadata(): Promise<() => Promise<void>> {
  const lockPath = path.join(process.env.ORCHESTRATE_STATE_DIR as string, "preferences.lock")
  await mkdir(path.dirname(lockPath), { recursive: true })
  const handle = await open(lockPath, "a+", 0o600)
  const { dlopen } = await import("bun:ffi")
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: ["i32", "i32"], returns: "i32" }
  })
  if (library.symbols.flock(handle.fd, LOCK_EX) !== 0) {
    await handle.close()
    throw new Error("Could not establish the preferences test lock.")
  }
  await handle.truncate(0)
  await handle.writeFile(`${JSON.stringify({ pid: 99_999_999, token: "stale" })}\n`)
  await handle.sync()
  return async () => {
    try {
      if (library.symbols.flock(handle.fd, LOCK_UN) !== 0) {
        throw new Error("Could not release the preferences test lock.")
      }
    } finally {
      library.close()
      await handle.close()
    }
  }
}

async function waitForRecords(log: string, expected: readonly string[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const records = new Set(
      await Bun.file(log)
        .text()
        .then((value) => value.trim().split("\n").filter(Boolean))
        .catch((): string[] => [])
    )
    if (expected.every((record) => records.has(record))) {
      return
    }
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for preference writer records: ${expected.join(", ")}.`)
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-ui-preferences-"))
  process.env.ORCHESTRATE_STATE_DIR = path.join(temporaryRoot, "state")
})

afterEach(async () => {
  delete process.env.ORCHESTRATE_STATE_DIR
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe("UI preferences contract", () => {
  test("starts from the documented defaults", async () => {
    const merged = await uiPreferencesWithOrigins("/tmp/project")
    expect(merged.value).toEqual(DEFAULT_UI_PREFERENCES)
    expect(merged.origins.board).toBe("default")
    expect(merged.origins.notifications.progress).toBe("default")
  })

  test("merges global and project fields with origins", async () => {
    await setUiPreference("focus", "never", null)
    await setUiPreference("notifications.attention", "board", "/tmp/project")

    const merged = await uiPreferencesWithOrigins("/tmp/project")
    expect(merged.value.focus).toBe("never")
    expect(merged.origins.focus).toBe("global")
    expect(merged.value.notifications.attention).toBe("board")
    expect(merged.origins.notifications.attention).toBe("project")
    expect(merged.value.notifications.progress).toBe("board")
    expect(merged.origins.notifications.progress).toBe("default")
  })

  test("materializes an unset object layer for a nested update", async () => {
    await setUiPreference("placement.maxSplitsPerTab", 7, null)
    const merged = await uiPreferencesWithOrigins("/tmp/project")
    expect(merged.value.placement.maxSplitsPerTab).toBe(7)
    expect(merged.origins.placement).toBe("global")
  })

  test("validates and merges the node workspace independently of surface rules", async () => {
    await setUiPreference("placement.workspace", "origin", "/tmp/project")
    const merged = await uiPreferencesWithOrigins("/tmp/project")
    expect(merged.value.placement.workspace).toBe("origin")
    expect(merged.value.placement.rules).toEqual(DEFAULT_UI_PREFERENCES.placement.rules)
    expect(merged.origins.placement).toBe("project")

    await expect(setUiPreference("placement.workspace", "current", null)).rejects.toThrow(
      'Expected "dedicated" | "origin"'
    )
  })

  test("rejects a placement object missing its required workspace without rewriting it", async () => {
    await setUiPreference("placement.maxSplitsPerTab", 7, null)
    const stored = JSON.parse(await Bun.file(preferencesPath()).text()) as {
      global: { ui: { placement: Record<string, unknown> } }
    }
    delete stored.global.ui.placement.workspace
    const malformed = `${JSON.stringify(stored)}\n`
    await Bun.write(preferencesPath(), malformed, { createPath: false })

    await expect(readPreferences()).rejects.toThrow("Missing key")
    expect(await Bun.file(preferencesPath()).text()).toBe(malformed)
  })

  test("rejects unknown design-preference fields without alternate parsing", async () => {
    await setUiPreference("focus", "never", null)
    const stored = JSON.parse(await Bun.file(preferencesPath()).text()) as {
      global: Record<string, unknown>
    }
    for (const field of [
      "providers",
      "writeConflicts",
      "concurrency",
      "limits",
      "worktrees",
      "verifyCommands"
    ]) {
      const malformed = structuredClone(stored)
      malformed.global[field] = null
      await Bun.write(preferencesPath(), `${JSON.stringify(malformed)}\n`, { createPath: false })
      await expect(readPreferences()).rejects.toThrow("Unexpected key")
    }
  })

  test("requires a final match-all placement rule", async () => {
    await expect(
      setUiPreference(
        "placement",
        {
          workspace: "dedicated",
          rules: [
            {
              match: {
                type: "agent",
                provider: "any",
                level: "any",
                origin: "any",
                id: "review-*"
              },
              surface: "split"
            }
          ],
          grouping: { by: "root-ancestor" },
          maxSplitsPerTab: 4
        },
        null
      )
    ).rejects.toThrow("mandatory match-all default")
  })

  test("rejects unknown paths without writing them", async () => {
    await expect(setUiPreference("unknown", true, null)).rejects.toThrow("does not exist")
    const merged = await uiPreferencesWithOrigins("/tmp/project")
    expect(merged.value).toEqual(DEFAULT_UI_PREFERENCES)
  })

  test("serializes A B C writers across stale metadata without an ABA admission gap", async () => {
    const interleavingLog = path.join(temporaryRoot, "preferences-writers.log")
    const releaseHeldLock = await holdPreferencesLockWithStaleMetadata()
    const moduleUrl = new URL("../src/preferences.ts", import.meta.url).href
    const writerNames = ["A", "B", "C"] as const
    const children = writerNames.map((name) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { appendFileSync } from "node:fs"; const { setUiPreference } = await import(${JSON.stringify(moduleUrl)}); const originalSetTimeout = globalThis.setTimeout; globalThis.setTimeout = (callback, delay, ...args) => { appendFileSync(${JSON.stringify(interleavingLog)}, ${JSON.stringify(name)} + ":blocked\\n"); globalThis.setTimeout = originalSetTimeout; return originalSetTimeout(callback, delay, ...args); }; appendFileSync(${JSON.stringify(interleavingLog)}, ${JSON.stringify(name)} + ":calling\\n"); await setUiPreference("focus", "never", ${JSON.stringify("/tmp/preferences-")} + ${JSON.stringify(name)}); appendFileSync(${JSON.stringify(interleavingLog)}, ${JSON.stringify(name)} + ":done\\n");`
        ],
        { env: process.env, stdout: "ignore", stderr: "pipe" }
      )
    )

    let interleavingError: unknown = null
    try {
      await waitForRecords(
        interleavingLog,
        writerNames.map((name) => `${name}:blocked`)
      )
      await expect(Bun.file(preferencesPath()).text()).rejects.toMatchObject({ code: "ENOENT" })
    } catch (error) {
      interleavingError = error
    } finally {
      await releaseHeldLock()
    }
    const exits = await Promise.all(children.map((child) => child.exited))
    if (exits.some((code) => code !== 0)) {
      const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()))
      throw new Error(`Preference writers failed: ${errors.join("\n")}`)
    }
    if (interleavingError !== null) {
      throw interleavingError
    }

    const stored = await readPreferences()
    expect(Object.keys(stored.projects).toSorted()).toEqual([
      "/tmp/preferences-A",
      "/tmp/preferences-B",
      "/tmp/preferences-C"
    ])
    expect(Object.values(stored.projects).map((project) => project.ui.focus)).toEqual([
      "never",
      "never",
      "never"
    ])
  })
})
