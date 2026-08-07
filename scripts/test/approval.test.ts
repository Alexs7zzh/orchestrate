import { afterEach, describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { approvalPreview, InvalidWorkflowProvenanceError, originLabel } from "../src/approval.js"
import { digestWorkflow } from "../src/digest.js"
import { SourceLocationSchema } from "../src/schema.js"
import { loadWorkflowSource } from "../src/workflow-source.js"
import { workflowSourceYaml } from "./workflow-source-fixture.js"

let temporaryRoot: string | null = null

afterEach(async () => {
  if (temporaryRoot !== null) {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  temporaryRoot = null
})

async function loadedWorkflow() {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-approval-"))
  const file = path.join(temporaryRoot, "workflow.yaml")
  await Bun.write(
    file,
    `name: approval
objective: Show exact approval data.
cwd: ${temporaryRoot}
callback:
  type: webhook
  url: https://user:password@example.test/hook?secret=value#fragment
  headers:
    Z-Token: hidden
    A-Token: also-hidden
  timeoutSeconds: 5
limits: { maxStarts: null }
nodes:
  - id: review
    agent: codex
    prompt: "Review\\nexactly."
    access: read-only
    env:
      PRIVATE_TOKEN: first-secret
    output: { format: text }
`
  )
  const loaded = await loadWorkflowSource(file)
  if (loaded.workflow === null || loaded.provenance === null) {
    throw new Error(JSON.stringify(loaded.diagnostics))
  }
  return { workflow: loaded.workflow, provenance: loaded.provenance }
}

async function loadedInferredWorkflow() {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orchestrate-approval-inferred-"))
  const file = path.join(temporaryRoot, "workflow.yaml")
  await Bun.write(
    file,
    `name: inferred-approval
objective: Validate inferred dependency provenance.
cwd: ${temporaryRoot}
limits: { maxStarts: null }
nodes:
  - id: explicit
    command: ["/usr/bin/printf", "explicit"]
    mutates: false
  - id: inferred
    command: ["/usr/bin/printf", "inferred"]
    mutates: false
  - id: review
    agent: codex
    prompt: Review both inputs.
    access: read-only
    needs: [explicit]
    inputs:
      - from: inferred
        as: evidence
`
  )
  const loaded = await loadWorkflowSource(file)
  if (loaded.workflow === null || loaded.provenance === null) {
    throw new Error(JSON.stringify(loaded.diagnostics))
  }
  return { workflow: loaded.workflow, provenance: loaded.provenance }
}

async function reloadWorkflow(
  workflow: Awaited<ReturnType<typeof loadedWorkflow>>["workflow"],
  name: string
) {
  if (temporaryRoot === null) {
    throw new Error("expected temporary approval directory")
  }
  const file = path.join(temporaryRoot, `${name}.yaml`)
  await Bun.write(file, workflowSourceYaml(workflow), { createPath: false })
  const loaded = await loadWorkflowSource(file)
  if (loaded.workflow === null || loaded.provenance === null) {
    throw new Error(JSON.stringify(loaded.diagnostics))
  }
  return { workflow: loaded.workflow, provenance: loaded.provenance }
}

describe("approval preview", () => {
  test("accepts only all-null sentinels or ordered one-based source ranges", () => {
    const decode = Schema.decodeUnknownResult(SourceLocationSchema, { errors: "all" })
    const file = "/tmp/workflow.yaml"
    for (const location of [
      { file, line: null, column: null, endLine: null, endColumn: null },
      { file, line: 1, column: 1, endLine: 1, endColumn: 1 },
      { file, line: 1, column: 9, endLine: 2, endColumn: 1 }
    ]) {
      expect(Result.isSuccess(decode(location))).toBe(true)
    }
    for (const location of [
      { file, line: 0, column: 1, endLine: 1, endColumn: 1 },
      { file, line: 1, column: null, endLine: 1, endColumn: 1 },
      { file, line: 2, column: 1, endLine: 1, endColumn: 9 },
      { file, line: 1, column: 9, endLine: 1, endColumn: 8 }
    ]) {
      expect(Result.isFailure(decode(location))).toBe(true)
    }
  })

  test("is deterministic, pure, complete, and secret-redacted", async () => {
    const loaded = await loadedWorkflow()
    const workflowBefore = structuredClone(loaded.workflow)
    const provenanceBefore = structuredClone(loaded.provenance)
    const first = approvalPreview(loaded.workflow, loaded.provenance)
    const second = approvalPreview(loaded.workflow, loaded.provenance)

    expect(first).toEqual(second)
    expect(loaded.workflow).toEqual(workflowBefore)
    expect(loaded.provenance).toEqual(provenanceBefore)
    expect(first.callback).toEqual({
      type: "webhook",
      endpoint: "https://example.test/hook",
      query: [{ name: "secret", value: "[redacted]" }],
      headerNames: ["A-Token", "Z-Token"],
      timeoutSeconds: 5
    })
    expect(first.nodes[0]).toMatchObject({
      id: "review",
      explicitNeeds: [],
      inferredNeeds: [],
      prompt: "Review\nexactly.",
      environmentKeys: ["PRIVATE_TOKEN"]
    })
    expect(JSON.stringify(first)).not.toContain("first-secret")
    expect(JSON.stringify(first)).not.toContain("password")
    expect(JSON.stringify(first)).not.toContain('"value":"value"')
    expect(JSON.stringify(first)).not.toContain("hidden")
    expect(first.origins["/concurrency"]?.kind).toBe("default")
    expect(originLabel(first.origins["/nodes/0/permissions/access"])).toBe(
      "[expanded:access-profile]"
    )

    const changed = structuredClone(loaded.workflow)
    if (changed.nodes[0]?.type !== "agent") {
      throw new Error("expected agent")
    }
    const changedEnvironment = changed.nodes[0].permissions.env as Record<string, string>
    changedEnvironment.PRIVATE_TOKEN = "second-secret"
    expect(digestWorkflow(changed)).not.toBe(digestWorkflow(loaded.workflow))
  })

  test("fails closed on missing and dangling final-IR provenance", async () => {
    const loaded = await loadedWorkflow()
    const missingLeaf = {
      ...loaded.provenance,
      origins: { ...loaded.provenance.origins }
    }
    delete missingLeaf.origins["/nodes/0/workspace/path"]
    expect(() => approvalPreview(loaded.workflow, missingLeaf)).toThrow(
      InvalidWorkflowProvenanceError
    )

    const missingArrayItem = {
      ...loaded.provenance,
      origins: { ...loaded.provenance.origins }
    }
    delete missingArrayItem.origins["/nodes/0"]
    expect(() => approvalPreview(loaded.workflow, missingArrayItem)).toThrow(
      "Missing final-IR origin /nodes/0"
    )

    const dangling = { ...loaded.provenance, origins: { ...loaded.provenance.origins } }
    dangling.origins["/nodes/0/session/resume"] = loaded.provenance.origins["/nodes/0/session"]!
    expect(() => approvalPreview(loaded.workflow, dangling)).toThrow(
      "Dangling final-IR origin /nodes/0/session/resume"
    )
  })

  test("distinguishes callback actions and routing while redacting credentials", async () => {
    const loaded = await loadedWorkflow()
    const command = {
      ...structuredClone(loaded.workflow),
      callback: {
        type: "command" as const,
        argv: [
          "curl",
          "publish",
          "--token",
          "flag-value",
          "--channel=stable",
          "-H",
          "Authorization: Bearer adjacent-secret",
          "--header=Authorization: Bearer equals-header-secret",
          "--header",
          "Proxy-Authorization: Basic adjacent-proxy-secret",
          "--header",
          "X-Route: stable",
          "-u",
          "adjacent-user:adjacent-password",
          "--user=equals-user:equals-password",
          "--url",
          "https://adjacent:password@example.test/hook?action=publish&token=adjacent-query",
          "--url=https://equals:password@example.test/hook?action=rollback&secret=equals-query"
        ],
        timeoutSeconds: 5
      }
    }
    const secondCommand = {
      ...structuredClone(command),
      callback: {
        type: "command" as const,
        argv: [
          "/usr/bin/env",
          "SECRET=other-value",
          "rollback",
          "--token",
          "other-flag-value",
          "--channel=canary"
        ],
        timeoutSeconds: 5
      }
    }
    const loadedCommand = await reloadWorkflow(command, "command")
    const loadedSecondCommand = await reloadWorkflow(secondCommand, "second-command")
    const commandPreview = approvalPreview(
      loadedCommand.workflow,
      loadedCommand.provenance
    ).callback
    const secondCommandPreview = approvalPreview(
      loadedSecondCommand.workflow,
      loadedSecondCommand.provenance
    ).callback
    expect(commandPreview).toEqual({
      type: "command",
      argv: [
        "curl",
        "publish",
        "--token",
        "[redacted]",
        "--channel=stable",
        "-H",
        "Authorization: [redacted]",
        "--header=Authorization: [redacted]",
        "--header",
        "Proxy-Authorization: [redacted]",
        "--header",
        "X-Route: stable",
        "-u",
        "[redacted]",
        "--user=[redacted]",
        "--url",
        "https://example.test/hook?action=publish&token=%5Bredacted%5D",
        "--url=https://example.test/hook?action=rollback&secret=%5Bredacted%5D"
      ],
      timeoutSeconds: 5
    })
    expect(secondCommandPreview).not.toEqual(commandPreview)
    expect(JSON.stringify([commandPreview, secondCommandPreview])).not.toMatch(
      /flag-value|other-value|adjacent-secret|equals-header-secret|adjacent-proxy-secret|adjacent-user|equals-user|adjacent-query|equals-query/
    )

    const webhook = {
      ...structuredClone(loaded.workflow),
      callback: {
        type: "webhook" as const,
        url: "https://user:password@example.test/hook?action=publish&token=query-value",
        headers: {},
        timeoutSeconds: 5
      }
    }
    const secondWebhook = {
      ...structuredClone(webhook),
      callback: {
        type: "webhook" as const,
        url: "https://other:credential@example.test/hook?action=rollback&token=other-query-value",
        headers: {},
        timeoutSeconds: 5
      }
    }
    const loadedWebhook = await reloadWorkflow(webhook, "webhook")
    const loadedSecondWebhook = await reloadWorkflow(secondWebhook, "second-webhook")
    const webhookPreview = approvalPreview(
      loadedWebhook.workflow,
      loadedWebhook.provenance
    ).callback
    const secondWebhookPreview = approvalPreview(
      loadedSecondWebhook.workflow,
      loadedSecondWebhook.provenance
    ).callback
    expect(webhookPreview).toMatchObject({
      endpoint: "https://example.test/hook",
      query: [
        { name: "action", value: "publish" },
        { name: "token", value: "[redacted]" }
      ]
    })
    expect(secondWebhookPreview).not.toEqual(webhookPreview)
    expect(JSON.stringify([webhookPreview, secondWebhookPreview])).not.toMatch(
      /password|credential|query-value/
    )
  })

  test("rejects wrong source files and impossible normalized-IR origins", async () => {
    const loaded = await loadedWorkflow()
    const name = loaded.provenance.origins["/name"]
    if (name === undefined) {
      throw new Error("expected name provenance")
    }
    const wrongFile = {
      ...loaded.provenance,
      origins: {
        ...loaded.provenance.origins,
        "/name": {
          ...name,
          location: { ...name.location, file: "/tmp/unrelated.yaml" }
        }
      }
    }
    expect(() => approvalPreview(loaded.workflow, wrongFile)).toThrow(
      "does not match provenance source"
    )

    const impossibleLocations = [
      {
        location: { file: loaded.provenance.source, line: 0, column: 1, endLine: 1, endColumn: 1 },
        message: "all positive integers"
      },
      {
        location: {
          file: loaded.provenance.source,
          line: 1,
          column: null,
          endLine: 1,
          endColumn: 1
        },
        message: "either all null or all positive integers"
      },
      {
        location: { file: loaded.provenance.source, line: 2, column: 1, endLine: 1, endColumn: 9 },
        message: "range start must not follow its end"
      },
      {
        location: { file: loaded.provenance.source, line: 1, column: 9, endLine: 1, endColumn: 8 },
        message: "range start must not follow its end"
      }
    ]
    impossibleLocations.forEach(({ location, message }) => {
      const provenance = {
        ...loaded.provenance,
        origins: {
          ...loaded.provenance.origins,
          "/name": { ...name, location }
        }
      } as typeof loaded.provenance
      expect(() => approvalPreview(loaded.workflow, provenance)).toThrow(message)
    })

    for (const location of [
      { file: loaded.provenance.source, line: null, column: null, endLine: null, endColumn: null },
      { file: loaded.provenance.source, line: 1, column: 2, endLine: 1, endColumn: 2 },
      { file: loaded.provenance.source, line: 1, column: 9, endLine: 2, endColumn: 1 }
    ]) {
      expect(() =>
        approvalPreview(loaded.workflow, {
          ...loaded.provenance,
          origins: {
            ...loaded.provenance.origins,
            "/name": { ...name, location }
          }
        })
      ).not.toThrow()
    }

    for (const pointer of [
      "/nodes/0/type",
      "/nodes/0/provider",
      "/nodes/0/permissions/access",
      "/nodes/0/session",
      "/nodes/0/retry"
    ]) {
      const origin = loaded.provenance.origins[pointer]
      if (origin === undefined) {
        throw new Error(`expected provenance for ${pointer}`)
      }
      const impossible = {
        ...loaded.provenance,
        origins: {
          ...loaded.provenance.origins,
          [pointer]: {
            kind: "explicit" as const,
            sourcePath: pointer,
            location: origin.location
          }
        }
      }
      expect(() => approvalPreview(loaded.workflow, impossible)).toThrow(
        "exists only in normalized IR"
      )
    }

    const concurrency = loaded.provenance.origins["/concurrency"]
    if (concurrency?.kind !== "default") {
      throw new Error("expected default concurrency provenance")
    }
    const wrongRule = {
      ...loaded.provenance,
      origins: {
        ...loaded.provenance.origins,
        "/concurrency": { ...concurrency, rule: "root.milestones.false" }
      }
    }
    expect(() => approvalPreview(loaded.workflow, wrongRule)).toThrow(
      'expected default rule "root.concurrency.one"'
    )
  })

  test("keeps omitted optional presentation absent from the preview", async () => {
    const loaded = await loadedWorkflow()
    expect(approvalPreview(loaded.workflow, loaded.provenance)).not.toHaveProperty("presentation")
  })

  test("requires inferredNeeds to exactly match final need-item origins", async () => {
    const loaded = await loadedInferredWorkflow()
    const annotation = loaded.provenance.inferredNeeds.review?.[0]
    const inferredOrigin = loaded.provenance.origins["/nodes/2/needs/1"]
    if (annotation === undefined || inferredOrigin?.kind !== "inferred") {
      throw new Error("expected normalized inferred dependency provenance")
    }
    expect(approvalPreview(loaded.workflow, loaded.provenance).nodes[2]).toMatchObject({
      explicitNeeds: ["explicit"],
      inferredNeeds: [annotation]
    })

    const variants = [
      { ...loaded.provenance, inferredNeeds: {} },
      {
        ...loaded.provenance,
        inferredNeeds: { review: [annotation, annotation] }
      },
      {
        ...loaded.provenance,
        inferredNeeds: { review: [{ ...annotation, node: "explicit" }] }
      },
      {
        ...loaded.provenance,
        inferredNeeds: {
          review: [
            {
              ...annotation,
              reason: annotation.reason === "when" ? ("input-current" as const) : ("when" as const)
            }
          ]
        }
      },
      {
        ...loaded.provenance,
        inferredNeeds: { review: [{ ...annotation, sourcePath: "/nodes/2/prompt" }] }
      },
      {
        ...loaded.provenance,
        inferredNeeds: { ...loaded.provenance.inferredNeeds, explicit: [annotation] }
      },
      {
        ...loaded.provenance,
        inferredNeeds: { ...loaded.provenance.inferredNeeds, ghost: [annotation] }
      },
      {
        ...loaded.provenance,
        origins: {
          ...loaded.provenance.origins,
          "/nodes/2/needs/1": {
            kind: "explicit" as const,
            sourcePath: "/nodes/2/needs/1",
            location: inferredOrigin.location
          }
        }
      },
      {
        ...loaded.provenance,
        origins: {
          ...loaded.provenance.origins,
          "/nodes/2/needs/0": inferredOrigin
        }
      }
    ]
    variants.forEach((provenance) => {
      expect(() => approvalPreview(loaded.workflow, provenance)).toThrow(
        InvalidWorkflowProvenanceError
      )
    })
  })
})
