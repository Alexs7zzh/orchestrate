import { chmod, cp, lstat, mkdir, readdir, symlink } from "node:fs/promises"
import path from "node:path"

import { COMPILED_TARGET, MINIMUM_MACOS_VERSION } from "./build-contract.js"
import { assertReleaseVersion } from "./semver.js"

export const RELEASE_PAYLOAD_FILES = Object.freeze([
  "LICENSE",
  "SKILL.md",
  "THIRD_PARTY_LICENSES.txt",
  "agents/openai.yaml",
  "bin/orchestrate",
  "herdr-plugin/README.md",
  "herdr-plugin/bin/orchestrate-panel",
  "herdr-plugin/herdr-plugin.toml",
  "references/cli-spec.md",
  "references/event.schema.json",
  "references/examples.md",
  "references/guarantees.md",
  "references/preferences.schema.json",
  "references/runtime-operations.md",
  "references/state.schema.json",
  "references/workflow-format.md",
  "references/workflow.schema.json"
] as const)

async function payloadFiles(directory: string, prefix = ""): Promise<readonly string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await payloadFiles(path.join(directory, entry.name), relative)))
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relative)
    }
  }
  return files.toSorted()
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`)
  }
  return value
}

function run(command: string, args: readonly string[], cwd?: string): string {
  const result = Bun.spawnSync([command, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  })
  const stderr = new TextDecoder().decode(result.stderr)
  if (!result.success) {
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr.trim()}`)
  }
  return new TextDecoder().decode(result.stdout)
}

function assertCompiledPlatform(binary: string): void {
  const architectures = run("/usr/bin/lipo", ["-archs", binary]).trim()
  if (architectures !== "arm64") {
    throw new Error(
      `Release binary must match ${COMPILED_TARGET} as a thin ARM64 Mach-O; found ${architectures}.`
    )
  }
  const buildVersion = run("/usr/bin/vtool", ["-show-build", binary])
  if (
    !/^\s*platform MACOS$/m.test(buildVersion) ||
    !new RegExp(`^\\s*minos ${MINIMUM_MACOS_VERSION.replace(".", "\\.")}$`, "m").test(buildVersion)
  ) {
    throw new Error(
      `Release binary must target macOS with minimum version ${MINIMUM_MACOS_VERSION}.`
    )
  }
}

export interface ReleaseArtifacts {
  readonly version: string
  readonly archive: string
  readonly sha256: string
  readonly formula: string
  readonly unpacked: string
}

