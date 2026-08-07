# CLI contract

This document is the normative public command, JSON, streaming, and exit-code contract. Workflow
authoring semantics live in [workflow-format.md](workflow-format.md); runtime mechanisms live in
[runtime-operations.md](runtime-operations.md).

## In this reference

- [Output and exit codes](#output-and-exit-codes)
- [Command shapes](#command-shapes)
- [Run selection and environment](#run-selection-and-environment)
- [Live attention and waiting](#live-attention-and-waiting)
- [Shell completion](#shell-completion) and [durable outcomes](#durable-outcomes)
- [Master wake-up and submission transport](#master-wake-up-and-submission-transport)

## Output and exit codes

Every command prints human text by default and exactly one JSON value on stdout with `--json`.
Parse, dispatch, missing-file, and noninteractive errors use
`{"ok":false,"error":{"code":"<stable-code>","message":"..."}}` on stdout and exit `1` with
no human stderr. Codes distinguish `usage`, `validation`, `not_found`, `conflict`, `herdr`, and
`io`; unclassified failures use `command_failed`. `events --json` returns one
`{"events":[...]}` value; the explicit streaming exception `events --follow --json` emits one event
JSON value per line. Exit codes are `0` for
success, `1` for error, and `2` when the observed run needs human attention. Run IDs accept a unique
prefix, except `node-done`, whose sandbox-safe transport path requires the exact full run ID embedded
in the node prompt. Every command accepts `--help` without performing work; with `--json`, help is a
JSON value.

Authored workflow paths are case-sensitive `.yaml` or `.yml` only. `validate --json` returns
`{ok,source,workflow,digest,diagnostics}`; `preview --json` returns
`{ok,source,digest,preview,diagnostics}`. Invalid source exits `1`, keeps `workflow` or `preview`
null, and reports source-aware RFC 6901 paths and one-based YAML locations. Validation derives the
normalized workflow, digest, provenance, and diagnostics from one validation pass; `validate`
reports success only for that complete coherent result, otherwise `workflow` and `digest` are both
null and it exits `1`. Run and revision source
failures use error code `validation` and include the same `source` and `diagnostics` fields.
Pending revision state contains `{workflow,digest,summary,provenance,createdAt}`.
`revision.proposed` event data is `{digest,summary,provenance}` and `revision.approved` event data is
`{digest,workflow,provenance}`; approval copies the exact pending provenance.

Flags have fixed arity. Value flags require one value; boolean flags accept presence only, so forms
such as `--remove=false`, `--yes=false`, and `--dry-run=false` are errors. `--json` is always
noninteractive: it never opens a selector, confirmation, editor, or wizard. `board --json` selects
the normal default run even on a TTY, `stop --json` does not prompt, and `ui wizard --json` fails
with an explicit noninteractive error.

## Command shapes

| Command       | Shape                                                                                       | Purpose                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `validate`    | `validate <workflow.yaml> [--json]`                                                         | Validate YAML source, expansion, and semantics.                                                             |
| `preview`     | `preview <workflow.yaml> [--json]`                                                          | Print the approval plan, provenance, and digest.                                                            |
| `run`         | `run <workflow.yaml> --approve <sha256> [--allow-write-conflicts] [--dry-run] [--json]`     | Preflight, capture origin, create durable state, start ready panes, and return.                             |
| `status`      | `status [<run>] [--wait] [--json]`                                                          | Show state; wait until attention or settlement.                                                             |
| `events`      | `events [<run>] [--follow] [--json]`                                                        | Read or follow the journal.                                                                                 |
| `board`       | `board [<run>] [--json]`                                                                    | Open the TUI or print a plain snapshot.                                                                     |
| `reconcile`   | `reconcile <run> [--json]`                                                                  | Consume submissions, commit transitions, and start newly ready panes.                                       |
| `result`      | `result <run> <node> [--attempt <n>] [--json]`                                              | Read durable output.                                                                                        |
| `runs`        | `runs [--active\|--paused\|--needs-attention\|--settled] [--json]`                          | List runs with at most one filter.                                                                          |
| `approve`     | `approve <run> --gate <node> --digest <sha256> [--json]`                                    | Approve exact rendered gate content.                                                                        |
| `approve`     | `approve <run> --revision <sha256> [--json]`                                                | Apply an exact proposed revision.                                                                           |
| `pause`       | `pause <run> [--json]`                                                                      | Prevent new pane starts.                                                                                    |
| `resume`      | `resume <run> [--override-fuse] [--continue-rounds <n>\|--accept-repeat <repeat>] [--json]` | Resume with any required explicit exception.                                                                |
| `stop`        | `stop <run> [--yes] [--json]`                                                               | Close live panes and settle.                                                                                |
| `hold`        | `hold <run> <node> [--json]`                                                                | Hold downstream dependency release without changing node outcome.                                           |
| `release`     | `release <run> <node> [--json]`                                                             | Remove only the downstream barrier and crank ready work.                                                    |
| `revise`      | `revise <run> <workflow.yaml> [--json]`                                                     | Propose a digest-bound remaining-plan replacement with source provenance.                                   |
| `revise`      | `revise <run> --discard [--json]`                                                           | Discard the pending revision.                                                                               |
| `node-done`   | `node-done <run> <node> --token <token> --outcome <completed\|failed> [--hold] [--json]`    | Require a nonempty result, then submit an authenticated envelope; `--hold` also requests a downstream hold. |
| `node-exit`   | `node-exit <run> <node> --token <token> --code <integer> [--json]`                          | Command-pane completion trampoline.                                                                         |
| `herdr-event` | `herdr-event [--json]`                                                                      | Trusted Herdr plugin bridge for agent blocked/done and pane closed/exited events.                           |
| `ui show`     | `ui show [--origin] [--project <cwd>] [--json]`                                             | Show merged UI choices and optional origins.                                                                |
| `ui set`      | `ui set <path> <json-value> [--project <cwd>] [--json]`                                     | Set one validated UI choice.                                                                                |
| `ui edit`     | `ui edit [--project <cwd>] [--json]`                                                        | Edit one layer with `$EDITOR`.                                                                              |
| `ui wizard`   | `ui wizard [--project <cwd>] [--json]`                                                      | Choose run workspace, node layout, board placement, and notification routing.                               |
| `ui restore`  | `ui restore <run> [--json]`                                                                 | Reopen the board, reconcile panes, and apply retry policy.                                                  |
| `clean`       | `clean <run> [--dry-run] [--json]`                                                          | Close panes, remove opted-in worktrees, and delete run, submission, and provider-session files.             |
| `clean`       | `clean --settled [--dry-run] [--json]`                                                      | Clean every settled run.                                                                                    |
| `completion`  | `completion <fish\|zsh\|bash> [--json]`                                                     | Emit shell completion.                                                                                      |
| `setup`       | `setup [--dry-run] [--remove] [--defaults\|--no-wizard] [--json]`                           | Stage assets and link detected integrations.                                                                |
| `doctor`      | `doctor [--json]`                                                                           | Check Herdr, providers, state access, and installed build.                                                  |

## Run selection and environment

Read commands without a run ID select the newest run needing attention, otherwise the newest run.
Mutating commands always require an ID. `ORCHESTRATE_STATE_DIR` or `XDG_STATE_HOME` selects state
storage. `ORCHESTRATE_BIN` selects the orchestrate executable injected into node panes; its
resolved path is protected like other installed control assets. `ORCHESTRATE_DISABLE_PREFS=1`
disables preferences. `ORCHESTRATE_DISABLE_UI=1` suppresses
presentation only; node execution remains Herdr-backed.

## Live attention and waiting

`board`, `board --json`, and `runs --needs-attention` sample live Herdr pane/agent state for durably
running nodes. Explicit `blocked`, `done`, and `pane_not_found` observations are attention only when
the active attempt lacks a valid token-matched result and completion envelope; `done` is then
reported as `result missing`. Valid authenticated evidence takes precedence over all three live
observations and is reported as submitted/pending reconcile, not attention. `idle`, `unknown`, and
`working` remain transient. This observed
attention participates in the default board selection, so an older result-missing run is selected
before a newer healthy run. A nonempty `runs --needs-attention` and an attentive board exit `2`.

`run --dry-run` performs the same read-only `herdr --version` requirement as a real start and
rejects versions older than the enforced minimum without creating state, worktrees, workspaces,
tabs, or panes.
`status --wait` and `events --follow` install their filesystem watch before each authoritative scan,
then rescan, so a terminal state or event cannot be lost between a scan and watch registration.

## Shell completion

Fish, Zsh, and Bash completion routing is generated from the command-shape table used by the CLI.
Every run-taking form is covered, including `clean`, `node-done`, `node-exit`, and `ui restore`;
run candidates and node candidates occupy disjoint positions.

## Durable outcomes

Status and board JSON keep outcome and dependency release separate: a successful node has
`status: "completed"`, while `downstreamHeld`, `holdTargets`, and the top-level durable `holds`
collection describe its release barrier. `result --json` reports the same axes with the output.
Scheduler-derived conditions add `status: "skipped"` and `skip` reason metadata with no attempt or
result path; human result output prints `[skipped]`. Preview JSON includes each node's full `when`,
and text preview prints its source, pointer, and expected value. Both approval views expose each
node's workspace mode/path, declared writes and exclusive resources, and environment key names
without revealing environment values. Agent rows also show their execution
and escalation settings. Workroom previews show the floor plan
and explain the active-to-settled pane lifecycle. A condition-contract pause is reported in status
as actionable revision-or-stop work; unchanged resume is rejected.
Callback command previews preserve the ordered argv so distinct executables, actions, and routing
flags remain distinguishable. Environment-assignment values, credential-named option values, and
credentials inside HTTP(S) argv are replaced with `[redacted]`. Curl-style `-H`/`--header`,
`-u`/`--user`, and `--url` payloads are interpreted in adjacent and equals forms so credential
values are redacted while nonsecret header and URL routing remains visible. Webhook previews expose a
credential-free endpoint plus ordered query `{name,value}` entries; credential-named query values
are redacted, userinfo and fragments are omitted, and only header names are shown.
The board renders a completion check and a separate `downstream held` indicator. A Herdr agent
reported as done while durable status is still running is shown as actionable `result missing`
unless valid authenticated completion evidence is already pending reconcile. Human status and
noninteractive board text never expose active completion tokens or synthesize `node-done` recovery
commands; they preserve owner-directed inspection and restore/resume guidance.
Human `status` text and the noninteractive `board` snapshot mark a not-yet-started gated node with
`approval gate ahead`.

## Master wake-up and submission transport

When `run` is invoked from a Herdr agent pane, the launching master's exact provider session is
captured. An explicit `resume` from an authenticated Herdr agent pane transfers wake ownership to
that exact session; a resume from a non-agent terminal preserves the prior owner. Herdr invokes
the installed plugin bridge when a workflow agent becomes blocked or done. The trusted bridge maps
the pane to a running attempt, authenticates completion evidence before interpreting either status,
and prompts the master to reconcile a valid submission or debug a missing one. A transient `done`
recheck applies only when completion evidence is absent. The provider-sandboxed `node-done` command
never calls Herdr. Wake-up affects latency
only. Explicit human pause and stop do not request another prompt. Direct origin prompts, workflow
callbacks, and UI notifications are separate best-effort presentation routes and may be lost or
duplicated after a crash.

The owning workflow agent must write its declared nonempty result before `node-done`; provider-native
delegation is disabled and delegated workers are not completion owners. `node-done` preflights that
token-local result through the launcher-provided `ORCHESTRATE_COMPLETION_CONTRACT`; invocations
outside the owning provider pane fail closed. It performs one bounded read, then writes only a strict, versioned token-addressed
submission containing that exact raw result's SHA-256 and byte length. It does not schedule.
Reconciliation independently re-reads the result, authenticates the active token, verifies the
exact bytes before parsing, and never treats pane idle/done state or free text as completion. Submissions
made while no master is active are consumed by the next `reconcile`. Concurrent reconciles are
serialized by the run lock. Malformed envelopes do not block unrelated trusted transitions or
spawns: reconciliation advances them to a fixed point before returning the aggregate nonzero
replace-or-remove remedy. An invocation with no ready work returns cleanly.
