# Workflow format

Use this reference while creating or reviewing an Orchestrate workflow. Check the final JSON with
`orchestrate validate`, which validates it against `workflow.schema.json` and the semantic rules;
do not read the schema file itself unless a validation error is unclear.

## Workflow

Every field is required:

- `version`: `1`.
- `name`, `objective`: human-readable identity and success intent.
- `cwd`: absolute base working directory.
- `concurrency`: maximum simultaneously running nodes.
- `heartbeat.intervalMinutes`: positive number, or `null` for no periodic update.
- `heartbeat.milestones`: whether node milestones invoke the callback.
- `heartbeat.callback`: a discriminated object, not a string. Use `{ "type": "none" }`,
  `{ "type": "notification" }`,
  `{ "type": "command", "argv": ["/absolute/program", "arg"], "timeoutSeconds": 30 }`, or
  `{ "type": "webhook", "url": "https://example.test/hook", "headers": {},
  "timeoutSeconds": 30 }`. Callbacks deliver to the user, not to the assistant. Command callbacks
  require a non-empty `argv` and an explicit positive `timeoutSeconds`; webhook callbacks require
  an absolute HTTP(S) `url`, `headers` (an empty `{}` is valid), and an explicit positive
  `timeoutSeconds`. `notification` posts a desktop notification with a fixed one-minute timeout.
  Propose `{ "type": "notification" }` for interactive runs unless the user opts out or the run
  is headless; reserve `{ "type": "none" }` for runs where nobody is waiting.
- `limits`: explicit nullable `nodeWallTimeMinutes`, `workflowWallTimeMinutes`,
  `maxAgentStarts`, and `maxGoalRounds`. Each is a positive value or `null`; zero is rejected.
- `writeConflicts`: `reject` or `allow-with-approval`.
- `nodes`: the initial DAG.

Numeric limits pause scheduling unless they are node timeouts. A node timeout terminates that
specific process tree and fails the attempt even if the process handles termination by exiting
zero. `null` means intentionally unbounded. Continuing past a reached workflow or goal limit
requires `orchestrate resume <run-id> --override-limit`.

## Common node fields

Every node declares:

- `id`: lowercase letters, numbers, and hyphens.
- `type`: `agent`, `command`, or `supervisor`.
- `title`: preview label.
- `needs`: dependency node IDs.
- `cwd`: absolute override or `null`.
- `inputs`: prior result artifacts to append as labeled content or paths. Each entry is
  `{ "from": <ancestor node id>, "as": <label>, "include": "content" | "path" }`.
- `timeoutMinutes`: explicit positive number or `null`. The effective timeout is the smaller of
  this value and `limits.nodeWallTimeMinutes`.
- `retry.maxAttempts`: total attempts including the first; use `1` for no retry.
- `retry.delaySeconds`: explicit retry delay.
- `gate`: `"none"` or `"approval"`. With `"approval"`, the run pauses when the node becomes
  runnable and presents the fully rendered content for digest-bound approval before any attempt
  starts. See "Approval gates" below.
- `workspace`: isolation, VCS, writes, and exclusive resources.

## Approval gates

A node with `"gate": "approval"` never starts silently. The moment it becomes runnable (all
dependencies completed, resources available), the run pauses at that node boundary instead of
launching it: no attempt starts, nothing else from that scheduling round launches, and
already-running nodes finish normally. The pause publishes the exact content the node would run
with — for agent and supervisor nodes the fully rendered prompt (prompt frame plus resolved input
sections), for command nodes the argv plus resolved inputs; environment values are never included
— together with a SHA-256 digest binding the run id, node id, and that content.

Approval is `orchestrate resume <run-id> --approve-gate <node-id> --gate-digest <sha256>`; a stale
or mismatched digest is refused, and the worker independently re-renders and verifies the content
before letting the node start. Approving one gate approves only that node; every later gated node
pauses again. Once satisfied, a gate does not re-trigger for retries or later supervisor rounds of
the same node. To not run a gated node at all, stop the run or revise the workflow instead.

