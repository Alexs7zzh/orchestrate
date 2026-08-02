import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { atomicWriteJson } from "../state.js"

// The marker is carried as a `--marker` flag value that the CLI accepts and
// ignores, so the installed command stays valid whether Codex runs hooks
// through a shell or execs argv directly. The value is deliberately a
// substring of the legacy "# orchestrate-wake-hook" shell-comment marker, so
// detection and merging recognize old-style installs and upgrade them in
// place instead of duplicating the hook.
const CODEX_HOOK_MARKER = "orchestrate-wake-hook"

interface HooksFile {
  readonly hooks?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

function groupContainsMarker(group: unknown): boolean {
  if (typeof group !== "object" || group === null || Array.isArray(group)) {
    return false
  }
  const candidates = (group as { readonly hooks?: unknown }).hooks
  if (!Array.isArray(candidates)) {
    return false
  }
  return candidates.some(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as { readonly command?: unknown }).command === "string" &&
      (candidate as { readonly command: string }).command.includes(CODEX_HOOK_MARKER)
  )
}

function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim()
  return path.resolve(
    configured !== undefined && configured.length > 0
      ? configured
      : path.join(os.homedir(), ".codex")
  )
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function codexHooksPath(): string {
  return path.join(codexHome(), "hooks.json")
}

export async function installCodexWakeHook(commandPath: string): Promise<{
  readonly filePath: string
  readonly changed: boolean
}> {
  const filePath = codexHooksPath()
  let existing: HooksFile = {}
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${filePath} must contain a JSON object.`)
    }
    existing = parsed as HooksFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }

  const hooks = existing.hooks
  if (
    hooks !== undefined &&
    (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))
  ) {
    throw new Error(`${filePath} has an invalid hooks object; it was not changed.`)
  }
  const stop = hooks?.Stop
  if (stop !== undefined && !Array.isArray(stop)) {
    throw new Error(`${filePath} has an invalid Stop hook list; it was not changed.`)
  }
  const stopGroups: readonly unknown[] = stop ?? []

  const command = `${shellQuote(path.resolve(commandPath))} __wake-hook codex --marker ${CODEX_HOOK_MARKER}`
  const retained = stopGroups.filter((group) => !groupContainsMarker(group))
  const prior = stopGroups.find(groupContainsMarker)
  const desired = {
    hooks: [{ type: "command", command, timeout: 86_400 }]
  }
  const changed = JSON.stringify(prior) !== JSON.stringify(desired)
  if (!changed) {
    return { filePath, changed: false }
  }
  await atomicWriteJson(filePath, {
    ...existing,
    hooks: {
      ...hooks,
      Stop: [...retained, desired]
    }
  })
  return { filePath, changed: true }
}

export async function hasCodexWakeHook(): Promise<boolean> {
  try {
    const content = await readFile(codexHooksPath(), "utf8")
    return content.includes(CODEX_HOOK_MARKER)
  } catch {
    return false
  }
}
