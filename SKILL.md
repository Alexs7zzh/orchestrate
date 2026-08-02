---
name: orchestrate
description: Design, preview, approve, and run validated declarative DAG workflows — multi-agent pipelines across Codex, Claude, commands, and adaptive supervisors. Use when explicitly requested, or when a complex task materially benefits from independent cold reviews, parallel branches, handoffs back to the original implementer context, background execution, or a bounded repeat-until-clean goal. Do not use for simple direct tasks, routine single-agent implementation, or ordinary one-pass review.
---

# Orchestrate

Use the current agent to design a workflow, obtain informed approval, then launch one background
controller that passes artifacts and sessions between nodes.

## Guard implicit activation

When activating implicitly:

- First tell the user why this task is a strong orchestration candidate.
- Use the skill only when multiple contexts, parallel branches, or adaptive continuation materially
  improve reliability. Do not use it merely because a task has several steps.
- Treat activation as permission to inspect and propose, never as permission to launch workers.
- If inspection shows that direct execution is better, say so and continue without Orchestrate.

Explicit invocation also starts in proposal mode. Never treat invocation itself as approval.

## Design and approve

1. Read applicable repository instructions. Inspect the VCS, workspace state, relevant files,
   provider CLIs, and constraints. Run `orchestrate prefs --project <cwd>` and treat its merged
   project/global view only as defaults to propose; it never authorizes skipping preview or
   escalating permissions.
2. Read [workflow-format.md](references/workflow-format.md), then design a complete declarative
   DAG for the actual task. Choose providers, models, effort, permissions, context strategy,
   workspaces, writes, resources, heartbeat, retries, and explicit nullable limits. Prefer an exact
   supported model name when it can be verified; use `provider-default` deliberately only when
   provider-managed selection is desired or an exact supported name cannot be established. For an
   interactive user session, propose `heartbeat.callback` `{ "type": "notification" }` rather than
   `{ "type": "none" }` unless the user opts out or the run is headless/CI: the harness wake path
   below resumes you, but the callback is the only channel that reaches the user while they are
   away.
3. Prefer fresh sessions for independent review or brainstorming. Resume the original implementer
   when its prior tradeoffs are valuable. Use provider-native forks only when supported.
4. Parallelize mutating nodes only after reasoning about file overlap, generated artifacts,
   services, locks, ports, and VCS operations. Use Git worktrees when appropriate; do not assume
   worktree support for Plastic SCM or other VCSs.
5. Use a supervisor only for an approved dynamic goal such as review-and-fix until no new issues
   are found. Give it a narrow envelope and explicit semantic success and convergence criteria.
6. Every node declares `gate`. Propose `"gate": "approval"` where a human checkpoint materially
   helps — above all before a node that consumes another node's generated task through `inputs`
   (for example a planner writes the next task and the human confirms the fully rendered prompt
   before it runs), or before a particularly consequential mutation. Keep `"gate": "none"` for
   ordinary nodes; a gate pauses the whole run until the rendered content is approved.
7. Every agent node declares `interactive`. Propose `"interactive": true` only for a node the user
   wants to co-drive live — typically an implementer or fix node where mid-task human steering is
   valuable. It runs as the provider's real TUI in a herdr pane (requires the herdr CLI) and
   completes only via its node-done prompt contract. NEVER make independent cold reviewers
   interactive: independence is the point, and a human-attended session destroys it. Everything
   else stays `"interactive": false`.
8. Write the workflow JSON to a stable path outside the repository's tracked files (for example a
   temp directory or `${ORCHESTRATE_STATE_DIR:-~/.local/state/orchestrate}/drafts/`); the digest
   binds that file's canonicalized content, so it must remain unchanged between preview and
   launch. Then validate and preview:

   ```bash
   orchestrate validate /path/to/workflow.json
   orchestrate preview /path/to/workflow.json
   ```

   If `orchestrate` is not on `PATH`, install it first per the install section of
   [runtime-operations.md](references/runtime-operations.md). Do not read
   `workflow.schema.json` up front; `orchestrate validate` already checks the file against it.
