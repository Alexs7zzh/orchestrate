# Workflow format

The normative machine contract is [workflow.schema.json](workflow.schema.json). Unknown fields are
errors. Paths are evaluated from the explicit workflow `cwd`; use absolute paths wherever the
schema requires them.

## Root

- `name`, `objective`, `cwd`: identity, outcome, and project directory.
- `concurrency`: maximum simultaneous active node attempts. Completed panes may remain open. Prefer
  3 as a human-attention budget.
- `callback`: `{ "type": "none" }`, `notification`, `command`, or `webhook`. Command `{{event}}`
  expansion and webhook bodies receive the event without its internal state patch, which can embed
  node result content.
- `milestones`: whether milestone events invoke the callback.
- `limits.maxStarts`: nullable pane-start fuse.
- `writeConflicts`: reject overlaps, or require run-time approval with
  `allow-with-approval`.
- `nodes`: static agent and command nodes.
- `repeats`: bounded repeated subgraphs.

## Common node fields

Every node declares `id`, `type`, `title`, `needs`, nullable `cwd`, `workspace`, `inputs`, `retry`,
and `gate`, and may declare `when`. IDs are unique and dependencies must form a DAG.

Naming convention: `parent--sub` (for example `api--test`) marks a sub-node of `api`. The default
UI placement written by `ui wizard` keys on this: sub-nodes open as splits in their parent's tab
while every other node opens its own tab, so name detail work `<stage>--<detail>` when the workflow
has a backbone of stages.

An input declares `from`, the prompt/result name `as`, `include` (`content` or `path`), and `round`
(`current` or `previous`). Previous-round input is valid only inside one repeat and is absent in its
first round.

`retry.maxAttempts` includes the first attempt. `gate` is `none` or `approval`.

`when` is a scheduler-owned condition over a direct dependency's schema-validated JSON result:

```json
{ "type": "agent-output", "node": "verdict", "pointer": "/done", "equals": false }
```

The scheduler evaluates it after dependencies release and before a gate, attempt, session, pane,
resource, or start is consumed. Deep equality runs the node; a different value records a terminal,
zero-attempt `skipped` outcome. A skipped condition source propagates a skip. A missing pointer is
a condition-contract error: the run pauses for an approved condition change or stop, rejects an
unchanged resume, and never silently interprets malformed data as a skip. A paused repeat member may
revise only that template's `when` for its current and future unstarted instances; settled earlier
rounds remain immutable. The source must be a direct dependency and a JSON agent with
a non-null output schema. Conditional session producers and conditional repeat verdicts are
invalid. Content inputs from a skipped node render as `[skipped]`; path inputs are rejected because
there is no synthetic result artifact.

## Workspaces

All modes declare `writes` glob patterns and `exclusiveResources`:

- `shared`: nullable path plus `vcs`.
- `existing`: explicit existing path plus `vcs`.
- `git-worktree`: nullable target path, `vcs: "git"`, and `git` with `branch`, `startPoint`, and
  `removeOnClean`. Branch strings and explicit paths may contain `{{runId}}` and `{{nodeId}}`.
  Repeat members must include `{{nodeId}}` in the branch and every explicit path so every runtime
  round uses a unique branch and directory. A null path derives a run/runtime-unique temporary
  worktree outside Orchestrate authoritative state.

Parallel nodes with overlapping write prefixes are rejected unless the workflow explicitly permits
an approval override. An exclusive resource serializes all nodes that name it.

## Mid-run revisions

Approved mid-run revisions may reorder, insert, remove, or change dependencies for nodes that have
not started. Their runtime entries are rebuilt in revised declaration order and rescheduled from
`pending`. Templates for nodes with an attempt or a scheduler-derived skip are immutable; unsafe
removal or rewriting is rejected so journal history, decisions, and session lineage remain valid.
The proposal and approval mechanics are in [runtime-operations.md](runtime-operations.md).

## Agent nodes

Agent nodes add `provider`, `model`, nullable `effort`, `prompt`, `session`, `permissions`, and
`output`.

`session.mode` is `fresh`, `resume`, or `fork`; `from` names an earlier `saveAs` alias for resume or
fork. `saveAs` records the session id for lineage: Claude ids are launcher-chosen and passed to the
provider at start (resume keeps the source id), while Codex ids are captured from Herdr after the
first prompt. Nodes without a `saveAs` alias never depend on session reporting. Claude sessions are
project-scoped by launch directory, so every Claude node participating in a lineage runs from one
run-shared session directory beside the token-addressed submission directories. Fan-out must fork rather than resume the
same source twice.
When a resumed session's previous Herdr pane is still live, Orchestrate replaces the provider in
that pane's existing UI slot instead of opening another configured tab or split. A missing pane
falls back to the normal placement rules.

A repeat member may resume an alias seeded by an unconditional node outside the repeat. Members
sharing one alias must form a total dependency order; they cannot fork, replace the alias name, or
seed it from inside the repeat. At launch, every repeated resume is executed as a provider fork of
the alias's committed session head. Schema-valid success atomically promotes the alias to that
child session and current runtime node; failure leaves the prior head unchanged, so a retry forks
the same committed parent rather than inheriting a possibly poisoned attempt. Pane reuse follows
the committed `sourceNodeId`. Different aliases advance independently. The repeat declaration is
revision-immutable for the run, and each member template becomes immutable after its first attempt
or skip.

