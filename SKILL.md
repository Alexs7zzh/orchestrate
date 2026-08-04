---
name: orchestrate
description: Design, validate, approve, and run explicit multi-agent DAG workflows in Herdr panes. Use when the requested work is shaped like a graph or loop rather than one straight run - multiple agent steps with handoffs or dependencies between them, repeating steps until a condition or agreement is reached, bounded rounds of rework, independent parallel branches merged later, or deliberate context control such as keeping a stable agent session across steps versus starting a fresh one - especially across multiple agents or providers (such as Codex and Claude reviewing each other). Do not use for a simple one-agent task.
---

# Orchestrate

Use Orchestrate only when the task is materially clearer or safer as an explicit graph.

## Workflow

1. Run `orchestrate doctor`; it verifies herdr, the provider commands, state access, and the
   installed build. Stop and report if anything is unhealthy.
2. Inspect project instructions and the current working tree before designing writes.
3. Write a complete workflow JSON document using `references/workflow.schema.json`.
4. Declare every dependency, input, workspace, write pattern, exclusive resource, permission,
   retry, gate, session relationship, repeat, and execution limit explicitly.
5. Prefer concurrency 3. It limits simultaneous active node attempts and is a human-attention budget.
6. Run `orchestrate validate`, then `orchestrate preview`.
7. Present the objective, graph, mutation boundaries, permissions, repeat limits, and preview
   digest as a readable prose walkthrough in your reply message — describe the nodes,
   dependencies, loops, providers, and models in words. Never paste raw workflow JSON or terminal
   preview output as the presentation, and never route approval through an interactive question
   tool: terminal output is often collapsed, so the human would be approving work they never saw.
   End your message after the walkthrough and wait for the human to reply. Do not start until the
   user approves that digest.
8. Start with `orchestrate run <file> --approve <digest>`. Report the run ID. Initial panes run
   independently. `node-done` writes only the authenticated submission; Herdr's trusted plugin event
   hook wakes the launching master when a workflow agent becomes blocked or done.
9. Run `orchestrate reconcile <run>` after a wake-up or at any time to consume submissions and start
   newly ready work. A missed wake only delays progress. Observe with `board`, `status --wait`, or
   `events --follow`, and read durable node output with `result`.
10. When a gate, round limit, fuse, write conflict, hold, failure, or revision needs judgment,
    explain the exact decision and use the dedicated command. Approval is always digest-bound.

## Design rules

- Keep the graph static. If downstream work is unknowable, add a planner that emits
  schema-validated JSON and put an approval gate on the executor that consumes it.
- Use `session.saveAs` and `session.from` only for intentional provider lineage. A fork preserves
  the source and creates a new session; resume continues the source.
- Use `shared` only for safe shared access, `existing` for an explicit directory, and
  `git-worktree` for isolated Git writes. Set `removeOnClean` deliberately.
- Declare the narrowest honest `workspace.writes` and all exclusive external resources. Never use
  `allow-with-approval` as a substitute for understanding overlapping writes.
- Use structured JSON results for machine decisions. Agent nodes write the declared result file
  and invoke the exact completion command embedded in their prompt.
- Set execution and escalation separately. Use `escalation: "deny"` for unattended nodes so an
  out-of-policy action fails instead of opening a human approval dialog. Use `ask-user` only when
  the approved workflow intentionally requires live human approvals.
- Do not add Orchestrate state paths to `workspace.writes` or provider arguments. Agent panes
  automatically receive write access only to a token-addressed attempt submission directory outside
  authoritative run state. `node-done` writes an envelope there; the launching master validates and
  commits it with `reconcile`, then schedules newly ready work. Use `node-done --hold` to submit
  `completed` with a separate downstream hold for one reconciliation transaction.
- Keep every mutating provider cwd, workspace path, sandbox root, and write prefix disjoint from
  Orchestrate state and installed control assets in both ancestor directions. For repeat Git
  worktrees, include `{{nodeId}}` in both the branch and any explicit path.
- Express iteration as a `repeat`: ordered members, a bounded `maxRounds`, and an objective
  `until` condition — a command's success or a named field in a verdict node's JSON result. Never
  unroll rounds into copied nodes; the board folds repeat rounds into one aligned group, while
  copies render as an ever-deepening chain. Round extensions and acceptance are explicit human
  decisions.
- Holds control dependency release. Pausing prevents new panes but lets running panes finish.
  Stopping closes live panes and settles the run.
- A human pause or stop does not prompt the launching agent. Completion, exhausted failure, gates,
  downstream holds set at completion, revisions, fuses, and round limits do.
- Do not infer permission to commit, publish, deploy, send messages, or mutate systems outside the
  user-approved workflow.

## Preferences and setup

Use `orchestrate setup` for the staged CLI, this skill, and the required herdr plugin. Link/unlink
failure makes setup/removal fail, and `doctor` reports a missing registration as unhealthy. Use `ui show --origin`
before changing UI behavior. Project preferences override global preferences, which override
built-in defaults. Node `placement.workspace` selects `dedicated` or `origin` independently from
the ordered tab/split rules; a missing live origin falls back to the dedicated run workspace.
`ORCHESTRATE_DISABLE_PREFS=1` disables preference reads and writes.

Use `ORCHESTRATE_DISABLE_UI=1` only to suppress presentation. Node execution still requires herdr.
For a named herdr remote, verify that checkout, provider commands, executable path, and state path
are all reachable from that remote before starting.

## References

- `references/workflow.schema.json`
- `references/guarantees.md`
- `references/workflow-format.md`
- `references/runtime-operations.md`
- `references/cli-spec.md`
- `references/examples.md`
