# Workflow examples

Replace paths, prompts, providers, models, permissions, and commands based on the actual request.
Examples illustrate structure; they are not model or safety defaults.

## Implement, cold-review in parallel, adjudicate, fix, verify

```json
{
  "version": 1,
  "name": "implement-review-fix",
  "objective": "Implement the requested change, independently review it, adjudicate findings in the original implementer context, fix accepted issues, and verify the result.",
  "cwd": "/absolute/path/to/project",
  "concurrency": 2,
  "heartbeat": {
    "intervalMinutes": 12,
    "milestones": true,
    "callback": { "type": "notification" }
  },
  "limits": {
    "nodeWallTimeMinutes": null,
    "workflowWallTimeMinutes": null,
    "maxAgentStarts": null,
    "maxGoalRounds": null
  },
  "writeConflicts": "reject",
  "nodes": [
    {
      "id": "implement",
      "type": "agent",
      "title": "Implement",
      "needs": [],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": ["src/**", "test/**"],
        "exclusiveResources": []
      },
      "inputs": [],
      "timeoutMinutes": null,
      "retry": { "maxAttempts": 1, "delaySeconds": 0 },
      "gate": "none",
      "provider": "codex",
      "model": "provider-default",
      "effort": "high",
      "prompt": "Implement the approved task. Follow repository instructions, keep the change scoped, and report the changed files and validation.",
      "session": {
        "mode": "fresh",
        "from": null,
        "saveAs": "implementer",
        "retain": true,
        "reuseOnRepeat": false
      },
      "permissions": {
        "sandbox": "workspace-write",
        "extraArgs": [],
        "inheritEnv": ["PATH", "HOME", "CODEX_HOME"],
        "env": {}
      },
      "output": { "format": "text", "schema": null },
      "interactive": false
    },
    {
      "id": "codex-review",
      "type": "agent",
      "title": "Cold Codex review",
      "needs": ["implement"],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": [],
        "exclusiveResources": []
      },
      "inputs": [{ "from": "implement", "as": "Implementation report", "include": "content" }],
      "timeoutMinutes": null,
      "retry": { "maxAttempts": 1, "delaySeconds": 0 },
      "gate": "none",
      "provider": "codex",
      "model": "provider-default",
      "effort": "high",
      "prompt": "Review the implementation independently. Inspect the actual diff and code. Report only concrete issues with evidence.",
      "session": {
        "mode": "fresh",
        "from": null,
        "saveAs": null,
        "retain": false,
        "reuseOnRepeat": false
      },
      "permissions": {
        "sandbox": "read-only",
        "extraArgs": [],
        "inheritEnv": ["PATH", "HOME", "CODEX_HOME"],
        "env": {}
      },
      "output": { "format": "text", "schema": null },
      "interactive": false
    },
    {
      "id": "claude-review",
      "type": "agent",
      "title": "Cold Claude review",
      "needs": ["implement"],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": [],
        "exclusiveResources": []
      },
      "inputs": [{ "from": "implement", "as": "Implementation report", "include": "content" }],
      "timeoutMinutes": null,
      "retry": { "maxAttempts": 1, "delaySeconds": 0 },
      "gate": "none",
      "provider": "claude",
      "model": "provider-default",
      "effort": "high",
      "prompt": "Review the implementation independently. Inspect the actual diff and code. Report only concrete issues with evidence.",
      "session": {
        "mode": "fresh",
        "from": null,
        "saveAs": null,
        "retain": false,
        "reuseOnRepeat": false
      },
      "permissions": {
        "permissionMode": "plan",
        "extraArgs": [],
        "inheritEnv": ["PATH", "HOME", "CLAUDE_CONFIG_DIR"],
        "env": {}
      },
      "output": { "format": "text", "schema": null },
      "interactive": false
    },
    {
      "id": "adjudicate",
      "type": "agent",
      "title": "Adjudicate reviews",
      "needs": ["codex-review", "claude-review"],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": [],
        "exclusiveResources": []
      },
      "inputs": [
        { "from": "codex-review", "as": "Codex review", "include": "content" },
        { "from": "claude-review", "as": "Claude review", "include": "content" }
      ],
      "timeoutMinutes": null,
      "retry": { "maxAttempts": 1, "delaySeconds": 0 },
      "gate": "none",
      "provider": "codex",
      "model": "provider-default",
      "effort": "high",
      "prompt": "Evaluate each finding against the implementation and original tradeoffs. Classify it as accepted or rejected with evidence, then state the exact fixes needed.",
      "session": {
        "mode": "resume",
        "from": "implementer",
        "saveAs": "implementer-after-review",
        "retain": true,
        "reuseOnRepeat": false
      },
      "permissions": {
        "sandbox": "read-only",
        "extraArgs": [],
        "inheritEnv": ["PATH", "HOME", "CODEX_HOME"],
        "env": {}
      },
      "output": { "format": "text", "schema": null },
      "interactive": false
    },
    {
      "id": "fix",
      "type": "agent",
      "title": "Fix accepted findings",
      "needs": ["adjudicate"],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": ["src/**", "test/**"],
        "exclusiveResources": []
      },
      "inputs": [{ "from": "adjudicate", "as": "Review adjudication", "include": "content" }],
      "timeoutMinutes": null,
      "retry": { "maxAttempts": 1, "delaySeconds": 0 },
      "gate": "none",
      "provider": "codex",
      "model": "provider-default",
      "effort": "high",
      "prompt": "Apply the accepted fixes only. Preserve the requested scope and report the final changes.",
      "session": {
        "mode": "resume",
        "from": "implementer-after-review",
        "saveAs": "implementer-final",
        "retain": true,
        "reuseOnRepeat": false
      },
      "permissions": {
        "sandbox": "workspace-write",
        "extraArgs": [],
        "inheritEnv": ["PATH", "HOME", "CODEX_HOME"],
        "env": {}
      },
      "output": { "format": "text", "schema": null },
      "interactive": false
    },
    {
      "id": "verify",
      "type": "command",
      "title": "Verify",
      "needs": ["fix"],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": [],
        "exclusiveResources": ["build"]
      },
      "inputs": [],
      "timeoutMinutes": null,
      "retry": { "maxAttempts": 1, "delaySeconds": 0 },
      "gate": "none",
      "mutates": false,
      "argv": ["bun", "test"],
      "inheritEnv": ["PATH", "HOME"],
      "env": {},
      "allowedExitCodes": [0]
    }
  ]
}
```