export async function assembleRelease(options: {
  readonly version: string
  readonly repository: string
  readonly output: string
  readonly scriptsRoot?: string
}): Promise<ReleaseArtifacts> {
  const version = assertReleaseVersion(options.version)
  const scriptsRoot = path.resolve(options.scriptsRoot ?? path.join(import.meta.dir, ".."))
  const repositoryRoot = path.resolve(scriptsRoot, "..")
  const output = path.resolve(options.output)
  if (
    output === path.parse(output).root ||
    output === repositoryRoot ||
    output === scriptsRoot ||
    repositoryRoot.startsWith(`${output}${path.sep}`)
  ) {
    throw new Error(`Refusing unsafe release output directory "${output}".`)
  }
  const stageRoot = path.join(output, "stage")
  const payload = path.join(stageRoot, "orchestrate")
  const archive = path.join(output, "orchestrate-macos-arm64.tar.gz")
  const formula = path.join(output, "orchestrate.rb")
  const unpacked = path.join(output, "unpacked")
  const existingOutput = await lstat(output).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw error
  })
  if (existingOutput !== null) {
    if (!existingOutput.isDirectory() || (await readdir(output)).length > 0) {
      throw new Error(`Release output directory "${output}" already exists and is not empty.`)
    }
  }
  await mkdir(output, { recursive: true })
  await mkdir(path.join(payload, "bin"), { recursive: true })
  const binary = path.join(scriptsRoot, "dist", "orchestrate")
  assertCompiledPlatform(binary)
  await cp(binary, path.join(payload, "bin", "orchestrate"))
  await chmod(path.join(payload, "bin", "orchestrate"), 0o755)
  for (const entry of ["SKILL.md", "agents", "references", "herdr-plugin"] as const) {
    await cp(path.join(repositoryRoot, entry), path.join(payload, entry), { recursive: true })
  }
  await cp(path.join(repositoryRoot, "LICENSE"), path.join(payload, "LICENSE"))
  await cp(
    path.join(scriptsRoot, "THIRD_PARTY_LICENSES.txt"),
    path.join(payload, "THIRD_PARTY_LICENSES.txt")
  )
  const pluginPath = path.join(payload, "herdr-plugin", "herdr-plugin.toml")
  const plugin = (await Bun.file(pluginPath).text()).replace(
    /^version = ".*"$/m,
    `version = "${version}"`
  )
  await Bun.write(pluginPath, plugin, { createPath: false, mode: 0o644 })
  const inventory = await payloadFiles(payload)
  if (JSON.stringify(inventory) !== JSON.stringify(RELEASE_PAYLOAD_FILES)) {
    throw new Error(`Release payload inventory mismatch: ${JSON.stringify(inventory)}.`)
  }
  for (const [source, staged] of [
    [path.join(repositoryRoot, "LICENSE"), path.join(payload, "LICENSE")],
    [
      path.join(scriptsRoot, "THIRD_PARTY_LICENSES.txt"),
      path.join(payload, "THIRD_PARTY_LICENSES.txt")
    ]
  ] as const) {
    if ((await Bun.file(source).text()) !== (await Bun.file(staged).text())) {
      throw new Error(`Release notice ${path.basename(staged)} does not match its source.`)
    }
  }
  const binaryVersion = run(path.join(payload, "bin", "orchestrate"), ["--version"]).trim()
  if (!binaryVersion.startsWith(`@local/orchestrate-runtime@${version}+`)) {
    throw new Error(`Binary version ${binaryVersion} does not match ${version}.`)
  }
  if (!plugin.includes(`version = "${version}"`)) {
    throw new Error("Staged plugin version does not match the release version.")
  }
  run("tar", ["-C", stageRoot, "-czf", archive, "orchestrate"])
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).bytes())
    .digest("hex")
  await Bun.write(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`, {
    createPath: false,
    mode: 0o644
  })
  const template = await Bun.file(
    path.join(repositoryRoot, "distribution", "orchestrate.rb.in")
  ).text()
  await Bun.write(
    formula,
    template
      .replaceAll("@VERSION@", version)
      .replaceAll("@SHA256@", sha256)
      .replaceAll("@REPOSITORY@", options.repository),
    { createPath: false, mode: 0o644 }
  )
  await mkdir(unpacked, { recursive: true })
  run("tar", ["-C", unpacked, "-xzf", archive])
  // Exercise the formula's libexec + bin symlink install shape without
  // mutating Homebrew or the host installation.
  const formulaRoot = path.join(output, "formula-root")
  await mkdir(path.join(formulaRoot, "bin"), { recursive: true })
  await cp(path.join(unpacked, "orchestrate"), path.join(formulaRoot, "libexec"), {
    recursive: true
  })
  await symlink(
    path.join(formulaRoot, "libexec", "bin", "orchestrate"),
    path.join(formulaRoot, "bin", "orchestrate")
  )
  const formulaBinary = path.join(formulaRoot, "bin", "orchestrate")
  run(formulaBinary, ["--help"])
  const formulaVersion = run(formulaBinary, ["--version"]).trim()
  if (formulaVersion !== binaryVersion) {
    throw new Error(`Formula binary version ${formulaVersion} does not match ${binaryVersion}.`)
  }
  run("ruby", ["-c", formula])
  return { version, archive, sha256, formula, unpacked }
}

if (import.meta.main) {
  const result = await assembleRelease({
    version: requiredEnvironment("ORCHESTRATE_RELEASE_VERSION"),
    repository: requiredEnvironment("ORCHESTRATE_RELEASE_REPOSITORY"),
    output: requiredEnvironment("ORCHESTRATE_RELEASE_OUTPUT")
  })
  console.log(JSON.stringify(result))
}
