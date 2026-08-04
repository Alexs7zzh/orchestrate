import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { installedBuild, migrateStagedInstallation, runSetup } from "../src/setup.js"
import { setRuntimeBuildForTests } from "../src/state.js"

let root = ""
let home = ""
let bin = ""
let executable = ""
let originalHome: string | undefined
let originalPath: string | undefined
let originalStateDir: string | undefined

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-setup-"))
  home = path.join(root, "home")
  bin = path.join(root, "bin")
  executable = path.join(root, "orchestrate")
  await mkdir(path.join(home, ".codex"), { recursive: true })
  await mkdir(bin)
  await writeFile(executable, "#!/bin/sh\nexit 0\n")
  await chmod(executable, 0o755)
  await writeFile(
    path.join(bin, "herdr"),
    `#!/bin/sh
case "$1 $2" in
  "--version ") echo "herdr 0.7.5" ;;
  "plugin link") [ "\${HERDR_FAIL_LINK-}" = 1 ] && { echo link-failed >&2; exit 9; }; exit 0 ;;
  "plugin unlink") [ "\${HERDR_FAIL_UNLINK-}" = 1 ] && { echo unlink-failed >&2; exit 9; }; exit 0 ;;
  "plugin list") echo '{"result":{"plugins":[{"id":"orchestrate"}]}}' ;;
esac
exit 0
`
  )
  await chmod(path.join(bin, "herdr"), 0o755)
  originalHome = process.env.HOME
  originalPath = process.env.PATH
  originalStateDir = process.env.ORCHESTRATE_STATE_DIR
  process.env.HOME = home
  process.env.PATH = bin
  process.env.ORCHESTRATE_STATE_DIR = path.join(home, ".local", "state", "orchestrate")
})

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalPath === undefined) {
    delete process.env.PATH
  } else {
    process.env.PATH = originalPath
  }
  if (originalStateDir === undefined) {
    delete process.env.ORCHESTRATE_STATE_DIR
  } else {
    process.env.ORCHESTRATE_STATE_DIR = originalStateDir
  }
  delete process.env.ORCHESTRATE_BUILD_ID
  delete process.env.HERDR_FAIL_LINK
  delete process.env.HERDR_FAIL_UNLINK
  setRuntimeBuildForTests(null)
  await rm(root, { recursive: true, force: true })
})

async function target(link: string): Promise<string> {
  return path.resolve(path.dirname(link), await readlink(link))
}

