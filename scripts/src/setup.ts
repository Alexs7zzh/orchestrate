import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  chmod,
  copyFile,
  access,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { bundledAssets } from "./assets.js"
import { runDirectory, runStatePath, runsRoot, runtimeBuild } from "./state.js"

export interface SetupStep {
  readonly action: string
  readonly target: string
  readonly status: "planned" | "done" | "warning"
  readonly detail: string | null
}

export interface SetupResult {
  readonly remove: boolean
  readonly dryRun: boolean
  readonly build: string
  readonly steps: readonly SetupStep[]
}

function installHome(): string {
  const configured = process.env.HOME?.trim()
  return path.resolve(
    configured === undefined || configured.length === 0 ? os.homedir() : configured
  )
}

function shareRoot(): string {
  return path.join(installHome(), ".local", "share", "orchestrate")
}

function stableCurrent(): string {
  return path.join(shareRoot(), "current")
}

export async function installedBuild(): Promise<string | null> {
  return readFile(path.join(stableCurrent(), "build.json"), "utf8")
    .then((raw) => {
      const value = JSON.parse(raw) as unknown
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return null
      }
      const build = (value as Record<string, unknown>).build
      return typeof build === "string" ? build : null
    })
    .catch(() => null)
}

function executableLink(): string {
  return path.join(installHome(), ".local", "bin", "orchestrate")
}

function buildDirectoryName(): string {
  return runtimeBuild().replaceAll(/[^A-Za-z0-9._+-]/g, "-")
}

async function runCommand(command: string, args: readonly string[]): Promise<void> {
  await runCommandOutput(command, args)
}

async function runCommandOutput(command: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env })
    let stdout = ""
    let stderr = ""
    let spawnError: Error | null = null
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.once("error", (error) => (spawnError = error))
    child.once("close", (code) => {
      if (spawnError !== null) {
        reject(spawnError)
      } else if (code === 0) {
        resolve(stdout)
      } else {
        reject(
          new Error(
            `${command} ${args.slice(0, 2).join(" ")} exited with ${code}${stderr.trim().length === 0 ? "." : `: ${stderr.trim()}`}`
          )
        )
      }
    })
  })
}

function containsPlugin(value: unknown): boolean {
  if (value === "orchestrate") {
    return true
  }
  if (Array.isArray(value)) {
    return value.some(containsPlugin)
  }
  return value !== null && typeof value === "object"
    ? Object.values(value as Record<string, unknown>).some(containsPlugin)
    : false
}

export async function herdrPluginHealth(): Promise<{
  readonly ok: boolean
  readonly detail: string
}> {
  try {
    const raw = await runCommandOutput("herdr", [
      "plugin",
      "list",
      "--plugin",
      "orchestrate",
      "--json"
    ])
    const parsed = JSON.parse(raw) as unknown
    return containsPlugin(parsed)
      ? { ok: true, detail: "orchestrate registered" }
      : { ok: false, detail: "orchestrate plugin is not registered" }
  } catch (error) {
    return { ok: false, detail: String(error) }
  }
}

async function atomicSymlink(target: string, linkPath: string): Promise<void> {
  await mkdir(path.dirname(linkPath), { recursive: true, mode: 0o755 })
  const existing = await lstat(linkPath).catch(() => null)
  if (existing !== null && !existing.isSymbolicLink()) {
    throw new Error(`Refusing to replace non-symlink ${linkPath}.`)
  }
  const temporary = `${linkPath}.next-${randomUUID()}`
  await symlink(target, temporary)
  await rename(temporary, linkPath)
}

async function assertReplaceableLink(linkPath: string): Promise<void> {
  const existing = await lstat(linkPath).catch(() => null)
  if (existing !== null && !existing.isSymbolicLink()) {
    throw new Error(`Refusing to replace non-symlink ${linkPath}.`)
  }
}

async function symlinkTarget(linkPath: string): Promise<string | null> {
  const existing = await lstat(linkPath).catch(() => null)
  return existing !== null && existing.isSymbolicLink()
    ? path.resolve(path.dirname(linkPath), await readlink(linkPath))
    : null
}