9. Give the user an approval brief derived from the validated workflow. Do not make them
   reconstruct the execution plan from `needs` arrays or read raw JSON. The brief must include:

   - A dependency-ordered execution map, grouped into stages or waves. Explicitly label nodes that
     are eligible to run in parallel, every join or synchronization gate, and what becomes eligible
     after the join. State the concurrency cap and any write, exclusive-resource, workspace, or
     session-lineage constraint that will serialize otherwise independent nodes.
   - For every node: its ID and task, node type, provider, configured model, effort, session mode,
     permissions, workspace/write scope, inputs it receives, result it produces or passes onward,
     retry/timeout behavior, and direct dependencies. Summarize deterministic command nodes with
     the command purpose rather than hiding them among agent steps.
   - A brief task-specific reason for each provider/model/effort choice and for fresh, resumed, or
     forked context. If the model is `provider-default`, explain why it was left provider-managed,
     say that the exact model is not fixed by this workflow and will be chosen by the provider, and
     never present it as a specific model.
   - Every node with `"gate": "approval"`, listed explicitly: where in the flow the run will pause,
     what rendered content the user will be asked to approve, and that the run waits until the gate
     is approved with its digest.
   - Every node with `"interactive": true`, listed explicitly: that it opens the provider's live
     TUI in a herdr pane the user can join, and that the run waits there until the session reports
     completion through its node-done contract (herdr CLI required).
   - Any supervisor loop as a separate adaptive phase: when it runs, what evidence ends it, what it
     may add, its round/time limits, and which changes would pause for new approval.
   - The critical artifact flow, declared mutations and isolation, relevant limits, notifications,
     material risks or warnings, and the point at which the workflow is complete.

   Use a compact tree, numbered stages, or a table that remains readable as plain text. For example,
   show parallel children beneath one stage and then an explicit `join -> next-stage` line. In
   Markdown-capable clients, use restrained **bold emphasis** for stage names, joins, approval
   gates, warnings, and completion criteria; use headings and whitespace to separate the execution
   map, node details, limits, and risks. Optimize for scanning without turning every label or table
   cell into emphasis. In a GUI known to support rendered Mermaid or a native workflow
   visualization, you may add a diagram, but never replace the plain-text brief with one. Do not
   create or execute a standalone JavaScript UI merely to request approval unless the user asks for
   that artifact.
10. Beneath the brief, show a concise approval record containing the workflow name and file path,
   approval digest, validation status, warnings, and any approval-sensitive flags or material
   choices. Do not paste the full CLI preview or digest-bound JSON by default; show either only when
   the user explicitly requests it or when a material choice cannot be represented accurately in
   the brief. The generated CLI preview and digest-bound JSON remain the authoritative source if a
   prose label is inconsistent. After any edit, rerun validation and preview, then regenerate the
   brief and approval record; do not reuse an old explanation or digest.
11. Invite natural-language changes and ask for explicit approval only after the user has both the
   brief and approval record. Do not launch while approval is ambiguous.
12. After approval, launch with the digest from the approval record, which must come directly from
   the latest generated preview:

   ```bash
   orchestrate run /path/to/workflow.json --approve <sha256>
   ```

   Use only that digest. It binds the canonicalized workflow content: any change to field values
   or structure — including one the user requested — changes it, while pure whitespace or
   key-order reformatting does not. After any edit, still rerun preview and obtain a new explicit
   approval; never recompute a digest to bypass this. Add `--allow-write-conflicts` only when the
   preview warned about an overlap and the user explicitly approved it.

## Continue safely

