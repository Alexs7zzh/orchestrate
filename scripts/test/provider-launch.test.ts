import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AgentNode, WorkflowSpec } from "../src/types.js"

import {
  compileProviderLaunchIdentity,
  compileProviderPath,
  decodeMaterializedProviderRelay,
  decodeProviderLaunchIdentity,
  materializeProviderRelay,
  revalidateProviderLaunchIdentity
} from "../src/provider-launch.js"
import { assertWorkflowProviderLaunchIsolation } from "../src/validation.js"

let root = ""
let bin = ""

async function executable(name: string, content: string): Promise<string> {
  const target = path.join(bin, name)
  await Bun.write(target, content, { createPath: false })
  await chmod(target, 0o755)
  return target
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-provider-launch-"))
  bin = path.join(root, "bin")
  await mkdir(bin)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("provider launch identity", () => {
  test("compiles native, absolute-shebang, env, and env-split execution argv", async () => {
    await symlink("/usr/bin/true", path.join(bin, "codex"))
    const native = await compileProviderLaunchIdentity("codex", bin)
    expect(native.shebangChain).toEqual([])
    expect(native.executionArgv).toEqual([native.entry.canonicalPath])
    expect(native.entry.sha256).toMatch(/^[0-9a-f]{64}$/)

    await rm(path.join(bin, "codex"))
    const absolute = await executable("codex", "#!/bin/sh\nprintf '%s\\n' \"$*\"\n")
    const absoluteIdentity = await compileProviderLaunchIdentity("codex", bin)
    expect(absoluteIdentity.shebangChain.map((hop) => hop.kind)).toEqual(["absolute"])
    expect(absoluteIdentity.fixedArguments).toEqual([await pathFor(absolute)])

    await symlink("/bin/sh", path.join(bin, "launch-shell"))
    await executable("codex", "#!/usr/bin/env launch-shell\nexit 0\n")
    const envIdentity = await compileProviderLaunchIdentity("codex", bin)
    expect(envIdentity.shebangChain.map((hop) => hop.kind)).toEqual(["env"])
    expect(envIdentity.shebangChain[0]?.lookup?.command).toBe("launch-shell")

    await executable("codex", "#!/usr/bin/env -S launch-shell -e\nexit 0\n")
    const splitIdentity = await compileProviderLaunchIdentity("codex", bin)
    expect(splitIdentity.shebangChain.map((hop) => hop.kind)).toEqual(["env-split"])
    expect(splitIdentity.fixedArguments).toEqual(["-e", await pathFor(path.join(bin, "codex"))])
  })

  test("preserves exact argv through nested interpreter scripts", async () => {
    const middle = await executable("middle", "#!/bin/sh\nexit 0\n")
    const entry = await executable("codex", `#!${middle} outer-argument\nexit 0\n`)
    const identity = await compileProviderLaunchIdentity("codex", bin)
    expect(identity.shebangChain).toHaveLength(2)
    expect(identity.fixedArguments).toEqual([
      await pathFor(middle),
      "outer-argument",
      await pathFor(entry)
    ])
    expect(identity.executionArgv).toEqual([
      identity.terminalExecutable.lexicalPath,
      ...identity.fixedArguments
    ])
  })

  test("rejects malformed, ambiguous, and recursive interpreter chains", async () => {
    for (const source of [
      "#!sh\n",
      "#!/usr/bin/env\n",
      "#!/usr/bin/env -i sh\n",
      "#!/usr/bin/env -S 'sh'\n"
    ]) {
      await executable("codex", source)
      await expect(compileProviderLaunchIdentity("codex", bin)).rejects.toThrow()
    }

    const first = path.join(bin, "codex")
    const second = path.join(bin, "second")
    await executable("codex", `#!${second}\n`)
    await executable("second", `#!${first}\n`)
    await expect(compileProviderLaunchIdentity("codex", bin)).rejects.toThrow("recursive")
  })

  test("rejects empty, relative, and unreadable PATH authority and deduplicates aliases", async () => {
    await expect(compileProviderPath(`${bin}${path.delimiter}`)).rejects.toThrow("empty component")
    await expect(compileProviderPath(`relative${path.delimiter}${bin}`)).rejects.toThrow("relative")

    const alias = path.join(root, "alias")
    await symlink(bin, alias)
    const deduplicated = await compileProviderPath(`${bin}${path.delimiter}${alias}`)
    expect(deduplicated.directories).toHaveLength(1)
    expect(deduplicated.normalizedPath).toBe(bin)

    const denied = path.join(root, "denied")
    await mkdir(denied)
    await Bun.write(path.join(denied, "codex"), "#!/bin/sh\nexit 0\n", { createPath: false })
    await chmod(path.join(denied, "codex"), 0o755)
    await chmod(denied, 0o000)
    try {
      await expect(
        compileProviderLaunchIdentity("codex", `${denied}${path.delimiter}${bin}`)
      ).rejects.toThrow()
    } finally {
      await chmod(denied, 0o700)
    }
  })

  test("materializes a pinned relay that survives ambient PATH replacement", async () => {
    await executable("codex", "#!/bin/sh\nprintf 'provider:%s\\n' \"$1\"\n")
    const identity = await compileProviderLaunchIdentity("codex", bin)
    const relay = await materializeProviderRelay(identity, path.join(root, "control"))
    const child = Bun.spawn([relay.path, "ok"], {
      env: { PATH: path.join(root, "poisoned") },
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(await new Response(child.stdout).text()).toBe("provider:ok\n")
    expect(await child.exited).toBe(0)
    expect(relay.environmentPath).toBe(`${relay.directory.canonicalPath}${path.delimiter}${bin}`)
    await revalidateProviderLaunchIdentity(identity, relay)
  })

  test("revalidation rejects in-place content changes and executable mode changes", async () => {
    const entry = await executable("codex", "#!/bin/sh\nexit 0\n")
    const contentIdentity = await compileProviderLaunchIdentity("codex", bin)
    await Bun.write(entry, "#!/bin/sh\nexit 1\n", { createPath: false })
    await expect(revalidateProviderLaunchIdentity(contentIdentity)).rejects.toThrow("changed")

    await executable("codex", "#!/bin/sh\nexit 0\n")
    const modeIdentity = await compileProviderLaunchIdentity("codex", bin)
    await chmod(entry, 0o744)
    await expect(revalidateProviderLaunchIdentity(modeIdentity)).rejects.toThrow("changed")
  })

  test("strictly decodes serialized launch and relay identities", async () => {
    await executable("codex", "#!/bin/sh\nexit 0\n")
    const identity = await compileProviderLaunchIdentity("codex", bin)
    expect(decodeProviderLaunchIdentity(JSON.parse(JSON.stringify(identity)))).toEqual(identity)
    await expect(() => decodeProviderLaunchIdentity({ ...identity, unexpected: true })).toThrow(
      "missing or excess"
    )
    await expect(() =>
      decodeProviderLaunchIdentity({
        ...identity,
        executionArgv: [identity.terminalExecutable.lexicalPath, "wrong"]
      })
    ).toThrow("inconsistent")

    const relay = await materializeProviderRelay(identity, path.join(root, "control"))
    expect(decodeMaterializedProviderRelay(JSON.parse(JSON.stringify(relay)))).toEqual(relay)
    expect(() => decodeMaterializedProviderRelay({ ...relay, sha256: "bad" })).toThrow("invalid")
  })

  test("validates interpreters and lookup precedence against every mutating authority", async () => {
    const source = path.join(root, "source")
    const allowed = path.join(source, "allowed")
    const precedence = path.join(allowed, "precedence")
    await mkdir(precedence, { recursive: true })
    const interpreter = path.join(allowed, "interpreter")
    await Bun.write(interpreter, "#!/bin/sh\nexit 0\n", { createPath: false })
    await chmod(interpreter, 0o755)
    await executable("codex", `#!${interpreter}\nexit 0\n`)
    const interpreterIdentity = await compileProviderLaunchIdentity("codex", bin)
    expect(() =>
      assertWorkflowProviderLaunchIsolation(mutatingWorkflow(source), [interpreterIdentity])
    ).toThrow("provider interpreter")

    await executable("codex", "#!/bin/sh\nexit 0\n")
    const precedenceIdentity = await compileProviderLaunchIdentity(
      "codex",
      `${precedence}${path.delimiter}${bin}`
    )
    expect(() =>
      assertWorkflowProviderLaunchIsolation(mutatingWorkflow(source), [precedenceIdentity])
    ).toThrow("PATH precedence")

    expect(() =>
      assertWorkflowProviderLaunchIsolation(mutatingCommandWorkflow(allowed), [precedenceIdentity])
    ).toThrow("mutating command root")
  })
})

async function pathFor(candidate: string): Promise<string> {
  return realpath(candidate)
}

function mutatingCommandWorkflow(cwd: string): WorkflowSpec {
  return {
    name: "command-provider-authority",
    objective: "Validate command-root authority.",
    cwd,
    concurrency: 1,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes: [
      {
        id: "command-writer",
        type: "command",
        title: "Command writer",
        needs: [],
        cwd: null,
        workspace: {
          mode: "shared",
          path: cwd,
          vcs: "none",
          writes: [],
          exclusiveResources: []
        },
        inputs: [],
        retry: { maxAttempts: 1 },
        gate: "none",
        argv: ["/usr/bin/true"],
        mutates: true,
        inheritEnv: [],
        env: {},
        allowedExitCodes: [0]
      }
    ],
    repeats: [],
    presentation: { workrooms: [] }
  }
}

function mutatingWorkflow(cwd: string): WorkflowSpec {
  const node: Extract<AgentNode, { readonly provider: "codex" }> = {
    id: "writer",
    type: "agent",
    title: "Writer",
    needs: [],
    cwd: null,
    workspace: {
      mode: "shared",
      path: cwd,
      vcs: "none",
      writes: ["allowed/**"],
      exclusiveResources: []
    },
    inputs: [],
    retry: { maxAttempts: 1 },
    gate: "none",
    provider: "codex",
    model: "provider-default",
    effort: null,
    prompt: "Write.",
    session: { mode: "fresh", from: null, saveAs: null },
    permissions: {
      execution: { sandbox: "workspace-write" },
      escalation: "deny",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
    output: { format: "text", schema: null }
  }
  return {
    name: "provider-authority",
    objective: "Validate provider authority.",
    cwd,
    concurrency: 1,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes: [node],
    repeats: [],
    presentation: { workrooms: [] }
  }
}