async function removeOwnedLink(linkPath: string, root: string, steps: SetupStep[]): Promise<void> {
  const info = await lstat(linkPath).catch(() => null)
  if (info === null) {
    return
  }
  if (!info.isSymbolicLink()) {
    steps.push({ action: "unlink", target: linkPath, status: "warning", detail: "not a symlink" })
    return
  }
  const target = path.resolve(path.dirname(linkPath), await readlink(linkPath))
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    steps.push({
      action: "unlink",
      target: linkPath,
      status: "warning",
      detail: "not owned by orchestrate"
    })
    return
  }
  await rm(linkPath)
  steps.push({ action: "unlink", target: linkPath, status: "done", detail: null })
}

async function writeAssets(stage: string): Promise<void> {
  for (const [relative, content] of Object.entries(await bundledAssets())) {
    const destination = path.join(stage, relative)
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 })
    await writeFile(destination, content, {
      mode: relative.endsWith("orchestrate-panel") ? 0o755 : 0o644
    })
  }
}

async function stageExecutable(stage: string, invokedPath: string): Promise<void> {
  const bin = path.join(stage, "bin")
  await mkdir(bin, { recursive: true, mode: 0o755 })
  const requested = path.resolve(invokedPath)
  const invoked =
    (await lstat(requested).then(
      () => requested,
      () => null
    )) ?? process.execPath
  const stable = path.join(stableCurrent(), "bin", "orchestrate")
  const runtime = path.join(bin, invoked.endsWith(".mjs") ? "orchestrate.mjs" : "orchestrate-bin")
  const stableRuntime = path.join(
    stableCurrent(),
    "bin",
    invoked.endsWith(".mjs") ? "orchestrate.mjs" : "orchestrate-bin"
  )
  await copyFile(invoked, runtime)
  await chmod(runtime, 0o755)
  const launch = invoked.endsWith(".mjs")
    ? `exec node ${JSON.stringify(stableRuntime)} "$@"`
    : `exec ${JSON.stringify(stableRuntime)} "$@"`
  const dollar = "$"
  const wrapper = [
    "#!/bin/sh",
    `export ORCHESTRATE_BIN=${JSON.stringify(stable)}`,
    // A staged wrapper commonly precedes Homebrew on PATH. During setup, ask
    // the first distinct PATH installation to stage itself so a freshly
    // upgraded formula cannot be overwritten by the prior staged build.
    `if [ "${dollar}{1-}" = setup ] && [ -z "${dollar}{ORCHESTRATE_SETUP_SOURCE_GUARD-}" ]; then`,
    "  orchestrate_old_ifs=$IFS",
    "  IFS=:",
    `  for orchestrate_dir in ${dollar}{PATH-}; do`,
    '    [ -n "$orchestrate_dir" ] || orchestrate_dir=.',
    '    orchestrate_candidate="$orchestrate_dir/orchestrate"',
    '    if [ -x "$orchestrate_candidate" ] && ! [ "$orchestrate_candidate" -ef "$0" ] && ! [ "$orchestrate_candidate" -ef "$ORCHESTRATE_BIN" ]; then',
    '      if /usr/bin/grep -q "^export ORCHESTRATE_BIN=" "$orchestrate_candidate" 2>/dev/null; then continue; fi',
    "      IFS=$orchestrate_old_ifs",
    "      export ORCHESTRATE_SETUP_SOURCE_GUARD=1",
    '      export ORCHESTRATE_SETUP_SOURCE="$orchestrate_candidate"',
    '      exec "$orchestrate_candidate" "$@"',
    "    fi",
    "  done",
    "  IFS=$orchestrate_old_ifs",
    "fi",
    launch,
    ""
  ].join("\n")
  await writeFile(path.join(bin, "orchestrate"), wrapper, { mode: 0o755 })
  await writeFile(
    path.join(stage, "build.json"),
    `${JSON.stringify({ build: runtimeBuild() }, null, 2)}\n`
  )
}

function agentLinks(): readonly string[] {
  return [
    path.join(installHome(), ".agents", "skills", "orchestrate"),
    path.join(installHome(), ".codex", "skills", "orchestrate"),
    path.join(installHome(), ".claude", "skills", "orchestrate")
  ]
}

