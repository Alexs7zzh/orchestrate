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
- optional `presentation.workrooms`: approved, stable Herdr rooms for related node turns.

## Presentation workrooms

`presentation` is optional. Its `workrooms` array declares stable human-facing rooms without
changing DAG, permission, workspace, or provider-session semantics. Each workroom declares:

- a unique `id` and human-facing `label`;
- `layout`, either `columns` or `rows`;
- an ordered `seats` array of one to four globally unique `{ "id", "label" }` entries; and
- a non-empty `settlesOn` array of node template IDs.

Seat order is presentation order. A room settles only after every `settlesOn` node has the durable
status `completed` or scheduler-owned `skipped`; failures, pauses, unopened gates, and exhausted
repeats do not satisfy an anchor. A downstream hold is a separate fact and does not rewrite a
completed anchor. An anchor must be outside every repeat and downstream of every node assigned to
the room, so settlement cannot race unfinished room work.

A node may name `workroom` and may name `seat`. Both are omission-only optional fields: in
particular, a seatless node omits `seat` rather than writing `"seat": null`. A seatful node must
name an existing room that declares that seat. A seatless supporting node may name the room with
`seat` omitted.
A node outside a room must not name a seat. Workrooms and seats are presentation identities, not
provider-session aliases: agent nodes still declare `session.mode`, `from`, and `saveAs` normally.

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

The implementer and reviewer agent nodes name `workroom: "review-s1"` and their respective seat.
A supporting build command names only `workroom: "review-s1"`; its `seat` field is omitted.

Seatful nodes use their declared room and ordered seat instead of matching the ordinary tab/split
placement rules. The room inherits the effective `placement.workspace` (`dedicated` or `origin`);
an unavailable origin still falls back to the dedicated run workspace. Nodes without a seat use
ordinary matcher placement. In particular, V1 command nodes remain seatless, transient Herdr panes
even when they support a workroom; workrooms do not add a headless command executor.

`layout` and seat order define the intended split direction and preview order. Herdr owns physical
geometry: after missing-pane reconstruction, Orchestrate guarantees logical seat identity and
workroom co-location when observation is unambiguous, not pixel-perfect restoration of the former
split geometry.

Only one live attempt may occupy a seat. Validation rejects seat assignments that can run
concurrently. A successful seatful turn parks in its seat while the room is active, even when the
ordinary agent completion preference is `close-success`. After settlement, that existing
preference applies to the parked seat panes: `keep-open` leaves the room archived and
`close-success` closes them. Seatless nodes keep their normal completion behavior.

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
Once an assigned attempt reserves a workroom, its identity, label, layout, seat order, seat
identities, and settlement anchors are immutable. The reservation boundary also covers a crash
after pane creation but before spawn observation reaches run state. Revisions must preserve every
live pane's unambiguous room and seat occupancy; a revision that would move, duplicate, or orphan
one is rejected rather than guessed.
The proposal and approval mechanics are in [runtime-operations.md](runtime-operations.md).

## Agent nodes

Agent nodes add `provider`, `model`, nullable `effort`, `prompt`, `session`, `permissions`, and
`output`.

`session.mode` is `fresh`, `resume`, or `fork`; `from` names an earlier `saveAs` alias for resume or
fork. `saveAs` records the session id for lineage: Claude ids are launcher-chosen and passed to the
provider at start (resume keeps the source id), while Codex ids are captured from Herdr after the
first prompt. Nodes without a `saveAs` alias never depend on session reporting. Claude sessions are
project-scoped by launch directory, so every Claude node participating in a lineage runs from one
run-shared session directory beside the token-addressed submission directories. Fan-out must fork
rather than resume the same source twice. In V1 a resumed or forked node must retain its source
node's workroom and seat assignment;
continuing one provider lineage across presentation identities is rejected.
When a resumed or forked session's previous Herdr pane is still live, Orchestrate replaces the
provider in that pane's existing UI slot instead of opening another configured tab or split. For a seatful
node, the declared seat is authoritative: an explicitly missing pane is restored in that seat and
room only when the observed Herdr room and remaining occupants identify the slot unambiguously.
Ambiguous or contradictory occupancy requires human attention instead of placement fallback. A
seatless node with a missing pane follows the normal placement rules.

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
directly in a transient herdr pane and do not occupy a workroom seat in V1. A command may still name
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
Every runtime instance inherits its template's workroom and seat. Retries and later rounds reuse
that seat; a scheduler-owned `when` skip creates no attempt or pane and does not replace, close, or
otherwise touch the seat's parked occupant.

Workrooms do not automatically recover an unavailable provider session as a fresh session. V1
retains the approved `fresh`, `resume`, and `fork` contract and stops for existing recovery when a
resume cannot be established; automatic fresh fallback and alias rebinding are outside this
presentation feature.

## Stable prompts and planning

The prompt frame is fixed by the approved workflow: objective, title, declared inputs, result
contract, paths, and completion command. Only dependency outputs and runtime paths are resolved at
start. For work that cannot be enumerated in advance, use a structured planner result as input to a
gated executor. The graph itself remains static and reviewable.
