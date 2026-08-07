import { describe, expect, test } from "bun:test"

import type { AttemptCapabilityManifest } from "../src/attempt-capability.js"
import type { AgentNode } from "../src/types.js"

import {
  compileClaudeProviderArguments,
  compileClaudeProviderPolicy,
  compileCodexProviderArguments,
  compileCodexProviderPolicy,
  MAX_CLAUDE_DENY_WRITE_ROOTS,
  MAX_PROVIDER_POLICY_BYTES,
  providerPolicyPathContains
} from "../src/provider-policy.js"

function manifest(provider: "codex" | "claude"): AttemptCapabilityManifest {
  const completion = "/opt/orchestrate/bin/orchestrate"
  const providerControl = `/home/test/.${provider}`
  return {
    version: 1,
    capabilityDigest: "a".repeat(64),
    attempt: {
      runId: "20260807000000-aaaaaaaa",
      nodeId: "review",
      attempt: 1,
      token: "b".repeat(64),
      provider
    },
    accessIntent: "workspace-write",
    trust: {
      control: {
        path: "/state/submissions/run/review/token/control",
        device: "1",
        inode: "1",
        mode: 0o500
      },
      inbox: {
        path: "/state/submissions/run/review/token/inbox",
        device: "1",
        inode: "2",
        mode: 0o500
      },
      outbox: {
        path: "/state/submissions/run/review/token/outbox",
        device: "1",
        inode: "3",
        mode: 0o700
      },
      scratch: {
        path: "/state/submissions/run/review/token/scratch",
        device: "1",
        inode: "4",
        mode: 0o700
      }
    },
    sourceRoots: ["/workspace"],
    declaredWriteRoots: ["/workspace/src"],
    providerControlRoot: providerControl,
    lineageRoot: null,
    providerLaunch: {} as AttemptCapabilityManifest["providerLaunch"],
    providerRelay: {} as AttemptCapabilityManifest["providerRelay"],
    access: {
      readableRoots: ["/workspace", "/state/submissions/run/review/token/control"],
      writableRoots: [
        "/workspace/src",
        "/state/submissions/run/review/token/outbox",
        "/state/submissions/run/review/token/scratch"
      ],
      unreadableRoots: ["/state"],
      immutableRoots: ["/state", providerControl, completion],
      completionExecutablePath: completion
    },
    projectedInputs: [],
    policyAssets: [],
    assets: {
      codexProfilePath: "/state/submissions/run/review/token/control/codex-profile.toml",
      claudeSettingsPath: "/state/submissions/run/review/token/control/claude-settings.json"
    },
    completion: { contractPath: "/contract", contractSha256: "c".repeat(64) }
  }
}

function agent(provider: "codex" | "claude"): AgentNode {
  return {
    id: "review",
    title: "Review",
    type: "agent",
    needs: [],
    cwd: null,
    workspace: { mode: "shared", path: null, vcs: "none", writes: [], exclusiveResources: [] },
    inputs: [],
    retry: { maxAttempts: 1 },
    gate: "none",
    provider,
    model: "provider-default",
    effort: null,
    prompt: "Review.",
    session: { mode: "fresh", from: null, saveAs: null },
    output: { format: "text", schema: null },
    permissions: {
      access: "workspace-write",
      escalation: "deny",
      extraArgs: [],
      inheritEnv: [],
      env: {}
    }
  }
}

