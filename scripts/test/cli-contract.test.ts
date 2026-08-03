import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { CommandNode, WorkflowSpec } from "../src/types.js"

import {
  COMMAND_COMPLETION_SHAPES,
  PUBLIC_COMMANDS,
  PUBLIC_COMMAND_HELP,
  jsonError,
  runCli,
  setWatchInstalledHookForTests,
  structuralDiff,
  watchBeforeScan
} from "../src/cli.js"

const COMMANDS = [
  "validate",
  "preview",
  "run",
  "status",
  "events",
  "board",
  "reconcile",
  "result",
  "runs",
  "approve",
  "pause",
  "resume",
  "stop",
  "hold",
  "release",
  "revise",
  "node-done",
  "node-exit",
  "herdr-event",
  "ui",
  "clean",
  "completion",
  "setup",
  "doctor"
] as const

async function capture(action: () => Promise<number>): Promise<{ code: number; output: string }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...values: readonly unknown[]) => {
    lines.push(values.map(String).join(" "))
  }
  try {
    return { code: await action(), output: lines.join("\n") }
  } finally {
    console.log = original
  }
}

function completionValues(raw: string): readonly string[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[0] as string)
    .toSorted()
}

describe("CLI contract", () => {
  test("classifies JSON errors without changing their messages", () => {
    const cases = [
      [new Error("Unknown flag --bad for run."), "usage"],
      [new Error("ERROR schema: Expected an object."), "validation"],
      [new Error('No run matches "missing".'), "not_found"],
      [new Error('Run prefix "2026" is ambiguous: a, b.'), "conflict"],
      [new Error("herdr pane get exited 1"), "herdr"],
      [Object.assign(new Error("permission denied"), { code: "EACCES" }), "io"],
      [new Error("Unexpected provider failure."), "command_failed"]
    ] as const

    for (const [error, code] of cases) {
      expect(jsonError(error)).toEqual({
        ok: false,
        error: { code, message: error.message }
      })
    }
  })

  test("structural workflow diffs ignore object key insertion order", () => {
    const before: WorkflowSpec = {
      name: "diff-test",
      objective: "Compare workflows semantically.",
      cwd: "/tmp",
      concurrency: 1,
      callback: { type: "none" },
      milestones: false,
      limits: { maxStarts: null },
      writeConflicts: "reject",
      repeats: [],
      nodes: [
        {
          id: "build",
          type: "command",
          title: "Build",
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
          argv: ["true"],
          mutates: false,
          inheritEnv: [],
          env: { ALPHA: "1", BETA: "2" },
          allowedExitCodes: [0]
        }
      ]
    }
    const reorderedNode: CommandNode = {
      ...(before.nodes[0] as CommandNode),
      env: { BETA: "2", ALPHA: "1" }
    }
    const after: WorkflowSpec = {
      ...before,
      nodes: [reorderedNode]
    }

    expect(structuralDiff(before, after)).toEqual([])
    expect(
      structuralDiff(before, {
        ...after,
        nodes: [{ ...reorderedNode, env: { BETA: "changed", ALPHA: "1" } }]
      })
    ).toEqual(["~ node build"])
  })

  test("publishes the command vocabulary and the global exit table", async () => {
    const result = await capture(() => runCli(["--help"]))
    expect(result.code).toBe(0)
    expect(result.output).toContain("2  the observed run needs human attention")
    for (const command of COMMANDS) {
      expect(result.output).toContain(command)
    }
  })

  test("derives the exact public vocabulary from one source", () => {
    expect(PUBLIC_COMMANDS).toEqual([...COMMANDS])
    expect(Object.keys(PUBLIC_COMMAND_HELP)).toEqual([...COMMANDS])
  })

  test.each([...COMMANDS])("publishes exact side-effect-free help for %s", async (command) => {
    const result = await capture(() => runCli([command, "--help"]))
    expect(result.code).toBe(0)
    expect(result.output).toBe(PUBLIC_COMMAND_HELP[command])
  })

  test("emits the exact public command set for every shell", async () => {
    for (const shell of ["fish", "zsh", "bash"]) {
      const result = await capture(() => runCli(["completion", shell, "--json"]))
      expect(result.code).toBe(0)
      const value = JSON.parse(result.output) as { shell: string; script: string }
      expect(value).toMatchObject({ shell })
      const commandLine = value.script
        .split("\n")
        .find((line) => line.includes(PUBLIC_COMMANDS.join(" ")))
      expect(commandLine).toBeDefined()
      for (const command of PUBLIC_COMMANDS) {
        expect(value.script).toMatch(new RegExp(`(?:^|[ '(])${command}(?:$|[ )'])`))
      }
    }
  })

  test("every shell queries the exact run argument for hold, release, and result nodes", async () => {
    const scripts = Object.fromEntries(
      await Promise.all(
        (["fish", "zsh", "bash"] as const).map(async (shell) => {
          const result = await capture(() => runCli(["completion", shell, "--json"]))
          return [shell, (JSON.parse(result.output) as { script: string }).script] as const
        })
      )
    )
    expect(scripts.fish).toContain("orchestrate status $w[3]")
    expect(scripts.fish).toContain("__orchestrate_at_node")
    expect(scripts.fish).not.toContain("orchestrate status $w[2]")
    const zshRun = ["$", "{words[3]}"].join("")
    const zshCommand = ["$", "{words[2]}"].join("")
    const bashRun = ["$", "{COMP_WORDS[2]}"].join("")
    const bashCommand = ["$", "{COMP_WORDS[1]}"].join("")
    expect(scripts.zsh).toContain(`orchestrate status ${zshRun}`)
    expect(scripts.zsh).not.toContain(`orchestrate status ${zshCommand}`)
    expect(scripts.bash).toContain(`orchestrate status ${bashRun}`)
    expect(scripts.bash).not.toContain(`orchestrate status ${bashCommand}`)
  })

  test("routes live run and node candidates exclusively from every documented command shape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-completion-live-"))
    try {
      const bin = path.join(root, "bin")
      await mkdir(bin)
      await writeFile(
        path.join(bin, "orchestrate"),
        `#!/bin/sh
if [ "$1" = runs ]; then printf 'runA  running  A\nrunB  running  B\n'; exit; fi
if [ "$1" = status ]; then printf 'Nodes:\n  nodeA  running\n  nodeB  pending\n'; exit; fi
exit 1
`
      )
      await chmod(path.join(bin, "orchestrate"), 0o755)
      const scripts = Object.fromEntries(
        await Promise.all(
          (["fish", "zsh", "bash"] as const).map(async (shell) => {
            const result = await capture(() => runCli(["completion", shell, "--json"]))
            const file = path.join(root, `completion.${shell}`)
            await writeFile(file, (JSON.parse(result.output) as { script: string }).script)
            return [shell, file] as const
          })
        )
      )
      const environment = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }
      const fish = (line: string) =>
        completionValues(
          spawnSync(
            "fish",
            ["--no-config", "-c", `source ${scripts.fish}; complete -C ${JSON.stringify(line)}`],
            { encoding: "utf8", env: environment }
          ).stdout
        )
      const bash = (words: readonly string[]) =>
        completionValues(
          spawnSync(
            "bash",
            [
              "-c",
              `source ${JSON.stringify(scripts.bash)}; COMP_WORDS=(${words.map((word) => JSON.stringify(word)).join(" ")}); COMP_CWORD=$((${words.length} - 1)); _orchestrate_complete; printf '%s\\n' "\${COMPREPLY[@]}"`
            ],
            { encoding: "utf8", env: environment }
          ).stdout
        )
      const zsh = (words: readonly string[]) =>
        completionValues(
          spawnSync(
            "zsh",
            [
              "-f",
              "-c",
              `path=(${JSON.stringify(bin)} /usr/bin /bin); export PATH; function _arguments() { :; }; function compadd() { shift; printf '%s\\n' "$@"; }; words=(${words.map((word) => JSON.stringify(word)).join(" ")}); CURRENT=${words.length}; source ${JSON.stringify(scripts.zsh)}`
            ],
            { encoding: "utf8", env: environment }
          ).stdout
        )

      for (const shape of COMMAND_COMPLETION_SHAPES) {
        const prefix =
          "subcommand" in shape
            ? ["orchestrate", shape.command, shape.subcommand]
            : ["orchestrate", shape.command]
        expect(fish(`${prefix.join(" ")} `)).toEqual(["runA", "runB"])
        expect(bash([...prefix, ""])).toEqual(["runA", "runB"])
        expect(zsh([...prefix, ""])).toEqual(["runA", "runB"])
        if (shape.nodeWord === 4) {
          expect(fish(`${prefix.join(" ")} runA `)).toEqual(["nodeA", "nodeB"])
          expect(bash([...prefix, "runA", ""])).toEqual(["nodeA", "nodeB"])
          expect(zsh([...prefix, "runA", ""])).toEqual(["nodeA", "nodeB"])
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("watch-before-scan closes deterministic status and event interleavings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-watch-before-scan-"))
    try {
      const state = path.join(root, "state.json")
      await writeFile(state, '{"status":"running"}\n')
      setWatchInstalledHookForTests(async () => {
        await writeFile(state, '{"status":"completed"}\n')
      })
      const settled = await Promise.race([
        watchBeforeScan(state, async () => {
          const value = JSON.parse(await readFile(state, "utf8")) as { status: string }
          return value.status === "running" ? null : value
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("lost wakeup")), 1_000)
        )
      ])
      expect(settled).toEqual({ status: "completed" })

      const events = path.join(root, "events.json")
      await writeFile(events, "[]\n")
      const emitted: number[] = []
      setWatchInstalledHookForTests(async () => {
        await writeFile(events, '[{"sequence":1}]\n')
      })
      await Promise.race([
        watchBeforeScan(events, async () => {
          const current = JSON.parse(await readFile(events, "utf8")) as Array<{
            sequence: number
          }>
          emitted.push(...current.map((event) => event.sequence))
          return current.length === 0 ? null : true
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("lost wakeup")), 1_000)
        )
      ])
      expect(emitted).toEqual([1])
    } finally {
      setWatchInstalledHookForTests(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("the CLI specification contains every exact live usage shape", async () => {
    const specification = await readFile(
      new URL("../../references/cli-spec.md", import.meta.url),
      "utf8"
    )
    for (const help of Object.values(PUBLIC_COMMAND_HELP)) {
      for (const line of help.split("\n")) {
        const shape = line
          .trim()
          .replace(/^Usage: orchestrate /, "")
          .replace(/^orchestrate /, "")
        expect(specification).toContain(shape.replaceAll("|", "\\|"))
      }
    }
  })
})
