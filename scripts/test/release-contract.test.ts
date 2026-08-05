import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { assembleRelease, RELEASE_PAYLOAD_FILES } from "../src/release.js"
import { assertReleaseVersion, parseSemVer } from "../src/semver.js"

setDefaultTimeout(30_000)

let root = ""
let shimDir = ""

function workflow(cwd: string) {
  return {
    name: "release-contract",
    objective: "Exercise the exact release payload.",
    cwd,
    concurrency: 1,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes: [
      {
        id: "check",
        type: "command",
        title: "check",
        needs: [],
        cwd: null,
        workspace: {
          mode: "shared",
          path: null,
          vcs: "none",
          writes: [],
          exclusiveResources: []
        },
        inputs: [],
        retry: { maxAttempts: 1 },
        gate: "none",
        argv: ["/usr/bin/true"],
        mutates: false,
        inheritEnv: [],
        env: {},
        allowedExitCodes: [0]
      }
    ],
    repeats: []
  }
}

function run(binary: string, args: readonly string[], home: string, state: string) {
  return spawnSync(binary, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      ORCHESTRATE_STATE_DIR: state,
      ORCHESTRATE_DISABLE_UI: "1"
    }
  })
}

async function inventory(directory: string, prefix = ""): Promise<readonly string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await inventory(path.join(directory, entry.name), relative)))
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relative)
    }
  }
  return files.toSorted()
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-release-contract-"))
  shimDir = path.join(root, "bin")
  await mkdir(shimDir)
  const herdr = path.join(shimDir, "herdr")
  await Bun.write(
    herdr,
    '#!/bin/sh\ncase "$1 $2" in "--version ") echo "herdr 0.7.5";; "plugin link"|"plugin unlink") exit 0;; "plugin list") echo \'{"result":{"plugins":[{"id":"orchestrate"}]}}\';; *) echo \'{"result":{"type":"ok"}}\';; esac\n',
    { createPath: false }
  )
  await chmod(herdr, 0o755)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("release payload contract", () => {
  test("covers the exact bundle source-map closure and native OpenTUI asset notices", async () => {
    const scriptsRoot = path.resolve(import.meta.dir, "..")
    const sourceMap = JSON.parse(
      await Bun.file(path.join(scriptsRoot, "orchestrate.mjs.map")).text()
    ) as { readonly sources: readonly string[] }
    const bundled = [
      ...new Set(
        sourceMap.sources.flatMap((source) => {
          const match = source.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
          return match?.[1] === undefined ? [] : [match[1]]
        })
      )
    ].toSorted()
    expect(bundled).toEqual([
      "@opentui/core",
      "ajv",
      "effect",
      "fast-check",
      "fast-deep-equal",
      "fast-uri",
      "json-schema-traverse",
      "pure-rand"
    ])
    const notice = await Bun.file(path.join(scriptsRoot, "THIRD_PARTY_LICENSES.txt")).text()
    for (const required of [
      "@opentui/core 0.4.5",
      "@opentui/core-darwin-arm64 0.4.5 native asset",
      "effect 4.0.0-beta.102",
      "fast-check 4.9.0",
      "pure-rand 8.4.2",
      "Copyright (c) 2025 opentui",
      "Copyright (c) 2023 Effectful Technologies Inc",
      "Copyright (c) 2017 Nicolas DUBIEN",
      "Copyright (c) 2018 Nicolas DUBIEN"
    ]) {
      expect(notice).toContain(required)
    }
    const coreLicense = await Bun.file(
      path.join(scriptsRoot, "node_modules", "@opentui", "core", "LICENSE")
    ).text()
    const nativeLicense = await Bun.file(
      path.join(scriptsRoot, "node_modules", "@opentui", "core-darwin-arm64", "LICENSE")
    ).text()
    expect(nativeLicense).toBe(coreLicense)
  })

  test("builds tags from main and creates a reviewable draft release", async () => {
    const ciWorkflow = await Bun.file(
      path.resolve(import.meta.dir, "../../.github/workflows/ci.yml")
    ).text()
    const releaseWorkflow = await Bun.file(
      path.resolve(import.meta.dir, "../../.github/workflows/release.yml")
    ).text()
    for (const workflowSource of [ciWorkflow, releaseWorkflow]) {
      expect(workflowSource).toContain('HOMEBREW_NO_AUTO_UPDATE: "1"')
      expect(workflowSource).toContain("brew install fish")
    }
    expect(releaseWorkflow).toContain("runs-on: macos-15")
    expect(releaseWorkflow).toContain('test "$(uname -m)" = arm64')
    expect(releaseWorkflow).toContain("fetch-depth: 0")
    expect(releaseWorkflow).toContain("git merge-base --is-ancestor")
    expect(releaseWorkflow).toContain("assertReleaseVersion")
    expect(releaseWorkflow).toContain("persist-credentials: false")
    expect(releaseWorkflow).toContain("needs: build")
    expect(releaseWorkflow).toContain("--draft --verify-tag --generate-notes")
    expect(releaseWorkflow).toContain("gh release upload")
    expect(releaseWorkflow).toContain("GH_REPO:")
    expect(releaseWorkflow).toContain("retention-days: 7")
    expect(releaseWorkflow.match(/contents: write/g)).toHaveLength(1)
    expect(releaseWorkflow.match(/contents: read/g)).toHaveLength(1)
    expect(releaseWorkflow).not.toContain("workflow_dispatch")
    expect(releaseWorkflow).not.toMatch(/uses:\s+actions\/[^@\s]+@v\d/)
    expect(releaseWorkflow).not.toContain("runs-on: macos-14")
  })

  test("uses strict SemVer 2.0 release versions and deliberately rejects build metadata", () => {
    for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha", "1.2.3-0.3.7", "1.2.3-x.7.z-92"]) {
      expect(parseSemVer(version)).not.toBeNull()
      expect(assertReleaseVersion(version)).toBe(version)
    }
    for (const version of [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-",
      "1.2.3-.",
      "1.2.3-..",
      "1.2.3-01",
      "1.2.3-alpha..1"
    ]) {
      expect(parseSemVer(version)).toBeNull()
      expect(() => assertReleaseVersion(version)).toThrow("SemVer 2.0")
    }
    expect(parseSemVer("1.2.3+build.7")?.buildMetadata).toBe("build.7")
    expect(() => assertReleaseVersion("1.2.3+build.7")).toThrow("must not contain build metadata")
  })

  test("compilation rejects an invalid release version through the shared validator", () => {
    const result = spawnSync("bun", ["src/build.ts"], {
      cwd: path.resolve(import.meta.dir, ".."),
      encoding: "utf8",
      env: { ...process.env, ORCHESTRATE_RELEASE_VERSION: "1.2.3-01" }
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Invalid SemVer 2.0")
  })

  test("refuses populated release output without deleting caller-owned files", async () => {
    const output = path.join(root, "occupied-release")
    const marker = path.join(output, "keep.txt")
    await mkdir(output)
    await Bun.write(marker, "keep\n", { createPath: false })

    await expect(
      assembleRelease({ version: "0.1.0", repository: "example/orchestrate", output })
    ).rejects.toThrow("already exists and is not empty")
    expect(await Bun.file(marker).text()).toBe("keep\n")
  })

  test("assembles, unpacks, and executes the exact compiled macOS ARM64 payload", async () => {
    const compiled = path.resolve(import.meta.dir, "../dist/orchestrate")
    const compiledVersion = spawnSync(compiled, ["--version"], { encoding: "utf8" }).stdout.trim()
    const version = compiledVersion.match(/^@local\/orchestrate-runtime@(.+)\+[0-9a-f]{16}$/)?.[1]
    expect(version).toBeDefined()
    expect(assertReleaseVersion(version as string)).toBe(version as string)
    const artifacts = await assembleRelease({
      version: version as string,
      repository: "example/orchestrate",
      output: path.join(root, "release")
    })
    const payload = path.join(artifacts.unpacked, "orchestrate")
    const binary = path.join(payload, "bin", "orchestrate")
    const formula = await Bun.file(artifacts.formula).text()
    const plugin = await Bun.file(path.join(payload, "herdr-plugin", "herdr-plugin.toml")).text()
    expect(await inventory(payload)).toEqual(RELEASE_PAYLOAD_FILES)
    expect(plugin).toContain('on = "pane.agent_status_changed"')
    expect(plugin).toContain('command = ["sh", "bin/orchestrate-panel", "herdr-event"]')
    expect(
      (await inventory(payload)).filter((file) => file.startsWith("references/"))
    ).toHaveLength(9)
    const archiveBytes = await Bun.file(artifacts.archive).bytes()
    const independentlyComputed = createHash("sha256").update(archiveBytes).digest("hex")
    const sidecar = await Bun.file(`${artifacts.archive}.sha256`).text()
    expect(independentlyComputed).toBe(artifacts.sha256)
    expect(sidecar).toBe(`${independentlyComputed}  ${path.basename(artifacts.archive)}\n`)
    expect(formula).toContain(`version "${version}"`)
    expect(formula).toContain(`sha256 "${artifacts.sha256}"`)
    expect(formula).not.toContain("@VERSION@")
    expect(plugin).toContain(`version = "${version}"`)
    const repositoryRoot = path.resolve(import.meta.dir, "../..")
    const sourceLicense = await Bun.file(path.join(repositoryRoot, "LICENSE")).text()
    const sourceNotices = await Bun.file(
      path.join(repositoryRoot, "scripts", "THIRD_PARTY_LICENSES.txt")
    ).text()
    const payloadLicense = await Bun.file(path.join(payload, "LICENSE")).text()
    const payloadNotices = await Bun.file(path.join(payload, "THIRD_PARTY_LICENSES.txt")).text()
    expect(payloadLicense).toBe(sourceLicense)
    expect(payloadNotices).toBe(sourceNotices)
    expect(createHash("sha256").update(payloadLicense).digest("hex")).toBe(
      createHash("sha256").update(sourceLicense).digest("hex")
    )
    expect(createHash("sha256").update(payloadNotices).digest("hex")).toBe(
      createHash("sha256").update(sourceNotices).digest("hex")
    )
    const formulaPayload = path.join(root, "release", "formula-root", "libexec")
    expect(await inventory(formulaPayload)).toEqual(RELEASE_PAYLOAD_FILES)
    expect(await Bun.file(path.join(formulaPayload, "LICENSE")).text()).toBe(sourceLicense)
    expect(await Bun.file(path.join(formulaPayload, "THIRD_PARTY_LICENSES.txt")).text()).toBe(
      sourceNotices
    )
    expect(
      run(binary, ["--help"], path.join(root, "home-help"), path.join(root, "state-help")).status
    ).toBe(0)
    expect(
      run(
        binary,
        ["--version"],
        path.join(root, "home-version"),
        path.join(root, "state-version")
      ).stdout.trim()
    ).toBe(compiledVersion)

    const cwd = path.join(root, "workflow-cwd")
    const home = path.join(root, "home")
    const state = path.join(root, "state")
    await mkdir(cwd)
    await mkdir(home)
    const file = path.join(root, "workflow.json")
    await Bun.write(file, `${JSON.stringify(workflow(cwd), null, 2)}\n`, { createPath: false })
    expect(run(binary, ["validate", file, "--json"], home, state).status).toBe(0)
    const preview = run(binary, ["preview", file, "--json"], home, state)
    expect(preview.status).toBe(0)
    const digest = (JSON.parse(preview.stdout) as { digest: string }).digest
    expect(
      run(binary, ["run", file, "--approve", digest, "--dry-run", "--json"], home, state).status
    ).toBe(0)
    const setup = run(binary, ["setup", "--no-wizard", "--json"], home, state)
    expect(setup.status).toBe(0)
    expect(
      await Bun.file(
        path.join(
          home,
          ".local",
          "share",
          "orchestrate",
          "current",
          "herdr-plugin",
          "herdr-plugin.toml"
        )
      ).text()
    ).toContain(`version = "${version}"`)
  })
})
