import { Ajv2020 } from "ajv/dist/2020.js"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AgentNode, CommandNode, WorkflowSpec } from "../src/types.js"

import { jsonSchemaDocumentFor, WorkflowProvenanceSchema } from "../src/schema.js"
import { stateRoot, submissionsRoot } from "../src/state.js"
import {
  injectPathCaseSensitivityForTests,
  injectPathInspectionForTests,
  validateWorkflow
} from "../src/validation.js"
import { loadWorkflowSource } from "../src/workflow-source.js"

let originalHome: string | undefined
let originalStateDirectory: string | undefined
let originalOrchestrateBin: string | undefined

beforeEach(() => {
  originalHome = process.env.HOME
  originalStateDirectory = process.env.ORCHESTRATE_STATE_DIR
  originalOrchestrateBin = process.env.ORCHESTRATE_BIN
  process.env.HOME = "/var/tmp/orchestrate-workflow-contract-home"
  process.env.ORCHESTRATE_STATE_DIR = "/var/tmp/orchestrate-workflow-contract-state"
  process.env.ORCHESTRATE_BIN = "/var/tmp/orchestrate"
})

afterEach(() => {
  injectPathCaseSensitivityForTests(null)
  injectPathInspectionForTests(null)
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalStateDirectory === undefined) {
    delete process.env.ORCHESTRATE_STATE_DIR
  } else {
    process.env.ORCHESTRATE_STATE_DIR = originalStateDirectory
  }
  if (originalOrchestrateBin === undefined) {
    delete process.env.ORCHESTRATE_BIN
  } else {
    process.env.ORCHESTRATE_BIN = originalOrchestrateBin
  }
})

function workspace() {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "none" as const,
    writes: [],
    exclusiveResources: []
  }
}

function command(id: string, overrides: Partial<CommandNode> = {}): CommandNode {
  return {
    id,
    type: "command",
    title: id,
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    retry: { maxAttempts: 1 },
    gate: "none",
    argv: ["/usr/bin/true"],
    mutates: false,
    inheritEnv: [],
    env: {},
    allowedExitCodes: [0],
    ...overrides
  }
}

function agent(id: string, overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    id,
    type: "agent",
    title: id,
    needs: [],
    cwd: null,
    workspace: workspace(),
    inputs: [],
    retry: { maxAttempts: 1 },
    gate: "none",
    provider: "codex",
    model: "provider-default",
    effort: null,
    prompt: `Work on ${id}.`,
    session: { mode: "fresh", from: null, saveAs: null },
    permissions: {
      access: "read-only",
      escalation: "deny",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    },
    output: { format: "text", schema: null },
    ...overrides
  }
}

function workflow(nodes: readonly WorkflowSpec["nodes"][number][]): WorkflowSpec {
  return {
    name: "contract-test",
    objective: "Exercise the replacement workflow contract.",
    cwd: "/tmp",
    concurrency: 3,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes,
    repeats: []
  }
}

function authoredWebhook(headers: Readonly<Record<string, string>>) {
  return {
    name: "headers",
    objective: "Validate callback headers.",
    cwd: "/tmp",
    limits: { maxStarts: null },
    callback: {
      type: "webhook",
      url: "https://example.test/hook",
      headers,
      timeoutSeconds: 10
    },
    nodes: [{ id: "check", command: ["/usr/bin/true"], mutates: false }]
  }
}

