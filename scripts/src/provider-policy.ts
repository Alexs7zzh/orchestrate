import path from "node:path"

import type { AttemptCapabilityManifest } from "./attempt-capability.js"
import type { AgentAccess, AgentNode, SessionSpec } from "./types.js"

export const MAX_PROVIDER_POLICY_BYTES = 64 * 1024
export const MAX_CLAUDE_DENY_WRITE_ROOTS = 16

function containsOrEquals(relative: string): boolean {
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

export function providerPolicyPathContains(root: string, candidate: string): boolean {
  return containsOrEquals(path.relative(root, candidate))
}

export function providerPolicyPathsOverlap(left: string, right: string): boolean {
  return (
    containsOrEquals(path.relative(left, right)) || containsOrEquals(path.relative(right, left))
  )
}

function assertPolicySize(document: string, provider: AgentNode["provider"]): string {
  const bytes = Buffer.byteLength(document, "utf8")
  if (bytes > MAX_PROVIDER_POLICY_BYTES) {
    throw new Error(
      `${provider} provider policy is ${bytes} bytes; maximum is ${MAX_PROVIDER_POLICY_BYTES}.`
    )
  }
  return document
}

function assertAdapterIntent(
  access: AgentAccess,
  manifest: AttemptCapabilityManifest,
  provider: AgentNode["provider"]
): void {
  if (manifest.attempt.provider !== provider || manifest.accessIntent !== access) {
    throw new Error(`${provider} provider policy does not match the attempt access intent.`)
  }
  if (
    !manifest.access.unreadableRoots.every((root) => manifest.access.immutableRoots.includes(root))
  ) {
    throw new Error("Unreadable attempt authority must also be immutable.")
  }
  if (!manifest.access.immutableRoots.includes(manifest.access.completionExecutablePath)) {
    throw new Error("The completion executable must be immutable.")
  }
  if (
    !manifest.access.immutableRoots.some((root) =>
      providerPolicyPathContains(root, manifest.providerControlRoot)
    )
  ) {
    throw new Error("Provider configuration must remain immutable to the workflow attempt.")
  }
  if (
    manifest.access.unreadableRoots.some((root) =>
      providerPolicyPathContains(root, manifest.providerControlRoot)
    )
  ) {
    throw new Error("Provider configuration must remain readable to its provider.")
  }
}

export function compileCodexProviderPolicy(
  access: AgentAccess,
  profile: string,
  manifest: AttemptCapabilityManifest
): string {
  assertAdapterIntent(access, manifest, "codex")
  const filesystem = [
    ...manifest.access.unreadableRoots.map((protectedPath) => [protectedPath, "deny"] as const),
    ...manifest.access.readableRoots.map((readRoot) => [readRoot, "read"] as const),
    ...manifest.access.writableRoots.map((writeRoot) => [writeRoot, "write"] as const)
  ].map(([candidate, permission]) => `${JSON.stringify(candidate)}=${JSON.stringify(permission)}`)
  return assertPolicySize(
    [
      `default_permissions=${JSON.stringify(profile)}`,
      "",
      `[permissions.${JSON.stringify(profile)}]`,
      'extends=":read-only"',
      "",
      `[permissions.${JSON.stringify(profile)}.filesystem]`,
      ...filesystem,
      ""
    ].join("\n"),
    "codex"
  )
}

export function compileClaudeProviderPolicy(
  access: AgentAccess,
  manifest: AttemptCapabilityManifest
): string {
  assertAdapterIntent(access, manifest, "claude")
  // Claude denies writes outside cwd/allowWrite itself. Keep this explicit
  // deny set bounded to launcher-owned roots that can otherwise be cwd.
  const protectedWritePaths = [
    ...new Set([
      ...manifest.access.unreadableRoots.filter(
        (root) =>
          !manifest.access.writableRoots.some((writeRoot) =>
            providerPolicyPathsOverlap(root, writeRoot)
          )
      ),
      manifest.access.completionExecutablePath,
      manifest.trust.control.path,
      manifest.trust.inbox.path,
      ...(manifest.lineageRoot === null ? [] : [manifest.lineageRoot])
    ])
  ]
  if (protectedWritePaths.length > MAX_CLAUDE_DENY_WRITE_ROOTS) {
    throw new Error(
      `Claude provider policy has ${protectedWritePaths.length} deny-write roots; maximum is ${MAX_CLAUDE_DENY_WRITE_ROOTS}.`
    )
  }
  const readableRoots = [
    ...new Set([...manifest.access.readableRoots, ...manifest.access.writableRoots])
  ]
  const document = JSON.stringify({
    permissions: { allow: ["Bash"], deny: [] },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        // Claude allowWrite does not imply read access through a denyRead
        // parent, so every writable root is reopened for both capabilities.
        allowRead: readableRoots,
        allowWrite: [...manifest.access.writableRoots],
        denyRead: [...manifest.access.unreadableRoots],
        denyWrite: protectedWritePaths
      }
    }
  })
  return assertPolicySize(document, "claude")
}

export function compileCodexProviderArguments(
  node: Extract<AgentNode, { readonly provider: "codex" }>,
  source: string | null,
  profile: string,
  sessionMode: SessionSpec["mode"]
): readonly string[] {
  const approval = node.permissions.escalation === "deny" ? "never" : "on-request"
  const args: string[] = [
    "--ask-for-approval",
    approval,
    "--profile",
    profile,
    "--disable",
    "multi_agent"
  ]
  if (node.permissions.escalation === "auto-review") {
    args.push("--config", 'approvals_reviewer="auto_review"')
  }
  if (node.model !== "provider-default") {
    args.push("--model", node.model)
  }
  if (node.effort !== null) {
    args.push("--config", `model_reasoning_effort=${JSON.stringify(node.effort)}`)
  }
  args.push(...node.permissions.extraArgs)
  if (sessionMode === "resume") {
    args.push("resume", source as string)
  }
  if (sessionMode === "fork") {
    args.push("fork", source as string)
  }
  return args
}

export function compileClaudeProviderArguments(
  node: Extract<AgentNode, { readonly provider: "claude" }>,
  source: string | null,
  settingsPath: string,
  sessionId: string | null,
  sessionMode: SessionSpec["mode"]
): readonly string[] {
  const args: string[] = [
    "--safe-mode",
    "--settings",
    settingsPath,
    "--permission-mode",
    // Native sandbox paths are the attempt boundary; unattended execution is
    // compiled as bypassPermissions so commands cannot strand on user prompts.
    "bypassPermissions",
    "--tools",
    // Bash is the only tool; Agent and Task never enter the provider surface.
    "Bash"
  ]
  if (sessionId !== null && sessionMode !== "resume") {
    args.push("--session-id", sessionId)
  }
  if (node.model !== "provider-default") {
    args.push("--model", node.model)
  }
  if (node.effort !== null) {
    args.push("--effort", node.effort)
  }
  if (source !== null) {
    args.push("--resume", source)
  }
  if (sessionMode === "fork") {
    args.push("--fork-session")
  }
  return args
}
