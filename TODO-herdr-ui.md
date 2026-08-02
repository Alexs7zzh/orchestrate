# Herdr UI redesign — working TODO

Tracking doc for the herdr-native workflow UI overhaul. Not shipped with the skill (lives at repo
root). Delete when done. Reconciled 2026-08-02 against all eight decisions; superseded wording
from earlier drafts has been rewritten rather than annotated.

## Ground rules (locked in)

- **DO NOT PUBLISH.** No GitHub push, no Homebrew formula, no release — until the redesign is
  fully done AND Alex has used it locally for a while and explicitly says to publish. All of
  Workstream F's tap/release items are build-out only; publishing is a separate, later,
  explicitly-requested step.
- **Breaking changes only.** No legacy compatibility paths, no stored-run migration shims, no
  contract-version dance for this change. Local state under `~/.local/state/orchestrate/` may be
  hand-edited or wiped. Drop the README's "stored runs pause on contract mismatch" obligation for
  this transition; re-establish it after the new shape settles.
- **State stays plain JSON files.** (Unchanged from today; no new storage engine.)
- **Every feature part lands with tests.** Bun unit tests + the recorded-call herdr shim pattern
  (from today's `mirror.test.ts`/`interactive.test.ts`) + the packaged contract suite. In the
  all-interactive world the headless mock provider is deleted; tests crank the engine directly
  (invoke `node-done`/`node-exit` against a run) and assert herdr calls via the shim. Pure logic
  (transition function, placement resolution, severity routing, board view-model) gets direct
  unit tests; user-visible CLI surfaces get contract tests.
- **herdr is the runtime host (inverted 2026-08-02 by decision 7).** Every run requires herdr:
  all nodes execute in herdr panes. Orchestrate itself is a persistent state machine cranked by
  events (`node-done`, command exits, CLI calls) — no resident orchestrate process. The board and
  notifications remain presentation-only: their failure never changes a run's outcome.
- **agmsg is out of scope.** Fallback option only if some future CLI can't run interactively.
  `herdr agent prompt` / `pane send-text` already cover mid-session prompting (verified in herdr
  0.7.5).
- **Intended flow:** an orchestrating agent session designs the workflow → `preview` digest →
  human approves → `run` starts → **the orchestrator stops there (fire-and-forget)**. The board +
  notifications are the feedback loop; the human re-engages the orchestrator (or any terminal)
  whenever they want to pause, revise, or approve. No agent session waits on the run.

## Decisions (answered 2026-08-02)

1. **Topology: fully configurable, preferences-driven.** No hardcoded workspace model. A
   placement policy decides where the board and every node pane land (current workspace vs
   dedicated run workspace, tab vs split, per node level/kind). A dedicated CLI command edits it.
2. **UI + notification config lives in preferences only.** Workflow JSON carries no `ui` field at
   all — no digest question arises, workflows stay pure execution contracts.
3. **Board is read-only + focus + pause/resume (+ holds).** No digest-bound approvals from the
   board; it displays each pending digest with a ready-to-paste `approve` command instead.
4. **TUI stack: Effect-native / OpenTUI-style library.** Spike first (see Workstream A), Ink or
   hand-rolled as fallback if the ecosystem option doesn't hold up.
5. **Orchestrator is fire-and-forget.** The session-ownership Stop-hook wake machinery is removed
   (not made opt-in): no hook merging into Codex `hooks.json`, no Claude plugin Stop hook, no
   continuation-on-settle. Scripted callers block with `status --wait`. Gates and results reach
   the human via notifications + board; the human brings them back to any agent session manually.
6. **Distribution flips from "skill with a bundled CLI" to "CLI with bundled skill assets".**
   Own repo (done, in place) + Homebrew tap; one command installs everything (see Workstream F).
7. **All-interactive, crank-based engine.** No detached worker, no headless agent nodes, no
   timers. Every agent node is a live TUI in a herdr pane (the `interactive` field is deleted —
   it is always true); command nodes run in panes with an exit trampoline
   (`cmd; orchestrate node-exit … --code $?`). Scheduling advances only when an event cranks it:
   file-lock → read state → apply event → compute ready set → spawn panes → atomic write →
   unlock. Structured output moves to `node-done`-time schema validation of the result file
   (refuse + explain until valid) and is therefore allowed on any agent node again. Wall-time
   limits, node timeouts, retry delays, and periodic heartbeats are deleted; count-based fuses
   (max starts, max rounds) stay as crank-time checks. **Supervisors and the envelope machinery
   are deleted, replaced by declarative repeat loops** (fixed subgraph repeated until a named
   member node reports clean or a command passes, explicit max rounds — approved once, no
   runtime node synthesis). Workflow contract becomes `version: 2`.
8. **Prompting stays hybrid, not dynamic-only.** Pre-generated prompt *frames* + dynamic
   `inputs` rendered in at run time. Dynamic-only prompting is rejected: the digest/gate safety
   model binds rendered content, and cold-review nodes specifically need stable, uncontaminated
   prompts. Fully-unknowable steps use the planner→inputs(+gate) pattern.

## Build order

Phases are strictly ordered; workstreams map onto them (D is split across 1–3 by design).

- **Phase 0 — contract.** Write the v2 workflow schema + run-state/event model + CLI surface
  table before any engine code. Resolve every item in "Pre-implementation decisions" below.
  Output: `types.ts`/`schema.ts`/generated schemas + a one-page CLI spec. Nothing else starts
  until this is settled — everything downstream (engine, board, docs, tests) consumes it.
- **Phase 1 — crank engine (Workstream G + D core).** Transition function, crank shell,
  `node-done`/`node-exit`, holds, repeat loops, retries, gates; simplest placement (one tab per
  node); core CLI verbs (`run`, `status`, `events`, `approve`, `resume`, `pause`, `stop`,
  `hold`/`release`, `revise`, `result`, `runs`). All decision-7 deletions happen here.
  **Milestone: run a real two-node workflow end-to-end from a terminal, no board.**
- **Phase 2 — board (Workstream A + D display).** TUI spike first, then the board against real
  crank-produced state; swap the herdr plugin entrypoint. **Dogfooding starts here** — use
  orchestrate for real work from this point and let friction drive priorities.
- **Phase 3 — placement (Workstream B + D defaults).** Placement policy, grouping, `ui` CLI,
  run-start snapshot, `ui restore`.
- **Phase 4 — notifications (Workstream C).** Severity classes, routing, herdr delivery.
- **Phase 5 — CLI polish + docs (Workstream E).** Dry-runs, confirmations, prefix matching,
  completions, filters; rewrite README/SKILL.md/workflow-format.md; wipe local run state.
- **Phase 6 — distribution (Workstream F).** bun-compile spike, setup pipeline + wizard,
  formula + release automation. Build-out only; publishing stays gated.

## Pre-implementation decisions (resolve in Phase 0)

- [ ] **Codex session lineage under all-interactive — the one real regression.** Interactive
      codex sessions expose no reliable native session id (that's why interactive codex nodes
      ban `session.saveAs` today). With ALL codex nodes interactive, codex `resume`/`fork`
      chains stop being supportable: sessions become a Claude-only feature unless codex has
      grown a usable mechanism (re-check current codex CLI: `codex resume` picker / session
      files / `--session-id`-equivalent). Decide: (a) accept — codex nodes are always `fresh`
      and hand off through result files/`inputs` (validation enforces it), or (b) find a codex
      resume mechanism first. Schema shape depends on this.
- [ ] **Loop-round node id syntax.** `review#2` violates the id charset (lowercase/digits/
      hyphens). Decide the canonical runtime suffix (e.g. `review--r2` with `--r<N>` reserved
      and rejected in user-authored ids) so round instances are addressable by `result`,
      completions, and the board without ambiguity.
- [ ] **Gate semantics inside loops.** A gate on a loop-member node: first round only, or every
      round? (Lean: every round — a gate guards content, and each round's rendered content is
      new. Human can release via hold policy instead if that's too chatty.) Same question for
      holds: does a hold on a template node apply to every round instance? (Lean: yes.)
- [ ] **`background` surface semantics.** Post-decision-7 every node has a real pane, so
      `background` cannot mean "no pane". Redefine: a shared low-profile utility tab (never
      focused, grouped) — or drop the surface and rely on focus policy. Pick one.
- [ ] **State authority + versioning.** `state.json` is authoritative; `events.jsonl` is the
      append-only audit (property test: replay reproduces state). Stamp both with a state
      version; **a crank whose binary version mismatches the run's state version refuses**
      (matters once brew upgrades can land mid-run). No migrations — refusal + message is the
      whole story.
- [ ] **`concurrency` keeps meaning max simultaneously-open node panes** (parallel live agents
      are a human-attention budget, not just a CPU one). Confirm the default guidance in
      SKILL.md.
- [x] **Daily use survives the rewrite via the machine split (2026-08-02).** Development moved
      to `mini:~/Dev/orchestrate` (fresh git history; laptop working tree imported, mirror shim
      probe timeout widened for mini's first-exec latency). The laptop checkout at
      `~/dev/orchestrate` stays untouched as the stable install — its symlinks
      (`~/.local/bin/orchestrate`, `~/.agents/skills/orchestrate`, herdr plugin link) keep
      serving daily use. Dogfooding the rewrite (Phase 2+) means installing from mini or
      syncing a built snapshot back — decide then.

## Workstream A — workflow board pane

The centerpiece: a native-looking TUI (plain program in a herdr pane, not an agent) showing the
whole workflow tree live.

- [ ] **Spike the TUI library first**: evaluate an Effect-composing terminal UI option (OpenTUI
      `@opentui/core`, or whatever fits the Effect runtime best) with a throwaway list+detail
      prototype including mouse clicks inside a herdr pane. Decision gate: if it can't do
      alt-screen + mouse + stable resize cleanly, fall back to Ink or hand-rolled ANSI and note it
      here.
- [ ] `orchestrate board [<run-id>]`: full-screen TUI intended to run inside a herdr pane;
      degrades to a plain terminal anywhere; no arg → needs-attention/latest run, with a picker
      for the rest.
- [ ] Data source: `state.json` + `events.jsonl` only (fs-watch). herdr agent status and pane
      existence are display garnish (staleness hints), never workflow truth.
- [ ] Render the DAG as an indented tree/list in dependency order: glyph + id + title + state +
      elapsed + continuation setting (auto ▸ / hold ⏸). States: pending / ready / running /
      awaiting-approval (gate) / completed / completed-held / failed / cancelled / paused.
      Loop rounds render collapsed history + current round expanded.
- [ ] "Needs you" section pinned at top: open gates, pending revisions, maxRounds pauses,
      held-completed nodes, stalled-pane hints — digest-bound items show the digest and the
      exact ready-to-paste `orchestrate approve …` command (board never submits approvals).
- [ ] Selection: keyboard (arrows/enter) and mouse click (SGR mouse reporting; herdr passes
      mouse through). Selecting any node with a live pane (agent TUI or command pane) →
      `herdr agent focus`/`tab focus` on the recorded pane id; completed node → show
      `result.txt` inline.
- [ ] Metrics column, extensible: elapsed per attempt (from events) now. Token usage has no
      reliable source for interactive sessions — leave the column pluggable, build nothing.
- [ ] Board controls: pause / resume (plain) / stop, hold/release toggle, node focus. Nothing
      digest-bound.
- [ ] Stalled-pane hint (presentation-only): board cross-checks running nodes against herdr
      pane existence/agent status and renders "pane gone/idle — human needed", with the manual
      `node-done` line. The engine never acts on this.
- [ ] Board auto-opens at run start (placement per Workstream B policy).
- [ ] Replace `herdr-plugin/bin/orchestrate-panel` report/watch mode with the board; keep the
      pause/resume plugin actions.
- [ ] **Tests**: pure `state+events → view-model` function — unit tests for every node state,
      "Needs you" ordering, elapsed derivation, loop-round collapsing, stalled-pane hint;
      input handling (key/mouse event → action) unit-tested without a real terminal;
      focus/pause/resume/hold actions asserted via the herdr shim; one frame-snapshot test;
      one contract test (`board` exists, degrades outside herdr, picks needs-attention run).

## Workstream B — placement policy (preferences-only) + `orchestrate ui` CLI

Workflow JSON stays UI-free. All placement lives in a validated `ui` section of the existing
bounded `preferences.json` (global + per-project layers, same merge rules as design prefs), edited
through a new CLI command.

- [ ] Placement policy schema. Three kinds of entries:
      - **board**: where the board goes at run start — `split-right` in the workspace/tab the
        run was launched from (the "push a panel on the right" default) | tab in a dedicated
        run workspace | tab in current workspace.
      - **node rules**: ordered matchers → surface. Matcher dimensions: node type
        (agent/command), provider, node level (root = no `needs` vs child), origin (initial vs
        loop-round instance), id glob. Surface: `tab` (own tab) | `split` (pane inside its
        group's tab) | `background` (semantics per Phase-0 decision). First match wins; a
        mandatory final default rule keeps "no defaults" honest.
      - **grouping rule**: what owns a tab when surface is `split` — e.g. group by nearest root
        ancestor ("one section owns a tab, its subtree renders as panes inside it") or by id
        prefix. Loop rounds inherit their template node's group.
- [ ] `orchestrate ui` CLI: `ui show [--origin]`, `ui set <path> <value>`, `ui edit` ($EDITOR,
      validate on save), `ui wizard` (guided dropdowns), `--project` for the per-project layer.
- [ ] Applies uniformly to agent panes and command panes.
- [ ] Split overflow: cap live splits per tab (configurable, e.g. 4), overflow to `<group> 2`.
- [ ] Retry placement: attempt N+1 reuses the node's slot (close old pane, open new in place).
- [ ] Completed-pane policy: keep-open vs auto-close on success — configurable; default
      keep-open for agent panes (session handoff value), close for command panes.
- [ ] Focus policy: never steal focus / focus on human-attention events / focus every new pane.
- [ ] Policy snapshot at run start into the run dir (`ui.json`) so `ui restore` and later
      cranks place consistently even if preferences change mid-run.
- [ ] **Tests**: placement resolution as a pure function with table-driven cases (precedence,
      first-match-wins, node type, provider, root-vs-child, origin, glob, mandatory default);
      grouping incl. overflow caps, per-run namespacing, loop-round inheritance; schema
      validation (unknown keys, missing default rule); `ui show/set/edit/wizard` layering
      (`preferences.test.ts` style) + `--origin` output; herdr-shim tests: resolved placements
      produce the right tab/split/`--no-focus` calls, retry-in-place reuse, snapshot honored
      when prefs change mid-run.

## Workstream C — notification verbosity

- [ ] Classify every journaled event into severity classes (exhaustively — adding an event type
      without a class fails a test):
      - **attention** — gate pause, maxRounds pause, revision proposed, run.failed,
        node held-completed
      - **milestone** — node.completed / node.failed / node.retrying, run.completed, run.paused,
        run.stopped
      - **progress** — node.started, run.started, ui.degraded
- [ ] **All delivery goes through herdr — no orchestrate-owned desktop notifications.** herdr's
      `ui.toast.delivery` already escalates per user config (`herdr` in-app | `terminal` OSC |
      `system` OS service). Channels: `herdr` (`notification show`, `--sound request` for
      attention, `--sound done` for milestones) | `board` (visible only on the board) |
      `silent`. Default: attention→herdr, milestone→herdr (done sound), progress→board.
      Delete the osascript/notify-send code in `event-journal.ts`.
- [ ] Periodic heartbeats die with the timers: `heartbeat.intervalMinutes` is deleted from the
      schema. The digest-bound callback survives as milestone-driven only (rename the workflow
      field to `callback` + `milestones`); `{ "type": "notification" }` means a herdr
      notification, best-effort. `command`/`webhook` callbacks remain the escape hatch for
      delivery outside herdr (e.g. an osascript argv).
- [ ] Routing table lives in the preferences `ui` section, edited by `orchestrate ui`. Never in
      workflow JSON.
- [ ] **Tests**: severity exhaustiveness; routing resolution (class → channel, defaults,
      silent); dispatch via herdr shim incl. sound mapping; milestone callback through the same
      path; dead herdr never fails the run (best-effort assertion).

## Workstream D — continuation holds (auto-continue vs wait-for-human)

A soft, runtime-level barrier distinct from `gate: "approval"`: the gate is digest-bound workflow
content approving a node's *content before it starts*; a **hold** is an unguarded scheduling
switch deciding whether dependents *auto-trigger after it finishes*. Deliberately not workflow
data and not digest-bound (accepted trade-off).

- [ ] Default policy in the preferences `ui` section: `autoContinue: true|false` overall, plus
      the same node-matcher rules as placement (e.g. hold after every agent node, auto-continue
      after command nodes).
- [ ] `orchestrate hold <run> <node>` / `orchestrate release <run> <node>`: set/clear anytime —
      before or while the node runs. A held node that completes parks as `completed-held`; the
      transition function treats an unreleased hold like an unmet dependency.
- [ ] Mid-run adjustment by prompting: the human tells any agent "wait for my approval before
      continuing" and the agent runs the `hold` command (on PATH in its pane). One line in the
      prompt contract teaches agents that `hold`/`release` exist.
- [ ] Board display + toggle (see Workstream A) — holds are in the pause/resume family, not the
      approval family.
- [ ] Release semantics: releasing a held completed node cranks dependents ready immediately;
      releasing during a run-level pause takes effect at resume.
- [ ] **Tests**: transition-function cases (held completes → dependents pending; release →
      ready; hold set mid-run; hold on failed node irrelevant — retries unaffected); policy
      default resolution; `hold`/`release` CLI + contract tests incl. unknown ids and
      double-release; hold + gate on the dependent (release first, gate still pauses — order
      asserted); hold-template-applies-to-rounds per the Phase-0 decision.

## Workstream E — CLI surface + consolidation + docs

### CLI surface redesign (reviewed 2026-08-02)

- [ ] Collapse observation commands: `status <run> [--wait] [--json]` absorbs `report`, `wait`,
      and `watch --once` (full render by default, exit 2 = needs attention); `events <run>
      [--follow] [--json]` absorbs `watch`. Keep `result`, `runs`. Delete `report`, `wait`,
      `watch` as commands.
- [ ] Split digest-bound approvals out of `resume`: `approve <run> --gate <node> --digest <sha>`
      / `approve <run> --revision <sha>`; `resume` keeps plain unpause + `--override-fuse`.
- [ ] Uniform conventions: `--json` on every command incl. mutations (`run` → `{runId,…}`);
      global exit-code table (0 ok, 1 error, 2 needs-attention) in `--help`; color only when
      TTY && !`NO_COLOR` — never switch *structure* on TTY detection (agents run inside PTYs;
      explicit `--json` is the machine contract); no `--interval` (fs-watch).
- [ ] Env cleanup: single `ORCHESTRATE_DISABLE_UI` kill switch replaces
      `ORCHESTRATE_MIRROR`/`ORCHESTRATE_DISABLE_MIRROR`/`ORCHESTRATE_DISABLE_AUTO_WAKE`; keep
      `ORCHESTRATE_STATE_DIR`/`XDG_STATE_HOME`, `ORCHESTRATE_DISABLE_PREFS`.
- [ ] Keep `validate` vs `preview` separate (terraform `validate`/`plan` precedent).
- [ ] **`--dry-run` where irreversible or multi-step, nowhere else:**
      - `run --dry-run` — environment preflight without spawning: digest match, herdr
        reachable, provider CLIs present, cwds exist, session aliases resolvable, worktrees
        creatable, write-conflict analysis. (`preview` is the *content* dry-run.)
      - `clean <run> --dry-run` — list what would be deleted/closed/pruned; plus
        `clean --settled [--dry-run]` for bulk cleanup.
      - `setup --dry-run` (and with `--remove`) — print the per-step plan.
      - Not on `pause`/`resume`/`hold`/`release` (cheap, reversible) or `approve` (digest is the
        safeguard).
- [ ] `stop` confirms on a TTY (`--yes` skips; non-TTY proceeds silently). No other command
      confirms.
- [ ] `revise <run> <file>` prints a structural diff of remaining-plan vs revision at propose
      time, alongside the digest.
- [ ] Run-id ergonomics: unique-prefix matching everywhere; read commands (`status`, `events`,
      `board`) default to needs-attention/latest when id omitted; **mutating commands always
      require an explicit id**.
- [ ] `runs` filters: `--active`, `--paused`, `--needs-attention`, `--settled`.
- [ ] `orchestrate completion fish|zsh|bash` with dynamic run-id/node-id completion.
- [ ] Per-command `--help`; every error names the command that fixes it (rule, not accident).
- [ ] Digest friction stays deliberate: no `--approve-last`/digest-from-file shortcuts.
- [ ] **Tests**: contract tests pinning the full command/flag matrix incl. deleted commands
      erroring with a pointer to the replacement; exit-code table; `--json` stability snapshots
      incl. mutations; `NO_COLOR`/non-TTY output byte-identical to piped; `run --dry-run`
      records zero herdr-shim calls and reports each preflight failure distinctly;
      `clean --dry-run` leaves the fs byte-identical; ambiguous prefixes error with candidates;
      id-omitted mutations refuse.

### Consolidation & removals

- [ ] One "herdr surface" module (successor of `mirror.ts` + `interactive.ts` pane logic):
      pane spawning per placement policy, pane-id recording (inherent in crank spawn intents,
      all node types), board/plugin glue. Presentation calls best-effort; execution calls
      (node pane spawn) propagate failure to the crank.
- [ ] `orchestrate ui restore <run>`: after a herdr restart, reopen the board and reconcile
      panes — every in-flight attempt's pane died with herdr, so mark those attempts failed
      (tokens void), journal it, and respawn per retry policy on the next crank.
- [ ] Remove the session-ownership / Stop-hook wake system: `runtime/harness-hooks.ts`,
      `runtime/wake-registry.ts`, the Codex `hooks.json` merge in `setup`, the Claude plugin
      Stop hook in `.claude-plugin` + `hooks/`, `setup --no-hooks`, and README/SKILL.md
      "owned run" language. Scripted blocking = `status --wait`.
- [ ] SKILL.md rewrite of the post-launch protocol: after `run --approve`, report the run id +
      board location and stop. Later turns: `status`/`result` to answer, `pause`/`revise`/
      `approve`/`hold` to act — never a blocking wait.
- [ ] SKILL.md prompting guidance: stable *frames* + detail through `inputs`; planner-node +
      gate for unknowable steps; never pre-bake guesses about upstream results.
- [ ] Update: `herdr-plugin.toml` (board entrypoint), plugin README, README, SKILL.md,
      `workflow-format.md` (v2), schema regeneration, preferences schema, contract tests,
      `doctor` (herdr ≥ 0.7 required now).
- [ ] Wipe local run state after the v2 schema lands.
- [ ] **Tests**: delete `wake-runtime.test.ts` + wake/hook cases; rewrite `mirror.test.ts`
      around the surface module; `ui restore` shim test (board reopened, dead attempts failed +
      journaled, tokens voided, retries scheduled).

## Workstream F — distribution, own repo & setup wizard

The CLI is the product; skill files are assets it installs. Target UX:

```
brew install alexs7zzh/tap/orchestrate
orchestrate setup         # everything below, idempotent, re-runnable
```

- [x] **Repo restructure done 2026-08-02** — converted in place: `orchestrate/*` moved to repo
      root, README/LICENSE deduped, CI + .gitignore updated, verify green (192 tests). Folder
      renamed `~/dev/skills` → `~/dev/orchestrate`; skill/bin/herdr-plugin symlinks repointed
      (`doctor` green). Never pushed — when publishing (gated!): fresh GitHub repo
      `Alexs7zzh/orchestrate`.
- [ ] **Spike: `bun build --compile` single executable.** Removes the Node dependency; formula
      matches the `codex-auth` pattern (arch-gated binary asset, plain `bin.install`). Skill
      assets + herdr-plugin embedded (`Bun.embeddedFiles`), `setup` extracts them to staging.
      Verify: Effect + `node:child_process`/`fs` under the compiled runtime; the prompt
      contract and command trampoline must reference the binary by **absolute stable path**
      (through staging `current`, not the Cellar) so `node-done`/`node-exit` survive upgrades
      mid-run; binary size acceptable. Fallback: committed `.mjs` + `depends_on "node"`.
- [ ] **Homebrew-only install** via the existing tap (`~/dev/homebrew-tap` →
      github.com/Alexs7zzh/homebrew-tap): `Formula/orchestrate.rb` in the `codex-auth` style —
      versioned release asset + sha256, `bin.install`, `test do` hitting `--help`,
      `depends_on arch: :arm64` to start. Dev checkouts keep working via the repo scripts.
- [ ] Release automation: tag → CI builds binary → GitHub release (versioned tarball + sha256)
      → bump formula version/sha in the tap. Contract suite runs against the compiled binary
      before a release is cut.
- [ ] Version-drift detection: `doctor`, `setup`, and the board header detect staging vs CLI
      version mismatch → "run `orchestrate setup`". Cranks refuse on state-version mismatch
      (Phase-0 decision).
- [ ] Skill linking done by us (not `npx skills`): stage assets, canonical
      `~/.agents/skills/orchestrate` link, symlink into detected agents' skill dirs (Claude
      Code, Codex). `npx skills add` documented as the escape hatch for other agents.
- [ ] `orchestrate setup` pipeline (check-then-fix, clearly reported):
      1. Stage assets to `~/.local/share/orchestrate/versions/<semver>/` + atomic `current`
         symlink flip; **all external links point through `current`**; prune all versions
         except the one `current` resolves to after a successful flip (updates and downgrades
         both stage + flip + prune — stale copies can never accumulate).
      2. Detect installed agents; link skill assets for those only.
      3. `herdr plugin link` the board plugin (herdr absent → warning; note runs now REQUIRE
         herdr, so this warning is prominent).
      4. Doctor checks inline: provider CLIs, herdr ≥ 0.7 reachable, state dir writable; node
         check only for dev checkouts (compiled binary needs none). Fail soft per component.
      5. Finish with the `ui wizard` (skippable: `--defaults`, `--no-wizard`).
- [ ] Wizard implementation: board's TUI stack or `@effect/cli` Prompt — decide in the spike.
- [ ] Update path = `brew upgrade` + re-run `setup`. Uninstall = `setup --remove` (unlink all,
      delete staging, leave state dir with a note) + `brew uninstall`. Nothing stranded.
- [ ] **Tests**: fake-`$HOME` pipeline suite — fresh install; idempotent re-run; update flips
      `current` atomically + prunes; interrupted stage leaves `current` valid and re-run
      recovers; downgrade same; `--remove` leaves no orphaned symlinks (sweep + assert); agent
      detection; `--no-wizard` writes nothing / `--defaults` writes valid `ui` prefs; doctor
      fails soft; `--dry-run` variants touch nothing.

## Workstream G — crank engine rewrite (decision 7)

The engine becomes `(state, event) → (state′, actions)` — a pure transition function plus a thin
herdr-actions shell. Foundation for everything else (Phase 1).

- [ ] Crank protocol: single-writer file lock per run; read `state.json` + event → apply →
      compute ready set (deps, holds, gates, fuses, write conflicts, exclusive resources,
      concurrency cap) → record spawn intents → spawn panes via herdr → atomic state write →
      unlock.
- [ ] Idempotent crash recovery: spawn intents recorded before herdr calls; a later crank
      reconciles intents vs actual panes (respawn or adopt) so a crank dying mid-way never
      loses or double-schedules a node.
- [ ] Crank entry points: `node-done`, `node-exit`, `approve`, `resume`, `revise`,
      `hold`/`release`, `pause`, `stop` — all plain CLI invocations that crank and exit.
- [ ] Command nodes: pane + exit trampoline; keep `allowedExitCodes`, `mutates`, env
      allowlists; output tee'd to the attempt file (pane live, file durable).
- [ ] Structured output at `node-done`: validate the result file against the node's schema;
      refuse with the validation errors so the agent fixes and retries the call.
- [ ] **Declarative repeat loops** (replaces supervisors): `repeat` group — member node ids
      (subgraph template), `until` (member whose verdict ends the loop: command success or
      schema-validated agent verdict field), `maxRounds` (explicit fuse). Each round
      instantiates the subgraph with the reserved round suffix (Phase-0 decision), fresh
      sessions per template, `inputs` resolving to the previous round. Loop state in run state;
      round transitions are ordinary cranks. maxRounds without a clean verdict **pauses for a
      human decision** (continue N more / accept / stop), never silently fails.
- [ ] Delete: supervisors wholesale (node type, decision schema, envelope validation,
      `--approve-patch`, `--respond`/input requests, `supervisor-decision.schema.json` +
      generated variants, docs, tests); `process.ts` + headless provider execution; the
      `interactive` field; worker lock/PID/token + `--recover`-as-worker-recovery; done-file
      polling; heartbeat scheduler + all timer fibers; `timeoutMinutes`,
      `limits.*WallTimeMinutes`, `retry.delaySeconds`, `heartbeat.intervalMinutes` from the
      schema; the mock provider (tests crank directly).
- [ ] Reinterpret: pause = state flag at crank (live panes keep running — human-attended);
      stop = close panes + settle directly; retries = respawn at crank, `maxAttempts` kept, no
      delay.
- [ ] **Tests**: table-driven transition tests over (state, event) pairs for every rule (deps,
      gates, holds, fuses, conflicts, concurrency, loops); event-replay property test
      (journal replay reproduces `state.json`); lock-contention (two concurrent cranks, one
      winner, no lost update); crash recovery (kill between intent and spawn → next crank
      reconciles); trampoline exit-code propagation incl. `allowedExitCodes`; node-done
      schema-validation refusal loop; loop tests (round instantiation, id suffixing, session
      lineage per round, prior-round inputs, verdict extraction, maxRounds pause, gate/hold
      semantics per Phase-0 decisions, board collapsing handled in A).

## Edge cases to handle

- [ ] **Pane killed by the human** mid-node: no engine timer notices (by design). The board's
      stalled-pane hint covers awareness; any crank reconciles pane existence and offers the
      failure path; the manual `node-done --outcome failed` line is always printed in `status`.
- [ ] **Staleness display**: "running" in state means "a pane should exist". The board
      cross-checks and shows age-of-last-event; there is no worker liveness concept anymore.
- [ ] **Multiple concurrent runs**: board is per-run with a picker; placement namespaces groups
      per run.
- [ ] **Named herdr sessions / remote**: cranks talk to whichever herdr server the CLI reaches;
      non-default `--session` setups land panes elsewhere. Document; optional passthrough env.
- [ ] **Board self-death**: reopen via plugin pane or `orchestrate board`; stateless.
- [ ] **`split-right` board with no herdr launch context**: run launched from a terminal
      outside any herdr pane has no "current tab" — policy falls back (dedicated workspace) and
      journals a hint.
- [ ] **Split placement target**: splitting into a group tab needs the group's root pane id —
      track per group in run state.

## Rejected / deferred

- Digest-bound approvals from the board (read-only + focus + pause/resume + holds; revisit).
- `ui` config inside workflow JSON (preferences-only).
- agmsg integration (only if some CLI can't run interactively).
- Token metrics for interactive sessions (no reliable source; column stays pluggable).
- Orchestrate-owned desktop notifications (herdr `ui.toast.delivery` escalates instead).
- Dynamic-only prompting (decision 8).
- npm distribution (Homebrew tap; npm later only if needed).
- Digest-bound holds (deliberately soft — they gate scheduling, not content).
- ~~Event-driven "crank" scheduler: rejected~~ **REVERSED by decision 7** — with headless nodes
  and timers gone, the worker's three jobs (child supervision, timers, single-process
  atomicity) dissolve. Kept as the record of why the worker existed.
- Detached per-run worker, headless agent execution, engine timers, stdout-parsed structured
  output, supervisors + envelopes, Stop-hook wake, mock provider: all deleted by decisions 5/7.
