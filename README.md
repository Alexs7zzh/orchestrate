# Orchestrate

An [Agent Skill](https://agentskills.io) that lets a coding agent design, preview, and run
**validated, declaratively-specified DAG workflows** across Codex CLI, Claude Code, and plain
commands — with every run gated behind digest-bound user approval.

Instead of one agent improvising a long task, the agent authors a workflow JSON: implementation
nodes, independent cold-review nodes with fresh contexts, command nodes for deterministic
verification, session handoffs back to the original implementer, and optionally an adaptive
**supervisor** that keeps scheduling bounded rounds of work ("review and fix until no new issues")
inside an explicitly approved envelope.

## Install

Requires Node.js >= 22 on macOS (developed and tested there; Linux is untested, Windows is
unsupported), plus [Codex CLI](https://github.com/openai/codex) and/or
[Claude Code](https://claude.com/claude-code) for the corresponding agent nodes.
[Bun](https://bun.sh) is only needed for development.

Install with [`npx skills`](https://github.com/vercel-labs/skills), which works for Claude Code,
Codex, Cursor, and 60+ other agents:

```bash
npx skills add https://github.com/Alexs7zzh/skills -g
```

From a local checkout, use `npx skills add . -g` at the repository root instead.

Then put the bundled CLI on your `PATH` and check the toolchain:

```bash
node ~/.agents/skills/orchestrate/scripts/orchestrate.mjs setup   # symlinks ~/.local/bin/orchestrate
orchestrate doctor
```

`setup` also merges the session wake Stop hook into Codex's global `hooks.json`; restart Codex and
approve it when prompted. Claude Code loads the corresponding hook from this folder's validated
single-skill plugin manifest. Pass `setup --no-hooks` for a Claude-only or headless install.

`skills` links each agent's skill directory to a canonical copy under `~/.agents/skills/`
(project-scoped installs use `./.agents/skills/`); if yours lives elsewhere, run `setup` from that
path instead. Update later with `npx skills update`.

To install manually, copy this folder into your agent's skills directory (for example
`~/.claude/skills/orchestrate`) and run the same `setup` from there.

## The safety model

- **Nothing runs without informed consent.** `orchestrate preview` renders the full plan — every
  node's provider, model, permissions, environment, session lineage, and declared write set — and
  prints a SHA-256 digest of the canonicalized file. `orchestrate run` requires that exact digest;
  any change to field values or structure invalidates it. The worker re-verifies the digest before
  scheduling.
- **No defaults.** Every field of the workflow is an explicit decision: timeouts, retry budgets,
  sandbox levels, inherited environment variables, write declarations. `null` always means
  "deliberately unbounded", never "unspecified".
- **Human checkpoints inside a run.** A node with `gate: "approval"` pauses the run before it
  starts and presents its fully rendered prompt (fixed frame plus generated inputs); it only runs
  after a digest-bound `resume --approve-gate`, and the worker re-verifies that exact content.
- **Live co-driven nodes.** An agent node with `interactive: true` runs as the provider's real
  interactive TUI in a [herdr](https://herdr.dev) pane: the human can watch and participate at any
  time, and the node completes only when the session follows its prompt contract — writing a
  handoff report and calling `orchestrate node-done` with a one-time token. Structured output is
  rejected for these nodes, and supervisors can never add them.
- **Bounded autonomy.** Supervisors can only add nodes inside a pre-approved envelope (providers,
  models, sandboxes, session aliases, write roots, command argv prefixes). Anything outside it
  pauses the run for explicit approval. Wall-time, agent-start, and goal-round limits pause
  scheduling; a 10,000-start emergency fuse backstops runaway loops.
- **Isolation-aware scheduling.** Declared write sets, exclusive resources, session-lineage
  fan-out detection, and Git worktree support keep parallel nodes from trampling each other.
- **Pause is resumable; stop is terminal.** `pause` closes scheduling at a node boundary and lets
  active nodes finish before settling into the existing resumable state. `stop` interrupts active
  work immediately, wins over a draining pause, and permanently settles the run as stopped. A
  paused run's remaining plan can also be revised by hand (`orchestrate revise`): executed nodes
  are immutable, and the revision applies only through its own digest-bound
  `resume --approve-revision`.

## Quickstart

The intended user is an agent following [SKILL.md](SKILL.md), but the CLI is usable directly:

```bash
orchestrate validate workflow.json     # validates and prints a digest only on success
orchestrate preview  workflow.json     # human-readable plan + approval digest
orchestrate run      workflow.json --approve <sha256>
orchestrate prefs    --project /absolute/project/path  # merged design defaults

orchestrate watch  <run-id>            # follow events; exits when finished or paused
orchestrate wait   <run-id> --json     # quiet blocking settled-state boundary
orchestrate status <run-id>            # exit code 2 = paused (needs attention)
orchestrate report <run-id> [--json]   # rendered digest: progress, results, what needs a decision
orchestrate result <run-id> <node-id>  # print a node's result text
orchestrate events <run-id> --json     # full event log
orchestrate pause  <run-id>            # finish active nodes, pause before scheduling more
orchestrate resume <run-id> [--approve-patch <sha256>] [--approve-revision <sha256>] [--respond <text> --input-digest <sha256>] [--approve-gate <node-id> --gate-digest <sha256>]
orchestrate revise <run-id> <file>     # propose a hand-edited remaining plan for a paused run
orchestrate stop   <run-id>            # cancel active nodes and settle terminal stopped
orchestrate clean  <run-id>
```

Interactive Codex and Claude sessions automatically own runs they launch. Their Stop hook waits
for a pause or terminal state and creates one continuation, including when the run completed
before the hook began. Background shell completion is not used as a wake guarantee. Headless
callers should run `orchestrate wait` and explicitly resume their provider session.

The workflow format is documented in [references/workflow-format.md](references/workflow-format.md)
with a complete example in [references/examples.md](references/examples.md);
[references/workflow.schema.json](references/workflow.schema.json) is the machine-readable
contract. Run state lives under `~/.local/state/orchestrate/` (or
`${XDG_STATE_HOME}/orchestrate`; override either with `ORCHESTRATE_STATE_DIR`), never in the skill
folder. Approved workflows also maintain a bounded,
schema-validated `preferences.json` there so future designs can reuse project/global defaults;
set `ORCHESTRATE_DISABLE_PREFS=1` to opt out.

## herdr integration

If you use [herdr](https://herdr.dev), pass `--mirror` to `run` or `resume` to mirror a run into
read-only herdr panes: one workspace per run, a `status` tab following `orchestrate watch`, and a
tab per node attempt tailing its live output. Mirroring is presentation only — it is opt-in, never
part of the approved workflow or its digest, every herdr call is best-effort with a short timeout,
and a dead or absent herdr can never change a run's outcome. `ORCHESTRATE_MIRROR=herdr` turns it
on for every run; `ORCHESTRATE_DISABLE_MIRROR=1` hard-disables it and wins.

A minimal herdr plugin lives in [herdr-plugin/](herdr-plugin/): a read-only "Orchestrate runs"
pane plus pause/resume-latest actions. Install it with
`herdr plugin link <skill-dir>/herdr-plugin` (see [herdr-plugin/README.md](herdr-plugin/README.md)).

## Development

```bash
cd scripts
bun install
bun run verify   # rebuild + typecheck + source tests + packaged public-contract tests
bun run test:contract  # rebuild + packaged public-contract tests only
bun run build    # regenerate published schemas + rebuild the bundled CLI
```

The committed `scripts/orchestrate.mjs` is a self-contained, minified bundle, so installed users
do not need Bun or `node_modules`. The TypeScript source and generated schemas remain in the skill
for inspection and reproducible development. CI rebuilds every committed artifact and fails if the
bundle or schemas drift from the source. Builds also produce an ignored external source map for
local debugging; it is not shipped because the readable source is already included. Tests run
against an internal schema variant that adds a `mock` provider behind
`ORCHESTRATE_ENABLE_MOCK_PROVIDER=1`; a separate raw-JSON contract suite runs the rebuilt bundle
under Node without that flag so the published contract and installed CLI are exercised directly.

Workflow `version: 1` is the public contract. After publication, adding or changing required
fields requires a new workflow version plus an explicit stored-run migration/compatibility path —
a runtime upgrade must not silently strand paused or recoverable runs (stored runs are stamped
with a contract version and pause, rather than fail, on mismatch).

## License

[MIT](LICENSE)