describe("setup pipeline", () => {
  test("herdr panel opens the attention run and falls back to the latest run", async () => {
    const log = path.join(root, "panel.log")
    const cli = path.join(bin, "orchestrate")
    await writeFile(
      cli,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$*" in
  "runs --needs-attention") [ "\${PANEL_HAS_ATTENTION-}" = 1 ] && printf '%s\\n' '20260803000000-aaaaaaaa  paused  attention' ;;
  "runs") printf '%s\\n' '20260803000001-bbbbbbbb  completed  latest' ;;
  "board "*) exit 0 ;;
esac
`
    )
    await chmod(cli, 0o755)
    const panel = path.resolve(import.meta.dir, "../../herdr-plugin/bin/orchestrate-panel")

    const attention = spawnSync("/bin/sh", [panel], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PANEL_HAS_ATTENTION: "1" }
    })
    expect(attention.status).toBe(0)
    expect(await readFile(log, "utf8")).toBe(
      "runs --needs-attention\nboard 20260803000000-aaaaaaaa\n"
    )

    await writeFile(log, "")
    const latest = spawnSync("/bin/sh", [panel], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
    })
    expect(latest.status).toBe(0)
    expect(await readFile(log, "utf8")).toBe(
      "runs --needs-attention\nruns\nboard 20260803000001-bbbbbbbb\n"
    )
  })

  test("stages assets, flips stable links, detects agents, and is idempotent", async () => {
    const first = await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    expect(
      first.steps.some((step) => step.action === "plugin-link" && step.status === "done")
    ).toBeTrue()
    const share = path.join(home, ".local", "share", "orchestrate")
    const current = path.join(share, "current")
    expect((await lstat(current)).isSymbolicLink()).toBeTrue()
    expect(await readFile(path.join(current, "skill", "SKILL.md"), "utf8")).toContain("Orchestrate")
    expect(await target(path.join(home, ".local", "bin", "orchestrate"))).toBe(
      path.join(current, "bin", "orchestrate")
    )
    const installed = spawnSync(path.join(home, ".local", "bin", "orchestrate"), ["--help"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home }
    })
    expect(installed.status).toBe(0)
    expect(
      (await lstat(path.join(home, ".agents", "skills", "orchestrate"))).isSymbolicLink()
    ).toBeTrue()
    expect(
      (await lstat(path.join(home, ".codex", "skills", "orchestrate"))).isSymbolicLink()
    ).toBeTrue()
    expect(
      await lstat(path.join(home, ".claude", "skills", "orchestrate")).catch(() => null)
    ).toBeNull()

    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    expect(
      (await readdir(path.join(share, "versions"))).filter((entry) => !entry.startsWith("."))
    ).toHaveLength(1)
  })

  test("atomically changes builds, prunes old and interrupted stages, and supports downgrade", async () => {
    const share = path.join(home, ".local", "share", "orchestrate")
    setRuntimeBuildForTests("build-a")
    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    const first = await target(path.join(share, "current"))
    await mkdir(path.join(share, "versions", ".stage-interrupted"))

    setRuntimeBuildForTests("build-b")
    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    const second = await target(path.join(share, "current"))
    expect(second).not.toBe(first)
    expect(await readdir(path.join(share, "versions"))).toHaveLength(1)

    setRuntimeBuildForTests("build-a")
    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    expect(path.basename(await target(path.join(share, "current")))).toBe("build-a")
    expect(await readdir(path.join(share, "versions"))).toHaveLength(1)
  })

  test("skips copied old staged wrappers and delegates setup to a newer formula build", async () => {
    const bundle = path.join(root, "build-b-orchestrate")
    const sourceBundle = path.resolve(import.meta.dir, "../orchestrate.mjs")
    await writeFile(
      bundle,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(sourceBundle)} "$@"\n`
    )
    await chmod(bundle, 0o755)
    const share = path.join(home, ".local", "share", "orchestrate")
    setRuntimeBuildForTests("build-a")
    await runSetup({ invokedPath: bundle, remove: false, dryRun: false })
    setRuntimeBuildForTests(null)
    const formulaBuild = spawnSync(process.execPath, [sourceBundle, "--version"], {
      encoding: "utf8",
      env: process.env
    }).stdout.trim()

    const formulaBin = path.join(root, "formula-bin")
    await mkdir(formulaBin)
    const formula = path.join(formulaBin, "orchestrate")
    await writeFile(formula, `#!/bin/sh\nexec ${JSON.stringify(bundle)} "$@"\n`)
    await chmod(formula, 0o755)
    const localBin = path.join(home, ".local", "bin")
    const copiedStageBin = path.join(root, "copied-stage-bin")
    await mkdir(copiedStageBin)
    await copyFile(path.join(localBin, "orchestrate"), path.join(copiedStageBin, "orchestrate"))
    await chmod(path.join(copiedStageBin, "orchestrate"), 0o755)
    const env = { ...process.env }
    delete env.ORCHESTRATE_BUILD_ID
    env.ORCHESTRATE_STATE_DIR = path.join(root, "state")
    const upgraded = spawnSync(
      path.join(localBin, "orchestrate"),
      ["setup", "--no-wizard", "--json"],
      {
        encoding: "utf8",
        env: { ...env, PATH: `${localBin}:${copiedStageBin}:${formulaBin}:${bin}` }
      }
    )
    expect(upgraded.stderr).toBe("")
    expect(upgraded.status).toBe(0)
    expect(JSON.parse(await readFile(path.join(share, "current", "build.json"), "utf8"))).toEqual({
      build: formulaBuild
    })
    const installed = spawnSync(path.join(localBin, "orchestrate"), ["--version"], {
      encoding: "utf8",
      env: { ...env, PATH: `${localBin}:${copiedStageBin}:${formulaBin}:${bin}` }
    })
    expect(installed.stderr).toBe("")
    expect(installed.status).toBe(0)
    expect(installed.stdout.trim()).toBe(formulaBuild)
  })

  test("dry-run touches nothing and remove sweeps owned links but retains state", async () => {
    const dry = await runSetup({ invokedPath: executable, remove: false, dryRun: true })
    expect(dry.steps.every((step) => step.status === "planned")).toBeTrue()
    expect(await lstat(path.join(home, ".local")).catch(() => null)).toBeNull()

    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    const state = path.join(home, ".local", "state", "orchestrate", "keep.txt")
    await mkdir(path.dirname(state), { recursive: true })
    await writeFile(state, "keep")
    await runSetup({ invokedPath: executable, remove: true, dryRun: false })
    expect(
      await lstat(path.join(home, ".local", "share", "orchestrate")).catch(() => null)
    ).toBeNull()
    expect(
      await lstat(path.join(home, ".local", "bin", "orchestrate")).catch(() => null)
    ).toBeNull()
    expect(await readFile(state, "utf8")).toBe("keep")
  })

  test("preserves foreign stable-link collisions before registering the plugin", async () => {
    const share = path.join(home, ".local", "share", "orchestrate")
    const current = path.join(share, "current")
    await mkdir(share, { recursive: true })
    await writeFile(current, "user-owned\n")

    await expect(
      runSetup({ invokedPath: executable, remove: false, dryRun: false })
    ).rejects.toThrow(`Refusing to replace non-symlink ${current}.`)
    expect(await readFile(current, "utf8")).toBe("user-owned\n")
    expect(await lstat(path.join(share, "versions")).catch(() => null)).toBeNull()
  })

  test("fails and rolls back staging when the required herdr plugin link fails", async () => {
    process.env.HERDR_FAIL_LINK = "1"
    await expect(
      runSetup({ invokedPath: executable, remove: false, dryRun: false })
    ).rejects.toThrow("plugin link exited with 9")
    expect(
      await lstat(path.join(home, ".local", "share", "orchestrate", "current")).catch(() => null)
    ).toBeNull()
    expect(
      await lstat(path.join(home, ".local", "bin", "orchestrate")).catch(() => null)
    ).toBeNull()
    expect(
      await readdir(path.join(home, ".local", "share", "orchestrate", "versions")).catch(() => [])
    ).toEqual([])
  })

  test("keeps a recoverable stage when plugin-link rollback cannot be observed", async () => {
    process.env.HERDR_FAIL_LINK = "1"
    process.env.HERDR_FAIL_UNLINK = "1"
    await expect(
      runSetup({ invokedPath: executable, remove: false, dryRun: false })
    ).rejects.toThrow("plugin link exited with 9")
    expect(
      await lstat(path.join(home, ".local", "share", "orchestrate", "current")).catch(() => null)
    ).toBeNull()
    const versions = await readdir(path.join(home, ".local", "share", "orchestrate", "versions"))
    expect(versions).toHaveLength(1)
    expect(
      await lstat(
        path.join(
          home,
          ".local",
          "share",
          "orchestrate",
          "versions",
          versions[0] as string,
          "herdr-plugin",
          "herdr-plugin.toml"
        )
      )
    ).not.toBeNull()
  })

  test("migrates a stale staged installation and is idempotent", async () => {
    setRuntimeBuildForTests("build-a")
    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    await utimes(executable, new Date(), new Date(Date.now() + 60_000))

    setRuntimeBuildForTests("build-b")
    expect(await migrateStagedInstallation(executable)).toEqual({
      migrated: true,
      from: "build-a",
      to: "build-b"
    })
    expect(await installedBuild()).toBe("build-b")
    expect(await migrateStagedInstallation(executable)).toEqual({
      migrated: false,
      reason: "no other installation"
    })
  })

  test("defers to a newer staged installation instead of downgrading", async () => {
    setRuntimeBuildForTests("build-a")
    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    await utimes(executable, new Date(), new Date(Date.now() - 60_000))

    setRuntimeBuildForTests("build-b")
    expect(await migrateStagedInstallation(executable)).toEqual({
      migrated: false,
      reason: "the staged installation is newer"
    })
    expect(await installedBuild()).toBe("build-a")
  })

  test("adopts a newer installation found on PATH using its install receipt clock", async () => {
    setRuntimeBuildForTests("build-a")
    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    const stagedBinary = path.join(
      home,
      ".local",
      "share",
      "orchestrate",
      "current",
      "bin",
      "orchestrate-bin"
    )
    const adoptLog = path.join(root, "adopt.log")
    const keg = path.join(root, "keg")
    const kegBinary = path.join(keg, "libexec", "bin", "orchestrate")
    await mkdir(path.dirname(kegBinary), { recursive: true })
    await writeFile(
      kegBinary,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(adoptLog)}
case "$1" in
  --version) printf '%s\\n' "@local/orchestrate-runtime@9.9.9+abcdef1234567890" ;;
  setup) printf '{}\\n' ;;