describe("workflow contract", () => {
  test("warns on hand-unrolled repeat rounds without rejecting the workflow", () => {
    const unrolled = validateWorkflow(
      workflow([
        command("s1r1-review"),
        command("s1r1-fix", { needs: ["s1r1-review"] }),
        command("s1r2-review", { needs: ["s1r1-fix"] }),
        command("s1r2-fix", { needs: ["s1r2-review"] })
      ])
    )
    expect(unrolled.workflow).not.toBeNull()
    expect(unrolled.digest).not.toBeNull()
    const issue = unrolled.issues.find((candidate) => candidate.code === "unrolled-rounds")
    expect(issue?.severity).toBe("warning")
    expect(issue?.message).toContain("repeat")
    expect(issue?.nodes?.toSorted()).toEqual(["s1r1-fix", "s1r1-review", "s1r2-fix", "s1r2-review"])

    // One repeating stem alone reads as ordinary sequence naming, and repeat
    // members themselves never trigger the warning.
    expect(
      validateWorkflow(
        workflow([command("chapter1"), command("chapter2", { needs: ["chapter1"] })])
      ).issues.some((candidate) => candidate.code === "unrolled-rounds")
    ).toBe(false)
    const declared = {
      ...workflow([command("review"), command("fix", { needs: ["review"] })]),
      repeats: [
        {
          id: "loop",
          members: ["review", "fix"],
          until: { type: "command-success" as const, node: "fix" },
          maxRounds: 3
        }
      ]
    }
    expect(
      validateWorkflow(declared).issues.some((candidate) => candidate.code === "unrolled-rounds")
    ).toBe(false)
  })

  test("keeps every documented YAML workflow example valid", async () => {
    const document = await Bun.file(new URL("../../references/examples.md", import.meta.url)).text()
    const blocks = [...document.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map(
      (match) => match[1] as string
    )
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    const directory = await mkdtemp(path.join(os.tmpdir(), "orchestrate-example-"))
    try {
      for (const [index, block] of blocks.entries()) {
        const file = path.join(directory, `example-${index}.yaml`)
        await Bun.write(file, block)
        expect(
          (await loadWorkflowSource(file)).diagnostics.filter(
            (diagnostic) => diagnostic.severity === "error"
          )
        ).toEqual([])
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("accepts the contract and rejects unknown fields", () => {
    expect(validateWorkflow(workflow([command("check")])).workflow).not.toBeNull()

    for (const unknown of [
      { unexpectedRoot: true },
      { unexpectedNode: true },
      { extraNodeSetting: 5 }
    ]) {
      const raw = structuredClone(workflow([command("check")])) as unknown as Record<
        string,
        unknown
      >
      if ("unexpectedNode" in unknown || "extraNodeSetting" in unknown) {
        Object.assign(
          (raw.nodes as Record<string, unknown>[])[0] as Record<string, unknown>,
          unknown
        )
      } else {
        Object.assign(raw, unknown)
      }
      const result = validateWorkflow(raw)
      expect(result.workflow).toBeNull()
      expect(result.digest).toBeNull()
    }
  })

  test("accepts ordered workroom seats and preserves workflows without presentation", () => {
    const legacy = workflow([command("legacy")])
    expect(validateWorkflow(legacy).issues).toEqual([])
    expect(validateWorkflow(legacy).workflow?.presentation).toBeUndefined()

    const presented: WorkflowSpec = {
      ...workflow([
        agent("plan", { workroom: "delivery", seat: "builder" }),
        agent("build", {
          needs: ["plan"],
          workroom: "delivery",
          seat: "builder"
        }),
        command("review", { needs: ["build"], workroom: "delivery" }),
        agent("settle", { needs: ["review"], workroom: "delivery", seat: "reviewer" })
      ]),
      presentation: {
        workrooms: [
          {
            id: "delivery",
            label: "Delivery",
            layout: "columns",
            seats: [
              { id: "builder", label: "Builder" },
              { id: "reviewer", label: "Reviewer" }
            ],
            settlesOn: ["settle"]
          }
        ]
      }
    }
    expect(validateWorkflow(presented).issues).toEqual([])
  })

  test("validates workroom references, globally unique seats, capacity, and settlement anchors", () => {
    const base: WorkflowSpec = {
      ...workflow([
        agent("left", { workroom: "alpha", seat: "shared-seat" }),
        agent("right", { workroom: "alpha", seat: "shared-seat" }),
        command("settle", { needs: ["left"], workroom: "alpha" })
      ]),
      presentation: {
        workrooms: [
          {
            id: "alpha",
            label: "Alpha",
            layout: "rows",
            seats: [{ id: "shared-seat", label: "Shared" }],
            settlesOn: ["settle"]
          },
          {
            id: "beta",
            label: "Beta",
            layout: "columns",
            seats: [{ id: "shared-seat", label: "Duplicate" }],
            settlesOn: ["missing"]
          }
        ]
      }
    }
    const codes = validateWorkflow(base).issues.map((issue) => issue.code)
    expect(codes).toEqual(expect.arrayContaining(["seat-id", "seat-order", "workroom-settlement"]))

    const badAssignmentsResult = validateWorkflow({
      ...workflow([
        agent("seat-without-room", { seat: "alpha-seat" }),
        command("unknown-room", { workroom: "missing" }),
        agent("wrong-room", { workroom: "alpha", seat: "beta-seat" }),
        agent("unknown-seat", { workroom: "alpha", seat: "missing-seat" }),
        command("command-seat", { workroom: "alpha", seat: "alpha-seat" }),
        command("settle", {
          needs: ["seat-without-room", "unknown-room", "wrong-room", "unknown-seat", "command-seat"]
        })
      ]),
      presentation: {
        workrooms: [
          {
            id: "alpha",
            label: "Alpha",
            layout: "columns",
            seats: [{ id: "alpha-seat", label: "Alpha" }],
            settlesOn: ["settle"]
          },
          {
            id: "beta",
            label: "Beta",
            layout: "columns",
            seats: [{ id: "beta-seat", label: "Beta" }],
            settlesOn: ["settle"]
          }
        ]
      }
    })
    const badAssignments = badAssignmentsResult.issues.map((issue) => issue.code)
    expect(badAssignments).toEqual(expect.arrayContaining(["node-seat", "node-workroom"]))
    expect(badAssignmentsResult.issues.map((issue) => issue.message).join("\n")).toContain(
      "cannot occupy participant seat"
    )

    for (const seats of [
      [],
      Array.from({ length: 5 }, (_unused, index) => ({
        id: `seat-${index}`,
        label: `Seat ${index}`
      }))
    ]) {
      const invalidCapacity = structuredClone(base) as unknown as Record<string, unknown>
      const presentation = invalidCapacity.presentation as {
        workrooms: Array<{ seats: Array<{ id: string; label: string }> }>
      }
      presentation.workrooms[0]!.seats = seats
      const capacityResult = validateWorkflow(invalidCapacity)
      expect(capacityResult.workflow).toBeNull()
      expect(capacityResult.issues.map((issue) => issue.code)).toContain("workroom-seats")
    }

    const duplicatedInput = structuredClone(base)
    for (const workroom of duplicatedInput.presentation!.workrooms) {
      Object.assign(workroom, { id: "duplicate" })
    }
    const duplicatedWorkroom = validateWorkflow(duplicatedInput)
    expect(duplicatedWorkroom.issues.map((issue) => issue.code)).toContain("workroom-id")
  })

  test("uses repeat-aware ordering but rejects repeat settlement anchors", () => {
    const research = agent("research", { workroom: "review-room", seat: "review-seat" })
    const verdict = command("verdict")
    const settle = agent("settle", {
      needs: ["verdict"],
      workroom: "review-room",
      seat: "review-seat"
    })
    const spec: WorkflowSpec = {
      ...workflow([research, verdict, settle]),
      presentation: {
        workrooms: [
          {
            id: "review-room",
            label: "Review",
            layout: "rows",
            seats: [{ id: "review-seat", label: "Review" }],
            settlesOn: ["settle"]
          }
        ]
      },
      repeats: [
        {
          id: "review-loop",
          members: ["research", "verdict"],
          until: { type: "command-success", node: "verdict" },
          maxRounds: 2
        }
      ]
    }
    expect(validateWorkflow(spec).issues).toEqual([])
    expect(
      validateWorkflow({
        ...spec,
        presentation: {
          workrooms: [{ ...spec.presentation!.workrooms[0]!, settlesOn: ["verdict"] }]
        }
      }).issues.map((issue) => issue.code)
    ).toContain("workroom-settlement")
  })

  test("rejects cycles introduced by repeat-boundary dependency expansion", () => {
    const spec: WorkflowSpec = {
      ...workflow([
        agent("worker", { workroom: "review-room", seat: "worker-seat" }),
        command("verdict", { needs: ["bridge"] }),
        command("bridge", { needs: ["worker"], workroom: "review-room" })
      ]),
      presentation: {
        workrooms: [
          {
            id: "review-room",
            label: "Review room",
            layout: "columns",
            seats: [{ id: "worker-seat", label: "Worker" }],
            settlesOn: ["bridge"]
          }
        ]
      },
      repeats: [
        {
          id: "review-loop",
          members: ["worker", "verdict"],
          until: { type: "command-success", node: "verdict" },
          maxRounds: 2
        }
      ]
    }

    const result = validateWorkflow(spec)
    expect(result.workflow).toBeNull()
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "repeat-boundary-cycle",
          nodes: expect.arrayContaining(["bridge", "verdict"])
        })
      ])
    )
  })

  test("keeps canonical session lineage in one seat and rejects presentation handoffs", () => {
    const source = agent("source", {
      workroom: "sessions",
      seat: "source-seat",
      session: { mode: "fresh", from: null, saveAs: "canonical" }
    })
    const resumed = agent("resumed", {
      needs: ["source"],
      workroom: "sessions",
      seat: "source-seat",
      session: { mode: "resume", from: "canonical", saveAs: null }
    })
    const spec: WorkflowSpec = {
      ...workflow([source, resumed]),
      presentation: {
        workrooms: [
          {
            id: "sessions",
            label: "Sessions",
            layout: "columns",
            seats: [
              { id: "source-seat", label: "Source" },
              { id: "other-seat", label: "Other" }
            ],
            settlesOn: ["resumed"]
          }
        ]
      }
    }
    expect(validateWorkflow(spec).issues).toEqual([])
    const crossSeat = structuredClone(spec)
    const resumedNode = crossSeat.nodes.find((node) => node.id === "resumed")
    expect(resumedNode).toBeDefined()
    if (resumedNode === undefined) {
      throw new Error("Expected resumed node in cloned workflow.")
    }
    Object.assign(resumedNode, { seat: "other-seat" })
    expect(validateWorkflow(crossSeat).issues.map((issue) => issue.code)).toContain(
      "session-presentation"
    )
  })

  test("rejects malformed and unsupported webhook callback URLs before approval", () => {
    for (const url of ["not a url", "file:///tmp/callback", "ftp://example.invalid/hook"]) {
      const result = validateWorkflow({
        ...workflow([command("check")]),
        callback: { type: "webhook", url, headers: {}, timeoutSeconds: 10 }
      })
      expect(result.workflow).toBeNull()
      expect(result.issues.some((issue) => issue.code === "callback-url")).toBe(true)
    }
  })

  test("keeps HTTP(S) callback URL acceptance aligned with the generated authoring schema", async () => {
    const generated = JSON.parse(
      await Bun.file(new URL("../../references/workflow.schema.json", import.meta.url)).text()
    )
    const validateGenerated = new Ajv2020({ strict: false }).compile(generated)
    const temporary = await mkdtemp(path.join(os.tmpdir(), "orchestrate-url-"))
    try {
      for (const [url, accepted] of [
        ["https://example.test/hook", true],
        ["http://a", true],
        ["HTTP://example.test/hook", true],
        ["HtTpS://example.test/hook", true],
        ["https://user:pass@example.test:8443/hook", true],
        ["http://[::1]:8080/hook", true],
        ["http://[::1/hook", false],
        [" https://example.test/hook", false],
        ["https://example.test/hook ", false],
        ["https://example.test/a b", false],
        ["ftp://example.test/hook", false]
      ] as const) {
        const runtime =
          validateWorkflow({
            ...workflow([command("check")]),
            callback: { type: "webhook", url, headers: {}, timeoutSeconds: 10 }
          }).workflow !== null
        const authored = validateGenerated({
          name: "callback-parity",
          objective: "Keep URL validation aligned.",
          cwd: "/tmp",
          limits: { maxStarts: null },
          callback: { type: "webhook", url, timeoutSeconds: 10 },
          nodes: [{ id: "check", command: ["/usr/bin/true"], mutates: false }]
        })
        const file = path.join(temporary, "workflow.yaml")
        await Bun.write(
          file,
          `name: callback-parity
objective: Keep URL validation aligned.
cwd: /tmp
limits: {maxStarts: null}
callback: {type: webhook, url: ${JSON.stringify(url)}, timeoutSeconds: 10}
nodes:
  - id: check
    command: [/usr/bin/true]
    mutates: false
`
        )
        const sourceAccepted = (await loadWorkflowSource(file)).workflow !== null
        expect(runtime).toBe(accepted)
        expect(sourceAccepted).toBe(accepted)
        expect(authored).toBe(accepted)
      }

      const malformedIpv6 = "http://[:::]/hook"
      expect(
        validateWorkflow({
          ...workflow([command("check")]),
          callback: { type: "webhook", url: malformedIpv6, headers: {}, timeoutSeconds: 10 }
        }).workflow
      ).toBeNull()
      const malformedFile = path.join(temporary, "workflow.yaml")
      await Bun.write(
        malformedFile,
        `name: callback-prefilter
objective: Exercise runtime URL parsing.
cwd: /tmp
limits: {maxStarts: null}
callback: {type: webhook, url: ${JSON.stringify(malformedIpv6)}, timeoutSeconds: 10}
nodes:
  - id: check
    command: [/usr/bin/true]
    mutates: false
`
      )
      expect((await loadWorkflowSource(malformedFile)).workflow).toBeNull()
      expect(
        validateGenerated({
          name: "callback-prefilter",
          objective: "Exercise the generated lexical prefilter.",
          cwd: "/tmp",
          limits: { maxStarts: null },
          callback: { type: "webhook", url: malformedIpv6, timeoutSeconds: 10 },
          nodes: [{ id: "check", command: ["/usr/bin/true"], mutates: false }]
        })
      ).toBe(true)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("rejects invalid webhook header names and values at their exact pointer", async () => {
    const validName = "X!#$%&'*+-.^_`|~"
    expect(
      validateWorkflow({
        ...workflow([command("check")]),
        callback: {
          type: "webhook",
          url: "https://example.test/hook",
          headers: { [validName]: "\tvisible\x80" },
          timeoutSeconds: 10
        }
      }).workflow
    ).not.toBeNull()

    for (const [headers, pointer] of [
      [{ "Bad/Header": "value" }, "/callback/headers/Bad~1Header"],
      [{ Valid: "line\r\nbreak" }, "/callback/headers/Valid"],
      [{ Valid: "nul\0byte" }, "/callback/headers/Valid"]
    ] as const) {
      const result = validateWorkflow({
        ...workflow([command("check")]),
        callback: {
          type: "webhook",
          url: "https://example.test/hook",
          headers,
          timeoutSeconds: 10
        }
      })
      expect(result.workflow).toBeNull()
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "callback-header", path: pointer })
      )
    }

    const generated = JSON.parse(
      await Bun.file(new URL("../../references/workflow.schema.json", import.meta.url)).text()
    )
    const validateGenerated = new Ajv2020({ strict: false }).compile(generated)
    expect(validateGenerated(authoredWebhook({ [validName]: "\tvisible\x80" }))).toBe(true)
    expect(validateGenerated(authoredWebhook({ "Bad/Header": "value" }))).toBe(false)
    expect(validateGenerated(authoredWebhook({ Valid: "line\r\nbreak" }))).toBe(false)

    const temporary = await mkdtemp(path.join(os.tmpdir(), "orchestrate-header-"))
    try {
      const file = path.join(temporary, "workflow.yaml")
      await Bun.write(
        file,
        `name: headers
objective: Validate callback headers.
cwd: /tmp
limits: {maxStarts: null}
callback:
  type: webhook
  url: https://example.test/hook
  headers:
    "Bad/Header": value
  timeoutSeconds: 10
nodes:
  - id: check
    command: [/usr/bin/true]
    mutates: false
`
      )
      expect((await loadWorkflowSource(file)).diagnostics).toContainEqual(
        expect.objectContaining({
          code: "workflow-source-schema",
          path: "/callback/headers/Bad~1Header",
          location: expect.objectContaining({ line: 9, column: 19 })
        })
      )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  test("keeps constrained environment records strict in source, final IR, and generated schema", async () => {
    const final = validateWorkflow(workflow([command("check", { env: { "BAD-NAME": "value" } })]))
    expect(final.workflow).toBeNull()
    expect(final.issues).toContainEqual(
      expect.objectContaining({
        code: "environment-name",
        path: "/nodes/0/env/BAD-NAME"
      })
    )

    const generated = JSON.parse(
      await Bun.file(new URL("../../references/workflow.schema.json", import.meta.url)).text()
    )
    const validateGenerated = new Ajv2020({ strict: false }).compile(generated)
    expect(
      validateGenerated({
        name: "invalid-env",
        objective: "Reject invalid record keys.",
        cwd: "/tmp",
        limits: { maxStarts: null },
        nodes: [
          {
            id: "check",
            command: ["/usr/bin/true"],
            mutates: false,
            env: { "BAD-NAME": "value" }
          }
        ]
      })
    ).toBe(false)
  })

  test("closes constrained provenance record keys in Effect and generated schemas", () => {
    const origin = {
      kind: "explicit" as const,
      sourcePath: "/name",
      location: {
        file: "/tmp/workflow.yaml",
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 5
      }
    }
    const valid = {
      source: "/tmp/workflow.yaml",
      origins: { "/name": origin },
      inferredNeeds: { inspect: [] }
    }
    const decode = Schema.decodeUnknownResult(WorkflowProvenanceSchema, {
      errors: "all",
      onExcessProperty: "error"
    })
    expect(Result.isSuccess(decode(valid))).toBe(true)
    expect(Result.isFailure(decode({ ...valid, origins: { "not-a-pointer": origin } }))).toBe(true)
    expect(Result.isFailure(decode({ ...valid, inferredNeeds: { BAD: [] } }))).toBe(true)

    const validateGenerated = new Ajv2020({ strict: false }).compile(
      jsonSchemaDocumentFor(WorkflowProvenanceSchema)
    )
    expect(validateGenerated(valid)).toBe(true)
    expect(validateGenerated({ ...valid, origins: { "not-a-pointer": origin } })).toBe(false)
    expect(validateGenerated({ ...valid, inferredNeeds: { BAD: [] } })).toBe(false)
  })

  test("rejects negative zero before a JSON persistence round trip can collapse it", () => {
    const source = agent("source", {
      output: { format: "json", schema: { type: "object" } }
    })
    const consumer = command("consumer", {
      needs: ["source"],
      when: {
        type: "agent-output",
        node: "source",
        pointer: "/value",
        equals: -0
      }
    })
    const spec = workflow([source, consumer])
    expect(Object.is(spec.nodes[1]?.when?.equals, -0)).toBe(true)
    expect(Object.is(JSON.parse(JSON.stringify(spec)).nodes[1].when.equals, -0)).toBe(false)
    expect(validateWorkflow(spec)).toMatchObject({
      workflow: null,
      digest: null,
      issues: [expect.objectContaining({ code: "json-value" })]
    })
  })

  test("reports every independent Effect schema problem in one validation pass", () => {
    const result = validateWorkflow({})
    expect(result.workflow).toBeNull()
    expect(result.issues.length).toBeGreaterThan(5)
    const messages = result.issues.map((issue) => issue.message).join("\n")
    expect(messages).toContain("name")
    expect(messages).toContain("objective")
    expect(messages).toContain("nodes")
  })

  test("enforces public node-id, path, pointer, and environment-name constraints in Effect Schema", () => {
    const invalid = workflow([
      command("Bad_ID", {
        cwd: "relative/path",
        inheritEnv: ["INVALID-NAME"]
      })
    ])
    const result = validateWorkflow(invalid)
    expect(result.workflow).toBeNull()
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["node-id", "node-cwd", "environment-name"])
    )
    const pointer = validateWorkflow({
      ...workflow([command("check")]),
      repeats: [
        {
          id: "loop",
          members: ["check"],
          until: { type: "agent-output", node: "check", pointer: "not-a-pointer", equals: true },
          maxRounds: 2
        }
      ]
    })
    expect(pointer.issues.map((issue) => issue.code)).toContain("repeat-until")
  })

  test("rejects only the exact launcher-owned environment names at their fields", () => {
    const launcherOwned = [
      "ORCHESTRATE_BIN",
      "ORCHESTRATE_STATE_DIR",
      "ORCHESTRATE_RUN_ID",
      "ORCHESTRATE_NODE_ID",
      "ORCHESTRATE_NODE_TOKEN",
      "ORCHESTRATE_COMPLETION_CONTRACT",
      "ORCHESTRATE_OUTPUT_PATH",
      "ORCHESTRATE_RESULT_PATH",
      "ORCHESTRATE_SOURCE_ROOT"
    ]
    for (const [index, name] of launcherOwned.entries()) {
      const commandResult = validateWorkflow(
        workflow([
          command("check", {
            inheritEnv: index % 2 === 0 ? [name] : [],
            env: index % 2 === 0 ? {} : { [name]: "authored" }
          })
        ])
      )
      expect(commandResult.workflow).toBeNull()
      expect(commandResult.issues).toContainEqual(
        expect.objectContaining({
          code: "reserved-environment",
          path: index % 2 === 0 ? "/nodes/0/inheritEnv/0" : `/nodes/0/env/${name}`
        })
      )
    }

    for (const [index, name] of ["TMPDIR", "TMP", "TEMP"].entries()) {
      const node = agent("review")
      if (node.provider !== "codex") {
        throw new Error("test fixture must be Codex")
      }
      const result = validateWorkflow(
        workflow([
          {
            ...node,
            permissions: {
              ...node.permissions,
              inheritEnv: index % 2 === 0 ? [name] : [],
              env: index % 2 === 0 ? {} : { [name]: "authored" }
            }
          }
        ])
      )
      expect(result.workflow).toBeNull()
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "reserved-environment",
          path:
            index % 2 === 0
              ? "/nodes/0/permissions/inheritEnv/0"
              : `/nodes/0/permissions/env/${name}`
        })
      )
    }

    const allowedAgent = agent("review")
    if (allowedAgent.provider !== "codex") {
      throw new Error("test fixture must be Codex")
    }
    expect(
      validateWorkflow(
        workflow([
          command("check", {
            inheritEnv: ["TMPDIR"],
            env: { ORCHESTRATE_CUSTOM: "kept", TEMP: "/command/temp" }
          }),
          {
            ...allowedAgent,
            permissions: {
              ...allowedAgent.permissions,
              inheritEnv: ["ORCHESTRATE_CUSTOM"],
              env: { ORCHESTRATE_BUILD_ID: "kept" }
            }
          }
        ])
      ).issues.some((issue) => issue.code === "reserved-environment")
    ).toBe(false)
  })

  test("reserves provider lookup and control environment for both agent providers", () => {
    const controlNames = ["PATH", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]
    for (const provider of ["codex", "claude"] as const) {
      for (const name of controlNames) {
        for (const field of ["inheritEnv", "env"] as const) {
          const inherited = field === "inheritEnv" ? [name] : []
          const env = field === "env" ? { [name]: "authored" } : {}
          const id = `${provider}-${name.toLowerCase().replaceAll("_", "-")}-${field === "inheritEnv" ? "inherit" : "env"}`
          const node =
            provider === "codex"
              ? agent(id, {
                  provider,
                  permissions: {
                    access: "read-only",
                    escalation: "deny",
                    extraArgs: [],
                    inheritEnv: inherited,
                    env
                  }
                })
              : agent(id, {
                  provider,
                  permissions: {
                    access: "read-only",
                    escalation: "deny",
                    extraArgs: [],
                    inheritEnv: inherited,
                    env
                  }
                })
          const result = validateWorkflow(workflow([node]))
          expect(result.workflow).toBeNull()
          expect(result.issues).toContainEqual(
            expect.objectContaining({
              code: "reserved-environment",
              path:
                field === "inheritEnv"
                  ? "/nodes/0/permissions/inheritEnv/0"
                  : `/nodes/0/permissions/env/${name}`
            })
          )
        }
      }
    }
  })

  test("supports captured Codex resume and fork lineage", () => {
    const source = agent("source", {
      session: { mode: "fresh", from: null, saveAs: "source-session" }
    })
    const resumed = agent("resume", {
      needs: ["source"],
      session: { mode: "resume", from: "source-session", saveAs: "resumed-session" }
    })
    const forked = agent("fork", {
      needs: ["resume"],
      session: { mode: "fork", from: "resumed-session", saveAs: "forked-session" }
    })
    expect(validateWorkflow(workflow([source, resumed, forked])).issues).toEqual([])
  })

  test("separates access from escalation and keeps Claude unattended", () => {
    const claude = {
      ...agent("claude-review"),
      provider: "claude" as const,
      workspace: { ...workspace(), writes: ["review-result/**"] },
      permissions: {
        access: "read-only" as const,
        escalation: "deny" as const,
        extraArgs: [],
        inheritEnv: [],
        env: {}
      }
    }
    expect(validateWorkflow(workflow([claude])).issues).toEqual([])
    const invalid = {
      ...claude,
      permissions: { ...claude.permissions, escalation: "ask-user" as const }
    }
    expect(validateWorkflow(workflow([invalid])).issues.map((issue) => issue.code)).toContain(
      "permission-escalation"
    )
  })

  test("accepts provider-neutral Claude write access and rejects caller-controlled arguments", () => {
    const base = {
      ...agent("claude-review"),
      provider: "claude" as const,
      workspace: { ...workspace(), writes: ["src/**"] },
      permissions: {
        access: "read-only" as const,
        escalation: "deny" as const,
        extraArgs: [],
        inheritEnv: [],
        env: {}
      }
    }
    const bypass = {
      ...base,
      permissions: {
        ...base.permissions,
        access: "workspace-write" as const
      }
    }
    expect(validateWorkflow(workflow([bypass])).issues).toEqual([])
    for (const extraArgs of [
      ["--allowedTools", "Edit(/**)"],
      ["--disallowedTools", "Read"],
      ["--tools", "default"],
      ["--settings", '{"sandbox":{"enabled":false}}'],
      ["--add-dir", "/"]
    ]) {
      const adversary = {
        ...base,
        permissions: { ...base.permissions, extraArgs }
      }
      expect(validateWorkflow(workflow([adversary])).issues.map((issue) => issue.code)).toContain(
        "reserved-provider-argument"
      )
    }
  })

  test("rejects mutating Codex and Claude authority overlap through every effective root and write prefix", () => {
    const saved = {
      home: process.env.HOME,
      state: process.env.ORCHESTRATE_STATE_DIR,
      xdg: process.env.XDG_STATE_HOME,
      bin: process.env.ORCHESTRATE_BIN,
      codexHome: process.env.CODEX_HOME,
      claudeConfig: process.env.CLAUDE_CONFIG_DIR
    }
    process.env.HOME = "/tmp/orchestrate-authority-home"
    process.env.XDG_STATE_HOME = "/tmp/orchestrate-authority-home/.local/state"
    delete process.env.ORCHESTRATE_STATE_DIR
    process.env.ORCHESTRATE_BIN =
      "/tmp/orchestrate-authority-home/.local/share/orchestrate/current/bin/orchestrate"
    process.env.CODEX_HOME = "/tmp/orchestrate-provider-control/codex"
    process.env.CLAUDE_CONFIG_DIR = "/tmp/orchestrate-provider-control/claude"
    try {
      const codex = agent("codex-write", {
        workspace: { ...workspace(), writes: ["src/**"] },
        permissions: {
          access: "workspace-write",
          escalation: "deny",
          extraArgs: [],
          inheritEnv: [],
          env: {}
        }
      })
      const claude = {
        ...agent("claude-write"),
        provider: "claude" as const,
        workspace: { ...workspace(), writes: ["src/**"] },
        permissions: {
          access: "workspace-write" as const,
          escalation: "deny" as const,
          extraArgs: [],
          inheritEnv: [],
          env: {}
        }
      }
      const claudeReadOnly = {
        ...claude,
        permissions: {
          ...claude.permissions,
          access: "read-only" as const
        }
      }
      const protectedPaths = [
        stateRoot(),
        path.dirname(stateRoot()),
        path.join(stateRoot(), "runs", "20260803000000-aaaaaaaa"),
        "/tmp/orchestrate-provider-control/codex",
        "/tmp/orchestrate-provider-control/codex/profiles",
        "/tmp/orchestrate-provider-control/claude",
        "/tmp/orchestrate-provider-control/claude/projects",
        "/tmp/orchestrate-authority-home/.local/share/orchestrate/current",
        "/tmp/orchestrate-authority-home/.codex/skills/orchestrate"
      ]
      for (const root of protectedPaths) {
        expect(
          validateWorkflow({ ...workflow([{ ...codex, cwd: root }]), cwd: "/tmp/safe" }).issues.map(
            (issue) => issue.code
          )
        ).toContain("protected-path")
        expect(
          validateWorkflow({
            ...workflow([{ ...claude, workspace: { ...claude.workspace, path: root } }]),
            cwd: "/tmp/safe"
          }).issues.map((issue) => issue.code)
        ).toContain("protected-path")
        expect(
          validateWorkflow({
            ...workflow([
              { ...claudeReadOnly, workspace: { ...claudeReadOnly.workspace, path: root } }
            ]),
            cwd: "/tmp/safe"
          }).issues.map((issue) => issue.code)
        ).not.toContain("protected-path")
        for (const providerNode of [codex, claude]) {
          expect(
            validateWorkflow({
              ...workflow([
                {
                  ...providerNode,
                  workspace: {
                    ...providerNode.workspace,
                    path: "/tmp/safe-workspace",
                    writes: [path.join(root, "**")]
                  }
                }
              ]),
              cwd: "/tmp/safe"
            }).issues.map((issue) => issue.code)
          ).toContain("protected-path")
        }
      }
      expect(
        validateWorkflow({
          ...workflow([codex]),
          cwd: stateRoot()
        }).issues.map((issue) => issue.code)
      ).toContain("protected-path")

      process.env.ORCHESTRATE_STATE_DIR = "/tmp/custom-orchestrate-state"
      expect(
        validateWorkflow({
          ...workflow([
            {
              ...codex,
              workspace: {
                ...codex.workspace,
                path: "/tmp/safe-workspace",
                writes: [path.join(submissionsRoot(), "*", "**")]
              }
            }
          ]),
          cwd: "/tmp/safe"
        }).issues.map((issue) => issue.code)
      ).toContain("protected-path")

      const readOnly = agent("read-only", {
        cwd: "/tmp/custom-orchestrate-state",
        workspace: { ...workspace(), writes: [] }
      })
      expect(validateWorkflow({ ...workflow([readOnly]), cwd: "/tmp/safe" }).issues).toEqual([])
    } finally {
      if (saved.home === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = saved.home
      }
      if (saved.state === undefined) {
        delete process.env.ORCHESTRATE_STATE_DIR
      } else {
        process.env.ORCHESTRATE_STATE_DIR = saved.state
      }
      if (saved.xdg === undefined) {
        delete process.env.XDG_STATE_HOME
      } else {
        process.env.XDG_STATE_HOME = saved.xdg
      }
      if (saved.bin === undefined) {
        delete process.env.ORCHESTRATE_BIN
      } else {
        process.env.ORCHESTRATE_BIN = saved.bin
      }
      if (saved.codexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = saved.codexHome
      }
      if (saved.claudeConfig === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = saved.claudeConfig
      }
    }
  })

  test("rejects a non-canonical mutating write prefix before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-write-prefix-"))
    try {
      const canonical = path.join(root, "canonical")
      const linked = path.join(root, "linked")
      await mkdir(canonical)
      await symlink(canonical, linked)
      const writer = agent("writer", {
        workspace: {
          mode: "existing",
          path: canonical,
          vcs: "none",
          writes: [path.join(linked, "subject.txt")],
          exclusiveResources: []
        },
        permissions: {
          access: "workspace-write",
          escalation: "deny",
          extraArgs: [],
          inheritEnv: [],
          env: {}
        }
      })
      expect(validateWorkflow(workflow([writer])).issues.map((issue) => issue.code)).toContain(
        "workspace-write-symlink"
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("compares command write sets by canonical physical path identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-command-write-"))
    try {
      const canonical = path.join(root, "canonical")
      const linked = path.join(root, "linked")
      await mkdir(canonical)
      await symlink(canonical, linked)
      const writer = (id: string, workspacePath: string) =>
        command(id, {
          mutates: true,
          workspace: {
            mode: "existing",
            path: workspacePath,
            vcs: "none",
            writes: ["shared/**"],
            exclusiveResources: []
          }
        })
      expect(
        validateWorkflow(workflow([writer("left", canonical), writer("right", linked)])).issues.map(
          (issue) => issue.code
        )
      ).toContain("write-conflict")
      expect(
        validateWorkflow(
          workflow([writer("left", canonical), writer("right", path.join(root, "distinct"))])
        ).issues.map((issue) => issue.code)
      ).not.toContain("write-conflict")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("uses the inspected volume case semantics for write conflicts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-write-case-"))
    const writer = (id: string, write: string) =>
      command(id, {
        mutates: true,
        workspace: {
          ...workspace(),
          path: root,
          writes: [write]
        }
      })
    try {
      const nodes = [writer("upper", "CaseTarget/**"), writer("lower", "casetarget/**")]
      injectPathCaseSensitivityForTests(() => false)
      expect(validateWorkflow(workflow(nodes)).issues.map((issue) => issue.code)).toContain(
        "write-conflict"
      )
      injectPathCaseSensitivityForTests(() => true)
      expect(validateWorkflow(workflow(nodes)).issues.map((issue) => issue.code)).not.toContain(
        "write-conflict"
      )
    } finally {
      injectPathCaseSensitivityForTests(null)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("matches the containing volume's observed case behavior", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orchestrate-volume-case-"))
    try {
      const canonical = path.join(root, "CaseWorkspace")
      const alternate = path.join(root, "caseWorkspace")
      await mkdir(canonical)
      const canonicalReal = await realpath(canonical)
      const caseAliases = await realpath(alternate).then(
        (resolved) => resolved === canonicalReal,
        () => false
      )
      const writer = (id: string, workspacePath: string) =>
        command(id, {
          mutates: true,
          workspace: {
            mode: "existing",
            path: workspacePath,
            vcs: "none",
            writes: ["shared/**"],
            exclusiveResources: []
          }
        })
      const hasConflict = validateWorkflow(
        workflow([writer("canonical", canonical), writer("alternate", alternate)])
      ).issues.some((issue) => issue.code === "write-conflict")
      expect(hasConflict).toBe(caseAliases)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reports uncertain static write-prefix inspection instead of comparing lexical paths", () => {
    const candidate = "/tmp/uncertain-prefix"
    injectPathInspectionForTests((ancestor) => {
      if (ancestor === candidate) {
        throw Object.assign(new Error("simulated I/O failure"), { code: "EIO" })
      }
    })
    try {
      const result = validateWorkflow(
        workflow([
          command("left", {
            mutates: true,
            workspace: { ...workspace(), writes: [candidate] }
          }),
          command("right", {
            mutates: true,
            workspace: { ...workspace(), writes: ["other/**"] }
          })
        ])
      )
      const issue = result.issues.find(
        (candidateIssue) => candidateIssue.code === "write-prefix-inspection"
      )
      expect(issue?.message).toContain('Node "left"')
      expect(issue?.message).toContain(JSON.stringify(candidate))
      expect(issue?.message).toContain(`candidate "${candidate}"`)
      expect(issue?.message).toContain(`ancestor "${candidate}" (EIO)`)
    } finally {
      injectPathInspectionForTests(null)
    }
  })

  test("rejects empty aliases and unordered mutable session fanout", () => {
    const emptyAlias = structuredClone(workflow([agent("empty")])) as unknown as {
      nodes: Array<{ session: { saveAs: string } }>
    }
    emptyAlias.nodes[0]!.session.saveAs = ""
    expect(validateWorkflow(emptyAlias).digest).toBeNull()

    const source = agent("source", {
      session: { mode: "fresh", from: null, saveAs: "shared-session" }
    })
    const left = agent("left", {
      needs: ["source"],
      session: { mode: "resume", from: "shared-session", saveAs: null }
    })
    const right = agent("right", {
      needs: ["source"],
      session: { mode: "resume", from: "shared-session", saveAs: null }
    })
    expect(
      validateWorkflow(workflow([source, left, right])).issues.map((issue) => issue.code)
    ).toContain("session-fanout")
  })

  test("reports a cyclic session graph without recursing", () => {
    const left = agent("left", {
      needs: ["right"],
      session: { mode: "resume", from: "right-session", saveAs: "left-session" }
    })
    const right = agent("right", {
      needs: ["left"],
      session: { mode: "resume", from: "left-session", saveAs: "right-session" }
    })
    const result = validateWorkflow(workflow([left, right]))
    expect(result.digest).toBeNull()
    expect(result.issues.map((issue) => issue.code)).toContain("cycle")
  })

  test("reserves the runtime round suffix", () => {
    const result = validateWorkflow(workflow([command("review--r2")]))
    expect(result.issues.map((issue) => issue.code)).toContain("node-id")
    expect(result.digest).toBeNull()
  })

  test("accepts a fixed repeat with explicit previous-round input", () => {
    const implement = agent("implement", {
      inputs: [{ from: "review", as: "Previous review", include: "content", round: "previous" }]
    })
    const review = agent("review", {
      needs: ["implement"],
      gate: "approval",
      output: {
        format: "json",
        schema: {
          type: "object",
          properties: { clean: { type: "boolean" } },
          required: ["clean"],
          additionalProperties: false
        }
      }
    })
    const spec = {
      ...workflow([implement, review]),
      repeats: [
        {
          id: "review-loop",
          members: ["implement", "review"],
          until: { type: "agent-output" as const, node: "review", pointer: "/clean", equals: true },
          maxRounds: 4
        }
      ]
    }
    expect(validateWorkflow(spec).issues).toEqual([])
  })

  test("allows an outside consumer to bind the final repeat result", () => {
    const check = command("check", { allowedExitCodes: [2] })
    const summarize = agent("summarize", {
      needs: ["check"],
      inputs: [{ from: "check", as: "Final check", include: "content", round: "current" }]
    })
    const spec = {
      ...workflow([check, summarize]),
      repeats: [
        {
          id: "check-loop",
          members: ["check"],
          until: { type: "command-success" as const, node: "check" },
          maxRounds: 3
        }
      ]
    }
    expect(validateWorkflow(spec).issues).toEqual([])
  })

  test("rejects cross-loop previous inputs and unknown repeat session sources", () => {
    const first = agent("first", {
      session: { mode: "resume", from: "outside-session", saveAs: null },
      inputs: [{ from: "other", as: "Other", include: "content", round: "previous" }]
    })
    const other = agent("other")
    const spec = {
      ...workflow([first, other]),
      repeats: [
        {
          id: "first-loop",
          members: ["first"],
          until: { type: "agent-output" as const, node: "first", pointer: "/clean", equals: true },
          maxRounds: 2
        },
        {
          id: "other-loop",
          members: ["other"],
          until: { type: "agent-output" as const, node: "other", pointer: "/clean", equals: true },
          maxRounds: 2
        }
      ]
    }
    const codes = validateWorkflow(spec).issues.map((issue) => issue.code)
    expect(codes).toContain("session-source")
    expect(codes).toContain("input-round")
  })

  test("accepts linear persistent sessions in repeats and rejects ambiguous lineage shapes", () => {
    const seed = agent("seed", {
      session: { mode: "fresh", from: null, saveAs: "reviewer" }
    })
    const review = agent("review", {
      needs: ["seed"],
      prompt: "REVIEW s1 r{{round}}.",
      session: { mode: "resume", from: "reviewer", saveAs: null }
    })
    const verdict = agent("verdict", {
      needs: ["review"],
      session: { mode: "resume", from: "reviewer", saveAs: null },
      output: {
        format: "json",
        schema: {
          type: "object",
          required: ["done"],
          properties: { done: { type: "boolean" } }
        }
      }
    })
    const persistent = {
      ...workflow([seed, review, verdict]),
      repeats: [
        {
          id: "review-loop",
          members: ["review", "verdict"],
          until: { type: "agent-output" as const, node: "verdict", pointer: "/done", equals: true },
          maxRounds: 2
        }
      ]
    }
    expect(
      validateWorkflow(persistent).issues.filter((issue) => issue.severity === "error")
    ).toEqual([])

    const retrying = {
      ...persistent,
      nodes: persistent.nodes.map((node) =>
        node.id === "review" ? { ...node, retry: { maxAttempts: 2 } } : node
      )
    }
    expect(validateWorkflow(retrying).issues.filter((issue) => issue.severity === "error")).toEqual(
      []
    )

    const forked = {
      ...persistent,
      nodes: persistent.nodes.map((node) =>
        node.id === "review"
          ? {
              ...node,
              session: { mode: "fork" as const, from: "reviewer", saveAs: "forked-reviewer" }
            }
          : node
      )
    }
    expect(validateWorkflow(forked).issues.map((issue) => issue.code)).toContain("repeat-session")

    const renamed = {
      ...persistent,
      nodes: persistent.nodes.map((node) =>
        node.id === "review"
          ? Object.assign({}, node, {
              session: { mode: "resume" as const, from: "reviewer", saveAs: "next" }
            })
          : node
      )
    }
    expect(validateWorkflow(renamed).issues.map((issue) => issue.code)).toContain("repeat-session")

    const outsidePlaceholder = agent("outside-placeholder", {
      prompt: "REVIEW s1 r{{round}}."
    })
    expect(
      validateWorkflow(workflow([outsidePlaceholder])).issues.map((issue) => issue.code)
    ).toContain("prompt-round")
  })

  test("validates conditional nodes, repeat verdicts, and skipped path inputs", () => {
    const decision = agent("decision", {
      output: {
        format: "json",
        schema: {
          type: "object",
          required: ["run"],
          properties: { run: { type: "boolean" } }
        }
      }
    })
    const optional = agent("optional", {
      needs: ["decision"],
      when: { type: "agent-output", node: "decision", pointer: "/run", equals: true }
    })
    expect(
      validateWorkflow(workflow([decision, optional])).issues.filter(
        (issue) => issue.severity === "error"
      )
    ).toEqual([])

    const untypedDecision = agent("untyped-decision", {
      output: { format: "json", schema: null }
    })
    const untypedOptional = agent("untyped-optional", {
      needs: ["untyped-decision"],
      when: {
        type: "agent-output",
        node: "untyped-decision",
        pointer: "/run",
        equals: true
      }
    })
    expect(
      validateWorkflow(workflow([untypedDecision, untypedOptional])).issues.map(
        (issue) => issue.code
      )
    ).toContain("condition-source")

    const indirect = agent("indirect", {
      needs: ["optional"],
      when: { type: "agent-output", node: "decision", pointer: "/run", equals: true }
    })
    expect(
      validateWorkflow(workflow([decision, optional, indirect])).issues.map((issue) => issue.code)
    ).toContain("condition-order")

    const pathConsumer = agent("path-consumer", {
      needs: ["optional"],
      inputs: [{ from: "optional", as: "Optional path", include: "path", round: "current" }]
    })
    expect(
      validateWorkflow(workflow([decision, optional, pathConsumer])).issues.map(
        (issue) => issue.code
      )
    ).toContain("conditional-input-path")

    const conditionalVerdict = {
      ...workflow([decision, optional]),
      repeats: [
        {
          id: "conditional-loop",
          members: ["decision", "optional"],
          until: { type: "agent-output" as const, node: "optional", pointer: "", equals: true },
          maxRounds: 2
        }
      ]
    }
    expect(validateWorkflow(conditionalVerdict).issues.map((issue) => issue.code)).toContain(
      "condition-verdict"
    )
  })

  test("accepts composed verdict schemas and rejects an invalid JSON pointer", () => {
    const review = agent("review", {
      output: {
        format: "json",
        schema: {
          allOf: [
            {
              type: "object",
              properties: { clean: { type: "boolean" } },
              required: ["clean"]
            }
          ]
        }
      }
    })
    const base = workflow([review])
    const repeat = {
      id: "review-loop",
      members: ["review"],
      until: { type: "agent-output" as const, node: "review", pointer: "/clean", equals: true },
      maxRounds: 2
    }
    expect(validateWorkflow({ ...base, repeats: [repeat] }).issues).toEqual([])
    expect(
      validateWorkflow({
        ...base,
        repeats: [{ ...repeat, until: { ...repeat.until, pointer: "/bad~2escape" } }]
      }).issues.map((issue) => issue.code)
    ).toContain("repeat-until")
  })

  test("rejects a two-round Git worktree repeat without a per-instance branch token", () => {
    const check = command("check", {
      workspace: {
        mode: "git-worktree",
        path: null,
        vcs: "git",
        writes: [],
        exclusiveResources: [],
        git: {
          branch: "review/{{runId}}",
          startPoint: "HEAD",
          removeOnClean: true
        }
      }
    })
    const repeat = {
      id: "check-loop",
      members: ["check"],
      until: { type: "command-success" as const, node: "check" },
      maxRounds: 2
    }
    const invalid = validateWorkflow({ ...workflow([check]), repeats: [repeat] })
    expect(invalid.digest).toBeNull()
    expect(invalid.issues.map((issue) => issue.code)).toContain("repeat-worktree-branch")

    const fixedPath = validateWorkflow({
      ...workflow([
        command("check", {
          workspace: {
            mode: "git-worktree",
            path: "/tmp/fixed-repeat-worktree",
            vcs: "git",
            writes: [],
            exclusiveResources: [],
            git: {
              branch: "review/{{runId}}/{{nodeId}}",
              startPoint: "HEAD",
              removeOnClean: true
            }
          }
        })
      ]),
      repeats: [repeat]
    })
    expect(fixedPath.issues.map((issue) => issue.code)).toContain("repeat-worktree-path")

    const validCheck = command("check", {
      workspace: {
        mode: "git-worktree",
        path: "/tmp/check-{{nodeId}}",
        vcs: "git",
        writes: [],
        exclusiveResources: [],
        git: {
          branch: "review/{{runId}}/{{nodeId}}",
          startPoint: "HEAD",
          removeOnClean: true
        }
      }
    })
    const valid = validateWorkflow({
      ...workflow([validCheck]),
      repeats: [repeat]
    })
    expect(valid.issues).toEqual([])
  })
})
