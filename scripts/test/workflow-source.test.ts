import { afterEach, describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { WorkflowSourceSchema } from "../src/schema.js"
import { loadWorkflowSource } from "../src/workflow-source.js"

let temporary: string | null = null

afterEach(async () => {
  if (temporary !== null) {
    await rm(temporary, { recursive: true, force: true })
  }
  temporary = null
})

async function source(content: string, name = "workflow.yaml") {
  temporary ??= await mkdtemp(path.join(os.tmpdir(), "orchestrate-source-"))
  const file = path.join(temporary, name)
  await Bun.write(file, content)
  return file
}

const ROOT = `name: source-test
objective: Exercise YAML source normalization.
cwd: /tmp
limits:
  maxStarts: null
`

function nestedSequence(collections: number): string {
  return `${"[".repeat(collections)}0${"]".repeat(collections)}`
}

describe("YAML workflow source", () => {
  test("accepts both lowercase YAML suffixes", async () => {
    for (const name of ["workflow.yaml", "workflow.yml"]) {
      const loaded = await loadWorkflowSource(
        await source(
          `${ROOT}nodes:
  - id: inspect
    agent: codex
    execution: read-only
    prompt: Inspect.
`,
          name
        )
      )
      expect(loaded.workflow?.name).toBe("source-test")
    }
  })

  test("rejects every non-lowercase YAML extension exactly", async () => {
    for (const name of ["workflow.json", "workflow.YAML", "workflow.txt"]) {
      const loaded = await loadWorkflowSource(await source("{}", name))
      expect(loaded.workflow).toBeNull()
      expect(loaded.diagnostics[0]).toMatchObject({
        code: "workflow-extension",
        message:
          "Workflow authoring is YAML-only; use a .yaml or .yml file. JSON workflow files are not supported."
      })
    }
  })

  test("normalizes defaults, shorthands, and stable inferred dependencies", async () => {
    const file = await source(`${ROOT}nodes:
  - id: collect
    command: [/usr/bin/true]
    mutates: false
  - id: decide
    agent: codex
    execution: read-only
    prompt: Decide.
    output:
      format: json
      schema:
        type: object
  - id: consume
    needs: [collect]
    agent: claude
    execution: dont-ask
    prompt: Consume.
    inputs:
      - from: decide
        as: decision
    when:
      type: agent-output
      node: decide
      pointer: /done
      equals: true
`)
    const previousEnvironment = {
      state: process.env.ORCHESTRATE_STATE_DIR,
      home: process.env.HOME,
      xdg: process.env.XDG_STATE_HOME,
      binary: process.env.ORCHESTRATE_BIN
    }
    process.env.ORCHESTRATE_STATE_DIR = path.join(temporary as string, "state")
    process.env.HOME = path.join(temporary as string, "home")
    process.env.XDG_STATE_HOME = path.join(temporary as string, "xdg")
    process.env.ORCHESTRATE_BIN = path.join(temporary as string, "bin", "orchestrate")
    let loaded: Awaited<ReturnType<typeof loadWorkflowSource>>
    try {
      loaded = await loadWorkflowSource(file)
    } finally {
      for (const [name, value] of [
        ["ORCHESTRATE_STATE_DIR", previousEnvironment.state],
        ["HOME", previousEnvironment.home],
        ["XDG_STATE_HOME", previousEnvironment.xdg],
        ["ORCHESTRATE_BIN", previousEnvironment.binary]
      ] as const) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name)
        } else {
          process.env[name] = value
        }
      }
    }
    expect(loaded.diagnostics).toMatchObject([
      {
        severity: "warning",
        code: "unknown-writes",
        path: "/nodes/2/workspace"
      }
    ])
    expect(loaded.workflow).not.toBeNull()
    expect(loaded.workflow?.concurrency).toBe(1)
    expect(loaded.workflow?.callback).toEqual({ type: "none" })
    expect(loaded.workflow?.nodes[0]).toMatchObject({
      type: "command",
      argv: ["/usr/bin/true"],
      retry: { maxAttempts: 1 },
      allowedExitCodes: [0]
    })
    expect(loaded.workflow?.nodes[2]?.needs).toEqual(["collect", "decide"])
    expect(loaded.provenance?.origins["/concurrency"]).toMatchObject({
      kind: "default",
      rule: "root.concurrency.one"
    })
    expect(loaded.provenance?.origins["/nodes/2/needs/1"]).toMatchObject({
      kind: "inferred",
      reason: "input-current",
      sourcePath: "/nodes/2/inputs/0/from"
    })
    expect(loaded.provenance?.inferredNeeds.consume).toEqual([
      { node: "decide", reason: "input-current", sourcePath: "/nodes/2/inputs/0/from" }
    ])
  })

  test("reports strict schema and YAML AST failures with resolved locations", async () => {
    const unknown = await loadWorkflowSource(
      await source(`${ROOT}unknown: true
nodes:
  - id: inspect
    agent: codex
    execution: read-only
    prompt: Inspect.
`)
    )
    expect(unknown.diagnostics[0]?.code).toBe("workflow-source-schema")
    expect(unknown.diagnostics[0]?.path).toBe("/unknown")
    expect(unknown.diagnostics[0]?.location.file).toBe(path.resolve(unknown.source))
    expect(unknown.diagnostics[0]?.location.line).toBe(6)

    const anchored = await loadWorkflowSource(
      await source(
        `${ROOT}nodes: &nodes
  - id: inspect
    agent: codex
    execution: read-only
    prompt: Inspect.
`,
        "anchored.yml"
      )
    )
    expect(anchored.diagnostics[0]?.code).toBe("workflow-yaml-anchor")
  })

  test("anchors only UnexpectedKey issues to keys and missing fields to the nearest parent", async () => {
    const loaded = await loadWorkflowSource(
      await source(`${ROOT}concurrency: unknown
unknown: true
nodes:
  - id: inspect
    agent: codex
    prompt: Inspect.
`)
    )
    expect(
      loaded.diagnostics.find((entry) => entry.path === "/concurrency")?.location
    ).toMatchObject({ line: 6, column: 14 })
    expect(loaded.diagnostics.find((entry) => entry.path === "/unknown")?.location).toMatchObject({
      line: 7,
      column: 1
    })
    expect(
      loaded.diagnostics.find((entry) => entry.path === "/nodes/0/execution")?.location
    ).toMatchObject({ line: 9, column: 5 })
  })

  test("rejects explicit duplicate dependencies before inference", async () => {
    const loaded = await loadWorkflowSource(
      await source(`${ROOT}nodes:
  - id: inspect
    needs: [inspect, inspect]
    agent: codex
    execution: read-only
    prompt: Inspect.
`)
    )
    expect(loaded.workflow).toBeNull()
    expect(loaded.diagnostics.filter((entry) => entry.code === "dependency")).toHaveLength(1)
  })

  test("locates every repeated invalid list entry at its own one-based YAML range", async () => {
    const dependency = await loadWorkflowSource(
      await source(`${ROOT}nodes:
  - id: inspect
    needs: [missing, missing]
    command: [/usr/bin/true]
    mutates: false
`)
    )
    const repeat = await loadWorkflowSource(
      await source(`${ROOT}nodes:
  - id: inspect
    command: [/usr/bin/true]
    mutates: false
repeats:
  - id: loop
    members: [missing, missing]
    maxRounds: 2
    until: {type: agent-output, node: inspect, pointer: /done, equals: true}
`)
    )
    const settlement = await loadWorkflowSource(
      await source(`${ROOT}nodes:
  - id: inspect
    command: [/usr/bin/true]
    mutates: false
presentation:
  workrooms:
    - id: room
      label: Room
      layout: rows
      seats: [{id: worker, label: Worker}]
      settlesOn: [missing, missing]
`)
    )

    for (const [loaded, code, prefix, message] of [
      [dependency, "dependency", "/nodes/0/needs", "needs unknown node"],
      [repeat, "repeat-members", "/repeats/0/members", "names unknown member"],
      [
        settlement,
        "workroom-settlement",
        "/presentation/workrooms/0/settlesOn",
        "settles on unknown node"
      ]
    ] as const) {
      const diagnostics = loaded.diagnostics.filter(
        (entry) => entry.code === code && entry.message.includes(message)
      )
      expect(diagnostics.map((entry) => entry.path)).toEqual([`${prefix}/0`, `${prefix}/1`])
      expect(diagnostics[0]?.location.line).toBeGreaterThan(0)
      expect(diagnostics[0]?.location.column).toBeGreaterThan(0)
      expect(diagnostics[1]?.location.line).toBe(diagnostics[0]?.location.line)
      expect(diagnostics[1]?.location.column).toBeGreaterThan(diagnostics[0]?.location.column ?? 0)
    }
  })

  test("removes source-only shorthand subtrees from final-IR provenance", async () => {
    const loaded = await loadWorkflowSource(
      await source(`${ROOT}nodes:
  - id: inspect
    agent: codex
    execution: read-only
    prompt: Inspect.
    session: {fresh: review-session}
    extraArgs: [--quiet]
    inheritEnv: [REVIEW_CHANNEL]
    env: {REVIEW_MODE: strict}
`)
    )
    expect(loaded.workflow).not.toBeNull()
    expect(loaded.provenance?.origins).toHaveProperty("/nodes/0/session/mode")
    expect(loaded.provenance?.origins).toHaveProperty("/nodes/0/permissions/env/REVIEW_MODE")
    for (const obsolete of [
      "/nodes/0/session/fresh",
      "/nodes/0/extraArgs/0",
      "/nodes/0/inheritEnv/0",
      "/nodes/0/env/REVIEW_MODE"
    ]) {
      expect(loaded.provenance?.origins).not.toHaveProperty(obsolete)
    }
  })

  test("reports semantic fields at their authored source ranges with explicit node metadata", async () => {
    const command = await loadWorkflowSource(
      await source(`${ROOT}nodes:
  - id: check
    command: [relative-command]
    mutates: false
`)
    )
    expect(command.diagnostics.find((entry) => entry.code === "command-path")).toMatchObject({
      path: "/nodes/0/command/0",
      location: { line: 8 },
      primaryNode: "check",
      nodes: ["check"]
    })

    const repeat = await loadWorkflowSource(
      await source(`${ROOT}nodes:
  - id: check
    command: [/usr/bin/true]
    mutates: false
repeats:
  - id: loop
    members: [check]
    maxRounds: 2
    until: {type: agent-output, node: check, pointer: /done, equals: true}
`)
    )
    expect(repeat.diagnostics.find((entry) => entry.code === "repeat-until")).toMatchObject({
      path: "/repeats/0/until/node",
      location: { line: 14 },
      relatedNodes: ["check"],
      related: [{ path: "/nodes/0", location: { line: 7 } }]
    })

    const crossNode = await loadWorkflowSource(
      await source(`${ROOT}nodes:
  - id: source
    command: [/usr/bin/true]
    mutates: false
  - id: consumer
    agent: codex
    execution: read-only
    prompt: Consume.
    when: {type: agent-output, node: source, pointer: /done, equals: true}
`)
    )
    expect(crossNode.diagnostics.find((entry) => entry.code === "condition-source")).toMatchObject({
      path: "/nodes/1/when/node",
      location: { line: 14 },
      primaryNode: "consumer",
      relatedNodes: ["source"],
      related: [{ path: "/nodes/0", location: { line: 7 } }]
    })
  })

  test("rejects negative zero at the exact conditional and repeat fields", async () => {
    const cases = [
      `${ROOT}nodes:
  - id: source
    agent: codex
    execution: read-only
    prompt: Source.
    output: {format: json, schema: {type: object}}
  - id: consumer
    agent: codex
    execution: read-only
    prompt: Consume.
    when: {type: agent-output, node: source, pointer: /value, equals: -0}
`,
      `${ROOT}nodes:
  - id: source
    agent: codex
    execution: read-only
    prompt: Source.
    output: {format: json, schema: {type: object}}
repeats:
  - id: loop
    members: [source]
    maxRounds: 2
    until: {type: agent-output, node: source, pointer: /value, equals: -0}
`
    ]
    for (const [index, contents] of cases.entries()) {
      const loaded = await loadWorkflowSource(await source(contents))
      expect(loaded.diagnostics[0]).toMatchObject({
        code: "workflow-yaml-value",
        path: index === 0 ? "/nodes/1/when/equals" : "/repeats/0/until/equals",
        message: "YAML numbers cannot be negative zero."
      })
      expect(loaded.diagnostics[0]?.location.line).not.toBeNull()
    }
  })

  test("rejects anchors and every explicit tag on mapping keys and values", async () => {
    for (const [contents, code] of [
      [`&named name: source-test\n`, "workflow-yaml-anchor"],
      [`!!str name: source-test\n`, "workflow-yaml-tag"],
      [`name: !!str source-test\n`, "workflow-yaml-tag"]
    ] as const) {
      const loaded = await loadWorkflowSource(await source(contents))
      expect(loaded.diagnostics[0]?.code).toBe(code)
    }
  })

  test("locates reserved env and inheritEnv fields in authored command and agent source", async () => {
    const loaded = await loadWorkflowSource(
      await source(`${ROOT}nodes:
  - id: check
    command: [/usr/bin/true]
    mutates: false
    env:
      ORCHESTRATE_BIN: authored
  - id: inspect
    agent: codex
    execution: read-only
    prompt: Inspect.
    inheritEnv: [TMPDIR]
`)
    )
    expect(loaded.workflow).toBeNull()
    const reserved = loaded.diagnostics.filter(
      (diagnostic) => diagnostic.code === "reserved-environment"
    )
    expect(reserved).toHaveLength(2)
    expect(reserved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/nodes/0/env/ORCHESTRATE_BIN",
          location: expect.objectContaining({ line: 11 })
        }),
        expect.objectContaining({
          path: "/nodes/1/inheritEnv/0",
          location: expect.objectContaining({ line: 16 })
        })
      ])
    )
  })

  test("rejects unreadable, oversized, and invalid UTF-8 sources", async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "orchestrate-source-"))
    const missing = await loadWorkflowSource(path.join(temporary, "missing.yaml"))
    expect(missing.diagnostics[0]?.code).toBe("workflow-read")

    const invalidUtf8 = path.join(temporary, "invalid.yml")
    await Bun.write(invalidUtf8, new Uint8Array([0xc3, 0x28]))
    expect((await loadWorkflowSource(invalidUtf8)).diagnostics[0]?.code).toBe("workflow-utf8")

    const oversized = path.join(temporary, "oversized.yaml")
    await Bun.write(oversized, new Uint8Array(1_048_577))
    expect((await loadWorkflowSource(oversized)).diagnostics[0]?.code).toBe("workflow-size")
  })

  test("uses one bounded no-follow handle and rejects special files without blocking", async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "orchestrate-source-"))
    const grow = path.join(temporary, "grow.yaml")
    await Bun.write(grow, ROOT)
    const grown = await loadWorkflowSource(grow, {
      afterFileStat: async () => {
        await Bun.write(grow, new Uint8Array(1_048_577))
      }
    })
    expect(grown.diagnostics[0]?.code).toBe("workflow-size")

    const target = path.join(temporary, "target.yaml")
    const linked = path.join(temporary, "linked.yaml")
    await Bun.write(target, ROOT)
    await symlink(target, linked)
    expect((await loadWorkflowSource(linked)).diagnostics[0]?.code).toBe("workflow-file-type")

    const fifo = path.join(temporary, "workflow.yaml")
    const created = Bun.spawnSync(["mkfifo", fifo])
    expect(created.exitCode).toBe(0)
    const special = await Promise.race([
      loadWorkflowSource(fifo),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("special-file read blocked")), 1_000)
      )
    ])
    expect(special.diagnostics[0]?.code).toBe("workflow-file-type")
  })

  test("enforces the one-document strict YAML subset", async () => {
    const cases = [
      ["", "workflow-yaml-empty"],
      ["---\na: 1\n---\nb: 2\n", "workflow-yaml-documents"],
      ["a: 1\na: 2\n", "workflow-yaml"],
      ["? [a, b]\n: value\n", "workflow-yaml"],
      ["base: &base {a: 1}\ncopy: *base\n", "workflow-yaml-anchor"],
      ["base: {a: 1}\ncopy: {<<: {a: 2}}\n", "workflow-yaml-merge"],
      ["name: !private value\n", "workflow-yaml"],
      ["name: .nan\n", "workflow-yaml-value"],
      ["name: .inf\n", "workflow-yaml-value"]
    ] as const
    for (const [contents, code] of cases) {
      const loaded = await loadWorkflowSource(await source(contents))
      expect(loaded.diagnostics[0]?.code).toBe(code)
    }
  })

  test("localizes non-finite YAML numbers at their nested source range", async () => {
    for (const number of [".nan", ".inf", "-.inf"]) {
      const loaded = await loadWorkflowSource(
        await source(`${ROOT.replace("maxStarts: null", `maxStarts: ${number}`)}nodes: []\n`)
      )
      expect(loaded.diagnostics[0]).toMatchObject({
        code: "workflow-yaml-value",
        message: "YAML numbers must be finite.",
        path: "/limits/maxStarts",
        location: {
          line: 5,
          column: 14,
          endLine: 5,
          endColumn: 14 + number.length
        }
      })
    }
  })

  test("counts only collection nesting for the depth limit", async () => {
    const accepted = await loadWorkflowSource(await source(`root: ${nestedSequence(63)}\n`))
    expect(accepted.diagnostics[0]?.code).toBe("workflow-source-schema")
    const rejected = await loadWorkflowSource(await source(`root: ${nestedSequence(64)}\n`))
    expect(rejected.diagnostics[0]?.code).toBe("workflow-yaml-depth")
    const excessive = await loadWorkflowSource(await source(`root: ${nestedSequence(2_000)}\n`))
    expect(excessive.diagnostics[0]?.code).toBe("workflow-yaml-depth")
  })

  test("rejects unsafe YAML integers without changing their pointer", async () => {
    const accepted = await loadWorkflowSource(
      await source(`${ROOT.replace("maxStarts: null", `maxStarts: ${Number.MAX_SAFE_INTEGER}`)}nodes:
  - id: inspect
    agent: codex
    execution: read-only
    prompt: Inspect.
`)
    )
    expect(accepted.workflow?.limits.maxStarts).toBe(Number.MAX_SAFE_INTEGER)

    const rejected = await loadWorkflowSource(
      await source(`${ROOT.replace("maxStarts: null", "maxStarts: 9007199254740993")}nodes:
  - id: inspect
    agent: codex
    execution: read-only
    prompt: Inspect.
`)
    )
    expect(rejected.diagnostics[0]).toMatchObject({
      code: "workflow-yaml-value",
      path: "/limits/maxStarts",
      location: { line: 5, column: 14 }
    })
  })

  test("retains and rejects invalid constrained record keys", async () => {
    const loaded = await loadWorkflowSource(
      await source(`${ROOT}nodes:
  - id: inspect
    agent: codex
    execution: read-only
    prompt: Inspect.
    env: {BAD-NAME: value}
`)
    )
    expect(loaded.workflow).toBeNull()
    expect(loaded.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "workflow-source-schema",
        path: "/nodes/0/env/BAD-NAME",
        location: expect.objectContaining({ line: 11 })
      })
    )
  })

  test("keeps source defaults absent until normalization", () => {
    const decoded = Schema.decodeUnknownResult(WorkflowSourceSchema, {
      errors: "all",
      onExcessProperty: "error"
    })({
      name: "minimal",
      objective: "prove absence",
      cwd: "/tmp",
      limits: { maxStarts: null },
      nodes: [{ id: "inspect", agent: "codex", execution: "read-only", prompt: "Inspect." }]
    })
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isFailure(decoded)) {
      throw new Error("source decode failed")
    }
    expect(Object.hasOwn(decoded.success, "concurrency")).toBe(false)
    expect(Object.hasOwn(decoded.success, "callback")).toBe(false)
    expect(Object.hasOwn(decoded.success.nodes[0]!, "retry")).toBe(false)
    expect(Object.hasOwn(decoded.success.nodes[0]!, "session")).toBe(false)
  })

  test("rejects union leakage and provider-invalid authored fields", async () => {
    const nodes = [
      `id: command\n    command: [/usr/bin/true]`,
      `id: claude\n    agent: claude\n    execution: read-only\n    prompt: Review.`,
      `id: claude\n    agent: claude\n    execution: dont-ask\n    escalation: ask-user\n    prompt: Review.`,
      `id: claude\n    agent: claude\n    execution: dont-ask\n    extraArgs: [--unsafe]\n    prompt: Review.`,
      `id: codex\n    agent: codex\n    execution: dont-ask\n    prompt: Review.`,
      `id: codex\n    type: agent\n    agent: codex\n    execution: read-only\n    prompt: Review.`,
      `id: codex\n    agent: codex\n    execution: read-only\n    effort: null\n    prompt: Review.`,
      `id: codex\n    agent: codex\n    command: [/usr/bin/true]\n    execution: read-only\n    prompt: Review.`,
      `id: codex\n    agent: codex\n    execution: read-only\n    session: {fresh: one, saveAs: two}\n    prompt: Review.`
    ]
    for (const node of nodes) {
      const loaded = await loadWorkflowSource(await source(`${ROOT}nodes:\n  - ${node}\n`))
      expect(loaded.workflow).toBeNull()
      expect(loaded.diagnostics[0]?.code).toBe("workflow-source-schema")
    }
  })
})
