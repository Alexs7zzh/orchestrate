# Orchestrate herdr plugin

A [herdr](https://herdr.dev) plugin for the [Orchestrate](../README.md) board and reversible run
controls.

It declares (see [herdr-plugin.toml](herdr-plugin.toml), validated against herdr 0.7.x):

- **Pane `orchestrate.board`** — opens the OpenTUI board for the run needing attention, otherwise
  the latest run.
- **Action `orchestrate.pause-latest`** — `orchestrate pause` on the most recent active run
  (live panes keep running; no new pane starts).
- **Action `orchestrate.resume-latest`** — `orchestrate resume` on the most recent paused run.
  Max-round and fuse decisions remain explicit CLI operations.
- **Event `pane.agent_status_changed`** — routes blocked and done workflow-agent events through the
  trusted plugin bridge. The bridge prompts the captured master to reconcile a valid submission or
  debug a missing one without granting provider nodes Herdr control authority.

## Install

The supported plugin package targets macOS. It requires the `orchestrate` command on `PATH` and
herdr 0.7 or newer. `orchestrate setup` installs
the bundled skill and links this plugin. Plugin registration is required: a link or unlink failure
makes setup/removal fail without silently reporting success, and `orchestrate doctor` reports the
registration unhealthy.

```bash
herdr plugin link /path/to/skill/herdr-plugin   # local checkout
herdr plugin list
herdr plugin pane open --plugin orchestrate --entrypoint board
herdr plugin action list --plugin orchestrate
herdr plugin action invoke orchestrate.pause-latest
```

Uninstall with `orchestrate setup --remove` or `herdr plugin unlink orchestrate`.
