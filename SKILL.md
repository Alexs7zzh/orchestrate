---
name: orchestrate
description: Design, validate, approve, and run live, steerable workflow graphs on Herdr. Trigger only for role-to-role feedback loops, iterative or conditional cross-provider handoffs, branching beyond a single fan-out/fan-in stage, or requests to watch, inspect, or redirect concurrent workers mid-run, even if their topology is flat. Sharding plus final validation and retries never qualifies by itself. Linear chains are excluded.
---

# Orchestrate

Use Orchestrate only when the task is materially clearer or safer as an explicit graph.

## Workflow

1. Run `orchestrate doctor`; it verifies Herdr, the provider commands, state access, and the
   installed build. Stop and report if anything is unhealthy.
2. Inspect project instructions and the current working tree before designing writes.
3. Start from the validated patterns in `references/examples.md` and the semantic rules in
   `references/workflow-format.md`. Consult `references/workflow.schema.json` only when exact
   structural detail is needed.
4. Declare every dependency, input, workspace, write pattern, exclusive resource, permission,
   retry, gate, session relationship, repeat, presentation workroom, and execution limit explicitly.
5. Prefer concurrency 3. It limits simultaneous active node attempts and is a human-attention budget.
6. Run `orchestrate validate`, then `orchestrate preview`.
7. Present the objective, graph, mutation boundaries, permissions, repeat limits, presentation
   workrooms/seats, and preview digest as a readable prose walkthrough in your reply message —
   describe the nodes, dependencies, loops, providers, and models in words. Never paste raw
   workflow YAML or terminal preview output as the presentation, and never route approval through
   an interactive question tool: terminal output is often collapsed, so the human would be
   approving work they never saw. End your message after the walkthrough and wait for the human to
   reply. Do not start until the user approves that digest.
8. Start with `orchestrate run <file> --approve <digest>`. Report the run ID. Initial panes run
   independently. `node-done` writes only the authenticated submission; Herdr's trusted plugin event
   hook wakes the current wake-owning master when a workflow agent becomes blocked or done. An
   authenticated agent-pane `resume` transfers wake ownership to that agent's exact provider
   session; a non-agent resume preserves the current owner.
9. Run `orchestrate reconcile <run>` after a wake-up or at any time to consume submissions and start
   newly ready work. A missed wake only delays progress. Observe with `board`, `status --wait`, or
   `events --follow`, and read durable node output with `result`.
10. When a gate, round limit, fuse, write conflict, hold, failure, or revision needs judgment,
    explain the exact decision and use the dedicated command. Approval is always digest-bound.

## Authoring invariants

- Keep the graph static. If downstream work is unknowable, add a planner that emits
  schema-validated JSON and put an approval gate on the executor that consumes it.
- In `session`, create intentional provider lineage with `{fresh: alias}`, continue it with
  `{resume: alias}`, and fan it out with `{fork: alias}`. Resume and fork may add `saveAs` to name
  their resulting lineage. Persistent repeat sessions must resume an unconditional alias seeded
  outside the repeat.
- Use `shared` only for safe shared access, `existing` for an explicit directory, and
  `git-worktree` for isolated Git writes. Set `removeOnClean` deliberately.
- Declare the narrowest honest `workspace.writes` and all exclusive external resources. Never use
  `allow-with-approval` as a substitute for understanding overlapping writes.
- Use structured JSON results for machine decisions. The owning agent writes the declared result
  file and invokes the exact completion command embedded in its prompt before its final response.
  Delegated workers return evidence only and never write the result or invoke `node-done`.
- Use node `when` for an approved branch over a direct schema-validated JSON dependency. A false
  value becomes scheduler-owned `skipped`; a missing pointer pauses as a contract error and resume
  requires an approved condition change. Never ask an agent to assert scheduler state in free text.
- Set execution and escalation separately. Use `escalation: "deny"` for unattended nodes so an
  out-of-policy action fails instead of opening a human approval dialog. Use `ask-user` only when
  the approved workflow intentionally requires live human approvals.
- Do not add Orchestrate state paths or installed control assets to `workspace.writes` or provider
  arguments. The runtime supplies the exact completion channel automatically.
- Keep every mutating provider cwd, workspace path, sandbox root, and write prefix disjoint from
  Orchestrate state and installed control assets in both ancestor directions. For repeat Git
  worktrees, include `{{nodeId}}` in both the branch and any explicit path.
- Express iteration as a `repeat`: ordered members, a bounded `maxRounds`, and an objective
  `until` condition — a command's success or a named field in a verdict node's JSON result. Never
  unroll rounds into copied nodes. Use `{{round}}` only when a repeat prompt must name its round.
  A repeat-member `when` binds to the source in the same round and is reevaluated in every round;
  the verdict member must remain unconditional. Round extensions and acceptance are explicit human
  decisions.
- Use optional `presentation.workrooms` for stable human-facing review seats. Seatful nodes name a
  workroom and seat; seatless supporting nodes may name only the workroom. Nodes sharing a seat must
  be dependency-ordered, and every settlement anchor must be a non-repeat node downstream of every
  other workroom node. Workrooms add no dependency edges or permission/session authority, but they
  constrain validation, revision, and seat launch ordering.
- Holds control dependency release. Pausing prevents new panes but lets running panes finish.
  Stopping closes live panes and settles the run.
- Do not infer permission to commit, publish, deploy, send messages, or mutate systems outside the
  user-approved workflow.

## Preferences and setup

Use `orchestrate setup` for the staged CLI, this skill, and the required Herdr plugin. Inspect UI
preference origins with `ui show --origin` before changing them. The effective UI
`placement.workspace` preference selects `dedicated` or `origin` independently from ordered
tab/split rules; it is not a workflow-node field.

Use `ORCHESTRATE_DISABLE_UI=1` only to suppress presentation. Node execution still requires Herdr.
For a named Herdr remote, verify that checkout, provider commands, executable path, and state path
are all reachable from that remote before starting.

## Reference routing

- Start or adapt a workflow: `references/examples.md`.
- Author fields and cross-field semantics: `references/workflow-format.md`.
- Look up exact generated structure: `references/workflow.schema.json`.
- Operate or recover a run: `references/runtime-operations.md`.
- Resolve a reliability or ownership question: `references/guarantees.md`.
- Check exact commands, JSON, or exit codes: `references/cli-spec.md`.
