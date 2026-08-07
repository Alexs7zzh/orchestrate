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
anchor. Findings keep stable IDs across rounds and explicitly move through `new`, `recurring`, and
`resolved`. If the loop reaches its bound, inspect that trend and the structural assessment before
deciding whether to revise or extend it; do not extend the loop just to pursue stylistic churn.

```yaml
name: persistent-paired-review
objective: Review one change until the reviewer and implementer agree it is clean.
cwd: /absolute/project
concurrency: 2
callback:
  type: notification
milestones: true
limits:
  maxStarts: 20
writeConflicts: reject
presentation:
  workrooms:
    - id: review-room
      label: Paired review
      layout: columns
      seats:
        - id: implementer-seat
          label: Implementer
        - id: reviewer-seat
          label: Reviewer
      settlesOn:
        - settle
nodes:
  - id: seed-implementer
    title: Seed implementer protocol
    needs: []
    workroom: review-room
    seat: implementer-seat
    cwd: null
    workspace:
      mode: shared
      path: null
      vcs: git
      writes: []
      exclusiveResources: []
    inputs: []
    retry:
      maxAttempts: 1
    gate: none
    agent: codex
    prompt: >
      You are the implementation-side collaborator in a paired review. Verify each substantive
      finding against the code and explain whether you agree, disagree, or need more evidence.
      Preserve the reviewer's stable finding IDs. Return READY after learning this role.
    model: provider-default
    effort: medium
    access: read-only
    escalation: deny
    extraArgs: []
    inheritEnv: []
    env: {}
    output:
      format: text
    session:
      fresh: implementer
  - id: seed-reviewer
    title: Seed reviewer protocol
    needs: []
    workroom: review-room
    seat: reviewer-seat
    cwd: null
    workspace:
      mode: shared
      path: null
      vcs: git
      writes: []
      exclusiveResources: []
    inputs: []
    retry:
      maxAttempts: 1
    gate: none
    agent: claude
    prompt: >
      You are the independent reviewer in a paired review. Report only behaviorally meaningful
      correctness, security, or contract issues with concrete evidence. Give each finding a stable
      ID and carry it across rounds as new, recurring, or resolved. Return READY after learning
      this role.
    model: provider-default
    access: read-only
    escalation: deny
    extraArgs: []
    inheritEnv: []
    env: {}
    output:
      format: text
    session:
      fresh: reviewer
  - id: review
    title: Review round
    needs:
      - seed-implementer
      - seed-reviewer
    workroom: review-room
    seat: reviewer-seat
    cwd: null
    workspace:
      mode: shared
      path: null
      vcs: git
      writes: []
      exclusiveResources: []
    inputs:
      - from: respond
        as: previous-response
        include: content
        round: previous
    retry:
      maxAttempts: 2
    gate: none
    agent: claude
    prompt: >
      Here is the implementer's latest response, when one exists. Review the current implementation
      and verify the response against the code. Keep each finding's ID stable, mark its lifecycle as
      new, recurring, or resolved, and cite concrete evidence. Ignore minor style churn unless it
      changes behavior. From round 2 onward, if substantive findings remain, say whether they point
      to a shared structural cause instead of adding another isolated patch. Set done only when no
      substantive finding remains, and set hasFindings only when the implementer must respond.
    model: provider-default
    access: read-only
    escalation: deny
    extraArgs: []
    inheritEnv: []
    env: {}
    output:
      format: json
      schema:
        type: object
        properties:
          done:
            type: boolean
          hasFindings:
            type: boolean
          findings:
            type: array
            items:
              type: object
              properties:
                id:
                  type: string
                severity:
                  type: string
                  enum:
                    - critical
                    - high
                    - medium
                    - low
                lifecycle:
                  type: string
                  enum:
                    - new
                    - recurring
                    - resolved
                summary:
                  type: string
                evidence:
                  type: array
                  items:
                    type: string
              required:
                - id
                - severity
                - lifecycle
                - summary
                - evidence
              additionalProperties: false
          structuralAssessment:
            type: string
        required:
          - done
          - hasFindings
          - findings
          - structuralAssessment
        additionalProperties: false
    session:
      resume: reviewer
  - id: respond
    title: Respond to findings
    needs:
      - review
    workroom: review-room
    seat: implementer-seat
    cwd: null
    workspace:
      mode: shared
      path: null
      vcs: git
      writes: []
      exclusiveResources: []
    inputs:
      - from: review
        as: review
        include: content
        round: current
    retry:
      maxAttempts: 2
    gate: none
    when:
      type: agent-output
      node: review
      pointer: /hasFindings
      equals: true
    agent: codex
    prompt: >
      Here is another code review from the independent reviewer. What do you think? Verify every
      substantive finding against the implementation, refer to each one by its stable ID, and say
      whether you agree, disagree, or need more evidence. Address a shared structural cause when the
      evidence supports one. Do not make or request changes for style alone.
    model: provider-default
    effort: medium
    access: read-only
    escalation: deny
    extraArgs: []
    inheritEnv: []
    env: {}
    output:
      format: text
    session:
      resume: implementer
  - id: settle
    title: Settle review workroom
    needs:
      - review
    workroom: review-room
    cwd: null
    workspace:
      mode: shared
      path: null
      vcs: git
      writes: []
      exclusiveResources: []
    inputs: []
    retry:
      maxAttempts: 1
    gate: none
    command:
      - /usr/bin/true
    mutates: false
    inheritEnv: []
    env: {}
    allowedExitCodes:
      - 0
repeats:
  - id: review-loop
    members:
      - review
      - respond
    maxRounds: 3
    until:
      type: agent-output
      node: review
      pointer: /done
      equals: true
```

