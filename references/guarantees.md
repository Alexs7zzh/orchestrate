# Product guarantees

This document is the normative reliability and ownership contract for Orchestrate. If another
document describes a stronger implementation mechanism, this document wins.

## In this reference

- [Operating model](#operating-model)
- [Ownership](#ownership)
- [Guaranteed behavior](#guaranteed-behavior)
- [External side effects and crashes](#external-side-effects-and-crashes)
- [Background operation](#background-operation)

## Operating model

Orchestrate is an interactive, master-driven DAG coordinator for Herdr. Herdr is assumed to remain
available and internally consistent during ordinary operation. Orchestrate does not attempt to be a
fault-tolerant distributed system around Herdr.

The current master agent is the scheduler after the initial ready nodes start. `run` captures the
launching agent session; an explicit `resume` from another authenticated Herdr agent session
transfers wake ownership to that session. A resume from a non-agent terminal retains the prior
owner. When a workflow
agent becomes blocked or done, Herdr invokes the trusted Orchestrate plugin event hook. The hook maps
that pane to its live attempt and prompts the current master to reconcile a valid submission or
debug a missing one. The master runs `orchestrate reconcile` to validate submitted results, commit
transitions, and start newly ready work. If the master is not available, the run remains durably
dormant; unattended progression is not a default guarantee.
Already-running nodes may still finish and submit durable results while the run is dormant. The next
reconcile processes those submissions. A wake-up affects latency only: running `reconcile` at any
time is safe, and correctness never depends on receiving a wake-up.

## Ownership

- Herdr owns workspaces, tabs, panes, provider lifecycle observation, focus, plugin event dispatch,
  and the prompt transport used for master wake-up.
- Orchestrate owns the approved DAG and presentation contract, durable local run state,
  authenticated node submissions, dependency readiness, holds, gates, repeats, workroom/seat
  occupancy, and revisions.
- The master agent owns reconciliation, debugging, and recovery decisions.
- A human or master owns steering decisions. A steering message is clarification for one exact
  running attempt; it does not become workflow authority or transfer completion ownership.
- The owning workflow agent alone owns its declared task writes and exact token-addressed result
  submission. Provider-native delegation is disabled or denied; delegated workers cannot inherit
  or exercise that completion contract. It never writes authoritative run state or schedules
  another node.

## Guaranteed behavior

- YAML source is strictly parsed, normalized, expanded-schema/semantically validated, then
  domain-separated canonically digested before a run starts. Digests are recomputed at start,
  revision, and gate trust boundaries.
- Provider agents cannot write authoritative Orchestrate state, another attempt's submission, or
  installed control assets. Claude exposes only Bash; its required native sandbox is therefore the
  only provider filesystem channel, while Agent/Task delegation and built-in filesystem tools are
  absent from the tool surface.
- Both providers receive the same approved `read-only` or `workspace-write` intent. Focused
  provider adapters compile that intent into provider-native controls without making those controls
  authorable workflow fields. A persisted attempt capability binds the access intent as well as its
  provider and roots, so it cannot be reused after an access change even if the calculated write
  roots happen to be identical.
- Claude session projects are isolated per canonical lineage outside node submission transport;
  resume and fork reuse only their source lineage project, and a session-bearing peer receives no
  sibling-lineage or alternate completion-channel grant. Claude cannot read a sibling attempt or
  sibling lineage through sandboxed Bash, and has no alternate built-in filesystem channel.
- Both providers receive launcher-owned `TMPDIR`, `TMP`, and `TEMP` pointing to scratch inside only
  their token-scoped transport; ambient temp and undeclared workspace writes are not granted.
  Each launch is governed by one immutable, typed attempt capability manifest whose four canonical
  directory identities are pairwise distinct: launcher-owned read-only `control/`, launcher-projected
  read-only `inbox/`, provider-writable `outbox/`, and mode-0700 provider-writable `scratch/`.
  Provider policy, launch, projection, completion submission, and reconciliation consume those same
  identities; no provider receives a write grant to their common parent.
  Provider lookup and configuration use launcher-owned `PATH`, `HOME`, and provider control roots;
  authored agent environment cannot select a different executable or configuration directory. The
  compiled launch identity freezes an absolute, nonempty, unambiguous `PATH`, pins the provider's
  complete native or supported shebang/interpreter chain and exact fixed argv, and binds every
  executable plus every earlier lookup directory. Those identities and the canonical effective
  control roots are outside every mutating node's root and write authority and are
  revalidated before provider start.
- `node-done` requires the owner's declared nonempty token-local result, then records a strict,
  versioned token-addressed submission bound to that bounded read's raw-byte SHA-256 and length.
  It reads only the immutable attempt-local completion contract and exact no-follow result: it does
  not read workflow/run authority, acquire the run lock, call Herdr, or schedule. Reconciliation
  reloads the bound manifest and contract, independently verifies the exact result bytes before
  parsing, validates the live output schema and active attempt/token/path/status, and rejects stale
  tokens rather than applying them to another attempt.
- The trusted Herdr plugin event hook, not the provider sandbox, performs the best-effort,
  session-checked master wake for blocked and done workflow agents.
- Steering requires a running agent's exact latest attempt, recorded pane, provider, and persisted
  provider session to agree at inspection and delivery. Its requested and delivered journal records
  contain a SHA-256 and byte length, never the message or completion token. Steering cannot alter the
  approved task, access, escalation, graph, dependencies, output schema, or completion ownership.
- Concurrent `reconcile` invocations are serialized by the run lock. One commits while later
  invocations observe the committed state and either make the next valid transition or return
  cleanly.
- Each authoritative local transition is committed atomically before `reconcile` reports it as
  successful. If reconciliation is interrupted, the previously committed state remains readable and
  rerunning `reconcile` is safe.
- A successful node outcome and a downstream hold are separate facts. Releasing a hold never
  rewrites the historical outcome.
- Agents report only successful or failed completion. The trusted scheduler alone derives a
  zero-attempt `skipped` outcome from a digest-approved `when` condition; a missing JSON pointer
  pauses as a condition-contract error and never silently selects or skips work.
- A repeated resume attempt forks the committed provider-session head. Only a schema-valid success
  promotes the alias; failure and retry leave the prior head unchanged. This isolates conversation
  lineage, not arbitrary workspace writes made by an attempt.
- An approved workroom has ordered seats and explicit settlement anchors. A seatful node runs in
  its declared seat instead of ordinary matcher placement; retries and repeat instances reuse that
  seat, and a scheduler-owned skipped node never consumes or changes it. Active seat panes park
  until every anchor is durably completed or skipped, after which the effective completion
  preference either keeps them open and relabels them settled or closes them.
- Workrooms inherit the effective UI `placement.workspace` preference. Seatless supporting commands
  remain real, transient Herdr panes; presentation metadata does not create a headless execution
  path.
- A dead prompt-bearing receipt is never re-prompted under its old completion token. Reconciliation
  adopts its submission only with exact child-session attribution; otherwise retry uses a fresh
  token and the unchanged committed parent.
- Reconciliation adopts an unambiguous observed Herdr resource, defers a transient observation
  failure without consuming the intent, or reports human attention for contradictory occupancy.
  It does not silently guess after an ambiguous failure.
- An explicitly missing seat pane is restored inside its declared workroom tab only when live Herdr
  state identifies that workroom and seat unambiguously. Conflicting or ambiguous occupancy reports
  attention rather than moving the node through ordinary placement. Restoration preserves logical
  seat identity and workroom co-location; Herdr-owned physical geometry is best effort.
- While a seatful spawn's occupancy is unresolved, reconciliation starts no sibling seat in that
  workroom. It preserves every planned intent and retry budget while unrelated work may proceed.
- Explicit human pause, stop, hold, gate, revision, and repeat-limit decisions remain explicit.
- Plain `doctor` is read-only and launches no providers. `doctor --live` is an explicit billed
  operation bounded to three serial starts and a 180-second terminal deadline; the probe launches
  only after the read-only checks pass and is otherwise reported as skipped. In ordinary operation
  with Herdr available, every recorded diagnostic pane is closed and confirmed absent before return;
  success additionally removes its run and workspace. Failure retains evidence and never claims
  cleanup when a stop transition or pane-absence check fails.

## External side effects and crashes

Orchestrate state changes and Herdr actions are not one transaction. Pane creation, provider
prompting, and steering delivery are at-least-once operations, so a crash may produce a duplicate.
`steering.requested` can exist without known delivery, and delivery can occur before
`steering.delivered` is durably committed. Master wake-ups,
callbacks, and desktop notifications are best effort: they may be lost, and a retried foreground
operation may duplicate them. Nodes and callbacks should be idempotent where practical.

Orchestrate does not guarantee:

- autonomous scheduling while the master is unavailable;
- exactly-once pane creation, provider execution, prompting, steering, callbacks, or notifications;
- automatic recovery from a Herdr bug, Herdr restart, machine crash, forced process termination,
  filesystem failure, or ambiguous external side effect;
- automatic fresh-provider fallback or session-alias rebinding when an approved resume is
  unavailable;
- programmatic reconstruction of every external action after a failure.

These cases are expected to be rare. Recovery is agent-assisted: inspect durable Orchestrate state
and live Herdr state, debug the underlying problem, then run `orchestrate reconcile`. Reconcile
adopts an unambiguous pane or submission and retries an explicitly missing action. It stops and
explains when observation is ambiguous. The master or human chooses when destructive cleanup or an
ambiguous retry is appropriate.

## Background operation

The default product leaves no per-run process running after a foreground command returns and does
not persist presentation-delivery replay state. An optional unattended supervisor may be added
later as a separate mode with its own explicit guarantees; it is not part of the default contract.