async function commandAvailable(command: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) {
      continue
    }
    if (
      await access(path.join(directory, command), 1).then(
        () => true,
        () => false
      )
    ) {
      return true
    }
  }
  return false
}

async function detectedAgentLinks(): Promise<readonly string[]> {
  const home = installHome()
  const links = [path.join(home, ".agents", "skills", "orchestrate")]
  if (
    (await lstat(path.join(home, ".codex")).then(
      () => true,
      () => false
    )) ||
    (await commandAvailable("codex"))
  ) {
    links.push(path.join(home, ".codex", "skills", "orchestrate"))
  }
  if (
    (await lstat(path.join(home, ".claude")).then(
      () => true,
      () => false
    )) ||
    (await commandAvailable("claude"))
  ) {
    links.push(path.join(home, ".claude", "skills", "orchestrate"))
  }
  return links
}

export function setupPlan(
  remove = false,
  links: readonly string[] = agentLinks()
): readonly SetupStep[] {
  if (remove) {
    return [
      ...[executableLink(), ...links].map((target) => ({
        action: "unlink",
        target,
        status: "planned" as const,
        detail: null
      })),
      { action: "plugin-unlink", target: "orchestrate", status: "planned", detail: null },
      {
        action: "remove-staging",
        target: shareRoot(),
        status: "planned",
        detail: "run state is retained"
      }
    ]
  }
  return [
    {
      action: "stage",
      target: path.join(shareRoot(), "versions", buildDirectoryName()),
      status: "planned",
      detail: null
    },
    { action: "link-cli", target: executableLink(), status: "planned", detail: null },
    ...links.map((target) => ({
      action: "link-skill",
      target,
      status: "planned" as const,
      detail: null
    })),
    {
      action: "plugin-link",
      target: path.join(stableCurrent(), "herdr-plugin"),
      status: "planned",
      detail: null
    },
    {
      action: "prune",
      target: path.join(shareRoot(), "versions"),
      status: "planned",
      detail: "keep current only"
    }
  ]
}

export type StagedMigration =
  | { readonly migrated: false; readonly reason: string }
  | { readonly migrated: true; readonly from: string; readonly to: string }

const SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "stopped"])

async function allRunsSettled(): Promise<boolean> {
  // A missing runs directory means no runs; any other listing failure hides
  // unknown run state, so it defers like an unreadable snapshot below.
  const entries = await readdir(runsRoot(), { withFileTypes: true }).catch((error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null
  )
  if (entries === null) {
    return false
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    // Reads the snapshot loosely, without the schema or runtime-build fence:
    // runs created by an older build must still defer migration, and this
    // guard only ever errs toward deferring.
    const status = await readFile(runStatePath(runDirectory(entry.name)), "utf8")
      .then((raw) => {
        const value = JSON.parse(raw) as unknown
        return value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).status
          : null
      })
      .catch(() => null)
    if (typeof status !== "string" || !SETTLED_RUN_STATUSES.has(status)) {
      return false
    }
  }
  return true
}

const RUNTIME_BUILD_PREFIX = "@local/orchestrate-runtime@"

async function installationTimestamp(executablePath: string): Promise<number | null> {
  const resolved = await realpath(executablePath).catch(() => executablePath)
  // A Homebrew keg carries CI build mtimes in its poured files; the install
  // receipt is written at install time and is the honest installation clock.
  let directory = path.dirname(resolved)
  for (let depth = 0; depth < 4; depth += 1) {
    const receipt = await stat(path.join(directory, "INSTALL_RECEIPT.json")).catch(() => null)
    if (receipt !== null) {
      return receipt.mtimeMs
    }
    const parent = path.dirname(directory)
    if (parent === directory) {
      break
    }
    directory = parent
  }
  const info = await stat(resolved).catch(() => null)
  return info?.mtimeMs ?? null
}

async function stagedTimestamp(): Promise<number | null> {
  const info = await stat(path.join(stableCurrent(), "build.json")).catch(() => null)
  return info?.mtimeMs ?? null
}

async function isStagedWrapperCopy(executablePath: string): Promise<boolean> {
  const info = await stat(executablePath).catch(() => null)
  if (info === null || info.size > 8_192) {
    return false
  }
  const content = await readFile(executablePath, "utf8").catch(() => null)
  return content !== null && content.includes("export ORCHESTRATE_BIN=")
}