## Simple fan-out and fan-in CLI illustration

The CLI supports this shape, but one fan-out/fan-in stage alone does not normally justify invoking
the Orchestrate agent skill. This complete file is useful for learning the base node fields.

```yaml
name: review-and-synthesize
objective: Review a change from two perspectives and write one decision.
cwd: /absolute/project
concurrency: 3
callback:
  type: notification
milestones: true
limits:
  maxStarts: 8
writeConflicts: reject
nodes:
  - id: correctness
    title: Correctness review
    needs: []
    cwd: null
    workspace:
      mode: shared
      path: null
      vcs: git
      writes: []
      exclusiveResources: []
    inputs: []
    retry:
      maxAttempts: 2
    gate: none
    agent: codex
    prompt: Inspect the current change. Return concrete correctness findings.
    model: provider-default
    effort: high
    access: read-only
    escalation: deny
    extraArgs: []
    inheritEnv: []
    env: {}
    output:
      format: text
    session: fresh
  - id: usability
    title: Usability review
    needs: []
    cwd: null
    workspace:
      mode: shared
      path: null
      vcs: git
      writes: []
      exclusiveResources: []
    inputs: []
    retry:
      maxAttempts: 2
    gate: none
    agent: claude
    prompt: Inspect the current change. Return concrete usability findings.
    model: provider-default
    access: read-only
    escalation: deny
    extraArgs: []
    inheritEnv: []
    env: {}
    output:
      format: text
    session: fresh
  - id: synthesis
    title: Synthesize
    needs:
      - correctness
      - usability
    cwd: null
    workspace:
      mode: shared
      path: null
      vcs: git
      writes: []
      exclusiveResources: []
    inputs:
      - from: correctness
        as: correctness
        include: content
        round: current
      - from: usability
        as: usability
        include: content
        round: current
    retry:
      maxAttempts: 1
    gate: none
    agent: codex
    prompt: Reconcile the reviews into one prioritized decision.
    model: provider-default
    effort: medium
    access: read-only
    escalation: deny
    extraArgs: []
    inheritEnv: []
    env: {}
    output:
      format: text
    session: fresh
repeats: []
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