Permissions deliberately separate two axes:

- `execution` is provider-native capability configuration: Codex declares `sandbox`; Claude
  declares `permissionMode`.
- `escalation` is `deny`, `ask-user`, or `auto-review`. `deny` is the unattended default: an action
  outside the permitted execution envelope fails instead of opening a user prompt.

For Codex, escalation maps independently to `never`, `on-request`, or `on-request` with the
automatic reviewer. Claude workflow execution supports only `dontAsk` with `deny`. The launcher
owns a fail-closed native sandbox, starts Claude in the exact token transport directory, permits
only sandboxed Bash, grants only canonical declared source write prefixes, and denies authoritative
state and installed control assets. Built-in file tools, `bypassPermissions`, interactive/auto-edit
modes, and all Claude `extraArgs` are rejected because provider labels and allow rules are not an OS
confinement boundary.

Codex may declare non-reserved `extraArgs`; Claude must declare an empty array. Both providers
declare `inheritEnv` and literal `env`. Output is `text` or
`json`; JSON may have a JSON Schema. The agent writes `ORCHESTRATE_RESULT_PATH` and invokes the exact
`node-done` command in its prompt. `node-done --hold` submits a successful `completed` outcome and a
separate instance-scoped downstream hold for the next reconciliation. Release changes only the
hold. The embedded command always uses the exact full run ID; sandboxed submission does not resolve
run prefixes through authoritative state. Agent and command results are limited to 1 MiB before
trusted parsing, input rendering, journaling, or `orchestrate result` output.

Orchestrate implicitly grants each agent write access only to its exact token-addressed attempt
submission directory in the sibling transport root outside authoritative state. This channel is
separate from the declared execution and escalation axes: a Codex read-only source remains
read-only, a workspace-write source gains no other writable path, and Claude's enforced `dontAsk`
mode still produces no human prompt. `node-done` writes a completion envelope there and cannot
mutate the journal, snapshot, workflow/UI files, run lock, receipts, another attempt's submission,
or other authoritative state. The launching master runs `orchestrate reconcile` outside the
provider sandbox to validate the active token and result, commit the transition, and schedule
newly ready work. `danger-full-access` is not a valid workflow sandbox, and this runtime-only
transport is intentionally absent from the workflow schema, `workspace.writes`, preferences, and
provider `extraArgs`.

Mutating provider nodes are invalid when the effective workspace/cwd sandbox root or any static
write-prefix ancestor overlaps the configured state root or installed Orchestrate authority in
either direction. This applies to Codex and Claude, resolves existing symlink ancestors, and covers
default and custom state roots, run journals, every non-token submission directory,
installed runtime assets, executable links, and provider skill links. The trusted launcher's exact
token-addressed submission allowance is the only exception.

## Command nodes

Command nodes add `argv`, `mutates`, `inheritEnv`, literal `env`, and `allowedExitCodes`. They run
directly in a herdr pane. Output is tee'd to the attempt output path before `node-exit` reports the
numeric status.

## Node environment

Beyond declared `inheritEnv` and literal `env`, every pane receives `ORCHESTRATE_BIN`,
`ORCHESTRATE_STATE_DIR`, `ORCHESTRATE_RUN_ID`, `ORCHESTRATE_NODE_ID`, `ORCHESTRATE_NODE_TOKEN`,
`ORCHESTRATE_OUTPUT_PATH`, `ORCHESTRATE_RESULT_PATH`, and `ORCHESTRATE_SOURCE_ROOT`. Agents write
the declared result to `ORCHESTRATE_RESULT_PATH`; the command trampoline uses the output path and
token to tee output and report `node-exit`. The token authenticates only that attempt's
submission, and reconciliation rejects stale tokens.

## Repeats

A repeat declares `id`, ordered `members`, `maxRounds`, and `until`:

- `command-success` names a command member.
- `agent-output` names a JSON agent member plus an RFC 6901 pointer and expected value.

Members instantiate as `<id>--r<N>`. Dependencies from outside to a member wait for the entire
repeat, then resolve the final-round instance. Reaching the bound pauses for explicit human action.
An agent repeat member may use `{{round}}` in its approved prompt; rendering replaces it with the
instance's decimal round number. The placeholder is invalid outside a repeat.
For `when`, a source and consumer in the same repeat bind to their `--r<N>` instances; a non-repeat
source keeps its stable ID, and an outside consumer of a repeat source observes the settled final
round. Conditions across two different repeats are invalid. Each member is evaluated anew per
round. Completed and skipped members both settle their dependency edge, subject to holds, while the
unconditional verdict member always runs and determines whether another round is instantiated.

## Stable prompts and planning

The prompt frame is fixed by the approved workflow: objective, title, declared inputs, result
contract, paths, and completion command. Only dependency outputs and runtime paths are resolved at
start. For work that cannot be enumerated in advance, use a structured planner result as input to a
gated executor. The graph itself remains static and reviewable.
