# Runtime operations

Read this reference when launching, monitoring, pausing, resuming, recovering, stopping, cleaning,
or installing the Orchestrate command.

## Launch

Launch only after the user explicitly approves the exact preview:

```bash
orchestrate run /path/to/workflow.json --approve <sha256>
```

Add `--allow-write-conflicts` only when the preview reported an overlap and the user explicitly
approved it. The workflow file is revalidated and its digest checked before scheduling.

## Design preferences

Before designing a workflow, inspect the concise merged defaults for its project:

```bash
orchestrate prefs --project /absolute/project/path
```

After a digest-matching `run --approve`, Orchestrate atomically upserts
`${ORCHESTRATE_STATE_DIR:-~/.local/state/orchestrate}/preferences.json`. It keeps global defaults
plus at most 20 canonical project entries. Ordinary fields are last-approved-wins; Codex's sandbox
ceiling is monotonic, while Claude retains the fixed set of permission modes actually approved
because those modes do not have a safe total ordering. An approved adaptive patch updates only the
fields its added nodes reveal.

The file records model/effort choices by mutating versus read-only role, permission authority,
inherited environment **names**, callback type and interval, write-conflict policy, concurrency,
limits, worktree use, up to three bounded read-only command lines, and cached provider
availability. It never records objectives, prompts, node titles, DAG shape, run history, outcomes,
environment values, callback URLs/headers/commands, or command environments. Verification command
capture is deliberately restricted to recognizable package-manager and compiler/test invocations;
arbitrary command lines, URLs, headers, shell fragments, and inline credentials are omitted.
Entries are defaults to propose, not approval: every workflow field remains explicit and every run
still requires its preview digest. Provider availability is detected from executable `PATH` entries
without running provider binaries. If the preferences file is malformed, Orchestrate preserves the
latest invalid copy as `preferences.json.damaged` and rebuilds a fresh schema-valid file; a later
invalid copy replaces that quarantine so state storage remains bounded. Cross-process updates use
an owner-identified lock; an abandoned lock is reclaimed only after the moved lock still matches
the dead owner that was inspected.

Set `ORCHESTRATE_DISABLE_PREFS=1` to disable provider detection and all preference reads/writes.
There is intentionally no `prefs set` command; the next approved workflow self-corrects the
captured defaults.

## After launch

`orchestrate run` detaches the worker and returns as soon as startup is acknowledged. Callbacks
deliver to the **user**, never to the assistant:

- `notification` posts a desktop notification (macOS `osascript`, Linux `notify-send`) with a
  one-minute internal timeout.
- `command` and `webhook` run the declared callback with its explicit `timeoutSeconds`.
- `none` writes events only to `events.jsonl`. A contract-version pause is the one exception:
  because the stored workflow is not interpreted under a mismatched contract, it posts a
  hardcoded best-effort desktop notification regardless of the configured callback.

The callback fires on run start, heartbeats, pauses (both `run.pausing` and the settled
`run.paused`), node failures and cancellations, and terminal states; `node.started`,
`node.completed`, and `goal.expanded` fire it only when `heartbeat.milestones` is true.

The assistant's wake-up channel is a harness-owned Stop hook, not the callback or a background
terminal. `run` and `resume` automatically register the run when `CODEX_THREAD_ID` or
`CLAUDE_CODE_SESSION_ID` is available. Registration is exact to the harness, session, and run;
multiple runs can be owned by one session, duplicate registration is idempotent, and a fast
completion cannot be missed. Set `ORCHESTRATE_DISABLE_AUTO_WAKE=1` or pass `--no-wake` only for a
deliberately unattended run.

When the agent reaches the end of its turn, the installed Stop hook waits for any owned run to
reach `completed`, `failed`, `paused`, or `stopped`. It consumes that registration only after
observing the durable state, then blocks the stop once with a continuation reason. The resumed
agent must inspect status and results. Other owned registrations remain for later turns,
including later stops inside the same continuation chain: each stop waits again while owned
registrations remain, so every settled run is delivered even before the user returns. This hold
is deliberate: while a session owns an unsettled run, the hook keeps the session open at
end-of-turn until a run settles or the hook times out; interrupting the wait (Esc) cancels only
the wait — the registration survives and delivery retries at the next stop. The installed hooks
declare a 86400-second timeout, but harness support for day-long Stop-hook waits is not
guaranteed across versions; if the harness enforces a shorter timeout, the wait ends early and
delivery happens at the next stop or user turn with the registration retained.

Harness selection:

