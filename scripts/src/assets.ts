import { readFile } from "node:fs/promises"
import path from "node:path"

declare const ORCHESTRATE_ASSETS_EMBEDDED: Readonly<Record<string, string>>

export const ASSET_SOURCES = {
  "skill/SKILL.md": "SKILL.md",
  "skill/agents/openai.yaml": "agents/openai.yaml",
  "skill/references/cli-spec.md": "references/cli-spec.md",
  "skill/references/examples.md": "references/examples.md",
  "skill/references/guarantees.md": "references/guarantees.md",
  "skill/references/runtime-operations.md": "references/runtime-operations.md",
  "skill/references/workflow-format.md": "references/workflow-format.md",
  "skill/references/workflow.schema.json": "references/workflow.schema.json",
  "skill/references/preferences.schema.json": "references/preferences.schema.json",
  "skill/references/state.schema.json": "references/state.schema.json",
  "skill/references/event.schema.json": "references/event.schema.json",
  "herdr-plugin/herdr-plugin.toml": "herdr-plugin/herdr-plugin.toml",
  "herdr-plugin/README.md": "herdr-plugin/README.md",
  "herdr-plugin/bin/orchestrate-panel": "herdr-plugin/bin/orchestrate-panel",
  LICENSE: "LICENSE"
} as const

export async function bundledAssets(): Promise<Readonly<Record<string, string>>> {
  if (typeof ORCHESTRATE_ASSETS_EMBEDDED === "object") {
    return ORCHESTRATE_ASSETS_EMBEDDED
  }
  const repository = path.resolve(import.meta.dir, "../..")
  return Object.fromEntries(
    await Promise.all(
      Object.entries(ASSET_SOURCES).map(async ([destination, source]) => [
        destination,
        await readFile(path.join(repository, source), "utf8")
      ])
    )
  )
}
