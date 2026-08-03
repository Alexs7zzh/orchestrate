# CLI contract

Every command prints human text by default and exactly one JSON value on stdout with `--json`.
Parse, dispatch, missing-file, and noninteractive errors use
`{"ok":false,"error":{"code":"<stable-code>","message":"..."}}` on stdout and exit `1` with
no human stderr. Codes distinguish `usage`, `validation`, `not_found`, `conflict`, `herdr`, and
`io`; unclassified failures use `command_failed`. `events --json` returns one `{"events":[...]}` value; the explicit streaming
exception `events --follow --json` emits one event JSON value per line. Exit codes are `0` for
success, `1` for error, and `2` when the observed run needs human attention. Run IDs accept a unique
prefix, except `node-done`, whose sandbox-safe transport path requires the exact full run ID embedded
in the node prompt. Every command accepts `--help` without performing work; with `--json`, help is a
JSON value.

Flags have fixed arity. Value flags require one value; boolean flags accept presence only, so forms
such as `--remove=false`, `--yes=false`, and `--dry-run=false` are errors. `--json` is always
noninteractive: it never opens a selector, confirmation, editor, or wizard. `board --json` selects
the normal default run even on a TTY, `stop --json` does not prompt, and `ui wizard --json` fails
with an explicit noninteractive error.

| Command      | Shape                                                                                   | Purpose                                                                                               |
| ------------ | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `validate`   | `validate <workflow.json> [--json]`                                                     | Validate schema and semantics.                                                                        |
| `preview`    | `preview <workflow.json> [--json]`                                                      | Print the approval plan and digest.                                                                   |
| `run`        | `run <workflow.json> --approve <sha256> [--allow-write-conflicts] [--dry-run] [--json]` | Preflight, capture origin, create durable state, start ready panes, and return.                            |
| `status`     | `status [<run>] [--wait] [--json]`                                                      | Show state; wait until attention or settlement.                                                       |
| `events`     | `events [<run>] [--follow] [--json]`                                                    | Read or follow the journal.                                                                           |
| `board`      | `board [<run>] [--json]`                                                                | Open the TUI or print a plain snapshot.                                                               |
| `reconcile`  | `reconcile <run> [--json]`                                                              | Consume submissions, commit transitions, and start newly ready panes.                                 |
| `result`     | `result <run> <node> [--attempt <n>] [--json]`                                          | Read durable output.                                                                                  |
| `runs`       | `runs [--active\|--paused\|--needs-attention\|--settled] [--json]`                      | List runs with at most one filter.                                                                    |
| `approve`    | `approve <run> --gate <node> --digest <sha256> [--json]`                                | Approve exact rendered gate content.                                                                  |
| `approve`    | `approve <run> --revision <sha256> [--json]`                                            | Apply an exact proposed revision.                                                                     |
| `pause`      | `pause <run> [--json]`                                                                  | Prevent new pane starts.                                                                              |
| `resume`     | `resume <run> [--override-fuse] [--continue-rounds <n>\|--accept-repeat <repeat>] [--json]` | Resume with any required explicit exception.                                                       |
| `stop`       | `stop <run> [--yes] [--json]`                                                           | Close live panes and settle.                                                                          |
| `hold`       | `hold <run> <node> [--json]`                                                            | Hold downstream dependency release without changing node outcome.                                     |
| `release`    | `release <run> <node> [--json]`                                                         | Remove only the downstream barrier and crank ready work.                                              |
| `revise`     | `revise <run> <workflow.json> [--json]`                                                 | Propose a digest-bound remaining-plan replacement.                                                    |
| `revise`     | `revise <run> --discard [--json]`                                                       | Discard the pending revision.                                                                         |
| `node-done`  | `node-done <run> <node> --token <token> --outcome <completed\|failed> [--hold] [--json]` | Submit an authenticated envelope; `--hold` atomically commits `completed` and a separate downstream hold. |
| `node-exit`  | `node-exit <run> <node> --token <token> --code <integer> [--json]`                      | Command-pane completion trampoline.                                                                   |
| `herdr-event` | `herdr-event [--json]`                                                                   | Trusted Herdr plugin bridge for agent blocked/done and pane closed/exited events.                                             |
| `ui show`    | `ui show [--origin] [--project <cwd>] [--json]`                                         | Show merged UI choices and optional origins.                                                          |
| `ui set`     | `ui set <path> <json-value> [--project <cwd>] [--json]`                                 | Set one validated UI choice.                                                                          |
| `ui edit`    | `ui edit [--project <cwd>] [--json]`                                                    | Edit one layer with `$EDITOR`.                                                                        |
| `ui wizard`  | `ui wizard [--project <cwd>] [--json]`                                                  | Choose placement, continuation, focus, and notifications.                                             |
| `ui restore` | `ui restore <run> [--json]`                                                             | Reopen the board, reconcile panes, and apply retry policy.                                            |
| `clean`      | `clean <run> [--dry-run] [--json]`                                                      | Close panes, remove opted-in worktrees, and delete run files.                                         |
| `clean`      | `clean --settled [--dry-run] [--json]`                                                  | Clean every settled run.                                                                              |
| `completion` | `completion <fish\|zsh\|bash> [--json]`                                                 | Emit shell completion.                                                                                |
| `setup`      | `setup [--dry-run] [--remove] [--defaults\|--no-wizard] [--json]`                       | Stage assets and link detected integrations.                                                          |
| `doctor`     | `doctor [--json]`                                                                       | Check herdr, providers, state access, and installed build.                                            |

