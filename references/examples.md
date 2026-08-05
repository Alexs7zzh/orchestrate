# Examples

Examples are illustrative, validated authoring patterns. The semantic contract lives in
[workflow-format.md](workflow-format.md), and exact structure lives in the generated
[workflow.schema.json](workflow.schema.json).

## In this reference

- [Persistent paired review with a conditional response](#persistent-paired-review-with-a-conditional-response)
- [Simple fan-out and fan-in CLI illustration](#simple-fan-out-and-fan-in-cli-illustration)
- [Put node tabs in the launching workspace](#put-node-tabs-in-the-launching-workspace)

## Persistent paired review with a conditional response

This is the kind of iterative role-to-role workflow for which the Orchestrate agent skill is
intended. Two provider sessions are seeded once, keep stable workroom seats, and resume across a
bounded repeat. The implementer response is scheduler-skipped when the review reports no findings;
the unconditional review result decides whether another round is needed. The seatless
`settle` command is downstream of every other workroom node and is therefore a valid settlement
anchor.

```json
{
  "name": "persistent-paired-review",
  "objective": "Review one change until the reviewer and implementer agree it is clean.",
  "cwd": "/absolute/project",
  "concurrency": 2,
  "callback": { "type": "notification" },
  "milestones": true,
  "limits": { "maxStarts": 20 },
  "writeConflicts": "reject",
  "presentation": {
    "workrooms": [
      {
        "id": "review-room",
        "label": "Paired review",
        "layout": "columns",
        "seats": [
          { "id": "implementer-seat", "label": "Implementer" },
          { "id": "reviewer-seat", "label": "Reviewer" }
        ],
        "settlesOn": ["settle"]
      }
    ]
  },
  "nodes": [
    {
      "id": "seed-implementer",
      "type": "agent",
      "title": "Seed implementer protocol",
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
      "retry": { "maxAttempts": 1 },
      "gate": "none",
      "workroom": "review-room",
      "seat": "implementer-seat",
      "provider": "codex",
      "model": "provider-default",
      "effort": "medium",
      "prompt": "Learn paired review. RESPOND classifies each finding AGREE or REJECT. Return READY.",
      "session": { "mode": "fresh", "from": null, "saveAs": "implementer" },
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
      "id": "seed-reviewer",
      "type": "agent",
      "title": "Seed reviewer protocol",
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
      "retry": { "maxAttempts": 1 },
      "gate": "none",
      "workroom": "review-room",
      "seat": "reviewer-seat",
      "provider": "claude",
      "model": "provider-default",
      "effort": null,
      "prompt": "Learn paired review. REVIEW emits done, hasFindings, and findings. Set done only when clean.",
      "session": { "mode": "fresh", "from": null, "saveAs": "reviewer" },
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
      "id": "review",
      "type": "agent",
      "title": "Review round",
      "needs": ["seed-implementer", "seed-reviewer"],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": [],
        "exclusiveResources": []
      },
      "inputs": [
        { "from": "respond", "as": "previous-response", "include": "content", "round": "previous" }
      ],
      "retry": { "maxAttempts": 2 },
      "gate": "none",
      "workroom": "review-room",
      "seat": "reviewer-seat",
      "provider": "claude",
      "model": "provider-default",
      "effort": null,
      "prompt": "REVIEW r{{round}}",
      "session": { "mode": "resume", "from": "reviewer", "saveAs": null },
      "permissions": {
        "execution": { "permissionMode": "dontAsk" },
        "escalation": "deny",
        "extraArgs": [],
        "inheritEnv": [],
        "env": {}
      },
      "output": {
        "format": "json",
        "schema": {
          "type": "object",
          "properties": {
            "done": { "type": "boolean" },
            "hasFindings": { "type": "boolean" },
            "findings": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["done", "hasFindings", "findings"],
          "additionalProperties": false
        }
      }
    },
    {
      "id": "respond",
      "type": "agent",
      "title": "Respond to findings",
      "needs": ["review"],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": [],
        "exclusiveResources": []
      },
      "inputs": [{ "from": "review", "as": "review", "include": "content", "round": "current" }],
      "retry": { "maxAttempts": 2 },
      "gate": "none",
      "when": {
        "type": "agent-output",
        "node": "review",
        "pointer": "/hasFindings",
        "equals": true
      },
      "workroom": "review-room",
      "seat": "implementer-seat",
      "provider": "codex",
      "model": "provider-default",
      "effort": "medium",
      "prompt": "RESPOND r{{round}}",
      "session": { "mode": "resume", "from": "implementer", "saveAs": null },
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
      "id": "settle",
      "type": "command",
      "title": "Settle review workroom",
      "needs": ["review"],
      "cwd": null,
      "workspace": {
        "mode": "shared",
        "path": null,
        "vcs": "git",
        "writes": [],
        "exclusiveResources": []
      },
      "inputs": [],
      "retry": { "maxAttempts": 1 },
      "gate": "none",
      "workroom": "review-room",
      "argv": ["/usr/bin/true"],
      "mutates": false,
      "inheritEnv": [],
      "env": {},
      "allowedExitCodes": [0]
    }
  ],
  "repeats": [
    {
      "id": "review-loop",
      "members": ["review", "respond"],
      "maxRounds": 3,
      "until": {
        "type": "agent-output",
        "node": "review",
        "pointer": "/done",
        "equals": true
      }
    }
  ]
}
```

## Simple fan-out and fan-in CLI illustration

The CLI supports this shape, but one fan-out/fan-in stage alone does not normally justify invoking
the Orchestrate agent skill. This complete file is useful for learning the base node fields.

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