## Adaptive cold-review loop

After an implementation and initial verification, add a `supervisor` whose prompt asks it to:

1. Return `complete` only when verification passes and the latest fresh review has no actionable
   findings.
2. Otherwise return `continue` with a new disposable cold-review node, an implementer-resume fix
   node, and a verification command node.
3. Use unique node IDs and dependencies for each round.
4. Return `pause` when product judgment or authority outside its envelope is required.

Set the supervisor session to a retained alias with `reuseOnRepeat: true` if continuity helps its
adjudication. Keep each cold reviewer fresh and disposable if independence is the point of the
loop.

When a planner or adjudicator node writes the task for the next node (delivered through `inputs`),
set that consuming node's `"gate": "approval"` so the human confirms the fully rendered prompt —
the fixed prompt frame plus the generated task — before it runs. For example, gate the fix node
that consumes the adjudication:

```json
{
  "id": "fix",
  "gate": "approval",
  "inputs": [{ "from": "adjudicate", "as": "Review adjudication", "include": "content" }]
}
```

Every other node keeps `"gate": "none"`; a gate is an explicit human checkpoint, not a default.

## Callback recipe: audible alert instead of a desktop notification

When the user prefers a sound over a notification banner, use a `command` callback (macOS shown;
on Linux substitute e.g. `paplay` with a sound file):

```json
{
  "heartbeat": {
    "intervalMinutes": null,
    "milestones": false,
    "callback": {
      "type": "command",
      "argv": ["afplay", "/System/Library/Sounds/Glass.aiff"],
      "timeoutSeconds": 15
    }
  }
}
```

The command runs detached from any terminal, so terminal-directed alerts (BEL, OSC sequences) do
not work here; use sounds, `notification`, or a `webhook`.