Read commands without a run ID select the newest run needing attention, otherwise the newest run.
Mutating commands always require an ID. `ORCHESTRATE_STATE_DIR` or `XDG_STATE_HOME` selects state
storage. `ORCHESTRATE_DISABLE_PREFS=1` disables preferences. `ORCHESTRATE_DISABLE_UI=1` suppresses
presentation only; node execution remains herdr-backed.

`board`, `board --json`, and `runs --needs-attention` sample live Herdr pane/agent state for durably
running nodes. Explicit `blocked`, `done`, and `pane_not_found` observations are attention; `done`
is reported as `result missing`. `idle`, `unknown`, and `working` remain transient. This observed
attention participates in the default board selection, so an older result-missing run is selected
before a newer healthy run. A nonempty `runs --needs-attention` and an attentive board exit `2`.

`run --dry-run` performs the same read-only `herdr --version` requirement as a real start and rejects
versions older than 0.7.5 without creating state, worktrees, workspaces, tabs, or panes.
`status --wait` and `events --follow` install their filesystem watch before each authoritative scan,
then rescan, so a terminal state or event cannot be lost between a scan and watch registration.

Fish, Zsh, and Bash completion routing is generated from the command-shape table used by the CLI.
Every run-taking form is covered, including `clean`, `node-done`, `node-exit`, and `ui restore`;
run candidates and node candidates occupy disjoint positions.

Status and board JSON keep outcome and dependency release separate: a successful node has
`status: "completed"`, while `downstreamHeld`, `holdTargets`, and the top-level durable `holds`
collection describe its release barrier. `result --json` reports the same axes with the output.
The board renders a completion check and a separate `downstream held` indicator. A Herdr agent
reported as done while durable status is still running is shown as actionable `result missing`.
Human `status` text and the noninteractive `board` snapshot mark a not-yet-started gated node with
`approval gate ahead`.

When `run` is invoked from a Herdr agent pane, the exact provider session is captured. Herdr invokes
the installed plugin bridge when a workflow agent becomes blocked or done. The trusted bridge maps
the pane to a running attempt and prompts the master to reconcile a valid submission or debug a
missing one. The provider-sandboxed `node-done` command never calls Herdr. Wake-up affects latency
only. Explicit human pause and stop do not request another prompt. Direct origin prompts, workflow
callbacks, and UI notifications are separate best-effort presentation routes and may be lost or
duplicated after a crash.

`node-done` writes only a durable token-addressed submission. It does not schedule. Submissions
made while no master is active are consumed by the next `reconcile`. Concurrent reconciles are
serialized by the run lock, and an invocation with no ready work returns cleanly.
