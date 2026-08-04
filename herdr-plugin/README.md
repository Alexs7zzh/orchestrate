# Orchestrate herdr plugin

A [herdr](https://herdr.dev) plugin for the [Orchestrate](../README.md) board and reversible run
controls.

It declares (see [herdr-plugin.toml](herdr-plugin.toml), requires herdr 0.7.5 or newer):

- **Pane `orchestrate.board`** — opens the OpenTUI board for the run needing attention, otherwise
  the latest run.
- **Action `orchestrate.pause-latest`** — `orchestrate pause` on the most recent active run
  (live panes keep running; no new pane starts).
- **Action `orchestrate.resume-latest`** — `orchestrate resume` on the most recent paused run.
  Max-round and fuse decisions remain explicit CLI operations.
- **Event `pane.agent_status_changed`** — routes blocked and done workflow-agent events through the
  trusted plugin bridge. The bridge prompts the captured master to reconcile a valid submission or
  debug a missing one without granting provider nodes Herdr control authority.
- **Events `pane.closed` and `pane.exited`** — when a pane hosting a durably running node
  disappears without a valid submission, the bridge prompts the captured master with the
  `orchestrate ui restore` command instead of leaving the run stalled until a human notices.
- **Startup hook** — after a herdr server restart or live handoff, `startup-attention` checks for
  runs needing attention and raises one desktop notification naming the run to inspect.

## Install

The supported plugin package targets macOS. `orchestrate setup` installs the bundled skill, links
this plugin, and binds its commands to the matching staged CLI so another `orchestrate` earlier on
`PATH` cannot take over plugin events. Linking the plugin directly from a checkout uses the
`orchestrate` command on `PATH`. Plugin registration is required: a link or unlink failure makes
setup/removal fail without silently reporting success, and `orchestrate doctor` reports the
registration unhealthy.

```bash
herdr plugin link /path/to/checkout/herdr-plugin   # local checkout
herdr plugin list
herdr plugin pane open --plugin orchestrate --entrypoint board
herdr plugin action list --plugin orchestrate
herdr plugin action invoke orchestrate.pause-latest
```

Uninstall with `orchestrate setup --remove` or `herdr plugin unlink orchestrate`.