Gates pair naturally with `inputs`: a planner node can write the task for the next node, and the
gate lets a human confirm the rendered prompt (fixed frame + generated task) before it executes.
Nodes added by an adaptive supervisor may also declare `"gate": "approval"`; the gate is part of
the node object and therefore inside the approved patch digest.

## Workspaces

Every workspace declares `mode`, `path`, `vcs`, `writes`, and `exclusiveResources`. `vcs` is
required in every mode: use `"git"`, `"plastic"`, `"other"`, or `"none"` for `shared` and
`existing`; `git-worktree` requires `"git"`.

`workspace.mode` is:

- `shared`: use `workspace.path` (absolute or `null`), node `cwd`, or workflow `cwd`.
- `existing`: use a separately prepared workspace; `workspace.path` must be an absolute path.
- `git-worktree`: create a worktree before the node. This variant also requires a `git` object;
  `shared` and `existing` must not have that separate `git` field.

Declare every possible mutation in `writes`; an empty array means no writes are declared. Only
each pattern's static prefix — the part before the first wildcard character — is compared: two
unordered nodes conflict when one resolved prefix contains the other, so `src/**` and
`src/api/file.ts` overlap. There is no full glob engine. These declarations control scheduling
and warnings; they are not an operating-system sandbox. Use provider permissions, worktree
isolation, and command approval for enforcement. Use `exclusiveResources` for resources that
cannot be shared.

A mutating node in a Plastic workspace should normally reserve `"plastic-scm"` in
`exclusiveResources` so workspace and version-control operations do not run concurrently with
another holder. This convention does not apply to Codex `read-only`, Claude `plan`, or command
`mutates: false` nodes.

For a Git worktree, declare:

- `branch`: supports `{{runId}}` and `{{nodeId}}`.
- `startPoint`: explicit revision or branch.
- `removeOnClean`: whether `orchestrate clean` should try a non-forced `git worktree remove`.

Orchestrate never force-removes a dirty worktree.

## Agent nodes

Declare:

- `provider`: `codex` or `claude`.
- `model`: exact model name, or exactly the sentinel `provider-default`; other strings starting
  with `provider-` are rejected as likely typos.
- `effort`: provider value or `null`.
- `prompt`: complete task instruction.
- `session`: context lifecycle.
- `permissions`: provider-specific; see below.
- `output`: `{ "format": "text" | "json", "schema": <JSON Schema object> | null }`.
- `interactive`: `false` for a normal headless node; `true` runs the node as the provider's real
  interactive TUI inside a herdr pane. See "Interactive agent nodes" below.

Session fields:

- `mode`: `fresh`, `resume`, or `fork`.
- `from`: alias for resume/fork, otherwise `null`.
- `saveAs`: alias to retain, otherwise `null`.
- `retain`: explicit persistence decision.
- `reuseOnRepeat`: when a repeated node already saved its alias, resume it on later invocations.

Each non-null `saveAs` produces a workflow-global alias, and exactly one node may produce a given
alias. Resuming or forking an alias does not require saving it again. For a normal linear resume
chain, the first node uses `saveAs: "alias"`; later nodes use `from: "alias"`, `saveAs: null`, and
`retain: true`. Use a different, unique `saveAs` only when intentionally naming the continued or
forked state.

Provider sessions are mutable. Two unordered nodes cannot resume the same session lineage; use a
linear resume chain, fresh sessions, or provider-native forks.

Permissions are provider-specific — the schema ties each shape to its provider:

- Codex nodes: `permissions.sandbox` is `read-only`, `workspace-write`, or `danger-full-access`.
- Claude nodes: `permissions.permissionMode` is `acceptEdits`, `auto`, `bypassPermissions`,
  `dontAsk`, `manual`, or `plan`.

Both also declare `extraArgs`, `inheritEnv`, and `env`. Keep `extraArgs` empty unless the plan
specifically needs them. Model, session, permission, output, and environment-control flags are
reserved and rejected from `extraArgs`; use their semantic fields instead.

Codex refuses to run in a working directory that is not inside a version-controlled (Git)
directory unless `--skip-git-repo-check` is passed via `extraArgs`. Prefer running codex nodes
inside a repository; reserve the flag for a deliberately unversioned workspace.