describe("provider policy adapters", () => {
  test("keeps Claude writable roots readable while bounding immutable denials", () => {
    const draft = manifest("claude")
    const parsed = JSON.parse(compileClaudeProviderPolicy("workspace-write", draft)) as {
      readonly sandbox: {
        readonly filesystem: {
          readonly allowRead: readonly string[]
          readonly allowWrite: readonly string[]
          readonly denyRead: readonly string[]
          readonly denyWrite: readonly string[]
        }
      }
    }
    const filesystem = parsed.sandbox.filesystem
    expect(filesystem.allowRead).toEqual(expect.arrayContaining(draft.access.writableRoots))
    expect(filesystem.allowWrite).toEqual(draft.access.writableRoots)
    expect(filesystem.denyRead).toEqual(draft.access.unreadableRoots)
    expect(filesystem.denyWrite.length).toBeLessThanOrEqual(MAX_CLAUDE_DENY_WRITE_ROOTS)
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(MAX_PROVIDER_POLICY_BYTES)
  })

  test("rejects unreadable mutable authority, unreadable provider config, and access mismatch", () => {
    const base = manifest("codex")
    expect(() => compileCodexProviderPolicy("read-only", "attempt-profile", base)).toThrow(
      "does not match the attempt access intent"
    )
    expect(() =>
      compileCodexProviderPolicy("workspace-write", "attempt-profile", {
        ...base,
        access: { ...base.access, immutableRoots: base.access.immutableRoots.slice(1) }
      })
    ).toThrow("Unreadable attempt authority must also be immutable")
    expect(() =>
      compileCodexProviderPolicy("workspace-write", "attempt-profile", {
        ...base,
        access: {
          ...base.access,
          unreadableRoots: [...base.access.unreadableRoots, base.providerControlRoot]
        }
      })
    ).toThrow("Provider configuration must remain readable")
  })

  test("uses directional ancestor containment for provider configuration authority", () => {
    expect(providerPolicyPathContains("/home/test", "/home/test/.codex")).toBe(true)
    expect(providerPolicyPathContains("/home/test/.codex", "/home/test/.codex")).toBe(true)
    expect(providerPolicyPathContains("/home/test/.codex/profiles", "/home/test/.codex")).toBe(
      false
    )
    expect(providerPolicyPathContains("/home/test/.claude", "/home/test/.codex")).toBe(false)

    const base = manifest("codex")
    expect(() =>
      compileCodexProviderPolicy("workspace-write", "attempt-profile", {
        ...base,
        access: {
          ...base.access,
          immutableRoots: [
            base.access.unreadableRoots[0]!,
            `${base.providerControlRoot}/profiles`,
            base.access.completionExecutablePath
          ]
        }
      })
    ).toThrow("Provider configuration must remain immutable")
    expect(() =>
      compileCodexProviderPolicy("workspace-write", "attempt-profile", {
        ...base,
        access: {
          ...base.access,
          unreadableRoots: [...base.access.unreadableRoots, `${base.providerControlRoot}/private`],
          immutableRoots: [...base.access.immutableRoots, `${base.providerControlRoot}/private`]
        }
      })
    ).not.toThrow()
  })

  test("keeps authoritative state denied while reopening only attempt-local control", () => {
    const codex = manifest("codex")
    const codexPolicy = compileCodexProviderPolicy("workspace-write", "profile", codex)
    expect(codexPolicy).toContain('"/state"="deny"')
    expect(codexPolicy).toContain('"/state/submissions/run/review/token/control"="read"')

    const claude = manifest("claude")
    const filesystem = JSON.parse(compileClaudeProviderPolicy("workspace-write", claude)).sandbox
      .filesystem
    expect(filesystem.denyRead).toContain("/state")
    expect(filesystem.allowRead).toContain("/state/submissions/run/review/token/control")
  })

  test("fails closed when Claude deny roots or provider policy bytes are unbounded", () => {
    const claude = manifest("claude")
    const roots = Array.from(
      { length: MAX_CLAUDE_DENY_WRITE_ROOTS + 1 },
      (_, index) => `/deny/${index}`
    )
    expect(() =>
      compileClaudeProviderPolicy("workspace-write", {
        ...claude,
        access: {
          ...claude.access,
          unreadableRoots: roots,
          immutableRoots: [
            ...roots,
            claude.providerControlRoot,
            claude.access.completionExecutablePath
          ]
        }
      })
    ).toThrow("deny-write roots")

    const codex = manifest("codex")
    const huge = `/workspace/${"x".repeat(MAX_PROVIDER_POLICY_BYTES)}`
    expect(() =>
      compileCodexProviderPolicy("workspace-write", "attempt-profile", {
        ...codex,
        access: { ...codex.access, readableRoots: [...codex.access.readableRoots, huge] }
      })
    ).toThrow("provider policy is")
  })

  test("keeps launcher-owned provider argument controls", () => {
    const codex = agent("codex") as Extract<AgentNode, { readonly provider: "codex" }>
    const claude = agent("claude") as Extract<AgentNode, { readonly provider: "claude" }>
    expect(compileCodexProviderArguments(codex, null, "profile", "fresh")).toEqual(
      expect.arrayContaining(["--disable", "multi_agent"])
    )
    const args = compileClaudeProviderArguments(claude, null, "/settings.json", "session", "fresh")
    expect(args).toEqual(
      expect.arrayContaining(["--permission-mode", "bypassPermissions", "--tools", "Bash"])
    )
    expect(args.join(" ")).not.toContain("Agent")
    expect(args.join(" ")).not.toContain("Task")
  })
})
