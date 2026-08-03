# TODO

Deferred work, scoped but not started. Ordered by risk.

## Herdr 0.7.5 feature adoption

From the 2026-08-03 herdr audit (herdr 0.7.5; adopting any item below requires bumping
`MINIMUM_HERDR` in `scripts/src/herdr-surface.ts` and `min_herdr_version` in
`herdr-plugin/herdr-plugin.toml` from 0.7.0 to 0.7.5). Everything else audited — notification
path, `[[events]]` usage, pane/tab/agent flags, hand-rolled worktrees — is already current.

1. Board/status polling spawns two herdr processes per running node per refresh
   (`board.ts` `observePaneGarnish`, `ui restore` loop). One `herdr api snapshot` (or
   `herdr agent list`) returns all agents, panes, and statuses in a single consistent call.
   High value, small-medium effort.
2. Subscribe the plugin to `pane.closed` / `pane.exited` events so a dying pane triggers
   reconciliation instead of waiting for a human `ui restore`. The `herdr-event` bridge
   needs a dispatch branch beyond `pane.agent_status_changed`. High value, medium effort.
3. Replace the fixed 1.5s done-flap sleep in `crank.ts` with
   `herdr agent wait <pane> --until working --timeout 1500` (event-driven, returns early).
   The session-id poll and shell-ready retry loops stay — no herdr primitive covers them.
   Small effort.
4. Use `agent prompt --wait --until working` (atomic, distinct `agent_prompt_stalled`
   error) to turn most "ambiguous prompt delivery" receipts into definite success/failure.
   Effort is in receipt semantics, not the call.
5. Add a `[[startup]]` plugin hook (fires after herdr server restart/handoff) that runs a
   restore-style reconcile — the moments panes vanish in bulk. Pairs with item 2.

## Interactive setup wizard redesign

Design proposal pending user approval (2026-08-03): simulation-based wizard where a demo
workflow tree previews notification levels live, and an ASCII herdr sketch previews
placement choices. Implement only after the design is approved.

## Notification burst coalescing

Reviewed 2026-08-03 and deliberately deferred: milestone-only default routing already
bounds bursts, and per-event callbacks must stay per-event for webhook consumers. Revisit
only if a real run produces notification spam with default preferences.

## Release pipeline dry run

`.github/workflows/release.yml` and `distribution/orchestrate.rb.in` have never executed in
CI. Run a dry tag or workflow-dispatch to validate compile, formula templating, and the
version-agreement checks on real runners.