Provider environments are explicit:

- `inheritEnv`: exact controller environment-variable names to copy, such as `PATH`, `HOME`, and
  the selected provider's credential/config variables.
- `env`: exact additional or overriding values.

Provider processes do not inherit any other controller variables. Preview displays inherited
names and explicit keys while redacting explicit values.

## Interactive agent nodes

An agent node with `"interactive": true` runs as the provider's real interactive TUI (`claude` or
`codex`) in a herdr tab labeled with the node id. A human may watch the pane and type into the
session at any time. herdr is the execution substrate for these nodes — spawning, hosting, and
killing go through the herdr CLI — so launching or resuming a run whose pending nodes include one
requires a usable herdr CLI on `PATH` and fails cleanly without it. Headless nodes never require
herdr.

Completion is signaled by a prompt contract, never by screen-scraping. The runtime appends a fixed
instruction block after the rendered prompt with a one-time per-attempt token. The template is:

```
# Orchestrate interactive-node contract

This session is node "<node-id>" of orchestrated workflow run <run-id>. It runs
interactively: a human may watch this terminal and participate at any time, and the session
stays open until you signal completion as described below.

When the task is complete you MUST, in this order:

1. Write a concise result/handoff report for downstream workflow nodes to exactly this file:
   <absolute result.txt path for this attempt>
2. Run exactly this command:
   <absolute orchestrate invocation> node-done <run-id> <node-id> --token <token> --outcome completed

If the task cannot be completed, write a report explaining why to the same file, then run the
same command with --outcome failed instead.

The command is rejected until the report file exists and is non-empty. Until it succeeds, the
workflow keeps waiting on this node.
```

Semantics and constraints:

- `interactive` is ordinary workflow content and part of the approval digest like every other
  field. The appended contract is runtime plumbing: approval digests and **gate content bind the
  rendered prompt exactly as for a headless node, without the contract or its token**. Approving a
  gate on an interactive node therefore covers the same rendered prompt it would cover headless.
- `output.format: "json"` or a non-null output schema is rejected: structured output cannot be
  enforced in a live TUI. Keep structured-output nodes headless.
- Interactive Codex nodes cannot set `session.saveAs`: an interactive codex session exposes no
  reliable native session id to record. Interactive Claude nodes may — a fresh session's id is
  pinned at spawn with `--session-id`, and a resume keeps its source id — except in `fork` mode,
  where the fork's new id cannot be pinned.
- `retain: false` is not fully enforceable interactively: the interactive CLIs persist sessions on
  disk regardless (`claude --no-session-persistence` and `codex --ephemeral` exist only headless).
- Interactive Codex nodes run with `approval_policy` forced to `on-request`, overriding a user
  config of `never` (correct for headless exec, wrong when a human is present in the pane):
  escalations — including writing the contract's result file from a `workspace-write` sandbox —
  must be able to reach the human. An explicit `extraArgs` entry still overrides this.
- Adaptive supervisor patches may **never** add interactive nodes; such a patch is rejected
  outright (not held for approval) because a supervisor must not spawn human-attended sessions.
- A `--outcome failed` report goes through the node's normal retry logic; a retried interactive
  node gets a fresh token and a fresh tab. A node timeout closes the pane best-effort and fails
  the attempt; `stop` closes the pane; `pause` waits for interactive nodes like any running node
  and names them in its reason. If the worker crashes, `resume --recover` fails the in-flight
  attempt (its token is void) and journals that the old pane may still be open.
- Process-listing caveat, for interactive nodes only: the full rendered prompt (with the appended
  contract) is written to `prompt.txt` in the attempt directory and substituted onto the TUI's
  command line inside the pane, so it can appear in local process listings on that machine. This
  deliberately relaxes the stdin-only promise that headless nodes keep.

## Command nodes

Commands use an argv array without a shell:

- `argv`: executable followed by arguments. Unless `inheritEnv` lists `PATH` or `env` declares
  it, `argv[0]` must be an absolute path; validation rejects the workflow otherwise.
