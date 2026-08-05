# Workflow format

This document is the normative semantic authoring contract for cross-field workflow rules. The
generated [workflow.schema.json](workflow.schema.json) is the structural machine contract. Unknown
fields are errors. Paths are evaluated from the explicit workflow `cwd`; use absolute paths wherever
the schema requires them. Runtime and recovery mechanisms live in
[runtime-operations.md](runtime-operations.md).

## In this reference

- [Root](#root) and [common node fields](#common-node-fields)
- [Workspaces](#workspaces) and [mid-run revisions](#mid-run-revisions)
- [Agent nodes](#agent-nodes), [command nodes](#command-nodes), and [node environment](#node-environment)
- [Repeats](#repeats) and [presentation workrooms](#presentation-workrooms)
- [Stable prompts and planning](#stable-prompts-and-planning)

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
- optional `presentation.workrooms`: stable presentation intent with scheduler-enforced occupancy
  invariants for related node turns.

## Common node fields

Every node declares `id`, `type`, `title`, `needs`, nullable `cwd`, `workspace`, `inputs`, `retry`,
and `gate`, and may declare `when`, `workroom`, and `seat`. IDs are unique and dependencies
must form a DAG.

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
Once an assigned attempt reserves a workroom, its definition is frozen as specified under
[Presentation workrooms](#presentation-workrooms). The reservation boundary also covers a crash
after pane creation but before spawn observation reaches run state. Revisions must preserve every
live pane's unambiguous workroom and seat occupancy; a revision that would move, duplicate, or orphan
one is rejected rather than guessed.
The proposal and approval mechanics are in [runtime-operations.md](runtime-operations.md).

## Agent nodes

Agent nodes add `provider`, `model`, nullable `effort`, `prompt`, `session`, `permissions`, and
`output`.

`session.mode` is `fresh`, `resume`, or `fork`; `from` names an earlier `saveAs` alias for resume or
fork. A continuation must use the same provider, and its source must be an ancestor dependency.
Resume is a single ordered continuation; use fork for fan-out. Nodes without a `saveAs` alias never
create a reusable workflow provider-session name.

A persistent repeat member may only resume an unconditional alias seeded outside that repeat. It
cannot fork, create or replace an alias, or form an unordered lineage. In V1 every resumed or forked
node must keep its source node's workroom and seat assignment. The copy-on-write retry and
provider-session promotion mechanics are documented under
[Retries and provider sessions](runtime-operations.md#retries-and-provider-sessions).

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

The launcher supplies the exact token-addressed completion channel automatically. Authors never add
it to `workspace.writes`, preferences, or provider `extraArgs`, and it does not expand source
workspace access. `danger-full-access` is not a valid workflow sandbox. The transport and trusted
reconciliation boundary are documented under
[Locking and completion transport](runtime-operations.md#locking-and-completion-transport).

Mutating provider nodes are invalid when the effective workspace/cwd sandbox root or any static
write-prefix ancestor overlaps the configured state root or installed Orchestrate authority in
either direction. This applies to Codex and Claude, resolves existing symlink ancestors, and covers
default and custom state roots, run journals, every non-token submission directory,
installed runtime assets, executable links, and provider skill links. The trusted launcher's exact
token-addressed submission allowance is the only exception.

## Command nodes

Command nodes add `argv`, `mutates`, `inheritEnv`, literal `env`, and `allowedExitCodes`. They run
directly in a transient Herdr pane and do not occupy a workroom seat in V1. A command may still name
its supporting `workroom` with `seat` omitted. Output is tee'd to the attempt output path
before `node-exit` reports the numeric status.

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

## Presentation workrooms

`presentation` is optional. Its `workrooms` array expresses stable human-facing presentation intent
with scheduler-enforced occupancy invariants. It does not add dependency edges or change permission,
workspace, or provider-session authority. Each workroom declares:

- a unique `id` and human-facing `label`;
- `layout`, either `columns` or `rows`;
- an ordered `seats` array of one to four globally unique `{ "id", "label" }` entries; and
- a non-empty `settlesOn` array of node template IDs.

```json
{
  "presentation": {
    "workrooms": [
      {
        "id": "review-s1",
        "label": "Deep Review · Slice 1",
        "layout": "columns",
        "seats": [
          { "id": "implementer", "label": "Implementer" },
          { "id": "reviewer", "label": "Independent Reviewer" }
        ],
        "settlesOn": ["s1-gate"]
      }
    ]
  }
}
```

A seatful node names both `workroom` and `seat`. A seatless supporting node may name only
`workroom`; omission is required rather than `"seat": null`. A node outside a workroom cannot name a
seat. Workrooms and seats are presentation identities, not provider-session aliases.

Nodes assigned to the same seat must have a total dependency order. Every settlement anchor must be
outside all repeats and downstream of every other node assigned to the workroom, including seatless
supporting work. A workroom settles only after every anchor is durably `completed` or
scheduler-owned `skipped`; a hold remains a separate dependency-release fact. A resumed or forked
provider session must retain its source workroom and seat. Retries and repeat instances reuse their
declared seat, while a scheduler-owned skip creates no pane and does not touch a parked occupant.

Seatful nodes use their declared workroom tab and seat instead of ordinary matcher placement, while
inheriting the effective UI `placement.workspace` preference. Seatless nodes use ordinary placement.
Layout and seat order express intended split direction and preview order; Herdr retains ownership of
physical geometry.

Once any attempt reserves a workroom, its workroom ID and label, layout, seat IDs, seat labels, seat
order, and settlement anchors are frozen for revision. Parking, settlement, completion preference,
missing-pane recovery, and best-effort geometry are specified under
[Herdr presentation](runtime-operations.md#herdr-presentation). The normative recovery boundary is
in [guarantees.md](guarantees.md). Workrooms do not provide automatic fresh-provider fallback or
session-alias rebinding.

## Stable prompts and planning

The prompt frame is fixed by the approved workflow: objective, title, declared inputs, result
contract, paths, and completion command. Only dependency outputs and runtime paths are resolved at
start. For work that cannot be enumerated in advance, use a structured planner result as input to a
gated executor. The graph itself remains static and reviewable.
