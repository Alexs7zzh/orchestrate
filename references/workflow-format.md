# Workflow format

This document is the normative semantic authoring contract for cross-field workflow rules. The
generated [workflow.schema.json](workflow.schema.json) is the structural contract for parsed YAML
`WorkflowSource`. Authored paths must end in case-sensitive `.yaml` or `.yml`; JSON authoring,
format flags, content sniffing, tags, merge keys, anchors, and aliases are not supported. Unknown
fields are errors. Source is normalized into the expanded runtime `WorkflowSpec`; only that valid IR
is digested and persisted. Runtime and recovery mechanisms live in
[runtime-operations.md](runtime-operations.md).

## In this reference

- [Root](#root) and [common node fields](#common-node-fields)
- [Workspaces](#workspaces) and [mid-run revisions](#mid-run-revisions)
- [Agent nodes](#agent-nodes), [command nodes](#command-nodes), and [node environment](#node-environment)
- [Repeats](#repeats) and [presentation workrooms](#presentation-workrooms)
- [Stable prompts and planning](#stable-prompts-and-planning)

## Source, diagnostics, provenance, and digests

The loader accepts one nonempty UTF-8 YAML 1.2 core document from a regular file up to 1,048,576
bytes, with string keys, unique keys, no merge behavior, and collection depth at most 64. Workflow
source symlinks and special files are rejected; ordinary ancestor-directory symlinks are resolved by
the operating system, but the final source entry is opened no-follow. That single nonblocking file
handle owns the type check and limit-plus-one bounded read. The value subset is null, strings,
booleans, finite numbers, safe integers, dense arrays, and plain string-keyed objects.

| Origin     | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `explicit` | Authored source value.                                                         |
| `default`  | Normalizer-owned default with a stable rule identifier.                        |
| `expanded` | Agent/command discriminator, execution, retry, or session shorthand expansion. |
| `inferred` | Current-round input or `when` dependency appended by normalization.            |

Every expanded IR leaf and array item has an RFC 6901-keyed origin. Diagnostics map parser, source
schema, normalization, and expanded semantic failures back to the actionable YAML pointer and
one-based source range. Human diagnostics are
`<file>[:line:column]: ERROR|WARN <code> <pointer-or-/>: <message>`.
For each inferred `/nodes/<index>/needs/<item>` origin, `inferredNeeds` contains exactly one
matching node, reason, and source-pointer annotation under that owning node ID. Unknown node keys,
annotations for explicit/default needs, and missing, extra, duplicate, or mismatched annotations
make the provenance invalid before proposal persistence or approval.
Persisted provenance is also checked structurally before proposal, approval, and status rendering:
every location file must equal the top-level source, source pointers must map back to an authorable
YAML field, and default rules, discriminator/permission/retry/session shorthands, and inferred
dependency reasons must be valid for the exact expanded IR field. In particular, normalized-only
`type`, `provider`, `permissions`, retry, and session fields cannot claim explicit authorship.

Canonical JSON preserves array order, sorts object keys by UTF-16 code units, and rejects any value
that JSON would silently omit or coerce. Workflow approval hashes UTF-8 bytes of
`orchestrate:digest/v1\0workflow-ir\0<canonical-json>`; gates use the `gate-content` domain over
`{content:<exact rendered content>}`. Starts, proposals, approvals, state, and events reuse
recomputed digests at their trust boundaries.

## Root

- Required: `name`, `objective`, absolute `cwd`, `limits: {maxStarts: <positive integer|null>}`,
  and a nonempty ordered `nodes` array.
- `concurrency` defaults to `1`; it is the maximum simultaneous active node attempts.
- `callback` defaults to `{type: none}` and may be `none`, `notification`, `command`, or `webhook`.
  Command `{{event}}`
  expansion and webhook bodies receive the event without its internal state patch, which can embed
  node result content. Webhook URLs are absolute `http` or `https` URLs with no whitespace and a
  nonempty host; minimal hosts, valid ports, IPv6 literals, credentials, and case-insensitive schemes
  are accepted. The generated schema applies the documented lexical URL prefilter, while source and
  final-IR decoding additionally use the runtime URL parser. Header names use the HTTP field-name
  token grammar, and values permit only fetch-compatible HTAB, visible/extended bytes, and no other
  controls; violations point to the escaped header-key pointer.
- `milestones` defaults to `false`.
- `writeConflicts` defaults to `reject`; `allow-with-approval` permits an explicit run override.
- `repeats` defaults to `[]` and contains bounded repeated subgraphs.
- optional `presentation.workrooms`: stable presentation intent with scheduler-enforced occupancy
  invariants for related node turns.

Normalizer-owned root defaults are exact:

| Source field      | Expanded value when omitted | Stable rule                      |
| ----------------- | --------------------------- | -------------------------------- |
| `concurrency`     | `1`                         | `root.concurrency.one`           |
| `callback`        | `{type: "none"}`            | `root.callback.none`             |
| webhook `headers` | `{}`                        | `callback.webhook.headers.empty` |
| `milestones`      | `false`                     | `root.milestones.false`          |
| `writeConflicts`  | `"reject"`                  | `root.write-conflicts.reject`    |
| `repeats`         | `[]`                        | `root.repeats.empty`             |

## Common node fields

Every source node requires `id` and exactly one discriminator: `agent: codex|claude` or
`command: [argv, ...]`. `title` defaults to `id`; `needs`, `inputs`, workspace writes/resources
default to `[]`; `cwd` defaults to null; `workspace` defaults to shared/null/none; retry defaults to
one attempt; and `gate` defaults to `none`. `workroom`, `seat`, and `when` stay absent when omitted;
null is rejected. IDs are unique and dependencies form a DAG.

Naming convention: `parent--sub` (for example `api--test`) marks a sub-node of `api`. The default
UI placement written by `ui wizard` keys on this: sub-nodes open as splits in their parent's tab
while every other node opens its own tab, so name detail work `<stage>--<detail>` when the workflow
has a backbone of stages.

An input requires `from` and the prompt/result name `as`; `include` defaults to `content` and
`round` defaults to `current`. Effective dependencies preserve explicit `needs` order, then append
each current-round input source in input order, then `when.node`, deduplicating inferred items.
Explicit duplicates are errors. Previous-round inputs and session sources never infer dependencies.

`retry.maxAttempts` includes the first attempt. `gate` is `none` or `approval`.

| Node source field        | Expanded value when omitted                               |
| ------------------------ | --------------------------------------------------------- |
| `title`                  | node `id`                                                 |
| `needs`, `inputs`        | `[]`                                                      |
| `cwd`                    | `null`                                                    |
| `workspace`              | shared, `path: null`, `vcs: none`, empty writes/resources |
| `retry`                  | `{maxAttempts: 1}`                                        |
| `gate`                   | `none`                                                    |
| input `include`, `round` | `content`, `current`                                      |

`when` is a scheduler-owned condition over a direct dependency's schema-validated JSON result:

```yaml
type: agent-output
node: verdict
pointer: /done
equals: false
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

All modes default `writes` and `exclusiveResources` to empty arrays:

- `shared`: path defaults null and `vcs` defaults `none`.
- `existing`: requires an absolute path; `vcs` defaults `none`.
- `git-worktree`: path defaults null, source `vcs` may only be `git`, and required `git` contains
  `branch`, `startPoint`, and
  `removeOnClean`. Branch strings and explicit paths may contain `{{runId}}` and `{{nodeId}}`.
  Repeat members must include `{{nodeId}}` in the branch and every explicit path so every runtime
  round uses a unique branch and directory. A null path derives a run/runtime-unique temporary
  worktree outside Orchestrate authoritative state.

Parallel nodes with overlapping write prefixes are rejected unless the workflow explicitly permits
an approval override. Conflict analysis resolves every static prefix through its deepest existing
ancestor, so symlink aliases compare as one physical path and case aliases compare according to the
actual containing volume rather than the host operating-system name. An inspection error or
undetermined volume case rule rejects validation instead of falling back to lexical comparison.
This scheduling identity rule applies to command write sets too; it does not make approved command
nodes provider-sandboxed. An exclusive resource serializes all nodes that name it.

## Mid-run revisions

Approved mid-run revisions may reorder, insert, remove, or change dependencies for nodes that have
not started. Their runtime entries are rebuilt in revised declaration order and rescheduled from
`pending`. Templates for nodes with an attempt or a scheduler-derived skip are immutable; unsafe
removal or rewriting is rejected so journal history, decisions, and session lineage remain valid.
Once an assigned attempt reserves a workroom, its definition is frozen as specified under
[Presentation workrooms](#presentation-workrooms). The reservation boundary also covers a crash
after pane creation but before spawn observation reaches run state. Revisions must preserve every
live pane's unambiguous workroom and seat occupancy; a revision that would move, duplicate, or orphan
one is rejected rather than guessed. Pending revisions persist the expanded workflow, its
recomputed digest, summary, and exact `WorkflowProvenance`; proposed and approved events carry the
same provenance. Preview is recomputed from the pending workflow and provenance. The proposal and
approval mechanics are in [runtime-operations.md](runtime-operations.md).

## Agent nodes

Agent source nodes require `agent`, `prompt`, and provider-specific `execution`. `model` defaults to
`provider-default`; `effort` to null; `escalation` to `deny`; `extraArgs`, `inheritEnv`, and `env`
to empty values; `output` to text; and `session` to fresh. Authors never write expanded `type`,
`provider`, or `permissions` keys.

| Authored shorthand                      | Expanded IR                                            |
| --------------------------------------- | ------------------------------------------------------ |
| `agent: codex` or `agent: claude`       | `type: agent` plus matching `provider`                 |
| `execution: read-only\|workspace-write` | Codex `permissions.execution.sandbox`                  |
| `execution: dont-ask`                   | Claude `permissions.execution.permissionMode: dontAsk` |
| retry integer or `{maxAttempts: N}`     | `{maxAttempts: N}`                                     |
| `session: fresh`                        | fresh session with null source and alias               |
| session map                             | explicit fresh/resume/fork lineage fields              |
| `command: [argv, ...]`                  | `type: command` plus `argv`                            |

Session source is scalar `fresh`, `{fresh: alias}`, `{resume: alias}`, `{resume: alias, saveAs:
newAlias}`, `{fork: alias}`, or `{fork: alias, saveAs: newAlias}`. A continuation must use the same
provider, and its source must be an ancestor dependency.
Resume is a single ordered continuation; use fork for fan-out. Nodes without a `saveAs` alias never
create a reusable workflow provider-session name.

A persistent repeat member may only resume an unconditional alias seeded outside that repeat. It
cannot fork, create or replace an alias, or form an unordered lineage. Every resumed or forked
node must keep its source node's workroom and seat assignment. The copy-on-write retry and
provider-session promotion mechanics are documented under
[Retries and provider sessions](runtime-operations.md#retries-and-provider-sessions).

Permissions deliberately separate two source axes:

- `execution` is `read-only` or `workspace-write` for Codex and only `dont-ask` for Claude.
- `escalation` is `deny`, `ask-user`, or `auto-review`. `deny` is the unattended default: an action
  outside the permitted execution envelope fails instead of opening a user prompt.

For Codex, escalation maps independently to `never`, `on-request`, or `on-request` with the
automatic reviewer. Claude authoring supports only `dontAsk` with `deny`. At launch, Orchestrate
removes the interactive permission layer, exposes only Bash, and makes the fail-closed native
sandbox the execution boundary. It grants source reads plus only canonical declared source writes
and denies authoritative state and installed control assets. Authored `bypassPermissions`,
interactive modes, nonempty Claude `extraArgs`, and provider-native delegation remain rejected or
disabled.

Codex may declare non-reserved `extraArgs`; Claude must declare an empty array. Both providers
declare `inheritEnv` and literal `env`. Output is `text` or `json`; JSON requires a non-null JSON
Schema object. Text forbids `schema` and expands it to null. The agent writes
`ORCHESTRATE_RESULT_PATH` and invokes the exact
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
installed runtime assets, executable links, provider skill links, and the canonical effective
`CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Preflight and each spawn boundary also protect the resolved
executable for every provider used by the workflow from every mutating provider node, regardless of
dependency order, provider kind, or retry timing. The trusted launcher's exact token-addressed
submission allowance is the only exception.

## Command nodes

Command source nodes require `command: [argv, ...]` and explicit boolean `mutates`; shell strings
and expanded `type`/`argv` keys are rejected. `inheritEnv` and `env` default empty and
`allowedExitCodes` defaults to `[0]`. They run directly in a transient Herdr pane and do not occupy a workroom seat. A command may still name
its supporting `workroom` with `seat` omitted. Output is tee'd to the attempt output path
before `node-exit` reports the numeric status.

## Node environment

Beyond declared `inheritEnv` and literal `env`, every pane receives `ORCHESTRATE_BIN`,
`ORCHESTRATE_STATE_DIR`, `ORCHESTRATE_RUN_ID`, `ORCHESTRATE_NODE_ID`, `ORCHESTRATE_NODE_TOKEN`,
`ORCHESTRATE_OUTPUT_PATH`, `ORCHESTRATE_RESULT_PATH`, and `ORCHESTRATE_SOURCE_ROOT`. Agent panes also
receive launcher-owned `ORCHESTRATE_COMPLETION_CONTRACT`, `TMPDIR`, `TMP`, and `TEMP` pointing to
their immutable attempt-local completion contract and dedicated scratch directory inside their
token-scoped transport. Their provider lookup and control environment is launcher-owned too:
`PATH` and `HOME` plus `CODEX_HOME` or `CLAUDE_CONFIG_DIR` are bound to the same values used to
resolve the provider executable and create its control configuration. Those nine `ORCHESTRATE_*`
names are reserved in both `env` and `inheritEnv` for every node; `TMPDIR`, `TMP`,
`TEMP`, `PATH`, `HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR` are additionally reserved for agent
nodes. Other `ORCHESTRATE_*` names are not implicitly reserved, and command nodes may declare their
own temp and lookup variables. Agents write
the declared result to `ORCHESTRATE_RESULT_PATH`; the command trampoline uses the output path and
token to tee output and report `node-exit`. The token authenticates only that attempt's
submission, and reconciliation rejects stale tokens. The owning workflow agent is the sole
completion owner. Delegated workers must never write the result, create `completion.json`, or invoke
`node-done`; idle/done pane state and free text are never completion evidence.

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
- an ordered `seats` array of one to four globally unique `{id, label}` entries; and
- a non-empty `settlesOn` array of node template IDs.

```yaml
presentation:
  workrooms:
    - id: review-s1
      label: Deep Review · Slice 1
      layout: columns
      seats:
        - { id: implementer, label: Implementer }
        - { id: reviewer, label: Independent Reviewer }
      settlesOn: [s1-gate]
```

A seatful node names both `workroom` and `seat`. A seatless supporting node may name only
`workroom`; omission is required rather than `seat: null`. A node outside a workroom cannot name a
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
