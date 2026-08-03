# Examples

## Two independent reviews and a synthesis

```json
{
  "name": "review-and-synthesize",
  "objective": "Review a change from two perspectives and write one decision.",
  "cwd": "/absolute/project",
  "concurrency": 3,
  "callback": { "type": "notification" },
  "milestones": true,
  "limits": { "maxStarts": 8 },
  "writeConflicts": "reject",
  "nodes": [
    {
      "id": "correctness",
      "type": "agent",
      "title": "Correctness review",
      "needs": [],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": [],
        "exclusiveResources": []
      },
      "inputs": [],
      "retry": { "maxAttempts": 2 },
      "gate": "none",
      "provider": "codex",
      "model": "provider-default",
      "effort": "high",
      "prompt": "Inspect the current change. Return concrete correctness findings.",
      "session": { "mode": "fresh", "from": null, "saveAs": null },
      "permissions": {
        "execution": { "sandbox": "read-only" },
        "escalation": "deny",
        "extraArgs": [],
        "inheritEnv": [],
        "env": {}
      },
      "output": { "format": "text", "schema": null }
    },
    {
      "id": "usability",
      "type": "agent",
      "title": "Usability review",
      "needs": [],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": [],
        "exclusiveResources": []
      },
      "inputs": [],
      "retry": { "maxAttempts": 2 },
      "gate": "none",
      "provider": "claude",
      "model": "provider-default",
      "effort": null,
      "prompt": "Inspect the current change. Return concrete usability findings.",
      "session": { "mode": "fresh", "from": null, "saveAs": null },
      "permissions": {
        "execution": { "permissionMode": "dontAsk" },
        "escalation": "deny",
        "extraArgs": [],
        "inheritEnv": [],
        "env": {}
      },
      "output": { "format": "text", "schema": null }
    },
    {
      "id": "synthesis",
      "type": "agent",
      "title": "Synthesize",
      "needs": ["correctness", "usability"],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": [],
        "exclusiveResources": []
      },
      "inputs": [
        { "from": "correctness", "as": "correctness", "include": "content", "round": "current" },
        { "from": "usability", "as": "usability", "include": "content", "round": "current" }
      ],
      "retry": { "maxAttempts": 1 },
      "gate": "none",
      "provider": "codex",
      "model": "provider-default",
      "effort": "medium",
      "prompt": "Reconcile the reviews into one prioritized decision.",
      "session": { "mode": "fresh", "from": null, "saveAs": null },
      "permissions": {
        "execution": { "sandbox": "read-only" },
        "escalation": "deny",
        "extraArgs": [],
        "inheritEnv": [],
        "env": {}
      },
      "output": { "format": "text", "schema": null }
    }
  ],
  "repeats": []
}
```

For implementation, give a mutating node an isolated `git-worktree`, a narrow `writes` list, and a
branch such as `orchestrate/{{runId}}/{{nodeId}}`. For plan-dependent execution, make a planner emit
schema-validated JSON, feed it to an executor through `inputs`, and set the executor gate to
`approval`.

## Put node tabs in the launching workspace

Workspace destination and node surface are separate UI preferences. This project layer sends node
panes to the live launching workspace while preserving first-match-wins node-specific tab/split
rules. If that origin pane disappears, Orchestrate creates or reuses the dedicated run workspace.

```bash
orchestrate ui set placement.workspace '"origin"' --project /absolute/project
orchestrate ui set placement.rules '[
  {"match":{"type":"agent","provider":"any","level":"any","origin":"any","id":"review-*"},"surface":"split"},
  {"match":{"type":"any","provider":"any","level":"any","origin":"any","id":"*"},"surface":"tab"}
]' --project /absolute/project
```
