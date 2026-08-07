import { expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  AgentNode,
  CommandNode,
  PaneReference,
  RunState,
  SpawnIntent,
  WorkflowNode,
  WorkflowSpec
} from "../src/types.js"

import {
  ensureAttemptTrustIdentities,
  loadAttemptCapabilityManifest
} from "../src/attempt-capability.js"
import { submitNodeDone } from "../src/completion-submission.js"
import { reconcileRun, type CrankSurface } from "../src/crank.js"
import {
  HerdrSurface,
  injectBeforeProviderBoundaryForTests,
  prepareAttemptLaunchCapabilities,
  prepareProviderLaunchArguments
} from "../src/herdr-surface.js"
import { DEFAULT_UI_PREFERENCES } from "../src/preferences.js"
import { prepareNode } from "../src/prompt.js"
import {
  attemptCapabilityManifestPath,
  completionSubmissionPath,
  persistNewRun,
  runDirectory,
  runtimeBuild,
  submissionResultPath
} from "../src/state.js"
import { createInitialRunState, transition } from "../src/transition.js"
import { validateWorkflow } from "../src/validation.js"

const selection = process.env.ORCHESTRATE_NATIVE_SANDBOX_PROBE?.trim().toLowerCase() ?? ""
const codexTest = selection === "codex" || selection === "all" ? test : test.skip
const claudeTest = selection === "claude" || selection === "all" ? test : test.skip
const PROVIDER_TIMEOUT_MS = 180_000
const NOW = "2026-08-06T12:00:00.000Z"
// macOS expands native sandbox profiles on the provider command line. Its
// per-user TMPDIR is already very long and can make the fixture itself exceed
// ARG_MAX; /private/tmp better matches normal installed state path lengths.
const NATIVE_PROBE_TEMP_ROOT = process.platform === "darwin" ? "/private/tmp" : os.tmpdir()

function workspace(writes: readonly string[] = []) {
  return {
    mode: "shared" as const,
    path: null,
    vcs: "none" as const,
    writes,
    exclusiveResources: []
  }
}

function agent(
  id: string,
  provider: "codex" | "claude",
  overrides: Partial<AgentNode> = {}
): AgentNode {
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
    provider,
    model: "provider-default",
    effort: null,
    prompt: "Exercise the attempt capability boundary.",
    session: { mode: "fresh", from: null, saveAs: null },
    permissions:
      provider === "codex"
        ? {
            access: "read-only",
            escalation: "deny",
            extraArgs: [],
            inheritEnv: [],
            env: {}
          }
        : {
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

function commandNode(id: string): CommandNode {
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
    argv: ["/usr/bin/printf", "command-projection\n"],
    mutates: false,
    inheritEnv: [],
    env: {},
    allowedExitCodes: [0]
  }
}

function workflow(cwd: string, nodes: readonly WorkflowNode[]): WorkflowSpec {
  return {
    name: "provider-capability-acceptance",
    objective: "Exercise the compiled attempt capability boundary.",
    cwd,
    concurrency: 3,
    callback: { type: "none" },
    milestones: false,
    limits: { maxStarts: null },
    writeConflicts: "reject",
    nodes,
    repeats: []
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function runProvider(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>
): Promise<string> {
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: { ...process.env, ...environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  })
  const timeout = setTimeout(() => child.kill(), PROVIDER_TIMEOUT_MS)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    if (exitCode !== 0) {
      throw new Error(
        `Provider exited with ${exitCode}.\nstdout:\n${stdout.slice(-4_000)}\nstderr:\n${stderr.slice(-4_000)}`
      )
    }
    return stdout
  } finally {
    clearTimeout(timeout)
  }
}

function minimalState(runId: string, nodes: RunState["nodes"]): RunState {
  return {
    id: runId,
    workflowName: "provider-capability-acceptance",
    nodes,
    sessions: {}
  } as RunState
}

function intent(nodeId: string, token: string): SpawnIntent {
  return { nodeId, attempt: 1, token } as SpawnIntent
}

class ReconcileSurface implements CrankSurface {
  async connect(): Promise<void> {}
  async recoverOrSpawn(): Promise<{
    readonly pane: PaneReference
    readonly providerSessionId: null
  }> {
    throw new Error("reconcile unexpectedly attempted to spawn")
  }
  async closePane(): Promise<void> {}
  async notify(): Promise<void> {}
}

function herdrResponse(result: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ id: `cli:acceptance:${String(result.type)}`, result })
}