Runs are detached background jobs. After `run` or `resume`, Orchestrate automatically binds the
run to the current Codex or Claude session when that harness exposes a session ID. Its Stop hook
then waits without polling through model turns and creates one continuation when any owned run
finishes or pauses. On that continuation, inspect `orchestrate status <run-id>` and relevant node
results before continuing or reporting; `orchestrate report <run-id>` is the rendered
progress-and-needs-attention view to show the user, with bounded node results, supervisor rounds,
and the exact resume command for any pending decision. Multiple runs in one session remain
independently owned; each settled run produces at most one continuation, and later stops in the
same continuation chain keep delivering the remaining owned runs. A run that settles before the
hook starts is still delivered. While a session owns an unsettled run, the Stop hook intentionally
holds the session open at end-of-turn until a run settles or the hook times out; interrupting the
wait (for example with Esc) cancels only the wait — the registration survives and delivery retries
at the next stop.

Use the best supported harness path:

- **Codex CLI or desktop:** `orchestrate setup` installs or refreshes the global Stop hook because
  current Codex releases support global hooks but not plugin-scoped hooks. Restart Codex and
  approve the changed hook when prompted. Do not assume a background terminal or PTY completion
  will create a model turn.
- **Claude Code interactive:** install the complete skill folder so its validated
  `.claude-plugin` manifest and `hooks/hooks.json` load. The plugin Stop hook owns continuation;
  do not substitute an experimental Monitor or background Bash task. `--bare` skips hooks.
- **Headless/CI or a harness without hooks/session IDs:** use `orchestrate wait <run-id> --json`
  from the external supervisor that owns the session, then explicitly resume that session. In an
  interactive product with a native scheduled-task tool, a bounded one-minute status task is the
  fallback; delete it after a settled state. Never claim auto-wake when neither path exists.

When the user is watching interactively and has the herdr CLI installed, offer `--mirror` on
`run`/`resume`: it mirrors the run into read-only herdr panes (status watcher plus live node
output) and is presentation-only — never required, never affecting scheduling, digests, or outcome.

Run `orchestrate doctor` before the first launch after installation. If automatic detection is
unavailable but the harness exposes stable identifiers, register explicitly with
`orchestrate wake <run-id> --harness <codex|claude> --session <id>`. Use `--no-wake` only when the
user deliberately wants a detached run with no session continuation. `orchestrate watch <run-id>`
remains the live event log for a user or terminal; it is not the wake mechanism.

Callbacks notify the user, not the assistant. Report the run ID, heartbeat interval, and selected
wake path, then end the turn. Adaptive patches, user responses, limit overrides, write-conflict
overrides, and recovery each require their documented approval, and publishing or pushing this
work anywhere requires a separate explicit user request.

When the user asks to pause active work safely, use `orchestrate pause <run-id>`. This requests a
token-bound node-boundary pause: the controller stops scheduling new nodes, lets already-running
nodes finish without interruption, emits both pause callbacks, and settles into the ordinary
resumable `paused` state. `orchestrate resume <run-id>` then continues pending work without
replaying completed nodes. A pause request is only an acknowledgement until `status` reports
`paused`; use the current synchronous tool call with `orchestrate wait <run-id>` or the installed
Stop hook to receive that transition.

The user can also ask to pause a run and revise its remaining plan: edit a copy of the stored
`workflow.json` and propose it with `orchestrate revise <run-id> <file>` (executed nodes must stay
unchanged). A revision requires its own digest approval via
`orchestrate resume <run-id> --approve-revision <sha256>`, obtained exactly like every other
approval in this skill.

Do not use pause when the user wants execution terminated. `orchestrate stop <run-id>` remains the
immediate destructive operation: it cancels active nodes, delivers cancellation callbacks before
the terminal callback, settles `stopped`, and can never be resumed. Stop takes priority over a
pause that is still draining, and stopping an already-paused run finalizes it as non-resumable.

Read [runtime-operations.md](references/runtime-operations.md) before launching, monitoring,
pausing, resuming, recovering, stopping, or cleaning a run.

## Load references as needed

- Always read [workflow-format.md](references/workflow-format.md) before authoring or reviewing a
  workflow.
- Read [examples.md](references/examples.md) only when a concrete workflow pattern is useful.
- Read [runtime-operations.md](references/runtime-operations.md) only when operating the runtime.
- Use [workflow.schema.json](references/workflow.schema.json) as the machine-readable contract.