function underAnyRoot(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))
}

// realpath can rewrite ancestors (macOS /var -> /private/var), so staged-path
// checks compare against the share root in both spellings.
async function shareRoots(): Promise<readonly string[]> {
  const root = shareRoot()
  const resolved = await realpath(root).catch(() => root)
  return resolved === root ? [root] : [root, resolved]
}

async function distinctPathExecutable(invokedReal: string): Promise<string | null> {
  const roots = await shareRoots()
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) {
      continue
    }
    const candidate = path.join(directory, "orchestrate")
    const executable = await access(candidate, 1).then(
      () => true,
      () => false
    )
    if (!executable) {
      continue
    }
    const resolved = await realpath(candidate).catch(() => null)
    if (resolved === null || resolved === invokedReal) {
      continue
    }
    if (underAnyRoot(resolved, roots)) {
      continue
    }
    if (await isStagedWrapperCopy(resolved)) {
      continue
    }
    return resolved
  }
  return null
}

async function adoptNewerInstallation(invokedReal: string): Promise<StagedMigration> {
  const stagedAt = await stagedTimestamp()
  if (stagedAt === null) {
    return { migrated: false, reason: "not installed" }
  }
  const candidate = await distinctPathExecutable(invokedReal)
  if (candidate === null) {
    return { migrated: false, reason: "no other installation" }
  }
  const candidateAt = await installationTimestamp(candidate)
  if (candidateAt === null || candidateAt <= stagedAt) {
    return { migrated: false, reason: "staged installation is newest" }
  }
  const version = (await runCommandOutput(candidate, ["--version"]).catch(() => "")).trim()
  if (!version.startsWith(RUNTIME_BUILD_PREFIX) || version === runtimeBuild()) {
    return { migrated: false, reason: "no newer installation" }
  }
  if (!(await allRunsSettled())) {
    return { migrated: false, reason: "unsettled runs" }
  }
  // The newer executable stages itself so its build metadata is authentic.
  await runCommandOutput(candidate, ["setup", "--no-wizard", "--json"])
  return { migrated: true, from: runtimeBuild(), to: version }
}

export async function migrateStagedInstallation(invokedPath: string): Promise<StagedMigration> {
  const current = runtimeBuild()
  if (current.endsWith("+development")) {
    return { migrated: false, reason: "development build" }
  }
  const staged = await installedBuild()
  if (staged === null) {
    return { migrated: false, reason: "not installed" }
  }
  const requested = path.resolve(invokedPath)
  const invoked =
    (await lstat(requested).then(
      () => requested,
      () => null
    )) ?? process.execPath
  const invokedReal = await realpath(invoked).catch(() => invoked)
  if (staged === current) {
    // The stage matches this binary; a newer installation elsewhere on PATH
    // may still supersede both.
    return adoptNewerInstallation(invokedReal)
  }
  if (underAnyRoot(invokedReal, await shareRoots())) {
    return { migrated: false, reason: "invoked the staged build" }
  }
  // The newest installation wins in both directions: an older binary never
  // replaces a newer stage, so a fresh local install survives running a
  // leftover formula build and vice versa.
  const invokedAt = await installationTimestamp(invokedReal)
  const stagedAt = await stagedTimestamp()
  if (invokedAt !== null && stagedAt !== null && invokedAt <= stagedAt) {
    return { migrated: false, reason: "the staged installation is newer" }
  }
  if (!(await allRunsSettled())) {
    return { migrated: false, reason: "unsettled runs" }
  }
  await runSetup({ invokedPath, remove: false, dryRun: false })
  return { migrated: true, from: staged, to: current }
}

