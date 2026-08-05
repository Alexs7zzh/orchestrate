import { readdir } from "node:fs/promises"
import path from "node:path"

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await sourceFiles(candidate)))
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      result.push(candidate)
    }
  }
  return result
}

function packageName(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:")
  ) {
    return null
  }
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string)
}

const scriptsRoot = path.resolve(import.meta.dir, "..")
const manifest = JSON.parse(await Bun.file(path.join(scriptsRoot, "package.json")).text()) as {
  readonly dependencies: Readonly<Record<string, string>>
}
const imports = new Set<string>()
const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g
for (const file of await sourceFiles(path.join(scriptsRoot, "src"))) {
  const source = await Bun.file(file).text()
  for (const match of source.matchAll(importPattern)) {
    const dependency = packageName(match[1] as string)
    if (dependency !== null) {
      imports.add(dependency)
    }
  }
}
const actual = [...imports].toSorted()
const declared = Object.keys(manifest.dependencies).toSorted()
if (JSON.stringify(actual) !== JSON.stringify(declared)) {
  throw new Error(
    `Production dependency closure mismatch: imports=${JSON.stringify(actual)} dependencies=${JSON.stringify(declared)}.`
  )
}
console.log(`Production dependency closure: ${actual.join(", ")}`)