- **Codex CLI/desktop:** run `orchestrate setup`. It safely merges an identified Stop hook into
  `${CODEX_HOME:-~/.codex}/hooks.json`, preserving unrelated hooks. Restart Codex and approve the
  new or changed hook when prompted. Codex plugin-scoped hooks are not a supported path in current
  releases, so the installed command owns this global adapter.
- **Claude Code interactive:** the skill folder is a single-skill plugin with
  `.claude-plugin/plugin.json` and `hooks/hooks.json`. Its Stop hook is the primary adapter.
  Claude Code `--bare`, non-interactive `-p`, and sessions that do not load the plugin do not have
  this wake guarantee. Experimental Monitors and background Bash tasks are not used as the
  primary path.
- **Headless/CI:** the external process that owns resumption must wait for the run and explicitly
  resume the provider session. Orchestrate cannot create a model turn inside a terminated
  harness. An interactive harness-native scheduled task may poll status once per minute as a
  fallback while that session remains open.

For an explicit or external registration:

```bash
orchestrate wake <run-id> --harness codex --session <stable-session-id>
```

If the harness does not expose a stable session ID and has no scheduled-task facility, report that
auto-wake is unavailable and rely on the user returning. Do not present a PTY/background-shell
completion notification as equivalent.

For a live human-readable event stream, use:

```bash
orchestrate watch <run-id>
```

`watch` prints the event journal and exits at a settled or paused state, but its process completion
alone does not wake a model. For a quiet machine-readable blocking boundary, use:

```bash
orchestrate wait <run-id> --json
```

`wait` checks durable state before sleeping, so it also returns immediately for a run that already
settled. The watcher or hook may die with the session; the workflow run does not. The registration
remains unless its settled state was delivered, so a later Stop-hook invocation can retry after a
hook timeout or harness restart.

## Monitor and control

```bash
orchestrate watch <run-id>                             # follow events; exits when the run finishes or pauses
orchestrate wait <run-id> [--json]                     # quiet settled-state boundary for hooks and supervisors
orchestrate watch <run-id> --once                      # single pass: print new events and the summary, then exit
orchestrate status <run-id>
orchestrate report <run-id> [--json]                   # rendered digest: needs-attention, bounded node results, supervisor rounds
orchestrate events <run-id> [--json]                   # print the full event log without blocking
orchestrate result <run-id> <node-id> [--attempt <n>]  # print a node's result text (latest attempt by default)
orchestrate runs
orchestrate pause <run-id>
orchestrate stop <run-id>
orchestrate resume <run-id>
```

Exit codes let scripts detect needs-attention states without parsing JSON: `status` and `report`
exit 1 when the run failed, 2 when it is paused, and 0 otherwise. `wait` and `watch` exit 0 when
the run completed, 2 when it is paused, and 1 when it failed or stopped; with `--once`, a
still-running `watch` also exits 1.

`report` is the read-only content-level digest of a run: header with limits usage, a
needs-attention block with copy-pasteable resume commands (pending adaptive patch, pending
supervisor input, reached limit), nodes in dependency order with bounded result summaries, and
reconstructed supervisor rounds. `--json` returns the same information as a stable
`{ run, needsAttention, nodes, supervisorRounds }` shape with result file paths instead of full
result text; env values and webhook headers stay redacted exactly as in `preview`.

Keep the controller as the source of truth. Never interpret elapsed silence as failure or no
progress. Judge convergence from completed outputs and verification evidence. Limits pause new
scheduling and do not kill healthy running nodes.

### Manual pause versus stop

`orchestrate pause <run-id>` writes an atomic request bound to the live worker token. Once the
worker observes it, `run.pausing` is persisted and delivered, no later node is scheduled, and
already-running nodes are allowed to finish normally. The worker then emits and delivers
`run.paused` before publishing the existing resumable `paused` state. `status` and `watch` return
exit code 2 there. Resume pending work normally:

```bash
orchestrate pause <run-id>
orchestrate watch <run-id>
orchestrate resume <run-id>
```

The pause command reports that the request was accepted; `status` remains authoritative because a
request can race worker completion or become stale during recovery. Requesting pause on an already
paused run is an idempotent no-op. A completed, failed, or stopped run is never changed into a
resumable state. If the run is active but its verified worker is gone, recover it first with
`orchestrate resume <run-id> --recover`.

`orchestrate stop <run-id>` is deliberately different. It immediately interrupts active node
fibers and their process groups, records cancellation, attempts cancellation callbacks outside the
interrupted node scopes, then attempts `run.stopped` before publishing terminal `stopped`. Stop
wins if it arrives while a pause is draining. Stopping an already-paused run terminalizes it under
the run lock and delivers the same terminal callback. A stopped run cannot resume.