export async function runSetup(options: {
  readonly invokedPath: string
  readonly remove: boolean
  readonly dryRun: boolean
}): Promise<SetupResult> {
  if (options.dryRun) {
    const links = options.remove ? agentLinks() : await detectedAgentLinks()
    return {
      remove: options.remove,
      dryRun: true,
      build: runtimeBuild(),
      steps: setupPlan(options.remove, links)
    }
  }
  const steps: SetupStep[] = []
  const root = shareRoot()
  if (options.remove) {
    const previousCurrent = await symlinkTarget(stableCurrent())
    await runCommand("herdr", ["plugin", "unlink", "orchestrate"])
    steps.push({ action: "plugin-unlink", target: "orchestrate", status: "done", detail: null })
    try {
      for (const link of [executableLink(), ...agentLinks()]) {
        await removeOwnedLink(link, root, steps)
      }
      await rm(root, { recursive: true, force: true })
      steps.push({
        action: "remove-staging",
        target: root,
        status: "done",
        detail: "run state retained"
      })
    } catch (error) {
      if (previousCurrent !== null) {
        await runCommand("herdr", ["plugin", "link", path.join(previousCurrent, "herdr-plugin")])
      }
      throw error
    }
    return { remove: true, dryRun: false, build: runtimeBuild(), steps }
  }

  const versions = path.join(root, "versions")
  const name = buildDirectoryName()
  const destination = path.join(versions, name)
  const previousCurrent = await symlinkTarget(stableCurrent())
  const detectedLinks = await detectedAgentLinks()
  for (const link of [stableCurrent(), executableLink(), ...detectedLinks]) {
    await assertReplaceableLink(link)
  }
  let createdDestination = false
  await mkdir(versions, { recursive: true, mode: 0o755 })
  if ((await lstat(destination).catch(() => null)) === null) {
    const stage = path.join(versions, `.stage-${name}-${randomUUID()}`)
    await mkdir(stage, { mode: 0o755 })
    try {
      await writeAssets(stage)
      await stageExecutable(stage, options.invokedPath)
      await rename(stage, destination)
      createdDestination = true
    } catch (error) {
      await rm(stage, { recursive: true, force: true })
      throw error
    }
  }
  steps.push({ action: "stage", target: destination, status: "done", detail: null })
  try {
    await runCommand("herdr", ["plugin", "link", path.join(destination, "herdr-plugin")])
  } catch (error) {
    const pluginRolledBack = await (
      previousCurrent === null
        ? runCommand("herdr", ["plugin", "unlink", "orchestrate"])
        : runCommand("herdr", ["plugin", "link", path.join(previousCurrent, "herdr-plugin")])
    ).then(
      () => true,
      () => false
    )
    if (createdDestination && pluginRolledBack) {
      await rm(destination, { recursive: true, force: true })
    }
    throw error
  }
  steps.push({
    action: "plugin-link",
    target: path.join(destination, "herdr-plugin"),
    status: "done",
    detail: null
  })
  try {
    await atomicSymlink(path.join("versions", name), stableCurrent())
    await atomicSymlink(path.join(stableCurrent(), "bin", "orchestrate"), executableLink())
    steps.push({ action: "link-cli", target: executableLink(), status: "done", detail: null })
    for (const link of detectedLinks) {
      await atomicSymlink(path.join(stableCurrent(), "skill"), link)
      steps.push({ action: "link-skill", target: link, status: "done", detail: null })
    }
  } catch (error) {
    let pluginRolledBack = false
    if (previousCurrent === null) {
      pluginRolledBack = await runCommand("herdr", ["plugin", "unlink", "orchestrate"]).then(
        () => true,
        () => false
      )
      for (const link of [executableLink(), ...detectedLinks, stableCurrent()]) {
        await removeOwnedLink(link, root, steps)
      }
    } else {
      await atomicSymlink(previousCurrent, stableCurrent()).catch(() => undefined)
      pluginRolledBack = await runCommand("herdr", [
        "plugin",
        "link",
        path.join(previousCurrent, "herdr-plugin")
      ]).then(
        () => true,
        () => false
      )
    }
    if (createdDestination && pluginRolledBack) {
      await rm(destination, { recursive: true, force: true })
    }
    throw error
  }
  for (const entry of await readdir(versions, { withFileTypes: true })) {
    if (entry.name !== name) {
      await rm(path.join(versions, entry.name), { recursive: true, force: true })
    }
  }
  steps.push({ action: "prune", target: versions, status: "done", detail: `kept ${name}` })
  return { remove: false, dryRun: false, build: runtimeBuild(), steps }
}
