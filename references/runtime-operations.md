# Runtime operations

This file describes implementation mechanics. The normative product contract is
[`guarantees.md`](guarantees.md), and it does not inherit stronger crash or delivery guarantees from
the mechanisms described here.

## State and crank

A run lives under `$ORCHESTRATE_STATE_DIR/runs/<id>` or the platform state directory. It contains
the approved workflow, `state.json`, an atomically replaced versionless `events.json` event array,
per-attempt outputs, each attempt's rendered prompt saved beside its output as `prompt.txt`,
and pane spawn receipts. Agent results and completion envelopes live in a sibling token-addressed
submission tree outside authoritative state. A kernel-held advisory lock serializes each crank.
Every event contains an RFC
6902 patch; `state.json` is the journal's current materialization, and replay is authoritative
recovery for a missing or torn snapshot.

Before a pane starts, Orchestrate persists an intent and attempt token. The surface records one
small receipt after Herdr creates a pane and marks it `ready` only after command start or agent
prompt succeeds. Agent prompts are delivered atomically and wait until the agent is observed
working, so a `ready` receipt means the prompt was actually taken, not merely accepted. Delivery
waits for the agent to report interactive readiness first, requires the prompt text to appear in
the pane transcript before trusting the observation, and delivers a prompt beyond the PTY-safe
typed budget as a short pointer to a prompt copy in the attempt submission directory. A prompt
error or wait timeout is recorded as `ambiguous`. A failure after the prompt was observed taken —
such as a provider reporting a required lineage session id late — is recorded as
`session-pending`: reconcile retries only the session capture on that live pane and promotes the
receipt to ready without re-prompting. Reconcile adopts a live ready pane. If a prompt-bearing
receipt's pane is gone, it adopts a token-valid submission only when the receipt also carries the
exact required child session id; otherwise it fails that attempt, and retry allocates a fresh token
and forks the unchanged committed parent. It never re-prompts a possibly accepted agent attempt
under the same completion token. A dead `created` receipt, which predates command start or prompt
delivery, may still be retried in place. Every other live incomplete or ambiguous receipt stops for
agent-assisted inspection. Reconcile does not infer prompt acceptance from provider lifecycle
status or close label-matched tabs. One node's ambiguous or pending spawn is surfaced after the
other planned intents of the same reconciliation have started; it never starves independent ready
work.

New agent panes may briefly exist before their interactive shell is ready; the surface retries only
Herdr's explicit `agent_pane_busy` readiness response within a fixed bound. Other unambiguous start
errors enter the workflow retry policy. A crash between a Herdr action and its local receipt may
produce a duplicate after explicit reconciliation; this is part of the documented at-least-once
external-action boundary.

`run` captures the launching session, persists the run, presents its initial events, starts initial
ready work, and returns. It does not create a detached controller, credential, lease, presentation
cursor, filesystem watcher, or delivery outbox. The launching master is the scheduler after that
point. When Herdr reports a workflow agent as blocked or done, the installed Orchestrate plugin event
hook runs outside the provider sandbox, maps the pane and workspace to the live attempt, and prompts
the captured master session. A valid done submission requests reconciliation; missing or invalid
submission data requests debugging after one short re-check that suppresses the prompt when the
agent is observed working again, because provider status can flap through done mid-task. The debug
prompt names the pane, points at the saved `prompt.txt`, and directs the master to
`orchestrate status` for the recovery command. This
wake-up is a latency hint; the master or human can safely run `orchestrate reconcile` at any time.
The bridge also consumes `pane.closed` and `pane.exited`: a pane vanishing under a durably running
node without a valid submission prompts the master with the `ui restore` command, while teardown
after a valid submission stays silent. A plugin startup hook raises one attention notification
after a herdr server restart or handoff when any run needs inspection. Board refresh and restore
observe all panes and agent statuses through one snapshot call rather than per-node probes.

