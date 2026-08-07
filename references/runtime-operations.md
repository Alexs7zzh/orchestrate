# Runtime operations

This file describes implementation mechanics. The normative product contract is
[`guarantees.md`](guarantees.md), and it does not inherit stronger crash or delivery guarantees from
the mechanisms described here.

## In this reference

- [State and crank](#state-and-crank)
- [Scheduling](#scheduling)
- [Repeats and limits](#repeats-and-limits)
- [Conditional nodes and skipped outcomes](#conditional-nodes-and-skipped-outcomes)
- [Gates and revisions](#gates-and-revisions)
- [Herdr presentation](#herdr-presentation)
- [Installation and upgrades](#installation-and-upgrades), [build identity](#build-identity),
  [cleanup](#cleanup), and [preference storage](#preference-storage)

## State and crank

### Durable state

A run lives under `$ORCHESTRATE_STATE_DIR/runs/<id>` or the platform state directory. It contains
the approved workflow, `state.json`, an atomically replaced versionless `events.json` event array,
per-attempt outputs, each attempt's rendered prompt saved beside its output as `prompt.txt`,
and pane spawn receipts. Agent results and completion envelopes live in a sibling token-addressed
submission tree outside authoritative state. A kernel-held advisory lock serializes each crank.
Every event contains an RFC
6902 patch; `state.json` is the journal's current materialization, and replay is authoritative
recovery for a missing or torn snapshot.

### Spawn intents and prompt delivery

Before a pane starts, Orchestrate persists an intent and attempt token. The surface records one
small receipt after Herdr creates a pane and marks it `ready` only after command start or agent
prompt succeeds. Every agent prompt carries a unique per-attempt delivery marker and waits until
the agent is observed working, done, or blocked, so a `ready` receipt means the prompt was actually
taken, not merely accepted. Delivery waits for the agent to report interactive readiness first and
requires the marker to appear in the pane transcript before trusting the observation. If Herdr
reports a stall with that marker visible, Orchestrate submits the already-rendered composer once
with Enter and waits for a live state; it resends the full prompt only while the marker is absent.
A prompt beyond the PTY-safe typed budget is delivered as a short pointer to a prompt copy in the
attempt submission directory. A prompt error or wait timeout is recorded as `ambiguous`. A failure
after the prompt was observed taken —
such as a provider reporting a required lineage session id late — is recorded as
`session-pending`: reconcile retries only the session capture on that live pane and promotes the
receipt to ready without re-prompting. Reconcile adopts a live ready pane. If a prompt-bearing
receipt's pane is gone, it adopts a token-valid submission only when the receipt also carries the
exact required child session id; otherwise it fails that attempt, and retry allocates a fresh token
and forks the unchanged committed parent. It never re-prompts a possibly accepted agent attempt
under the same completion token. A dead `created` receipt, which predates command start or prompt
delivery, may still be retried in place. Every other live incomplete or ambiguous receipt stops for
agent-assisted inspection. Reconcile does not infer prompt acceptance from provider lifecycle
status or close label-matched tabs. One node's ambiguous or pending spawn is surfaced after
independent planned intents of the same reconciliation have started; it never starves ready work
outside that node's declared workroom. A seatful observation failure blocks later seat launches in
the same workroom for that reconciliation because the workroom's physical occupancy is unresolved.

New agent panes may briefly exist before their interactive shell is ready; the surface retries only
Herdr's explicit `agent_pane_busy` readiness response within a fixed bound. Other unambiguous start
errors enter the workflow retry policy. A crash between a Herdr action and its local receipt may
produce a duplicate after explicit reconciliation; this is part of the documented at-least-once
external-action boundary.

### Master wake-up and live observation

`run` captures the launching master, persists the run, presents its initial events, starts initial
ready work, and returns. It does not create a detached controller, credential, lease, presentation
cursor, filesystem watcher, or delivery outbox. The captured wake owner is the scheduler after that
point. An explicit `resume` from an authenticated Herdr agent pane transfers wake ownership to that
current agent session; a resume from a non-agent terminal preserves the current owner. When Herdr
reports a workflow agent as blocked or done, the installed Orchestrate plugin event
hook runs outside the provider sandbox, maps the pane and workspace to the live attempt, and prompts
the current master session. Valid authenticated evidence from either status requests reconciliation.
Without valid evidence, blocked requests immediate attention; done requests debugging after one
short re-check that suppresses the prompt when the agent is observed working again, because provider
status can flap through done mid-task. The debug prompt names the pane, points at the saved
`prompt.txt`, and directs the master to `orchestrate status` for inspection and restore/resume
guidance. After restoration, the same owning provider session must write the declared result and
submit `node-done`; status does not expose a token-bearing substitute. This wake-up is a latency
hint; the master or human can safely run `orchestrate reconcile` at any time.
The bridge also consumes `pane.closed` and `pane.exited`: a pane vanishing under a durably running
node without a valid submission prompts the master with the `ui restore` command, while teardown
after a valid submission stays silent. A plugin startup hook raises one attention notification
after a Herdr server restart or handoff when any run needs inspection. Board refresh and restore
observe all panes and agent statuses through one snapshot call rather than per-node probes.

### Locking and completion transport

Every authoritative mutation, including reconcile and destructive cleanup, is serialized by a
kernel-held per-run lock. Concurrent invocations wait and then observe the latest committed state.
Readers replay a missing, invalid, torn, stale, or divergent snapshot without writing. A locked
mutation repairs the snapshot before it proceeds.

`node-done` runs inside the provider sandbox. The owning workflow agent must first write its
declared nonempty `outbox/result.txt`; `node-done` reads the mode-0600 completion contract from that
attempt's `control/`, reads the result once with a bounded no-follow open, validates completed JSON
against the contract schema, and only then writes a strict, versioned authenticated
`outbox/completion.json` containing the exact raw bytes' SHA-256 and length. Delegated
workers never inherit or exercise the owner's result or completion contract. Free-text answers,
provider idle state, pane nudges, and unauthenticated inference are not completion. `node-done` does
not acquire the run lock, read workflow or run authority, write authoritative run state, construct
a surface, or call Herdr. `reconcile` reloads the manifest and completion contract, consumes the
envelope, validates the live attempt/token/provider/path/status and output schema, verifies the exact
result bytes before parsing, commits completion, and starts newly ready work.
Repeated submissions for the same token replace the same envelope; stale tokens are rejected during
reconciliation. Reconcile accumulates malformed, stale, or schema-invalid envelope diagnostics
while processing trusted transitions and spawns to a fixed point; its aggregate nonzero error then
names each exact envelope and the replace-or-remove remedy. Trusted reads reject any agent or
command result larger than 1 MiB before parsing,
journaling, input rendering, or CLI return. Command panes retain their authenticated `node-exit`
completion path and may crank synchronously because they are not provider-sandboxed.

While no master is active, already-running panes may finish and leave submissions in the transport
tree. The run is dormant until a later explicit reconcile consumes them. `status --wait` and
`events --follow` observe filesystem changes but do not schedule work.

### Provider sandbox boundary

Agent launch compiles one immutable `AttemptCapabilityManifest` for the token. It records four
pairwise-distinct canonical directory identities: launcher-owned provider-readable/non-writable
`control/`, launcher-projected provider-readable/non-writable `inbox/`, provider-writable `outbox/`,
and provider-writable mode-0700 `scratch/`. Policies grant only the exact read/write identities and
never their common attempt parent. `control/` contains the completion contract, provider policy,
and pinned provider relay; `outbox/` is reserved for `result.txt` and `completion.json`.
Codex expresses that boundary as a launcher-owned permission profile. Claude expresses
it as a launcher-owned settings file inside `control/` — provider
configuration never rides the typed launch line, whose PTY input buffer is capped — and runs from
the exact inbox for an untracked fresh session or from its exact launcher-owned lineage
project for session-bearing work. The authored `dontAsk` contract is compiled into a launcher-owned
`bypassPermissions` invocation with `--safe-mode`, only Bash exposed, and a required native sandbox
whose unsandboxed fallback is disabled. This removes interactive permission stalls without exposing
Agent/Task delegation or built-in filesystem tools. Only canonical declared source prefixes are
added as sandbox writes; each write root is also reopened for reads beneath the denied submission
parent. Both providers
receive launcher-owned `TMPDIR`, `TMP`, and `TEMP` values naming an existing mode-0700 `scratch/`
directory inside the exact token submission directory. This permits attempt-local intermediate
files without granting ambient temporary-directory or undeclared workspace writes. Provider launch
compilation rejects empty or relative `PATH` entries and deterministically omits later canonical
aliases while preserving their first precedence position. It records every
lookup directory through the winning entry, content-binds each executable, resolves supported
absolute and `/usr/bin/env` shebang chains (including strict `env -S`), rejects malformed or cyclic
chains, and produces one exact terminal executable and fixed argv. Spawn materializes a
canonical-name relay under launcher control that uses only those pinned values, then supplies the
pane with the frozen launcher-owned `PATH`, `HOME`, and matching `CODEX_HOME` or
`CLAUDE_CONFIG_DIR`; later ambient `PATH` changes cannot retarget the launch. The effective provider control roots are resolved
through their deepest existing ancestors and protected from every mutating sandbox root and write
prefix. Preflight and the spawn boundary likewise resolve every provider used anywhere in the
workflow and reject any mutating node root or declared write prefix that could replace any
executable, interpreter, relay interpreter, or earlier lookup directory in those identities,
including a different provider used
by a later node or retry. File identity, executable mode, bounded content digest, and lookup
directory identity are rechecked immediately before provider start. Authored agent environment cannot replace provider
lookup or control configuration, and launch rechecks persisted IR before creating a provider pane.
Provider panes
receive no write
capability to `runs/<id>`, including `state.json`, `events.json`, locks, workflow/UI snapshots,
receipts, or any other authoritative state. `danger-full-access` is not a valid workflow sandbox.
Validation and launch both reject a mutating provider sandbox root or write prefix whose resolved
path is equal to, below, or above the configured state root or installed Orchestrate control assets.
This includes custom `ORCHESTRATE_STATE_DIR` roots, all other submissions,
runtime versions, executable links, and installed provider skills. The exact token submission
`outbox/` and `scratch/` identities are the only attempt-local write channels. Claude session projects live
outside the node-submission tree in a mode-0700 directory per launcher-derived canonical lineage;
fresh independent lineages are disjoint, while resume and fork reuse their source lineage project.
The Claude sandbox denies both canonical submission and provider-session parents, then reopens only
the exact canonical attempt transport and lineage project for sandboxed Bash; it never grants a
sibling lineage or another node's submission. Those parents and exact children are created and
canonicalized before policy comparison and emission, including when a configured-state ancestor is
a symlink. Codex applies the same canonical submission-parent denial and exact-attempt carve-out, and
both providers receive the canonical identity of the exact attempt scratch directory. Provider
roots are canonicalized before use; a pathname whose identity changes after preparation, a declared
write prefix with a symlink component, or any ancestor inspection failure is rejected with node, declared pattern,
candidate, inspected ancestor, and errno context before any
Herdr workspace, tab, or pane creation. Existing Git
worktree targets are reused only when their canonical top level, common repository, and exact
expanded branch all match the runtime declaration.

The native sandbox boundary has opt-in real-provider contract probes. From `scripts/`, run
`bun run test:provider:live` to execute the Codex and Claude probes serially. Individual provider
diagnosis may set `ORCHESTRATE_NATIVE_SANDBOX_PROBE=codex` or `claude` when invoking either probe
file directly. The probes use the production attempt preparation and launch path. They exercise
completion prevalidation and trusted reconciliation, agent and command result
projection, inbox/control immutability, producer isolation, delegation ownership, scratch recovery,
and the declared workspace boundary. They invoke authenticated provider CLIs and are therefore
gated out of ordinary deterministic verification.

### Origin handoff

When launch occurs inside a Herdr agent pane, the run records the origin pane plus the launching
master's provider session ID as the initial wake owner. An explicit `resume` from an authenticated
Herdr agent pane transfers wake ownership to that agent's exact provider session; a resume from a
non-agent terminal preserves the current owner. Herdr provides lifecycle event dispatch and the
prompt transport for the trusted plugin wake.
The provider node receives neither Herdr control authority nor authoritative state access. A
foreground reconcile may also prompt the exact current wake-owning master session
when the workflow completes or reaches actionable non-human attention: exhausted failure, gate,
downstream hold set at completion, revision, fuse, or round limit. Human pause and stop are
intentionally silent because their initiator already knows. The handoff contains only bounded
orchestrator-generated status and commands; node failure text remains in durable results. This
direct prompt and its notification fallback are best effort. There is no delivery outbox or
exactly-once guarantee, so a
crash may lose or duplicate presentation without changing authoritative run state.

## Scheduling

### Readiness and dependency release

A node becomes ready when every dependency has status `completed` or `skipped` and no matching
instance or template hold blocks dependency release, its condition selects it, its gate is
satisfied, and starting it would fit the concurrency, write-set, resource, and start-fuse
constraints. A successful node always remains `completed`; a matching durable hold independently
marks its downstream dependencies held.
`node-done --hold` commits the `completed` outcome and an instance-scoped hold in one authenticated
transaction as separate `node.completed` and `hold.set` journal events before reconciliation. A
release removes only the hold, never the historical outcome, and then cranks newly ready work.

Repeat rounds advance only after every current-round member is completed or skipped and releases
dependencies.
A template hold applies to each matching repeat instance; an instance hold applies only to that
runtime instance. Historical-round instance holds do not block a settled repeat's final-round
dependency release. Gates, restore, revision reconciliation, and replay consume the same two axes.

### Pause, restore, and live status

Herdr agent status `done` is only a live observation and never implies durable completion. While
durable status is `running`, a valid token-matched result and completion envelope takes precedence
over blocked, done, or gone and is shown as submitted and pending reconcile; without that
authenticated evidence, done requires owner recovery.
Interactive board refresh, `board --json`, and `runs --needs-attention` use the same classifier and
default-selection rule. Explicit blocked/done/gone observations without authenticated completion
evidence need attention; submitted/pending-reconcile, idle, unknown, and working states do not.

`pause` prevents new starts and allows live panes to finish. Pause kind is stored on each journal
event so handoff replay does not infer intent from later state. `resume` continues scheduling.
`stop` journals cancellation and settlement before best-effort pane cleanup. `ui restore` reconciles
recorded panes: live panes are adopted, explicitly missing in-flight attempts fail, and retry policy
is cranked. Herdr transport/service failures abort restore without treating a live pane as missing.

### Retries and provider sessions

Retries reuse their placement slot after the old pane is closed. Command exit codes outside
`allowedExitCodes` fail an ordinary node. In a repeat condition, an allowed exit settles the repeat;
another numeric exit begins the next round. Provider failures use the same bounded retry path.
Repeated session resumes are copy-on-write: each attempt forks the alias's committed provider
session, a schema-valid success promotes that child and its pane source, and any failed attempt
leaves the parent head unchanged. A retry therefore forks the same committed parent. This protects
provider conversation lineage; it does not roll back source-workspace mutations performed by a
failed attempt.

### Workroom seat reuse

For a seatful node, the reusable placement slot is its declared workroom seat. Later repeat
instances inherit the same seat. An active workroom parks a successful seat pane rather than applying
`close-success` to that individual turn. An ordinary failed attempt leaves a live pane parked, or an
absent pane empty, and its automatic retry returns to that seat; failure alone does not mark
occupancy attention. Neither failure nor retry advances workroom settlement. Workroom presentation
does not alter the provider lineage contract and does not automatically replace an unavailable
resume with a fresh provider session.

## Repeats and limits

A repeat instantiates its member subgraph one round at a time. Runtime IDs append `--r<N>`.
`round: previous` inputs are absent in round one and resolve to the prior instance thereafter.
External dependents wait for the repeat to settle and receive final-round output.
The approved `{{round}}` placeholder in an agent member's prompt renders to that instance's round;
all other directive text remains unchanged.

A member-level `when` uses the same-round source instance when both nodes belong to the repeat,
uses a stable non-repeat source directly, and resolves a repeat source to its final instance for an
outside consumer. Different repeats cannot be joined by a condition. The scheduler evaluates every
member anew each round before gates and attempts; a skip in one round does not force a skip in the
next. The verdict member cannot be conditional, so every settled round has an actual result for
`until`.

Repeat instances retain their template's workroom and seat. A workroom settlement anchor is a
non-repeat node downstream of every other node assigned to the workroom, including repeat members;
reaching `maxRounds` therefore pauses without settling that workroom.

The condition is either a command result or a JSON pointer into a schema-validated agent result.
At `maxRounds`, the run pauses. Resume requires `--continue-rounds <n>` or
`--accept-repeat <id>`. `limits.maxStarts` is independent; crossing it requires
`resume --override-fuse`.
Already-planned starts within the budget are reconciled before a later candidate pauses the run.
Repeat-member Git worktree branch templates and explicit paths must contain `{{nodeId}}`, whose
runtime value includes the round suffix; both are expanded for creation and cleanup. Default
worktrees use a run/runtime-unique temporary target outside authoritative state.

## Conditional nodes and skipped outcomes

`when` compares an approved expected value with an RFC 6901 pointer in a direct dependency's
schema-validated JSON result. A match continues normal scheduling. A mismatch, or an explicitly
skipped source, journals `node.skipped` and records a terminal zero-attempt node with scheduler-owned
reason metadata. It consumes no gate, retry, start, pane, session, workspace, or resource. The
agent completion command remains `completed|failed`; no agent can assert `skipped`.

A missing pointer is malformed control data, not a false predicate. Orchestrate pauses the run with
kind `condition`, leaves the target unstarted, and rejects resume until an approved revision changes
that condition, or the run is explicitly stopped. For a repeat member with prior-round history,
approval may change only `when` on the paused template; the current and future unstarted instances
use the revision while settled earlier instances remain immutable. This is the precise fail-closed
behavior: it never silently chooses either branch. A skipped dependency releases dependents unless
held; content inputs render `[skipped]`, while path inputs are invalid because skipped nodes have no
result file.
Status, result JSON, events, and the board expose the skipped state and reason.
A skipped seatful node has no attempt and performs no Herdr action: it does not open a workroom,
replace a provider, close a parked pane, or otherwise consume its seat. It may still satisfy a
workroom settlement anchor because `skipped` is a durable scheduler-owned terminal outcome.

## Gates and revisions

An approval gate stores the exact rendered prompt or command content and its digest. Approve with
both node ID and digest. Editing inputs changes the content and therefore requires a new digest.
The gate token is the canonical `gate-content` digest of `{content:<exact rendered content>}` and is
recomputed from stored content at approval. The `gate.opened` event message contains the full
paste-ready approve command. Human status and board output print the exact JSON-escaped gate content
immediately before that command; JSON output continues to expose the content. They also mark a
not-yet-started gated node with `approval gate ahead`.

`revise` validates a complete replacement YAML workflow, checks immutable completed work and active
sessions, prints the complete redacted approval preview plus the canonical `workflow-ir` digest,
and stores the expanded proposal, summary, digest, and exact source provenance. Status, board, and
approval recompute the preview purely from that durable workflow and provenance; provenance is
explanatory and never changes the digest or runtime behavior. Proposal computes the digest instead
of trusting input. `approve --revision <digest>` recomputes the pending workflow digest, requires
stored and supplied values to match, validates exact final-IR origins and inferred-dependency
annotations, applies atomically,
and journals the full workflow plus the same provenance so replay also restores `workflow.json`.
While a proposal is pending, live attempts may finish and record their outcomes, but neither new
intents nor reconciliation/spawn of already-planned old-plan intents may start a pane. Approving or
discarding the proposal removes that scheduling barrier.
Approval rewrites every unstarted runtime node from the revised declaration, including its
dependencies, resets it to pending for fresh scheduling, and rebuilds stable declaration order.
Already-started or skipped runtime history is preserved byte-for-byte; removing or changing its
template is rejected. The repeat declaration is immutable for the entire active run, and a member
template becomes immutable after its first attempt or skip, so approval cannot redirect a committed
provider lineage between rounds. Thus newly inserted barriers affect scheduling as well as board
edges.

Once an assigned attempt reserves a workroom, revision approval freezes its workroom ID and label,
layout, seat IDs, seat labels, seat order, and `settlesOn` anchors. The revised workflow must preserve
every live pane's unique workroom and seat assignment. A revision that would move an occupant,
assign two live occupants to one seat, or leave a live seat outside the workroom is rejected rather
than repaired by placement guesses.

## Herdr presentation

### Placement and workroom tabs

Every started node executes in a real Herdr pane; a scheduler-skipped node creates no pane. Optional
approved workrooms provide stable workroom tabs with ordered `columns` or `rows` seats. A seatful
node bypasses matcher-selected tab/split grouping and uses its declared workroom and seat; only one
live attempt may occupy it. A seatless node that names a workroom remains supporting, transient
work. Command nodes are always seatless and continue to execute in transient Herdr panes
rather than a background process.

Workrooms inherit the effective UI `placement.workspace` preference: the dedicated run workspace or
the launching origin workspace. Origin placement verifies that the recorded origin pane belongs to
its workspace and falls back to the dedicated run workspace when it does not. Ordinary seatless nodes
continue to use the ordered placement rules that choose tabs or splits, group related nodes, cap
splits per tab, and define retry reuse.

### Workroom settlement

While a workroom is active, successful seat panes park and ignore the ordinary agent `close-success`
policy so later turns can reuse the stable seats. The workroom settles after every `settlesOn`
anchor is durably `completed` or scheduler-owned `skipped`; failed, paused, gated, or exhausted-repeat
anchors that have not reached either status leave it active. A downstream hold remains a separate fact and
does not rewrite a completed anchor. At settlement, the effective agent completion preference
applies to the parked workroom: `keep-open` leaves its panes open and relabels them settled;
`close-success` closes its seat panes.
Seatless nodes retain their normal per-node completion behavior.

### Occupancy recovery

A recorded workroom tab and its remaining live occupants are verified immediately before reuse or
restoration. An explicitly missing seat pane is recreated in the declared workroom only when that
observation identifies the vacant seat unambiguously. Contradictory occupants, duplicate candidates,
or ambiguous Herdr state produce human attention; Orchestrate does not spill a seatful node into a
fresh matcher-selected tab. A transient occupancy-verification transport failure defers the seat
without durable attention, while a genuine contradiction durably marks it for attention. Both
cases block sibling seat launches in the workroom until reconciliation can observe the occupancy;
unrelated workrooms and seatless work may continue. The planned intent stays intact and consumes no
retry. Automatic fresh-provider fallback and alias rebinding are not supported.

The declared layout and seat order determine split intent and preview order. Herdr owns the actual
tab and split geometry, so recovery guarantees logical seat identity and co-location inside the
declared workroom tab, not pixel-perfect reconstruction of an earlier arrangement.

### Board and notifications

Board policy separately chooses a right split, the current workspace, or a dedicated workspace.
Focus policy may focus only attention events or every start.

The interactive board refreshes on a bounded clock as well as journal writes, so elapsed time and
Herdr garnish remain live. Herdr `idle` and `unknown` startup samples are transient. For a durably
running agent, blocked, `done`, or a missing pane with valid authenticated completion evidence is
shown as submitted and pending reconcile, not as human attention. Without that evidence, `done` is
result missing, while `blocked` and an explicitly missing pane produce the same kind of
owner-recovery attention. Human status and board output offer inspection and restore/resume guidance but never
expose the owner's token or a `node-done` recovery command: restore or resume the owning provider
session and let that same owner finish and submit completion.

Notifications are classified as attention, milestone, or progress and routed to Herdr, the board,
or silence. Workflow callbacks can be a command, webhook, platform notification, or none. Callback
failure is reported but never rolls back state. These presentation routes are independent from the
launching-agent handoff.

Use a local Herdr session unless a named remote can access identical checkout, state, provider,
and CLI paths. `ORCHESTRATE_DISABLE_UI=1` disables board auto-open and presentation notifications,
not pane execution.

## Installation and upgrades

`setup` stages one matching CLI, skill, and Herdr plugin under
`~/.local/share/orchestrate/current`, links the CLI into `~/.local/bin`, and optionally runs the UI
preference wizard. Plugin registration is required. A link failure removes the new stage and leaves
the prior installation selected; an unlink failure makes removal fail rather than reporting success.
If Herdr cannot confirm link or rollback, the versioned stage remains as a recoverable plugin target
while stable CLI and skill links remain unchanged. `doctor` reports missing or unqueryable
registration as unhealthy.

`brew upgrade orchestrate` installs a new formula build. The next eligible interactive command may
migrate the staged installation automatically, but migration waits while any run is unsettled and
never starts from node completion, plugin event handling, shell completion, `doctor`, or other
non-interactive invocation. Plain `orchestrate setup` is always the explicit migration path. The
newest installation wins: an older binary never replaces a newer staged build, and a staged wrapper
delegates setup to a newer formula executable found later on `PATH` rather than restaging itself.

Before uninstalling the Homebrew formula, run `orchestrate setup --remove` so the skill and plugin
are unlinked through the matching staged build.

## Build identity

The compiler embeds the exact version and source/asset build hash used by `--version`, journal
events, and state snapshots. Production code does not consult an ambient build-ID override, so a
subprocess cannot make one build read state created by another build.

## Cleanup

`clean --dry-run` lists panes, opted-in worktrees, the run directory, and the exact run-owned
provider-session directory without removing any of them. Without dry-run it takes the run lock,
refuses an unsettled run, closes recorded panes, removes each Git worktree whose
declaration has `removeOnClean: true` only after revalidating its repository and exact expanded
branch, then removes the run's submission transport, provider-session data, and authoritative run
files. `setup --remove` behavior is described under
[Installation and upgrades](#installation-and-upgrades).

## Preference storage

Preferences contain UI state only. Stored files are validated exactly against
`preferences.schema.json`; missing required fields, unknown design fields, and other schema-invalid
shapes fail without alternate parsing or rewrite.
