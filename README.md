# Orchestrate

Orchestrate turns a multi-agent task into an explicit, reviewable workflow: you describe a DAG of
agent and command nodes in one JSON file, approve its exact digest, and run it as real
[herdr](https://herdr.dev) panes you can watch, pause, and steer.

Execution is interactive and
master-driven: `run` starts the initial ready work, node agents submit authenticated results, and
the launching master uses `orchestrate reconcile` to commit those results and start newly ready
nodes. Herdr's trusted plugin event hook prompts that master when a workflow agent becomes blocked
or done; the sandboxed `node-done` path only writes its authenticated submission. Wake-ups reduce
latency, but reconciliation is safe at any time and does not depend on a wake being delivered. There
is no per-run background controller.

## Install

```bash
brew tap alexs7zzh/tap
brew install orchestrate
orchestrate setup
```

`setup` atomically stages the CLI, skill, and herdr plugin under
`~/.local/share/orchestrate/current`, links the CLI into `~/.local/bin`, and offers a UI preference
wizard. Use `setup --dry-run`, `setup --defaults`, `setup --no-wizard`, or `setup --remove` as
needed. Herdr plugin registration is required: if the plugin link fails, setup removes the new
stage and leaves the prior installation selected; if unlink fails, removal fails rather than
reporting success. `doctor` reports a missing registration as
unhealthy. If Herdr cannot confirm either link or rollback, the versioned stage is retained as the
plugin's recoverable target while the stable CLI/skill selection stays unchanged. Run
`orchestrate doctor` after changing herdr or provider installations.

Release builds are macOS ARM64 and are distributed through Homebrew; Linux is not a supported or
distributed platform, and no npm package is used. Update with `brew upgrade orchestrate`; the next
interactive command migrates the staged installation to the new build automatically. Migration
waits while any run is unsettled and never runs from node completion or plugin event handling,
shell completion, `doctor`, or non-interactive invocations — the unqualified `orchestrate setup`
remains the explicit path. The newest installation wins in both directions: an older binary never
overwrites a newer locally staged build (a Homebrew keg's install receipt is its installation
clock), and when the staged CLI runs first on `PATH` it adopts a newer formula found later on
`PATH` by delegating to that formula's own setup. The
staged wrapper delegates setup to the distinct formula executable later on `PATH`, preventing the
prior staged build from replacing a newer formula build. Before uninstalling the formula, run
`orchestrate setup --remove` to unlink the skill and plugin.

## Requirements

- macOS on Apple silicon
- herdr 0.7.5 or newer
- Codex and/or Claude for the providers used by a workflow
- Git only when a node requests an isolated Git worktree

## Run a workflow

```bash
orchestrate validate workflow.json
orchestrate preview workflow.json
orchestrate run workflow.json --approve <digest>
orchestrate board <run-id>
```

A complete workflow file is shown in [references/examples.md](references/examples.md); the machine
contract is [references/workflow.schema.json](references/workflow.schema.json).

Preview prints the exact digest required by `run`. Preflight verifies the workflow, provider
commands, herdr, paths, output schemas, worktree prerequisites, and declared write conflicts before
state or panes are created. `--dry-run` performs the same read-only `herdr --version` preflight as
a real start, but creates no state, worktrees, workspaces, tabs, or panes.

Every agent prompt has a stable frame: objective, node contract, declared inputs, result path, and
the exact `node-done` command. Dynamic inputs are resolved only when dependencies finish. A task
whose later work cannot be known up front should use a planning node that emits structured output,
then a digest-bound approval gate before execution—not runtime-generated nodes.

Agent permissions separate the execution boundary from escalation behavior. For example, a cold
Codex review should use `execution.sandbox: "read-only"` with `escalation: "deny"`: allowed reads
and commands run without approval dialogs, while anything outside the sandbox fails closed.
`ask-user` is reserved for intentionally attended nodes; `auto-review` routes eligible Codex
escalations through its reviewer instead of the human.

Every agent also receives an implicit completion channel to its exact token-addressed attempt
directory outside authoritative state; that is the only runtime path it can write. `node-done`
writes an authenticated envelope there, and the next explicit `reconcile` validates the active
token and result, commits transitions, and starts newly ready work. `node-done --hold` submits a
successful outcome with a separate downstream hold that release removes without rewriting the
outcome. The full sandbox rules — Claude workflow nodes require `dontAsk` plus `deny`, and
validation rejects any mutating node whose sandbox root or write prefix overlaps Orchestrate state
or installed control assets — are specified in
[workflow-format.md](references/workflow-format.md) and
[runtime-operations.md](references/runtime-operations.md).

## Operate a run

```bash
orchestrate status <run-id> --wait
orchestrate events <run-id> --follow
orchestrate result <run-id> <node-id>
orchestrate reconcile <run-id>
orchestrate pause <run-id>
orchestrate resume <run-id>
orchestrate hold <run-id> <node-id>
orchestrate release <run-id> <node-id>
orchestrate stop <run-id>
orchestrate clean <run-id> --dry-run
```

The interactive board, `board --json`, `runs --needs-attention`, and the Herdr panel sample live pane
state for durably running nodes. `blocked`, `done`, and gone panes need attention; `done` is shown as
`result missing`, while `idle`, `unknown`, and `working` remain transient. Observed attention affects
default selection, so an older result-missing run wins over a newer healthy run and exits with code 2. JSON mode writes one stable value to stdout on success or error; `events --follow --json` is the
documented newline-delimited streaming exception.

Crash semantics, pane receipts, run locking, and the at-least-once boundary for external Herdr
actions are specified in [runtime-operations.md](references/runtime-operations.md); the normative
limits are in [guarantees.md](references/guarantees.md). In short: the `events.json` journal is
authoritative and replayable, a kernel-held per-run lock serializes every mutation, `node-done`
only writes its token-addressed envelope, dormant submissions wait for the next explicit
`orchestrate reconcile`, and master wake-ups, callbacks, and notifications are best effort.

Repeats are declared, bounded subgraphs. Their completion condition is either an allowed command
exit or a schema-validated JSON value. Reaching the round limit pauses for an explicit extension or
acceptance. `limits.maxStarts` is a separate execution fuse; starts already planned within its
budget are reconciled before a later candidate pauses the run. Repeat Git worktrees must include
`{{nodeId}}` in the branch template and in every explicit path; both are expanded with the runtime
round ID. Default targets live in a run-unique temporary worktree root outside authoritative state.
Any pre-existing target must be the canonical worktree root for the expected repository and exact
expanded branch or launch fails before pane creation.

Nodes may declare a scheduler-owned `when` over a direct schema-validated JSON dependency. A false
condition records a first-class zero-attempt `skipped` state; a missing pointer pauses as a contract
error instead of silently choosing a branch, and resume requires an approved condition change. In
repeats, conditions bind to the same-round source and are reevaluated each round. Persistent repeat
sessions use copy-on-write provider forks: only a successful result advances the alias, so a failed
retry cannot contaminate the next attempt or round.

Compilation embeds the build identity used by run state. Ambient environment variables cannot
change `--version`, and a different binary refuses that state.

Concurrency limits simultaneous active node attempts, not retained completed panes. Treat it as a
human-attention budget; the default recommendation is 3. Write sets and exclusive resources prevent
unsafe parallel starts.

## UI and notifications

The OpenTUI board shows dependencies, pane state, elapsed time, repeat rounds, stalled work, and
items needing attention. Its bounded clock refresh advances elapsed time and resamples herdr even
when no workflow file changes. For a durably running agent, herdr `done` means the provider finished
without submitting `node-done`; the board reports it once in `NEEDS YOU` with the authenticated
recovery command. `idle` and `unknown` startup samples remain transient. Blocked agents and
explicitly vanished panes are also actionable. Mouse and keyboard controls focus panes, open
results, pause/resume, hold/release nodes, and stop the run. Gate approvals and vanished-pane
recovery remain explicit commands shown by the board.

Preferences contain UI state only and layer built-in defaults, global choices, then project choices.
Schema-invalid or unknown fields fail. Inspect origins or edit them with:

```bash
orchestrate ui show --origin
orchestrate ui set focus '"attention"'
orchestrate ui set placement.workspace '"origin"' --project "$PWD"
orchestrate ui wizard --project "$PWD"
```

`placement.workspace` is `"dedicated"` by default or `"origin"` to create node tabs in the
launching workspace. It is independent of ordered `placement.rules[].surface` tab/split choices.
If the recorded origin pane is no longer live, origin placement safely falls back to the dedicated
run workspace. A recorded split anchor is verified immediately before use: explicit absence creates
a fresh tab in the selected workspace. If the pane closes between that check and split, one
`pane_not_found` falls back exactly once to a fresh tab without consuming the attempt; transport
errors preserve the planned intent as observation failures.

Agent and command nodes always execute through herdr. `ORCHESTRATE_DISABLE_UI=1` suppresses board
auto-open and presentation notifications, but never changes execution. A named herdr remote must
have access to the same checkout and state paths; otherwise use the local herdr session.

## Documentation

- [guarantees.md](references/guarantees.md) — the normative reliability and ownership contract; it
  wins over any stronger mechanism described elsewhere.
- [workflow-format.md](references/workflow-format.md) — the workflow file: node kinds, workspaces,
  permissions, sessions, and repeats.
- [runtime-operations.md](references/runtime-operations.md) — state, scheduling, crash semantics,
  and presentation mechanics.
- [cli-spec.md](references/cli-spec.md) — the command table and the JSON and exit-code contract.
- [examples.md](references/examples.md) — a complete workflow file and UI preference examples.

The machine contracts are [workflow.schema.json](references/workflow.schema.json),
[preferences.schema.json](references/preferences.schema.json),
[state.schema.json](references/state.schema.json), and
[event.schema.json](references/event.schema.json).

## Development

```bash
cd scripts
bun install --frozen-lockfile
bun run verify
bun run build:compile
./dist/orchestrate setup
```

`./dist/orchestrate setup` installs the local build through the same staged layout as the formula
install.

The checked Herdr response decoders are generated from the checked-in socket schema snapshot. After
raising or changing the supported Herdr API contract, run `bun run schema:herdr` with that Herdr
version installed; this refreshes the narrowed snapshot from `herdr api schema --json` and
regenerates `src/herdr-api.generated.ts`.

Normal pushes to `main` run CI but do not build or publish a release. Start a release by pushing an
annotated or signed strict-SemVer tag that points to a commit on `main`:

```bash
git tag -a v0.2.0 -m "Orchestrate 0.2.0"
git push origin v0.2.0
```

The tag workflow derives one version from `v<semver>`, verifies the exact tagged source,
builds the macOS ARM64 payload, and creates a draft GitHub Release with the archive, checksum,
Homebrew bottle, and rendered formula attached. The formula's bottle stanza points at the release
assets, so `brew install` pours the bottle instead of requiring build tools on user machines. Review those assets and generated notes in GitHub, then publish
the draft manually. Release binaries and the generated `scripts/orchestrate.mjs` bundle are not
committed to this repository; CI generates both from source. The formula can optionally be copied to
`Formula/orchestrate.rb` in a separate Homebrew tap by automation running after the release is
published.

Release derivation, compilation, and assembly share one strict SemVer 2.0 validator. Leading-zero
core/numeric prerelease identifiers and empty prerelease identifiers are rejected. Release build
metadata is deliberately unsupported because the compiled identity appends its own build hash. The
release build runs on native ARM64 `macos-15` and asserts `uname -m=arm64`. The release contract
rejects binary, plugin, or formula version disagreement, pins the exact payload (binary, root
license, complete third-party notices, skill, agent metadata, plugin, and all nine reference files),
rejects unexpected extras, independently recomputes the archive checksum sidecar, and exercises the
unpacked formula-shaped install tree without changing Homebrew or the host installation.