async function writeHookBoundaryShim(directory: string, logPath: string): Promise<void> {
  const pane = {
    terminal_id: "terminal-p1",
    agent_status: "idle",
    workspace_id: "w1",
    tab_id: "t1",
    pane_id: "p1",
    focused: false,
    revision: 1
  }
  const tab = {
    tab_id: "t1",
    workspace_id: "w1",
    number: 1,
    label: "acceptance",
    focused: false,
    pane_count: 1,
    agent_status: "idle"
  }
  const herdrWorkspace = {
    workspace_id: "w1",
    number: 1,
    label: "acceptance",
    focused: false,
    pane_count: 1,
    tab_count: 1,
    active_tab_id: "t1",
    agent_status: "idle"
  }
  const body = `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
case "$1 $2" in
  "--version ") printf 'herdr 0.7.5\n' ;;
  "workspace list") printf '%s\n' ${shellQuote(herdrResponse({ type: "workspace_list", workspaces: [] }))} ;;
  "workspace create") printf '%s\n' ${shellQuote(herdrResponse({ type: "workspace_created", workspace: herdrWorkspace, tab, root_pane: pane }))} ;;
  *) printf '%s\n' ${shellQuote(herdrResponse({ type: "ok" }))} ;;
esac
`
  for (const executable of ["herdr", "codex"]) {
    const file = path.join(directory, executable)
    await Bun.write(file, executable === "herdr" ? body : "#!/bin/sh\nexit 0\n", {
      createPath: false
    })
    await chmod(file, 0o755)
  }
}

async function persistRunningAttempt(spec: WorkflowSpec, runId: string): Promise<RunState> {
  const validated = validateWorkflow(spec)
  if (validated.digest === null) {
    throw new Error("invalid acceptance workflow")
  }
  const initial = createInitialRunState(spec, {
    id: runId,
    runtimeVersion: runtimeBuild(),
    digest: validated.digest,
    now: NOW,
    origin: null
  })
  const runDir = runDirectory(runId)
  const started = transition(initial, spec, { type: "run" }, NOW, {
    prepareNode: (state, current, node) => prepareNode(current, state, runDir, node.id)
  })
  const runtimeNode = started.state.nodes.owner
  const currentIntent =
    runtimeNode === undefined ? undefined : started.state.spawnIntents["owner:a1"]
  if (runtimeNode === undefined || currentIntent === undefined) {
    throw new Error("acceptance attempt was not planned")
  }
  const observed = transition(
    started.state,
    spec,
    {
      type: "spawn-observed",
      nodeId: "owner",
      intentId: currentIntent.id,
      pane: {
        workspaceId: "acceptance",
        tabId: "acceptance",
        paneId: "acceptance",
        group: "owner",
        surface: "tab"
      },
      providerSessionId: null
    },
    NOW
  )
  await persistNewRun(spec, DEFAULT_UI_PREFERENCES, observed.state, [
    ...started.events,
    ...observed.events
  ])
  return observed.state
}

