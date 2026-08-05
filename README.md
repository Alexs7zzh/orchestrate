# Orchestrate

Orchestrate turns multi-agent work into an explicit, reviewable workflow. Agents normally author
and drive the graph; humans approve its exact digest, watch real [Herdr](https://herdr.dev) panes,
and make the decisions that should remain human.

Use it for role-to-role feedback loops, bounded review/fix rounds, conditional cross-provider
handoffs, and branching work whose dependencies or mutation boundaries deserve explicit review.
The CLI can run simpler DAGs too, but a linear chain or one fan-out/fan-in stage rarely justifies
agent-orchestrated setup.

## Install

Requires macOS ARM64 (Apple silicon), Herdr 0.7.5 or newer, and Codex and/or Claude for the providers
a workflow uses. Git is needed only when a workflow selects `git-worktree` isolation.

```bash
brew tap alexs7zzh/tap
brew install orchestrate
orchestrate setup
orchestrate doctor
```

`setup` installs the matching CLI, agent skill, and required Herdr plugin, then offers a UI
preference wizard. `doctor` must report healthy after installation or an upgrade. Use
`setup --dry-run`, `setup --defaults`, `setup --no-wizard`, or `setup --remove` when needed.
Staging, migration, rollback, and uninstall behavior is documented under
[Installation and upgrades](references/runtime-operations.md#installation-and-upgrades).

### Upgrade and uninstall

After `brew upgrade orchestrate`, run `orchestrate setup` if automatic migration has not activated
the new build; migration waits while any run is unsettled. Before `brew uninstall orchestrate`, run
`orchestrate setup --remove` so the matching build can unlink its skill and Herdr plugin.

Release builds target macOS ARM64 and are distributed through Homebrew. Linux and npm distribution
are not supported.

## Terms

- **Launching master** — the agent session that invokes `run`, receives trusted Herdr wake-ups, and
  calls `reconcile`.
- **Workflow provider session** — a node conversation lineage named by `session.saveAs` and
  continued through `session.from`; it is distinct from the launching master.
- **Workroom tab and seat** — workflow-approved presentation identities for stable pane placement.
  A node with a seat is seatful; supporting work without one is seatless.
- **UI placement preference** — layered global/project UI state such as `placement.workspace`; it is
  not a workflow-node field.

## Run a workflow

An agent usually designs the workflow from the validated examples and semantic authoring rules,
then presents a prose walkthrough with the exact preview digest. The human approves that digest;
approval is never inferred from an interactive tool or hidden terminal output.

```bash
orchestrate validate workflow.json
orchestrate preview workflow.json
orchestrate run workflow.json --approve <digest>
orchestrate board <run-id>
```

Start with the qualifying
[persistent paired-review example](references/examples.md#persistent-paired-review-with-a-conditional-response),
or use the [simple fan-out example](references/examples.md#simple-fan-out-and-fan-in-cli-illustration)
when learning the lower-level CLI. The authoring contract is
[workflow-format.md](references/workflow-format.md); consult the generated
[workflow.schema.json](references/workflow.schema.json) only for exact structural detail.

Preview is read-only and prints the digest required by `run`. Preflight validates schema and
cross-field semantics, provider commands, Herdr, paths, output schemas, worktree prerequisites, and
declared write conflicts before state or panes are created. `run --dry-run` performs the same
read-only preflight without creating state, worktrees, workspaces, tabs, or panes.

Every agent receives a stable prompt frame with the objective, node contract, declared inputs,
result path, and exact authenticated completion command. Dynamic inputs resolve only after their
dependencies finish. Work that cannot be enumerated in advance should use a planner with a
schema-validated result and a digest-bound approval gate before execution, not runtime-generated
nodes.

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

Orchestrate is interactive and master-driven. `run` starts the initial ready work, node agents write
authenticated submissions, and the launching master runs `reconcile` to commit them and start newly
ready nodes. Herdr's trusted plugin prompts that master when a workflow agent becomes blocked or
done. Wake-ups reduce latency, but correctness never depends on delivery: a dormant submission waits
durably for the next explicit reconcile. There is no per-run background controller.

The board, `board --json`, and `runs --needs-attention` combine durable run state with live Herdr
observations. A provider that is blocked, done without a result, or missing its pane needs attention;
startup `idle` and `unknown` states remain transient. `status --wait` and `events --follow` observe
changes but do not schedule work.

Repeats are bounded subgraphs with an objective command or schema-validated JSON condition. Reaching
their bound pauses for an explicit extension or acceptance. A node `when` can select an approved
branch from a direct JSON dependency: false records scheduler-owned `skipped`, while a missing pointer
pauses as malformed control data. Persistent repeat sessions advance only after schema-valid success.
See [Runtime operations](references/runtime-operations.md) for the detailed lifecycle and recovery
model.

## Workrooms and UI

UI preferences layer built-in defaults, global choices, then project choices. Inspect or change them
with:

```bash
orchestrate ui show --origin
orchestrate ui set focus '"attention"'
orchestrate ui set placement.workspace '"origin"' --project "$PWD"
orchestrate ui wizard --project "$PWD"
```

The UI `placement.workspace` preference chooses the dedicated run workspace or the launching
workspace independently from ordinary tab/split matching. It is not a workflow-node field. If the
recorded origin is unavailable, placement falls back to the dedicated run workspace.

Optional workflow workrooms express presentation intent with scheduler-enforced occupancy
invariants. A workroom has one ordered set of seats in a stable workroom tab. Seatful nodes use their
declared seat instead of ordinary matcher placement; seatless supporting nodes and all command nodes
remain ordinary Herdr panes. Nodes sharing a seat must be dependency-ordered, and settlement anchors
must be non-repeat nodes downstream of every other node assigned to the workroom.

While a workroom is active, a successful seat pane remains parked for later turns even when ordinary
agent panes use `close-success`. After every settlement anchor is durably completed or
scheduler-skipped, `keep-open` leaves those panes open and relabels them settled; `close-success`
closes them. Missing-seat recovery preserves logical seat identity when live occupancy is
unambiguous and requests attention instead of guessing when it is not. Herdr owns physical split
geometry, so reconstruction is best effort.

Agent and command nodes always execute through Herdr. `ORCHESTRATE_DISABLE_UI=1` suppresses board
auto-open and presentation notifications, not execution. A named Herdr remote must have access to
the same checkout, state, provider, and CLI paths.

## Documentation

| Need                                | Canonical source                                          | Authority                             |
| ----------------------------------- | --------------------------------------------------------- | ------------------------------------- |
| Learn or adapt a pattern            | [examples.md](references/examples.md)                     | Illustrative, validated examples      |
| Author fields and cross-field rules | [workflow-format.md](references/workflow-format.md)       | Normative semantic authoring contract |
| Look up exact workflow structure    | [workflow.schema.json](references/workflow.schema.json)   | Generated structural machine contract |
| Check reliability or ownership      | [guarantees.md](references/guarantees.md)                 | Normative product guarantees          |
| Operate, debug, or recover          | [runtime-operations.md](references/runtime-operations.md) | Explanatory implementation mechanics  |
| Check commands, JSON, or exit codes | [cli-spec.md](references/cli-spec.md)                     | Normative public CLI contract         |

The other generated machine contracts are
[preferences.schema.json](references/preferences.schema.json),
[state.schema.json](references/state.schema.json), and
[event.schema.json](references/event.schema.json).

## Development

Read [AGENTS.md](AGENTS.md) before changing the repository. It owns provider-neutral contributor
rules, documentation authority, generated-file policy, and synchronization requirements.

```bash
cd scripts
bun install --frozen-lockfile
bun run verify
bun run build:compile
./dist/orchestrate setup
```

The checked Herdr response decoders are generated from the checked-in socket schema snapshot. After
raising the supported Herdr API contract, run `bun run schema:herdr` with that Herdr version
installed.

Normal pushes to `main` run CI but do not publish. A release starts from an annotated or signed
strict-SemVer tag on `main`:

```bash
git tag -a v0.2.0 -m "Orchestrate 0.2.0"
git push origin v0.2.0
```

The tag workflow verifies the source, builds the macOS ARM64 payload, and creates a draft GitHub
Release with the archive, checksum, Homebrew bottle, formula, and generated notes. Review and publish
the draft manually. Generated bundles and release archives are not committed.
