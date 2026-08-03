import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as {
      global: { ui: { placement: Record<string, unknown> } }
    }
    delete stored.global.ui.placement.workspace
    const malformed = `${JSON.stringify(stored)}\n`
    await writeFile(preferencesPath(), malformed)

    await expect(readPreferences()).rejects.toThrow("Missing key")
    expect(await readFile(preferencesPath(), "utf8")).toBe(malformed)
  })

  test("rejects unknown design-preference fields without alternate parsing", async () => {
    await setUiPreference("focus", "never", null)
    const stored = JSON.parse(await readFile(preferencesPath(), "utf8")) as {
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
      await writeFile(preferencesPath(), `${JSON.stringify(malformed)}\n`)
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
})