Every authoritative mutation, including reconcile and destructive cleanup, is serialized by a
kernel-held per-run lock. Concurrent invocations wait and then observe the latest committed state.
Readers replay a missing, invalid, torn, stale, or divergent snapshot without writing. A locked
mutation repairs the snapshot before it proceeds.

`node-done` runs inside the provider sandbox. It writes only an authenticated completion envelope
beside the result in that attempt's submission directory. It does not acquire the run lock, read or
write authoritative run state, construct a surface, or call Herdr. `reconcile` consumes the
envelope, validates the active token and result, commits completion, and starts newly ready work.
Repeated submissions for the same token replace the same envelope; stale tokens are rejected during
reconciliation. Reconcile processes independent valid submissions before reporting malformed,
stale, or schema-invalid envelopes; its error names each exact envelope and the replace-or-remove
remedy. Trusted reads reject any agent or command result larger than 1 MiB before parsing,
journaling, input rendering, or CLI return. Command panes retain their authenticated `node-exit`
completion path and may crank synchronously because they are not provider-sandboxed.

While no master is active, already-running panes may finish and leave submissions in the transport
tree. The run is dormant until a later explicit reconcile consumes them. `status --wait` and
`events --follow` observe filesystem changes but do not schedule work.

Agent launch creates one implicit channel rooted at the exact token-addressed attempt submission
directory. Codex expresses that allowance as a launcher-owned permission profile. Claude expresses
it as a launcher-owned settings file inside the attempt transport directory — provider
configuration never rides the typed launch line, whose PTY input buffer is capped — and runs from
that exact directory under `dontAsk`, `--safe-mode`, sandboxed Bash only, exact completion rules,
and a required native sandbox with unsandboxed fallback disabled; only canonical declared source
prefixes are added as sandbox writes. Provider panes receive no write
capability to `runs/<id>`, including `state.json`, `events.json`, locks, workflow/UI snapshots,
receipts, or any other authoritative state. `danger-full-access` is not a valid workflow sandbox.
Validation and launch both reject a mutating provider sandbox root or write prefix whose resolved
path is equal to, below, or above the configured state root or installed Orchestrate control assets.
This includes custom `ORCHESTRATE_STATE_DIR` roots, all other submissions,
runtime versions, executable links, and installed provider skills. The exact token submission
directory injected by launch is the only completion write channel. Provider roots are canonicalized
before use; a pathname whose identity changes after preparation or a declared write prefix with a
symlink component is rejected before any Herdr workspace, tab, or pane creation. Existing Git
worktree targets are reused only when their canonical top level, common repository, and exact
expanded branch all match the runtime declaration.

When launch occurs inside a herdr agent pane, the run records the pane plus the provider session
ID. Herdr provides lifecycle event dispatch and the prompt transport for the trusted plugin wake.
The provider node receives neither Herdr control authority nor authoritative state access. A
foreground reconcile may also prompt that exact launching session
when the workflow completes or reaches actionable non-human attention: exhausted failure, gate,
downstream hold set at completion, revision, fuse, or round limit. Human pause and stop are intentionally silent
because their initiator already knows. The handoff contains only bounded orchestrator-generated
status and commands; node failure text remains in durable results. This direct prompt and its
notification fallback are best effort. There is no delivery outbox or exactly-once guarantee, so a
crash may lose or duplicate presentation without changing authoritative run state.

## Scheduling

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
Herdr agent status `done` is only a live observation: while durable status is `running`, it means
the authenticated result is missing and requires action; it never implies durable completion.
Interactive board refresh, `board --json`, and `runs --needs-attention` use the same classifier and
default-selection rule. Explicit blocked/done/gone observations need attention; idle, unknown, and
working states remain transient.

`pause` prevents new starts and allows live panes to finish. Pause kind is stored on each journal
event so handoff replay does not infer intent from later state. `resume` continues scheduling.
`stop` journals cancellation and settlement before best-effort pane cleanup. `ui restore` reconciles
recorded panes: live panes are adopted, explicitly missing in-flight attempts fail, and retry policy
is cranked. Herdr transport/service failures abort restore without treating a live pane as missing.

