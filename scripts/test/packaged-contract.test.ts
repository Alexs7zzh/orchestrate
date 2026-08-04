import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PUBLIC_COMMANDS, PUBLIC_COMMAND_HELP } from "../src/cli.js"
import { assertReleaseVersion } from "../src/semver.js"

setDefaultTimeout(30_000)

let temporaryRoot = ""
let binary = ""
let stateDir = ""
let shimDir = ""
let herdrLog = ""

function workflow() {
  return {
    name: "packaged-test",
    objective: "Exercise the packaged CLI.",
    cwd: temporaryRoot,
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

function agentWorkflow() {
  const base = workflow()
  const command = base.nodes[0]!
  return {
    ...base,
    nodes: [
      {
        id: command.id,
        type: "agent",
        title: command.title,
        needs: command.needs,
        cwd: command.cwd,
        workspace: command.workspace,
        inputs: command.inputs,
        retry: command.retry,
        gate: command.gate,
        provider: "codex",
        model: "provider-default",
        effort: "high",
        prompt: "Complete the result contract.",
        session: { mode: "fresh", from: null, saveAs: null },
        permissions: {
          execution: { sandbox: "read-only" },
          escalation: "deny",
          extraArgs: [],
          inheritEnv: [],
          env: {}
        },
        output: { format: "text", schema: null }
      }
    ]
  }
}

function run(args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}) {
  return spawnSync(binary, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      ORCHESTRATE_STATE_DIR: stateDir,
      ORCHESTRATE_DISABLE_UI: "1",
      ...extraEnv
    }
  })
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-packaged-"))
  binary = path.resolve(import.meta.dir, "../dist/orchestrate")
  stateDir = path.join(temporaryRoot, "state")
  shimDir = path.join(temporaryRoot, "bin")
  herdrLog = path.join(temporaryRoot, "herdr.log")
  await mkdir(shimDir)
  const shim = `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(herdrLog)}
case "$1 $2" in
  "--version ") printf 'herdr 0.7.5\n' ;;
  "workspace list") printf '%s\n' '{"id":"cli:workspace:list","result":{"type":"workspace_list","workspaces":[]}}' ;;
  "workspace create") printf '%s\n' '{"id":"cli:workspace:create","result":{"type":"workspace_created","workspace":{"workspace_id":"w1","number":1,"label":"packaged-test","focused":false,"pane_count":1,"tab_count":1,"active_tab_id":"t1","agent_status":"idle"},"tab":{"tab_id":"t1","workspace_id":"w1","number":1,"label":"packaged-test","focused":false,"pane_count":1,"agent_status":"idle"},"root_pane":{"terminal_id":"terminal-p1","agent_status":"idle","workspace_id":"w1","tab_id":"t1","pane_id":"p1","focused":false,"revision":1}}}' ;;
  "tab create")
    count_file=${JSON.stringify(`${herdrLog}.tabs`)}
    count=$(cat "$count_file" 2>/dev/null || printf 0)
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    printf '{"id":"cli:tab:create","result":{"type":"tab_created","root_pane":{"terminal_id":"terminal-p%s","agent_status":"idle","workspace_id":"w1","tab_id":"t%s","pane_id":"p%s","focused":false,"revision":1},"tab":{"tab_id":"t%s","workspace_id":"w1","number":%s,"label":"check","focused":false,"pane_count":1,"agent_status":"idle"}}}\n' "$count" "$count" "$count" "$count" "$count" ;;
  "pane get") printf '%s\n' '{"id":"cli:pane:get","result":{"type":"pane_info","pane":{"terminal_id":"terminal-p1","agent_status":"idle","workspace_id":"w1","tab_id":"t1","pane_id":"p1","focused":false,"revision":1}}}' ;;
  "pane current") printf '%s\n' '{"id":"cli:pane:current","result":{"type":"pane_current","pane":{"terminal_id":"terminal-p1","agent_status":"idle","agent":null,"agent_session":null,"workspace_id":"w1","tab_id":"t1","pane_id":"p1","focused":false,"revision":1}}}' ;;
  "pane list")
    count_file=${JSON.stringify(`${herdrLog}.tabs`)}
    count=$(cat "$count_file" 2>/dev/null || printf 0)
    printf '%s' '{"id":"cli:pane:list","result":{"type":"pane_list","panes":['
    index=1
    while [ "$index" -le "$count" ]; do
      [ "$index" -eq 1 ] || printf ','
      pane_id="p$index"
      if [ "$pane_id" = "\${HERDR_DONE_PANE-}" ]; then status=done; else status=idle; fi
      printf '{"terminal_id":"terminal-%s","agent_status":"%s","workspace_id":"w1","tab_id":"t%s","pane_id":"%s","focused":false,"revision":1}' "$pane_id" "$status" "$index" "$pane_id"
      index=$((index + 1))
    done
    printf '%s\n' ']}}' ;;
  "agent get")
    if [ "$3" = "\${HERDR_DONE_PANE-}" ]; then status=done; else status=idle; fi
    printf '{"id":"cli:agent:get","result":{"type":"agent_info","agent":{"terminal_id":"terminal-%s","agent_status":"%s","workspace_id":"w1","tab_id":"t1","pane_id":"%s","focused":false,"revision":1,"agent":"codex","agent_session":{"agent":"codex","kind":"id","source":"herdr:codex","value":"session-%s"}}}}\n' "$3" "$status" "$3" "$3" ;;
  "plugin list") printf '%s\n' '{"result":{"plugins":[{"id":"orchestrate"}]}}' ;;
  "plugin link") [ "\${HERDR_FAIL_LINK-}" = 1 ] && { printf 'link failed\n' >&2; exit 9; }; true ;;
  "plugin unlink") [ "\${HERDR_FAIL_UNLINK-}" = 1 ] && { printf 'unlink failed\n' >&2; exit 9; }; true ;;
  "tab list") printf '%s\n' '{"id":"cli:tab:list","result":{"type":"tab_list","tabs":[]}}' ;;
  *) printf '%s\n' '{"id":"cli:test","result":{"type":"ok"}}' ;;
esac
`
  await writeFile(path.join(shimDir, "herdr"), shim)
  await chmod(path.join(shimDir, "herdr"), 0o755)
  await writeFile(path.join(shimDir, "codex"), "#!/bin/sh\nexit 0\n")
  await chmod(path.join(shimDir, "codex"), 0o755)
})

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe("packaged CLI", () => {
  test("executes the compiled binary for exact help and version contracts", () => {
    expect(run(["--help"]).stdout).toContain("orchestrate — herdr-native")
    const identity = run(["--version"]).stdout.trim()
    const match = identity.match(/^@local\/orchestrate-runtime@(.+)\+([0-9a-f]{16})$/)
    expect(match).not.toBeNull()
    const releaseVersion = match?.[1]
    expect(releaseVersion).toBeDefined()
    expect(assertReleaseVersion(releaseVersion as string)).toBe(releaseVersion as string)
    expect(run(["--version"], { ORCHESTRATE_BUILD_ID: "forged-version" }).stdout.trim()).toBe(
      identity
    )
    for (const command of PUBLIC_COMMANDS) {
      const result = run([command, "--help"])
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(PUBLIC_COMMAND_HELP[command])
    }
  })

  test("refuses build A state from build B even when the environment forges build A", async () => {
    const file = path.join(temporaryRoot, "build-pinning-workflow.json")
    await writeFile(file, `${JSON.stringify(workflow(), null, 2)}\n`)
    const preview = run(["preview", file, "--json"])
    const digest = (JSON.parse(preview.stdout) as { digest: string }).digest
    const started = run(["run", file, "--approve", digest, "--json"])
    expect(started.status).toBe(0)
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId
    const buildB = run(["--version"]).stdout.trim()
    const journal = path.join(stateDir, "runs", runId, "events.json")
    const buildAJournal = (await readFile(journal, "utf8")).replaceAll(buildB, "build-a")
    await writeFile(journal, buildAJournal)

    const rejected = run(["status", runId, "--json"], {
      ORCHESTRATE_BUILD_ID: "build-a"
    })
    expect(rejected.status).not.toBe(0)
    expect(rejected.stderr).toBe("")
    expect(JSON.parse(rejected.stdout).error.message).toContain("matching CLI")
    expect(run(["--version"], { ORCHESTRATE_BUILD_ID: "build-a" }).stdout.trim()).toBe(buildB)
  })

  test("validates, previews, dry-runs without state mutation, and starts fire-and-forget", async () => {
    const file = path.join(temporaryRoot, "workflow.json")
    await writeFile(file, `${JSON.stringify(workflow(), null, 2)}\n`)
    const validated = run(["validate", file, "--json"])
    expect(validated.status).toBe(0)
    const validation = JSON.parse(validated.stdout)
    expect(validation.workflow.name).toBe("packaged-test")

    const previewed = run(["preview", file, "--json"])
    expect(previewed.status).toBe(0)
    const preview = JSON.parse(previewed.stdout)
    expect(preview.digest).toHaveLength(64)
    expect(preview).toMatchObject({
      limits: { maxStarts: null },
      callback: { type: "none" },
      milestones: false,
      writeConflicts: "reject"
    })

    const dry = run(["run", file, "--approve", preview.digest, "--dry-run", "--json"])
    expect(dry.status).toBe(0)
    expect(JSON.parse(dry.stdout).ok).toBeTrue()
    expect(await readdir(stateDir).catch(() => [])).toEqual([])
    expect(await readFile(herdrLog, "utf8").catch(() => "")).toBe("--version\n")

    const started = run(["run", file, "--approve", preview.digest, "--json"])
    expect(started.stderr).toBe("")
    expect(started.status).toBe(0)
    const runId = JSON.parse(started.stdout).runId as string
    expect(runId).toMatch(/^\d{14}-[0-9a-f]{8}$/)

    expect(run(["events", runId]).stdout).toContain("run.started")
    expect(JSON.parse(run(["events", runId, "--json"]).stdout).events).toBeArray()
    expect(run(["runs"]).stdout).toContain(runId)
    expect(JSON.parse(run(["runs", "--active", "--json"]).stdout).runs[0].runId).toBe(runId)
    expect(run(["board", runId]).stdout).toContain("Nodes:")
    expect(JSON.parse(run(["board", runId, "--json"]).stdout).run.id).toBe(runId)

    const state = JSON.parse(
      await readFile(path.join(stateDir, "runs", runId, "state.json"), "utf8")
    ) as { nodes: { check: { attempts: Array<{ outputPath: string }> } } }
    const outputPath = state.nodes.check.attempts.at(-1)?.outputPath as string
    await writeFile(outputPath, "compiled result\n")
    expect(run(["result", runId, "check"]).stdout).toBe("compiled result\n\n")
    expect(run(["result", runId.slice(0, 18), "check"]).stdout).toBe("compiled result\n\n")
    const resultJson = JSON.parse(
      run(["result", runId, "check", "--attempt", "1", "--json"]).stdout
    )
    expect(resultJson.content).toBe("compiled result\n")
    expect(resultJson).toMatchObject({ status: "running", downstreamHeld: false, holds: [] })

    expect(run(["hold", runId, "check", "--json"]).status).toBe(0)
    const heldStatus = JSON.parse(run(["status", runId, "--json"]).stdout)
    expect(heldStatus.holds).toEqual([
      expect.objectContaining({ target: "check", scope: "instance" })
    ])
    expect(heldStatus.nodes[0]).toMatchObject({
      id: "check",
      status: "running",
      downstreamHeld: true,
      holdTargets: ["check"]
    })
    expect(run(["release", runId, "check", "--json"]).status).toBe(0)
    const revised = { ...workflow(), objective: "Exercise revision dispatch." }
    const revisionFile = path.join(temporaryRoot, "revision.json")
    await writeFile(revisionFile, `${JSON.stringify(revised, null, 2)}\n`)
    const proposed = run(["revise", runId, revisionFile, "--json"])
    expect(proposed.status).toBe(0)
    const revisionDigest = JSON.parse(proposed.stdout).digest as string
    expect(run(["approve", runId, "--revision", revisionDigest, "--json"]).status).toBe(0)

    const paused = run(["pause", runId, "--json"])
    expect(paused.status).toBe(0)
    expect(JSON.parse(paused.stdout).status).toBe("paused")
    const status = run(["status", runId, "--json"])
    expect(status.status).toBe(2)
    expect(JSON.parse(status.stdout).needsAttention).toBeTrue()
    const prefix = runId.slice(0, 18)
    expect(JSON.parse(run(["status", prefix, "--json"]).stdout).runId).toBe(runId)
    expect(run(["board", runId, "--json"]).status).toBe(2)
    expect(run(["board", runId]).status).toBe(2)
    expect(run(["resume", runId, "--json"]).status).toBe(0)
    expect(run(["pause", runId, "--json"]).status).toBe(0)
    expect(run(["stop", runId, "--yes", "--json"]).status).toBe(0)
  })

  test("previews callback side effects and policies without exposing credentials", async () => {
    const callbacks = [
      {
        callback: {
          type: "command" as const,
          argv: ["/usr/bin/env", "SECRET=value", "publish"],
          timeoutSeconds: 30
        },
        expected: {
          type: "command",
          executable: "/usr/bin/env",
          argumentCount: 2,
          timeoutSeconds: 30
        }
      },
      {
        callback: {
          type: "webhook" as const,
          url: "https://user:password@example.invalid/hook?token=secret#fragment",
          headers: { Authorization: "Bearer secret", "X-Route": "release" },
          timeoutSeconds: 15
        },
        expected: {
          type: "webhook",
          endpoint: "https://example.invalid/hook",
          headerNames: ["Authorization", "X-Route"],
          timeoutSeconds: 15
        }
      }
    ]
    for (const [index, candidate] of callbacks.entries()) {
      const file = path.join(temporaryRoot, `callback-${index}.json`)
      await writeFile(
        file,
        `${JSON.stringify({
          ...workflow(),
          callback: candidate.callback,
          milestones: true,
          limits: { maxStarts: 7 },
          writeConflicts: "allow-with-approval"
        })}\n`
      )
      const jsonPreview = run(["preview", file, "--json"])
      expect(jsonPreview.status).toBe(0)
      expect(JSON.parse(jsonPreview.stdout)).toMatchObject({
        callback: candidate.expected,
        milestones: true,
        limits: { maxStarts: 7 },
        writeConflicts: "allow-with-approval"
      })
      const plain = run(["preview", file])
      expect(plain.stdout).toContain("Max starts: 7")
      expect(plain.stdout).toContain("Milestones: true")
      expect(plain.stdout).toContain("Write conflicts: allow-with-approval")
      expect(plain.stdout).not.toContain("password")
      expect(plain.stdout).not.toContain("secret")
    }
  })

  test("dry-run performs the read-only herdr >=0.7 version preflight", async () => {
    const file = path.join(temporaryRoot, "dry-run-version-workflow.json")
    await writeFile(file, `${JSON.stringify(workflow(), null, 2)}\n`)
    const digest = JSON.parse(run(["preview", file, "--json"]).stdout).digest as string
    const oldBin = path.join(temporaryRoot, "old-herdr-bin")
    const oldLog = path.join(temporaryRoot, "old-herdr.log")
    await mkdir(oldBin)
    await writeFile(
      path.join(oldBin, "herdr"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(oldLog)}\necho 'herdr 0.6.9'\n`
    )
    await chmod(path.join(oldBin, "herdr"), 0o755)
    const rejected = run(["run", file, "--approve", digest, "--dry-run", "--json"], {
      PATH: `${oldBin}:${process.env.PATH ?? ""}`
    })
    expect(rejected.status).toBe(1)
    expect(JSON.parse(rejected.stdout).checks).toContainEqual(
      expect.objectContaining({ name: "herdr", ok: false })
    )
    expect(await readFile(oldLog, "utf8")).toBe("--version\n")
    expect(await readdir(stateDir).catch(() => [])).toEqual([])
  })

  test("rejects unknown commands and flags", () => {
    for (const command of ["unknown-one", "unknown-two"]) {
      const result = run([command])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`Unknown command "${command}"`)
    }
    const result = run(["resume", "missing", "--unknown-flag", "node"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unknown flag --unknown-flag")
  })

  test("emits exactly one stable JSON error for dispatch plus every public command", () => {
    const commandCases: Record<(typeof PUBLIC_COMMANDS)[number], readonly string[]> = {
      validate: ["validate", path.join(temporaryRoot, "missing.json"), "--json"],
      preview: ["preview", path.join(temporaryRoot, "missing.json"), "--json"],
      run: ["run", path.join(temporaryRoot, "missing.json"), "--json"],
      status: ["status", "invalid!", "--json"],
      events: ["events", "invalid!", "--json"],
      board: ["board", "invalid!", "--json"],
      reconcile: ["reconcile", "invalid!", "--json"],
      result: ["result", "invalid!", "--json"],
      runs: ["runs", "--bad", "--json"],
      approve: ["approve", "invalid!", "--json"],
      pause: ["pause", "invalid!", "extra", "--json"],
      resume: ["resume", "invalid!", "extra", "--json"],
      stop: ["stop", "invalid!", "extra", "--json"],
      hold: ["hold", "invalid!", "--json"],
      release: ["release", "invalid!", "--json"],
      revise: ["revise", "--json"],
      "node-done": ["node-done", "invalid!", "--json"],
      "node-exit": ["node-exit", "invalid!", "--json"],
      "herdr-event": ["herdr-event", "--json"],
      ui: ["ui", "wizard", "--json"],
      clean: ["clean", "--json"],
      completion: ["completion", "nope", "--json"],
      setup: ["setup", "--remove=false", "--json"],
      doctor: ["doctor", "extra", "--json"]
    }
    expect(Object.keys(commandCases)).toEqual([...PUBLIC_COMMANDS])
    for (const args of [["unknown", "--json"], ...Object.values(commandCases)]) {
      const result = run(args)
      expect(result.status).toBe(1)
      expect(result.stderr).toBe("")
      const lines = result.stdout.trim().split("\n")
      expect(lines).toHaveLength(1)
      const payload = JSON.parse(lines[0] as string) as {
        readonly ok: boolean
        readonly error: { readonly code: string; readonly message: string }
      }
      expect(payload.ok).toBe(false)
      expect([
        "usage",
        "validation",
        "not_found",
        "conflict",
        "herdr",
        "io",
        "command_failed"
      ]).toContain(payload.error.code)
      expect(payload.error.message.length).toBeGreaterThan(0)
    }
  })

  test("rejects values on booleans before any setup, stop, or dry-run action", async () => {
    const home = path.join(temporaryRoot, "boolean-home")
    await mkdir(home)
    for (const args of [
      ["setup", "--remove=false", "--json"],
      ["stop", "missing", "--yes=false", "--json"],
      ["run", "missing.json", "--dry-run=false", "--json"]
    ]) {
      const result = run(args, { HOME: home })
      expect(result.status).toBe(1)
      expect(result.stderr).toBe("")
      expect(JSON.parse(result.stdout).error.message).toContain("does not accept a value")
    }
    expect(await readdir(home)).toEqual([])
  })

  test.each([
    [["runs", "--active", "--paused"], "at most one filter"],
    [
      ["resume", "missing", "--continue-rounds", "1", "--accept-repeat", "loop"],
      "one max-rounds decision"
    ],
    [["approve", "missing", "--gate", "node"], "requires exactly"],
    [["setup", "--defaults", "--no-wizard", "--json"], "not both"],
    [["clean", "missing", "--settled", "--dry-run"], "requires one run or --settled"],
    [["revise", "missing", "file.json", "--discard"], "does not accept a workflow file"],
    [["ui", "edit", "--json"], "cannot be used with --json"],
    [["ui", "wizard", "--json"], "cannot be used with --json"]
  ] as const)("rejects invalid documented combination %#", (args, message) => {
    const result = run(args)
    expect(result.status).toBe(1)
    if ((args as readonly string[]).includes("--json")) {
      expect(result.stderr).toBe("")
      expect(JSON.parse(result.stdout).error.message).toContain(message)
    } else {
      expect(result.stderr).toContain(message)
    }
  })

  test("dispatches alternate documented shapes with their complete arity", async () => {
    expect(run(["clean", "--settled", "--dry-run", "--json"]).status).toBe(0)
    expect(JSON.parse(run(["completion", "fish", "--json"]).stdout).shell).toBe("fish")
    const home = path.join(temporaryRoot, "alternate-home")
    await mkdir(home)
    expect(run(["setup", "--remove", "--dry-run", "--json"], { HOME: home }).status).toBe(0)
    for (const [args, message] of [
      [
        ["approve", "deadbeef", "--gate", "node", "--digest", "a".repeat(64), "--json"],
        "No run matches"
      ],
      [["revise", "deadbeef", "--discard", "--json"], "No run matches"],
      [
        ["node-done", "deadbeef", "node", "--token", "token", "--outcome", "completed", "--json"],
        "Invalid full run id"
      ],
      [
        ["node-exit", "deadbeef", "node", "--token", "token", "--code", "0", "--json"],
        "No run matches"
      ],
      [["ui", "restore", "deadbeef", "--json"], "No run matches"]
    ] as const) {
      const result = run(args)
      expect(result.status).toBe(1)
      expect(result.stderr).toBe("")
      expect(JSON.parse(result.stdout).error.message).toContain(message)
      expect(JSON.parse(result.stdout).error.message).not.toContain("Usage: orchestrate")
    }
  })

  test("uses identical plain help with and without NO_COLOR", () => {
    const regular = run(["--help"])
    const disabled = run(["--help"], { NO_COLOR: "1" })
    expect(regular.stdout).toBe(disabled.stdout)
  })

  test("clean dry-run leaves the run directory byte-identical", async () => {
    const file = path.join(temporaryRoot, "workflow.json")
    await writeFile(file, `${JSON.stringify(workflow(), null, 2)}\n`)
    const preview = JSON.parse(run(["preview", file, "--json"]).stdout)
    const started = JSON.parse(run(["run", file, "--approve", preview.digest, "--json"]).stdout)
    const runPath = path.join(stateDir, "runs", started.runId)
    const before = await readFile(path.join(runPath, "state.json"), "utf8")
    const dry = run(["clean", started.runId, "--dry-run", "--json"])
    expect(dry.status).toBe(0)
    expect(await readFile(path.join(runPath, "state.json"), "utf8")).toBe(before)
    const rejected = run(["clean", started.runId, "--json"])
    expect(rejected.status).toBe(1)
    expect(JSON.parse(rejected.stdout).error.message).toContain("stop it before cleaning")
    expect(run(["stop", started.runId, "--yes", "--json"]).status).toBe(0)
    expect(run(["clean", started.runId, "--json"]).status).toBe(0)
    expect(await readdir(runPath).catch(() => [])).toEqual([])
  })

  test("setup no-wizard leaves preferences untouched and defaults writes a valid layer", async () => {
    const home = path.join(temporaryRoot, "home")
    await mkdir(home)
    const untouched = run(["setup", "--no-wizard", "--json"], { HOME: home })
    expect(untouched.status).toBe(0)
    expect(
      await readFile(path.join(stateDir, "preferences.json"), "utf8").catch(() => null)
    ).toBeNull()

    const defaulted = run(["setup", "--defaults", "--json"], { HOME: home })
    expect(defaulted.status).toBe(0)
    const preferences = JSON.parse(await readFile(path.join(stateDir, "preferences.json"), "utf8"))
    expect(preferences.global.ui).toMatchObject({ board: null, focus: null })
    expect(run(["ui", "show", "--json"], { HOME: home }).status).toBe(0)
    expect(run(["ui", "set", "focus", '"never"', "--json"], { HOME: home }).status).toBe(0)
    expect(JSON.parse(run(["ui", "show", "--json"], { HOME: home }).stdout).focus).toBe("never")
    expect(run(["doctor", "--json"], { HOME: home }).status).toBe(0)
  })

  test("required plugin link and unlink failures fail compiled setup and make doctor unhealthy", async () => {
    const home = path.join(temporaryRoot, "plugin-home")
    await mkdir(home)
    const linkFailure = run(["setup", "--no-wizard", "--json"], {
      HOME: home,
      HERDR_FAIL_LINK: "1"
    })
    expect(linkFailure.status).toBe(1)
    expect(linkFailure.stderr).toBe("")
    expect(JSON.parse(linkFailure.stdout).error.message).toContain("plugin link exited with 9")
    expect(
      await readFile(
        path.join(home, ".local", "share", "orchestrate", "current", "build.json"),
        "utf8"
      ).catch(() => null)
    ).toBeNull()

    expect(run(["setup", "--no-wizard", "--json"], { HOME: home }).status).toBe(0)
    const unlinkFailure = run(["setup", "--remove", "--json"], {
      HOME: home,
      HERDR_FAIL_UNLINK: "1"
    })
    expect(unlinkFailure.status).toBe(1)
    expect(JSON.parse(unlinkFailure.stdout).error.message).toContain("plugin unlink exited with 9")
    expect(
      await readFile(
        path.join(home, ".local", "share", "orchestrate", "current", "build.json"),
        "utf8"
      )
    ).toContain("build")

    const unhealthyBin = path.join(temporaryRoot, "unhealthy-bin")
    await mkdir(unhealthyBin)
    await writeFile(
      path.join(unhealthyBin, "herdr"),
      '#!/bin/sh\ncase "$1 $2" in "--version ") echo "herdr 0.7.5";; "plugin list") echo \'{"result":{"plugins":[]}}\';; esac\n'
    )
    await chmod(path.join(unhealthyBin, "herdr"), 0o755)
    const doctor = run(["doctor", "--json"], {
      HOME: home,
      PATH: `${unhealthyBin}:${process.env.PATH ?? ""}`
    })
    expect(doctor.status).toBe(1)
    const report = JSON.parse(doctor.stdout)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "herdr-plugin", ok: false })
    )
  })

  test("a run does not mutate the UI-only preferences contract", async () => {
    const home = path.join(temporaryRoot, "preferences-home")
    await mkdir(home)
    expect(run(["setup", "--defaults", "--json"], { HOME: home }).status).toBe(0)
    const preferencesPath = path.join(stateDir, "preferences.json")
    const before = await readFile(preferencesPath, "utf8")
    const file = path.join(temporaryRoot, "preferences-workflow.json")
    await writeFile(file, `${JSON.stringify(workflow(), null, 2)}\n`)
    const preview = JSON.parse(run(["preview", file, "--json"], { HOME: home }).stdout)
    expect(run(["run", file, "--approve", preview.digest, "--json"], { HOME: home }).status).toBe(0)
    expect(await readFile(preferencesPath, "utf8")).toBe(before)
  })

  test("board --json remains noninteractive under a TTY with multiple runs", async () => {
    const file = path.join(temporaryRoot, "tty-workflow.json")
    await writeFile(file, `${JSON.stringify(workflow(), null, 2)}\n`)
    const digest = JSON.parse(run(["preview", file, "--json"]).stdout).digest as string
    expect(run(["run", file, "--approve", digest, "--json"]).status).toBe(0)
    expect(run(["run", file, "--approve", digest, "--json"]).status).toBe(0)
    const result = spawnSync("script", ["-q", "/dev/null", binary, "board", "--json"], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        ORCHESTRATE_STATE_DIR: stateDir,
        ORCHESTRATE_DISABLE_UI: "1"
      }
    })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe("")
    const normalized = result.stdout.replaceAll("\r", "")
    const jsonStart = normalized.indexOf("{")
    expect(jsonStart).toBeGreaterThanOrEqual(0)
    expect(() => JSON.parse(normalized.slice(jsonStart).trim())).not.toThrow()
    expect(result.stdout).not.toContain("Open run")
  })

  test("discovers an older live result-missing run across runs, board JSON, and the panel", async () => {
    const file = path.join(temporaryRoot, "attention-workflow.json")
    await writeFile(file, `${JSON.stringify(agentWorkflow(), null, 2)}\n`)
    const digest = JSON.parse(run(["preview", file, "--json"]).stdout).digest as string
    const older = JSON.parse(run(["run", file, "--approve", digest, "--json"]).stdout)
      .runId as string
    const newer = JSON.parse(run(["run", file, "--approve", digest, "--json"]).stdout)
      .runId as string
    expect(newer).not.toBe(older)
    const env = { HERDR_DONE_PANE: "p1" }
    const attention = run(["runs", "--needs-attention", "--json"], env)
    expect(attention.status).toBe(2)
    expect(JSON.parse(attention.stdout).runs.map((item: { runId: string }) => item.runId)).toEqual([
      older
    ])
    const board = run(["board", "--json"], env)
    expect(board.status).toBe(2)
    const model = JSON.parse(board.stdout)
    expect(model.run.id).toBe(older)
    expect(model.needsYou).toEqual([
      expect.objectContaining({ condition: "done", title: "check: result missing" })
    ])

    const panelLog = path.join(temporaryRoot, "panel-cli.log")
    await writeFile(
      path.join(shimDir, "orchestrate"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(panelLog)}\nexec ${JSON.stringify(binary)} "$@"\n`
    )
    await chmod(path.join(shimDir, "orchestrate"), 0o755)
    const panel = spawnSync(
      "/bin/sh",
      [path.resolve(import.meta.dir, "../../herdr-plugin/bin/orchestrate-panel")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          ORCHESTRATE_STATE_DIR: stateDir,
          ORCHESTRATE_DISABLE_UI: "1",
          HERDR_DONE_PANE: "p1"
        }
      }
    )
    expect(panel.status).toBe(2)
    expect(await readFile(panelLog, "utf8")).toBe(`runs --needs-attention\nboard ${older}\n`)
    expect(panel.stdout).toContain("result missing")
  })
})
