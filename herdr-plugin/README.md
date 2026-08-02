# Orchestrate herdr plugin

A minimal [herdr](https://herdr.dev) plugin for [Orchestrate](../README.md). Everything it does is
read-only rendering or node-boundary control through the `orchestrate` CLI; it never sends input
to provider processes.

It declares (see [herdr-plugin.toml](herdr-plugin.toml), validated against herdr 0.7.x):

- **Pane `orchestrate:runs`** — opens a tab running [`bin/orchestrate-panel`](bin/orchestrate-panel),
  which picks the run that most needs attention (most recent paused run, else the most recent
  active run, else the newest run), prints `orchestrate report <run-id>`, and follows an active run
  with `orchestrate watch` until it settles or pauses.
- **Action `orchestrate:pause-latest`** — `orchestrate pause` on the most recent active run
  (node-boundary pause; running nodes finish normally).
- **Action `orchestrate:resume-latest`** — `orchestrate resume` on the most recent paused run.
  This only resumes a plain pause: pending adaptive patches, approval gates, supervisor input, and
  limit overrides intentionally still require their explicit digest-bound flags from a session
  where a human reviewed them.

## Install

Requires the `orchestrate` command on `PATH` (`node <skill-dir>/scripts/orchestrate.mjs setup`
creates `~/.local/bin/orchestrate`).

```bash
herdr plugin link /path/to/skill/herdr-plugin   # local checkout
herdr plugin list
herdr plugin pane open --plugin orchestrate --entrypoint runs
herdr plugin action list --plugin orchestrate
herdr plugin action invoke orchestrate.pause-latest
```

Uninstall with `herdr plugin unlink orchestrate`.

## Related: mirror mode

Independently of this plugin, `orchestrate run/resume --mirror` mirrors a run into read-only herdr
panes (workspace per run, status watcher, live node output). See
[references/runtime-operations.md](../references/runtime-operations.md), section "Mirror a run
into herdr".