Retries reuse their placement slot after the old pane is closed. Command exit codes outside
`allowedExitCodes` fail an ordinary node. In a repeat condition, an allowed exit settles the repeat;
another numeric exit begins the next round. Provider failures use the same bounded retry path.
Repeated session resumes are copy-on-write: each attempt forks the alias's committed provider
session, a schema-valid success promotes that child and its pane source, and any failed attempt
leaves the parent head unchanged. A retry therefore forks the same committed parent. This protects
provider conversation lineage; it does not roll back source-workspace mutations performed by a
failed attempt.

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

## Gates and revisions

An approval gate stores the exact rendered prompt or command content and its digest. Approve with
both node ID and digest. Editing inputs changes the content and therefore requires a new digest.
The `gate.opened` event message contains the full paste-ready approve command, and `status` and the
non-interactive board mark a not-yet-started gated node with `approval gate ahead`.

`revise` validates a complete replacement workflow, checks immutable completed work and active
sessions, prints a structural summary, and stores the proposal. `approve --revision <digest>`
applies it atomically and journals the full workflow so replay also restores `workflow.json`.
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

## Herdr presentation

Every node is a real herdr pane. `placement.workspace` chooses the dedicated run workspace or the
launching origin workspace, independently from the ordered placement rules that choose tabs or
splits, group related nodes, cap splits per tab, and define retry reuse. Origin placement verifies
that the recorded origin pane still belongs to its workspace and falls back to the dedicated run
workspace when it does not. A recorded split anchor is verified immediately before creation.
Explicit `pane_not_found` falls back to a fresh tab in the selected origin or dedicated workspace;
transport failures abort with the planned intent intact and consume no retry. Board policy
separately chooses a right split, the current workspace,
or a dedicated workspace. Completion policy may close successful panes; focus policy may focus
only attention events or every start.

The interactive board refreshes on a bounded clock as well as journal writes, so elapsed time and
herdr garnish remain live. Herdr `idle` and `unknown` startup samples are transient. For a durably
running agent, `done` proves the provider finished without submitting `node-done`; the board shows
that node once in NEEDS YOU with its authenticated recovery command. `blocked` and an explicitly
missing pane also produce pane-related human attention.

Notifications are classified as attention, milestone, or progress and routed to herdr, the board,
or silence. Workflow callbacks can be a command, webhook, platform notification, or none. Callback
failure is reported but never rolls back state. These presentation routes are independent from the
launching-agent handoff.

Use a local herdr session unless a named remote can access identical checkout, state, provider,
and CLI paths. `ORCHESTRATE_DISABLE_UI=1` disables board auto-open and presentation notifications,
not pane execution.

## Build identity

The compiler embeds the exact version and source/asset build hash used by `--version`, journal
events, and state snapshots. Production code does not consult an ambient build-ID override, so a
subprocess cannot make one build read state created by another build.

## Cleanup

`clean --dry-run` lists panes, opted-in worktrees, and the run directory. Without dry-run it takes
the run lock, refuses an unsettled run, closes recorded panes, removes each Git worktree whose
declaration has `removeOnClean: true` only after revalidating its repository and exact expanded
branch, then removes run files. `setup --remove` first requires successful Herdr plugin unlink, then removes staged
product assets and owned links while retaining run state and preferences. Setup links the staged
plugin before flipping stable CLI/skill links; a link failure removes the new stage and leaves the
prior installation selected after confirmed rollback. If Herdr cannot confirm rollback, the
versioned stage remains so any partially registered plugin target is recoverable, while stable links
remain unchanged. `doctor` treats a missing/unqueryable plugin registration as unhealthy.

Preferences contain UI state only. Stored files are validated exactly against
`preferences.schema.json`; missing required fields, unknown design fields, and other schema-invalid
shapes fail without alternate parsing or rewrite.