- `mutates`: whether the command can modify anything. `mutates: false` declares a read-only
  command (tests, linters, type checks): it must keep `writes: []` and is exempt from
  write-safety warnings. `mutates: true` commands should declare their write set.
- `inheritEnv`: exact controller environment-variable names to copy, such as `PATH` and `HOME`.
- `env`: additional or overriding values.
- `allowedExitCodes`: explicit success codes.

The controller writes resolved inputs to `inputs.json` in the attempt directory and exposes its
path as `ORCHESTRATE_INPUTS_FILE`.

Command processes receive exactly the declared `inheritEnv` names plus `env` plus
`ORCHESTRATE_INPUTS_FILE` — nothing else. Commands added later by an adaptive supervisor must
declare `inheritEnv: []`; this prevents an adaptive command from inheriting unrelated
credentials.

Use a command node for deterministic validation or repository operations, not as a way to bypass
agent permission declarations.

## Supervisor nodes

A supervisor has the agent/session fields plus:

- `goal`: desired end state.
- `termination.success`: evidence required for completion.
- `termination.convergence`: semantic no-new-progress rule.
- `termination.maxRounds` and `maxWallTimeMinutes`: explicit values or `null`.
- `envelope.providers`, `models`, and `nodeTypes`. `models` accepts the wildcard entry `"*"` to
  approve any model; list it deliberately, never as a reflex.
- `envelope.cwdRoots` and `writeRoots`: absolute approved boundaries.
- `envelope.workspaceModes` and `vcs`: workspace/VCS declarations the supervisor may add.
- `envelope.gitWorktree`: explicit authority, branch prefixes, exact start points, and whether
  controller cleanup may remove the worktree.
- `envelope.allowCommands`.
- `envelope.commandArgvPrefixes` and exact `allowedCommandEnv` values. Every prefix must contain
  at least one argv element; an empty prefix is invalid.
- `envelope.codexSandboxes` and `claudePermissionModes`.
- `envelope.allowedExtraArgs`: exact approved provider CLI argument arrays.
- `envelope.allowedInheritedEnv` and `allowedProviderEnv`: exact provider environment authority.
  Inherited-name sets are compared order-insensitively.
- `envelope.resumableSessionAliases` and `newSessionAliasPrefixes`.
- `envelope.maxAddedNodesPerRound`: explicit number or `null`.

Empty grants are safe defaults, not lockouts: a node that declares `extraArgs: []`,
`inheritEnv: []`, or `env: {}` is always in-envelope for that dimension. The `allowed*` lists only
gate non-empty declarations, so an envelope with all three lists empty still admits nodes that ask
for nothing.

The structured result is:

```json
{
  "status": "complete | continue | pause",
  "reason": "Why this decision is justified",
  "addNodes": []
}
```

For `continue`, `addNodes` contains complete agent or command node objects. Orchestrate reruns the
supervisor after all added nodes finish. `continue` requires at least one node; `complete` and
`pause` require an empty array. An out-of-envelope proposal is displayed in full with its own
digest and requires `orchestrate resume <run-id> --approve-patch <sha256>`.

A `pause` decision creates a digest-bound input request. After the user answers, resume with
`orchestrate resume <run-id> --respond <text> --input-digest <sha256>`. The response is included
in that supervisor's next context.

## Runtime artifacts

Each run directory contains:

- `workflow.json`: approved initial workflow.
- `state.json`: atomic controller state.
- `events.jsonl`: append-only event stream.
- `nodes/<id>/attempt-<n>/`: raw provider output, errors, structured schema, and `result.txt`.
- `workspaces/`: controller-created Git worktrees when no explicit path was supplied.

The approval digest is SHA-256 over canonicalized validated JSON (sorted keys). It binds that
canonicalized content: any change to field values or structure changes it, while pure whitespace
or key-order reformatting does not — re-preview after any edit regardless. Every worker start
revalidates the stored workflow and compares that digest before scheduling.
Terminal previews redact webhook-header and command-environment values while the digest continues
to bind the unredacted source file. Rendered prompts for headless nodes are sent through stdin
rather than process arguments, so they never appear in process listings; interactive nodes
deliberately relax this (see "Interactive agent nodes").