esac
`
    )
    await chmod(kegBinary, 0o755)
    const receipt = path.join(keg, "INSTALL_RECEIPT.json")
    await writeFile(receipt, "{}\n")
    const kegBin = path.join(root, "keg-bin")
    await mkdir(kegBin)
    await symlink(kegBinary, path.join(kegBin, "orchestrate"))
    process.env.PATH = `${kegBin}:${bin}`

    // The poured binary predates the stage, but the receipt is the install
    // clock and is newer.
    await utimes(kegBinary, new Date(), new Date(Date.now() - 120_000))
    await utimes(receipt, new Date(), new Date(Date.now() + 60_000))
    expect(await migrateStagedInstallation(stagedBinary)).toEqual({
      migrated: true,
      from: "build-a",
      to: "@local/orchestrate-runtime@9.9.9+abcdef1234567890"
    })
    expect(await readFile(adoptLog, "utf8")).toContain("setup --no-wizard --json")

    await utimes(receipt, new Date(), new Date(Date.now() - 60_000))
    expect(await migrateStagedInstallation(stagedBinary)).toEqual({
      migrated: false,
      reason: "staged installation is newest"
    })

    const wrapperBin = path.join(root, "wrapper-bin")
    await mkdir(wrapperBin)
    await copyFile(
      path.join(home, ".local", "share", "orchestrate", "current", "bin", "orchestrate"),
      path.join(wrapperBin, "orchestrate")
    )
    await chmod(path.join(wrapperBin, "orchestrate"), 0o755)
    await utimes(path.join(wrapperBin, "orchestrate"), new Date(), new Date(Date.now() + 60_000))
    process.env.PATH = `${wrapperBin}:${bin}`
    expect(await migrateStagedInstallation(stagedBinary)).toEqual({
      migrated: false,
      reason: "no other installation"
    })
  })

  test("defers migration while any run is unsettled or unreadable", async () => {
    setRuntimeBuildForTests("build-a")
    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    await utimes(executable, new Date(), new Date(Date.now() + 60_000))
    setRuntimeBuildForTests("build-b")
    const runDir = path.join(home, ".local", "state", "orchestrate", "runs", "20260804-aaaaaaaa")
    await mkdir(runDir, { recursive: true })

    const statePath = path.join(runDir, "state.json")
    await writeFile(statePath, JSON.stringify({ status: "running" }))
    expect(await migrateStagedInstallation(executable)).toEqual({
      migrated: false,
      reason: "unsettled runs"
    })
    await writeFile(statePath, "torn-snapshot")
    expect(await migrateStagedInstallation(executable)).toEqual({
      migrated: false,
      reason: "unsettled runs"
    })
    expect(await installedBuild()).toBe("build-a")

    const runsRoot = path.dirname(runDir)
    await chmod(runsRoot, 0o000)
    try {
      expect(await migrateStagedInstallation(executable)).toEqual({
        migrated: false,
        reason: "unsettled runs"
      })
    } finally {
      await chmod(runsRoot, 0o755)
    }

    await writeFile(statePath, JSON.stringify({ status: "completed" }))
    expect(await migrateStagedInstallation(executable)).toEqual({
      migrated: true,
      from: "build-a",
      to: "build-b"
    })
  })

  test("never migrates development builds, a missing installation, or the staged binary", async () => {
    expect(await migrateStagedInstallation(executable)).toEqual({
      migrated: false,
      reason: "development build"
    })
    setRuntimeBuildForTests("build-a")
    expect(await migrateStagedInstallation(executable)).toEqual({
      migrated: false,
      reason: "not installed"
    })

    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    setRuntimeBuildForTests("build-b")
    const stagedBinary = path.join(
      home,
      ".local",
      "share",
      "orchestrate",
      "current",
      "bin",
      "orchestrate-bin"
    )
    expect(await migrateStagedInstallation(stagedBinary)).toEqual({
      migrated: false,
      reason: "invoked the staged build"
    })
    expect(await installedBuild()).toBe("build-a")
  })

  test("fails removal before touching staged assets when plugin unlink fails", async () => {
    await runSetup({ invokedPath: executable, remove: false, dryRun: false })
    const current = path.join(home, ".local", "share", "orchestrate", "current")
    const before = await target(current)
    process.env.HERDR_FAIL_UNLINK = "1"
    await expect(
      runSetup({ invokedPath: executable, remove: true, dryRun: false })
    ).rejects.toThrow("plugin unlink exited with 9")
    expect(await target(current)).toBe(before)
    expect(
      (await lstat(path.join(home, ".local", "bin", "orchestrate"))).isSymbolicLink()
    ).toBeTrue()
  })
})
