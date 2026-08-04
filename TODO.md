# TODO

Deferred work, scoped but not started.

## Notification burst coalescing

Reviewed 2026-08-03 and deliberately deferred: milestone-only default routing already
bounds bursts, and per-event callbacks must stay per-event for webhook consumers. Revisit
only if a real run produces notification spam with default preferences.

## Release pipeline dry run

`.github/workflows/release.yml` and `distribution/orchestrate.rb.in` have never executed in
CI. Run a dry tag or workflow-dispatch to validate compile, formula templating, and the
version-agreement checks on real runners.
