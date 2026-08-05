import { chmod, readdir } from "node:fs/promises"
import path from "node:path"

import { ASSET_SOURCES } from "./assets.js"
import {
  buildToolchainIdentity,
  COMPILED_BUNDLE_TARGET,
  COMPILED_TARGET,
  MINIMUM_MACOS_VERSION,
  SOURCE_BUNDLE_TARGET,
  TARGET_ARCHITECTURE,
  TARGET_PLATFORM
} from "./build-contract.js"
import { assertReleaseVersion } from "./semver.js"

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await sourceFiles(candidate)))
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".json"))) {
      result.push(candidate)
    }
  }
  return result
}

const root = path.resolve(import.meta.dir, "..")
const repository = path.resolve(root, "..")
const compiled = process.argv.includes("--compile")
const buildTarget = compiled ? COMPILED_TARGET : SOURCE_BUNDLE_TARGET
const bundleTarget = compiled ? COMPILED_BUNDLE_TARGET : SOURCE_BUNDLE_TARGET
if (compiled) {
  process.env.MACOSX_DEPLOYMENT_TARGET = MINIMUM_MACOS_VERSION
}
const packageJson = JSON.parse(await Bun.file(path.join(root, "package.json")).text()) as {
  readonly version: string
}
const requestedVersion = process.env.ORCHESTRATE_RELEASE_VERSION?.trim()
const releaseVersion = assertReleaseVersion(
  requestedVersion === undefined || requestedVersion.length === 0
    ? packageJson.version
    : requestedVersion
)
const assetFiles = Object.values(ASSET_SOURCES).map((file) => path.join(repository, file))
const inputs = [
  ...(await sourceFiles(path.join(root, "src"))),
  path.join(root, "package.json"),
  path.join(root, "bun.lock"),
  ...assetFiles
].toSorted()
const hasher = new Bun.CryptoHasher("sha256")
hasher.update(`version:${releaseVersion}\0`)
hasher.update(
  buildToolchainIdentity({
    artifact: compiled ? "compiled" : "bundle",
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    target: buildTarget,
    minimumMacOSVersion: compiled ? MINIMUM_MACOS_VERSION : null
  })
)
hasher.update("\0")
for (const file of inputs) {
  hasher.update(`${path.relative(root, file)}\0`)
  hasher.update(await Bun.file(file).bytes())
}
const build = hasher.digest("hex").slice(0, 16)
const assets = Object.fromEntries(
  await Promise.all(
    Object.entries(ASSET_SOURCES).map(async ([destination, source]) => {
      const raw = await Bun.file(path.join(repository, source)).text()
      const content =
        destination === "herdr-plugin/herdr-plugin.toml"
          ? raw.replace(/^version = ".*"$/m, `version = "${releaseVersion}"`)
          : raw
      return [destination, content]
    })
  )
)
const outfile = path.join(root, compiled ? "dist/orchestrate" : "orchestrate.mjs")
const result = await Bun.build({
  entrypoints: [path.join(root, "src/main.ts")],
  target: bundleTarget,
  format: "esm",
  minify: true,
  metafile: true,
  sourcemap: compiled ? "none" : "external",
  define: {
    ...(compiled
      ? {
          "process.arch": JSON.stringify(TARGET_ARCHITECTURE),
          "process.platform": JSON.stringify(TARGET_PLATFORM)
        }
      : {}),
    ORCHESTRATE_BUILD_EMBEDDED: JSON.stringify(build),
    ORCHESTRATE_VERSION_EMBEDDED: JSON.stringify(releaseVersion),
    ORCHESTRATE_ASSETS_EMBEDDED: JSON.stringify(assets)
  },
  ...(compiled
    ? {
        compile: {
          target: COMPILED_TARGET,
          outfile,
          autoloadDotenv: false,
          autoloadBunfig: false
        }
      }
    : {
        outdir: root,
        naming: {
          entry: "orchestrate.mjs",
          chunk: ".orchestrate.bun-build/[name]-[hash].[ext]",
          asset: ".orchestrate.bun-build/[name]-[hash].[ext]"
        }
      })
})
if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
if (compiled) {
  await Bun.write(
    path.join(root, "dist", "orchestrate.meta.json"),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
    { createPath: false, mode: 0o644 }
  )
}
await chmod(outfile, 0o755)
console.log(`${compiled ? "Compiled" : "Bundled"} ${outfile} (${build})`)