Cancellation and terminal callbacks are scoped and awaited through their configured timeout; a
failure is recorded as `callback.failed` without preventing terminal state publication. A
heartbeat, milestone, or node-failure callback already in progress may still be interrupted by a
destructive stop; only cancellation and terminal callback attempts have the stronger ordering
guarantee.

## Mirror a run into herdr

When the user works in [herdr](https://herdr.dev) (a terminal workspace manager for agents), a run
can be mirrored into read-only herdr panes:

```bash
orchestrate run <workflow.json> --approve <sha256> --mirror
orchestrate resume <run-id> --mirror        # turn mirroring on for an existing run
```

Mirroring opens one herdr workspace labeled with the workflow name and run id (cwd = the workflow
cwd), a `status` tab following `orchestrate watch <run-id>`, and one tab per node attempt tailing
that attempt's live `stdout.log`. Panes only render output — they never send input to provider
processes — and nothing is closed automatically when the run settles, so results stay readable.
`orchestrate clean <run-id>` also closes the run's mirror workspace, best-effort.

Mirroring is presentation only and never semantics: it is not part of the approved workflow, does
not enter the digest, and cannot affect scheduling, state, or run outcome. Every herdr call is
best-effort with a short timeout; a dead or absent herdr mid-run journals a single
`mirror.degraded` event and is then ignored. `--mirror` fails cleanly at launch when no usable
herdr CLI is on `PATH`.

Environment variables: `ORCHESTRATE_MIRROR=herdr` mirrors every run as if `--mirror` were passed
(degrading to a stderr note when herdr is missing instead of failing);
`ORCHESTRATE_DISABLE_MIRROR=1` hard-disables mirroring everywhere and wins over both. The choice
is recorded in run state, so resuming a mirrored run keeps mirroring and reuses its workspace when
it is still open.

A minimal herdr plugin ships in the skill's `herdr-plugin/` folder (`herdr plugin link
<skill-dir>/herdr-plugin`): a read-only "Orchestrate runs" pane plus pause/resume-latest actions
that shell out to `orchestrate`. See `herdr-plugin/README.md`.

## Interactive nodes

Unlike mirroring, `interactive: true` agent nodes use herdr as their **execution substrate**:
`run` and `resume` of a workflow whose pending nodes include one verify the herdr CLI up front and
fail cleanly without it. The run opens (or reuses) one herdr workspace — the same workspace
`--mirror` records — plus one tab per interactive attempt hosting the real provider TUI. `--mirror`
additionally adds the read-only status/tail panes as usual.

The node completes only through its prompt contract:

```bash
orchestrate node-done <run-id> <node-id> --token <one-time-token> --outcome <completed|failed>
```

Normally the agent inside the pane runs this itself after writing its handoff report to the
attempt's `result.txt`. The command validates the run, that the node is awaiting an interactive
completion, the one-time token (constant-time compare), and that the report file exists and is
non-empty (the error names the exact path to write first). On success it journals
`node.interactive.completed`/`.failed` and publishes an atomic done record; the live worker picks
it up within about half a second and finalizes the attempt through the normal state machinery — a
`failed` outcome goes through the node's ordinary retry logic with a fresh token and tab. The
human operator is a legitimate caller too: `report` and `status` print the full command, token
included, for every awaiting node.

Idle nudge (display only, never correctness): roughly every 30 seconds the worker asks herdr for
the pane agent's state. A pane that looks idle or blocked with no node-done call journals one
`node.interactive.idle` event per continuous idle period and fires the run callback; `report` and
`status` then show the node in needs-attention with its pane id and node-done command. herdr
failures during this polling are swallowed and cannot affect the run.

After node-done the pane deliberately **stays open** and the human may keep chatting with the
session. A later node that resumes the same saved session sees that mutated session — by design.
Close leftover panes manually or with the workspace. `pause` waits for interactive nodes (they
count as running nodes) and names them in its reason; `stop` and node timeouts close the pane via
`herdr pane close`, best-effort. If the worker crashes, the TUI survives as herdr's child, but
`resume --recover` fails the in-flight attempt (its token is void), journals
`node.interactive.recovered`, and notes that the stale pane may still be open; a retry opens a
fresh pane with a new token.

## Adaptive approval and input

The controller validates every supervisor patch. Invalid changes never run. Out-of-envelope
changes and newly introduced write conflicts pause for review:

```bash
orchestrate status <run-id>
orchestrate resume <run-id> --approve-patch <sha256>
```

When a supervisor asks for judgment, inspect the question and bind the user's answer to its
displayed input digest:

```bash
orchestrate status <run-id>
orchestrate resume <run-id> --respond "the user's answer" --input-digest <sha256>
```

When a run pauses at a node approval gate (`gate: "approval"`), show the user the rendered content
the node would run with, then bind the approval to the displayed gate digest:

```bash
orchestrate report <run-id>        # bounded rendered content, digest, exact resume command
orchestrate status <run-id> --json # full rendered content under pendingGate.content
orchestrate resume <run-id> --approve-gate <node-id> --gate-digest <sha256>
```

Gate digests bind the run id, node id, and the exact rendered content (prompt frame plus resolved
inputs; argv plus inputs for commands). Approving a gate approves only that node; the next gated
node pauses again, and the worker re-renders and verifies the approved content before the node
starts.

Patch digests bind the supervisor, displayed violations, and proposed decision. Input digests bind
the supervisor, question, and adaptive round. Resume refuses any of these artifacts if its stored
content no longer matches the displayed digest, and the worker independently rechecks approved
patches and gates.
For a patch paused by an older runtime, the first resume attempt refreshes a recognized legacy
digest and refuses to continue until the newly displayed digest is reviewed and approved.

Continue past a configured workflow or goal limit only after approval with `--override-limit`.
Continue past the emergency fuse — a hard controller-wide cap of 10,000 agent starts per run,
independent of `maxAgentStarts`, that guards against runaway adaptive loops — only after approval
with `--override-emergency-fuse`.

### Revise a paused run

A human can rewrite the remaining plan of a paused run without supervisor involvement. Pause the
run (any pause — manual, gate, limit, or input — qualifies), copy the stored
`workflow.json` from the run directory, edit the copy, then propose it as a complete workflow
document:

```bash
orchestrate pause <run-id>
orchestrate revise <run-id> /path/to/revised-workflow.json
orchestrate report <run-id>                          # revision summary + digest in needs-attention
orchestrate resume <run-id> --approve-revision <sha256>
orchestrate revise <run-id> --discard                # drop the proposal instead
```

`revise` validates the revised document stand-alone and enforces the mid-run invariants:
`version`, `name`, and `cwd` never change; nodes that have executed any attempt (or are
completed/running/cancelled) must stay byte-identical and cannot be removed; pending nodes may be
modified, removed, or added (a removal that breaks remaining `needs` is refused by revalidation);
workflow-level `concurrency`, `limits`, `heartbeat`, and `writeConflicts` may change. It prints a
revision summary, any newly introduced write-conflict warnings, and a revision digest. A second
`revise` replaces the pending proposal.

The proposal has full human authority — interactive nodes, supervisors, and gates are all allowed,
subject only to full validation; supervisor envelopes are not consulted. Nothing applies until
`resume --approve-revision <digest>`: an ordinary resume is refused while a revision is pending,
and approval is refused if the stored proposal no longer matches its digest. On approval the prior
workflow is archived under `revisions/<n>-workflow.json` in the run directory, `run.revised` is
journaled, and stale approval state is cleared — a changed gated node re-gates with freshly
rendered content, and a pending input or patch from a changed or removed supervisor is dropped.
Revision digests chain: each applied revision becomes the run's approved digest that the worker
re-verifies on every start, and a further revision needs its own approval.

## Recovery and cleanup

Recover a stale run only after confirming its worker died:

```bash
orchestrate resume <run-id> --recover
```

The controller records each child's PID plus start time, executable, and command fingerprint, and
verifies that the child remains its process-group leader, so recovery can terminate verified
orphans after a hard worker crash. It refuses to signal a process whose identity cannot be
verified and never exceeds a node's approved attempt count.

Logs and state live under `${ORCHESTRATE_STATE_DIR}`, `${XDG_STATE_HOME}/orchestrate`, or
`~/.local/state/orchestrate/` in that precedence order, not in the installed skill folder. Clean a
finished run only when requested:

```bash
orchestrate clean <run-id>
```

## Install the command

Global skill installers discover the skill but may not add its executable to `PATH`. Install or
refresh only the command symlink by running, from the installed skill directory:

```bash
node <skill-dir>/scripts/orchestrate.mjs setup
```

This creates `~/.local/bin/orchestrate` and merges the Codex Stop hook into
`${CODEX_HOME:-~/.codex}/hooks.json`. It never replaces unrelated hooks. Restart Codex and approve
the hook when prompted. Pass `--no-hooks` only when installing for a harness that will not use
Codex. Claude loads its hook from the installed skill plugin and needs no settings edit. Ensure
`~/.local/bin` is on `PATH`, then run `orchestrate doctor`.