async function providerCompletionProbe(provider: "codex" | "claude"): Promise<void> {
  const root = await realpath(
    await mkdtemp(path.join(NATIVE_PROBE_TEMP_ROOT, `orchestrate-completion-${provider}-`))
  )
  const previousState = process.env.ORCHESTRATE_STATE_DIR
  const previousBin = process.env.ORCHESTRATE_BIN
  const runId = provider === "codex" ? "20260806120000-c0de0002" : "20260806120000-c1a0de02"
  let profileAdapterPath: string | null = null
  try {
    process.env.ORCHESTRATE_STATE_DIR = path.join(root, "state")
    const source = path.join(root, "source")
    const launcher = path.join(root, "launcher")
    await Promise.all([source, launcher].map((directory) => mkdir(directory)))
    const cli = path.join(launcher, "orchestrate-node-done")
    const main = path.resolve(import.meta.dir, "../src/main.ts")
    await Bun.write(
      cli,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(main)} "$@"\n`,
      { createPath: false }
    )
    await chmod(cli, 0o755)
    process.env.ORCHESTRATE_BIN = cli

    const owner = agent("owner", provider, {
      output: {
        format: "json",
        schema: {
          type: "object",
          properties: { accepted: { type: "boolean" } },
          required: ["accepted"],
          additionalProperties: false
        }
      }
    })
    const spec = workflow(source, [owner])
    const running = await persistRunningAttempt(spec, runId)
    const attempt = running.nodes.owner?.attempts.at(-1)
    const planned = running.spawnIntents["owner:a1"]
    if (attempt === undefined || planned === undefined) {
      throw new Error("missing persisted provider completion attempt")
    }
    const capabilities = await prepareAttemptLaunchCapabilities(
      spec,
      owner,
      running,
      planned,
      source,
      null
    )
    profileAdapterPath = capabilities.profileAdapterPath
    const launch = await prepareProviderLaunchArguments(owner, running, planned, capabilities)
    const envelope = completionSubmissionPath(attempt.resultPath)
    if (provider === "claude") {
      const settings = JSON.parse(
        await Bun.file(capabilities.manifest.assets.claudeSettingsPath).text()
      ) as { sandbox: { filesystem: { allowRead: string[] } } }
      expect(settings.sandbox.filesystem.allowRead).toContain(path.dirname(attempt.resultPath))
    }
    const script = path.join(source, "completion-probe.sh")
    await Bun.write(
      script,
      `#!/bin/sh
set -u
result=$1
envelope=$2
cli=$3
scratch=$4
run=$5
node=$6
token=$7
printf '{}\n' > "$result"
if "$cli" node-done "$run" "$node" --token "$token" --outcome completed > "$scratch/invalid.out" 2> "$scratch/invalid.err"; then
  exit 71
fi
if [ -e "$envelope" ]; then
  exit 72
fi
printf '{"accepted":true}\n' > "$result"
"$cli" node-done "$run" "$node" --token "$token" --outcome completed > "$scratch/valid.out" 2> "$scratch/valid.err"
`
    )
    await chmod(script, 0o755)
    const command = [
      script,
      attempt.resultPath,
      envelope,
      cli,
      capabilities.manifest.trust.scratch.path,
      runId,
      "owner",
      attempt.token
    ]
      .map(shellQuote)
      .join(" ")
    const prompt = `Use Bash/shell exactly once to run this command, then stop without alternatives: ${command}`
    const claudeDebugPath = path.join(capabilities.manifest.trust.scratch.path, "claude-debug.log")
    const providerOutput = await runProvider(
      capabilities.manifest.providerRelay.path,
      provider === "codex"
        ? [...launch.args, "exec", "--skip-git-repo-check", prompt]
        : [...launch.args, "--debug-file", claudeDebugPath, "--print", prompt],
      provider === "claude" ? capabilities.manifest.trust.inbox.path : source,
      capabilities.environment
    )
    if (!(await Bun.file(envelope).exists())) {
      const diagnostics = await Promise.all(
        ["invalid.out", "invalid.err", "valid.out", "valid.err", "claude-debug.log"].map(
          async (name) => {
            const diagnosticPath = path.join(capabilities.manifest.trust.scratch.path, name)
            return `${name}: ${(await Bun.file(diagnosticPath).exists()) ? await Bun.file(diagnosticPath).text() : "[missing]"}`
          }
        )
      )
      const fixtureEntries = await Array.fromAsync(
        new Bun.Glob("**/*").scan({ cwd: root, dot: true, onlyFiles: false })
      )
      throw new Error(
        `Provider ${provider} produced no completion envelope.\nstdout:\n${providerOutput}\nfixture entries (${fixtureEntries.length}): ${fixtureEntries.join(", ")}\n${diagnostics.join("\n")}`
      )
    }
    const reconciled = await reconcileRun(runDirectory(runId), {
      surface: new ReconcileSurface(),
      now: () => NOW
    })
    expect(reconciled.state.status).toBe("completed")
    expect(reconciled.state.nodes.owner?.result).toEqual({ accepted: true })
  } finally {
    if (profileAdapterPath !== null) {
      await rm(profileAdapterPath, { force: true })
    }
    if (previousBin === undefined) {
      delete process.env.ORCHESTRATE_BIN
    } else {
      process.env.ORCHESTRATE_BIN = previousBin
    }
    if (previousState === undefined) {
      delete process.env.ORCHESTRATE_STATE_DIR
    } else {
      process.env.ORCHESTRATE_STATE_DIR = previousState
    }
    await rm(root, { recursive: true, force: true })
  }
}

async function providerCapabilityProbe(provider: "codex" | "claude"): Promise<void> {
  const root = await realpath(
    await mkdtemp(path.join(NATIVE_PROBE_TEMP_ROOT, `orchestrate-capability-${provider}-`))
  )
  const previousState = process.env.ORCHESTRATE_STATE_DIR
  const runId = provider === "codex" ? "20260806120000-c0de0001" : "20260806120000-c1a0de01"
  const source = path.join(root, "source")
  const globalAuthority = path.join(root, "state", "runs", runId, "state.json")
  const agentResult = "agent-projection\n"
  const commandResult = "command-projection\n"
  const producerToken = (provider === "codex" ? "1" : "3").repeat(64)
  const consumerToken = (provider === "codex" ? "2" : "4").repeat(64)
  const adapters: string[] = []
  try {
    process.env.ORCHESTRATE_STATE_DIR = path.join(root, "state")
    await mkdir(source, { recursive: true })
    await mkdir(path.dirname(globalAuthority), { recursive: true })
    await Bun.write(globalAuthority, "launcher-secret\n", { createPath: false })

    const producer = agent("agent-source", provider)
    const commandSource = commandNode("command-source")
    const consumer = agent("consumer", provider, {
      needs: ["agent-source", "command-source"],
      inputs: [
        { from: "agent-source", as: "Agent artifact", include: "path", round: "current" },
        { from: "command-source", as: "Command artifact", include: "path", round: "current" }
      ],
      output: {
        format: "json",
        schema: {
          type: "object",
          properties: { accepted: { type: "boolean" } },
          required: ["accepted"],
          additionalProperties: false
        }
      }
    })
    const spec = workflow(source, [producer, commandSource, consumer])
    let state = minimalState(runId, {})
    const producerCapabilities = await prepareAttemptLaunchCapabilities(
      spec,
      producer,
      state,
      intent("agent-source", producerToken),
      source,
      null
    )
    if (producerCapabilities.profileAdapterPath !== null) {
      adapters.push(producerCapabilities.profileAdapterPath)
    }
    const producerResultPath = submissionResultPath(runId, "agent-source", producerToken)
    await Bun.write(producerResultPath, agentResult, { createPath: false })
    await submitNodeDone(
      runId,
      "agent-source",
      producerToken,
      "completed",
      false,
      producerCapabilities.manifest.completion.contractPath
    )

    const commandResultPath = path.join(source, "command-result.txt")
    await Bun.write(commandResultPath, commandResult, { createPath: false })
    state = minimalState(runId, {
      "agent-source": {
        id: "agent-source",
        templateId: "agent-source",
        type: "agent",
        provider,
        status: "completed",
        resultPath: producerResultPath,
        result: agentResult,
        attempts: [{ attempt: 1, token: producerToken, resultPath: producerResultPath }]
      },
      "command-source": {
        id: "command-source",
        templateId: "command-source",
        type: "command",
        provider: null,
        status: "completed",
        resultPath: commandResultPath,
        result: commandResult,
        attempts: []
      }
    } as unknown as RunState["nodes"])
    const capabilities = await prepareAttemptLaunchCapabilities(
      spec,
      consumer,
      state,
      intent("consumer", consumerToken),
      source,
      null
    )
    if (capabilities.profileAdapterPath !== null) {
      adapters.push(capabilities.profileAdapterPath)
    }
    const launch = await prepareProviderLaunchArguments(
      consumer,
      state,
      intent("consumer", consumerToken),
      capabilities
    )
    expect(capabilities.manifest.projectedInputs).toHaveLength(2)
    const [agentInbox, commandInbox] = capabilities.manifest.projectedInputs
    if (agentInbox === undefined || commandInbox === undefined) {
      throw new Error("projected acceptance inputs are incomplete")
    }
    const controlFiles = [
      attemptCapabilityManifestPath(runId, "consumer", consumerToken),
      capabilities.manifest.completion.contractPath,
      ...capabilities.manifest.policyAssets.map((asset) => asset.path),
      ...(capabilities.profileAdapterPath === null ? [] : [capabilities.profileAdapterPath])
    ]
    const controlBefore = await Promise.all(controlFiles.map((file) => readFile(file)))
    const scratch = capabilities.manifest.trust.scratch.path
    const probeScript = path.join(source, "capability-probe.sh")
    await Bun.write(
      probeScript,
      `#!/bin/sh
scratch=${shellQuote(scratch)}
global=${shellQuote(globalAuthority)}
agent_inbox=${shellQuote(agentInbox.path)}
command_inbox=${shellQuote(commandInbox.path)}
producer_outbox=${shellQuote(producerResultPath)}
if content=$(cat "$global" 2>/dev/null); then printf '%s\n' "$content" > "$scratch/global-leak"; fi
printf 'poisoned\n' > "$global" 2>/dev/null || true
cat "$agent_inbox" > "$scratch/agent-read" 2>/dev/null || true
cat "$command_inbox" > "$scratch/command-read" 2>/dev/null || true
printf 'poisoned\n' > "$agent_inbox" 2>/dev/null || true
printf 'poisoned\n' > "$command_inbox" 2>/dev/null || true
if content=$(cat "$producer_outbox" 2>/dev/null); then printf '%s\n' "$content" > "$scratch/producer-leak"; fi
for protected in ${controlFiles.map(shellQuote).join(" ")}; do printf 'poisoned\n' > "$protected" 2>/dev/null || true; done
`
    )
    await chmod(probeScript, 0o755)
    const command = shellQuote(probeScript)
    if (provider === "codex") {
      const disabledFeature = launch.args.findIndex((argument) => argument === "--disable")
      expect(disabledFeature).toBeGreaterThanOrEqual(0)
      expect(launch.args[disabledFeature + 1]).toBe("multi_agent")
    } else {
      const settings = JSON.parse(
        await Bun.file(capabilities.manifest.assets.claudeSettingsPath).text()
      ) as {
        permissions: { deny: string[] }
        sandbox: { filesystem: { denyWrite: string[] } }
      }
      expect(settings.permissions.deny).toEqual([])
      const tools = launch.args.findIndex((argument) => argument === "--tools")
      expect(tools).toBeGreaterThanOrEqual(0)
      expect(launch.args[tools + 1]).toBe("Bash")
      expect(settings.sandbox.filesystem.denyWrite).toContain(
        await realpath(process.env.ORCHESTRATE_STATE_DIR)
      )
    }
    const prompt = `Use Bash/shell exactly once to run this command, and stop: ${command}`
    const claudeDebugPath = path.join(scratch, "claude-capability-debug.log")
    const claudeSettingsBefore =
      provider === "claude"
        ? await Bun.file(capabilities.manifest.assets.claudeSettingsPath).text()
        : ""
    await runProvider(
      capabilities.manifest.providerRelay.path,
      provider === "codex"
        ? [...launch.args, "exec", "--skip-git-repo-check", prompt]
        : [...launch.args, "--debug-file", claudeDebugPath, "--print", prompt],
      provider === "claude" ? capabilities.manifest.trust.inbox.path : source,
      capabilities.environment
    )

    const globalAfter = await Bun.file(globalAuthority).text()
    if (provider === "claude" && globalAfter !== "launcher-secret\n") {
      const settings = JSON.parse(claudeSettingsBefore) as { sandbox: { filesystem: unknown } }
      throw new Error(
        `Claude mutated global authority.\nfilesystem=${JSON.stringify(settings.sandbox.filesystem)}\n${(await Bun.file(claudeDebugPath).text()).slice(-8_000)}`
      )
    }
    expect(globalAfter).toBe("launcher-secret\n")
    expect(await Bun.file(path.join(scratch, "global-leak")).exists()).toBe(false)
    expect(await Bun.file(path.join(scratch, "agent-read")).text()).toBe(agentResult)
    expect(await Bun.file(path.join(scratch, "command-read")).text()).toBe(commandResult)
    expect(await Bun.file(agentInbox.path).text()).toBe(agentResult)
    expect(await Bun.file(commandInbox.path).text()).toBe(commandResult)
    expect(await Bun.file(path.join(scratch, "producer-leak")).exists()).toBe(false)
    for (const [index, file] of controlFiles.entries()) {
      expect(await readFile(file)).toEqual(controlBefore[index] as Buffer)
    }
  } finally {
    for (const adapter of adapters) {
      await rm(adapter, { force: true })
    }
    if (previousState === undefined) {
      delete process.env.ORCHESTRATE_STATE_DIR
    } else {
      process.env.ORCHESTRATE_STATE_DIR = previousState
    }
    await rm(root, { recursive: true, force: true })
  }
}

codexTest(
  "projects exact artifacts and denies authority, control, and delegated Codex completion",
  async () => {
    await providerCompletionProbe("codex")
    await providerCapabilityProbe("codex")
  },
  PROVIDER_TIMEOUT_MS * 2 + 30_000
)

claudeTest(
  "projects exact artifacts and denies authority, control, and delegated Claude completion",
  async () => {
    await providerCompletionProbe("claude")
    await providerCapabilityProbe("claude")
  },
  PROVIDER_TIMEOUT_MS * 2 + 30_000
)

test(
  "restores scratch mode and rejects symlink and hook-time identity replacement",
  async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "orchestrate-capability-scratch-"))
    )
    const previousState = process.env.ORCHESTRATE_STATE_DIR
    const previousPath = process.env.PATH
    const previousHome = process.env.HOME
    const previousCodexHome = process.env.CODEX_HOME
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR
    const previousBin = process.env.ORCHESTRATE_BIN
    const runId = "20260806120000-5c7a7c40"
    const token = "5".repeat(64)
    let hookAdapterPath: string | null = null
    try {
      process.env.ORCHESTRATE_STATE_DIR = path.join(root, "state")
      process.env.HOME = path.join(root, "home")
      process.env.CODEX_HOME = path.join(root, "codex-home")
      process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude-config")
      process.env.ORCHESTRATE_BIN = path.join(root, "orchestrate")
      await Promise.all(
        [process.env.HOME, process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].map((directory) =>
          mkdir(directory)
        )
      )
      await Bun.write(process.env.ORCHESTRATE_BIN, "#!/bin/sh\nexit 0\n", { createPath: false })
      await chmod(process.env.ORCHESTRATE_BIN, 0o755)
      const trust = await ensureAttemptTrustIdentities(runId, "owner", token)
      await chmod(trust.scratch.path, 0o777)
      await ensureAttemptTrustIdentities(runId, "owner", token)
      expect((await lstat(trust.scratch.path)).mode & 0o777).toBe(0o700)

      await rm(trust.scratch.path, { recursive: true })
      await symlink(root, trust.scratch.path)
      await expect(ensureAttemptTrustIdentities(runId, "owner", token)).rejects.toThrow(
        "no-follow directory"
      )

      const hookBin = path.join(root, "hook-bin")
      const hookLog = path.join(root, "hook-herdr.log")
      await mkdir(hookBin)
      await writeHookBoundaryShim(hookBin, hookLog)
      process.env.PATH = `${hookBin}:${previousPath ?? ""}`
      const hookOwner = agent("hook-owner", "codex")
      const hookSource = path.join(root, "hook-source")
      await mkdir(hookSource)
      const hookWorkflow = workflow(hookSource, [hookOwner])
      const validated = validateWorkflow(hookWorkflow)
      if (validated.digest === null) {
        throw new Error("invalid hook acceptance workflow")
      }
      const initial = createInitialRunState(hookWorkflow, {
        id: runId,
        runtimeVersion: runtimeBuild(),
        digest: validated.digest,
        now: NOW,
        origin: null
      })
      const runDir = runDirectory(runId)
      const planned = transition(initial, hookWorkflow, { type: "run" }, NOW, {
        prepareNode: (state, current, node) => prepareNode(current, state, runDir, node.id)
      })
      const hookIntent = planned.state.spawnIntents["hook-owner:a1"]
      if (hookIntent === undefined) {
        throw new Error("hook acceptance attempt was not planned")
      }
      const hookToken = hookIntent.token
      // The production spawn boundary consumes the hook after preparation and
      // revalidates the compiled identity before `herdr agent start`.
      injectBeforeProviderBoundaryForTests(async () => {
        const loaded = await loadAttemptCapabilityManifest(runId, "hook-owner", hookToken)
        hookAdapterPath = path.join(
          loaded.manifest.providerControlRoot,
          `orchestrate-attempt-${hookToken}.config.toml`
        )
        await rm(loaded.manifest.trust.scratch.path, { recursive: true })
        await mkdir(loaded.manifest.trust.scratch.path)
      })
      await expect(
        new HerdrSurface().spawn({
          workflow: hookWorkflow,
          state: planned.state,
          intent: hookIntent,
          prompt: "Do not run.",
          placement: {
            workspace: "dedicated",
            surface: "tab",
            group: "hook-owner",
            groupLabel: "hook-owner",
            groupOrdinal: 1,
            anchorPane: null,
            reusePane: null,
            splitDirection: "down"
          }
        })
      ).rejects.toThrow("identity changed")
      expect(await Bun.file(hookLog).text()).not.toContain("agent start")
    } finally {
      injectBeforeProviderBoundaryForTests(null)
      if (hookAdapterPath !== null) {
        await rm(hookAdapterPath, { force: true })
      }
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
      if (previousState === undefined) {
        delete process.env.ORCHESTRATE_STATE_DIR
      } else {
        process.env.ORCHESTRATE_STATE_DIR = previousState
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      if (previousClaudeConfig === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig
      }
      if (previousBin === undefined) {
        delete process.env.ORCHESTRATE_BIN
      } else {
        process.env.ORCHESTRATE_BIN = previousBin
      }
      await rm(root, { recursive: true, force: true })
    }
  },
  PROVIDER_TIMEOUT_MS
)
