import { Schema } from "effect"

const PositiveNumber = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)))
const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NonNegativeInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const NullablePositiveInteger = Schema.NullOr(PositiveInteger)
const NullableString = Schema.NullOr(Schema.String)
const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const StringArray = Schema.Array(Schema.String)
const NonEmptyStringArray = Schema.Array(NonEmptyString).check(Schema.isMinLength(1))
const StringRecord = Schema.Record(Schema.String, Schema.String)
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)

const InputSchema = Schema.Struct({
  from: NonEmptyString,
  as: NonEmptyString,
  include: Schema.Literals(["content", "path"]),
  round: Schema.Literals(["current", "previous"])
})

const SessionSchema = Schema.Struct({
  mode: Schema.Literals(["fresh", "resume", "fork"]),
  from: Schema.NullOr(NonEmptyString),
  saveAs: Schema.NullOr(NonEmptyString)
})

const GitWorkspaceSchema = Schema.Struct({
  branch: Schema.String,
  startPoint: Schema.String,
  removeOnClean: Schema.Boolean
})

const VcsSchema = Schema.Literals(["git", "plastic", "other", "none"])
const WorkspaceCommonFields = {
  writes: StringArray,
  exclusiveResources: StringArray
}

const SharedWorkspaceSchema = Schema.Struct({
  mode: Schema.Literal("shared"),
  path: NullableString,
  vcs: VcsSchema,
  ...WorkspaceCommonFields
})

const ExistingWorkspaceSchema = Schema.Struct({
  mode: Schema.Literal("existing"),
  path: NonEmptyString,
  vcs: VcsSchema,
  ...WorkspaceCommonFields
})

const GitWorktreeWorkspaceSchema = Schema.Struct({
  mode: Schema.Literal("git-worktree"),
  path: NullableString,
  vcs: Schema.Literal("git"),
  git: GitWorkspaceSchema,
  ...WorkspaceCommonFields
})

const WorkspaceSchema = Schema.Union([
  SharedWorkspaceSchema,
  ExistingWorkspaceSchema,
  GitWorktreeWorkspaceSchema
])

const RetrySchema = Schema.Struct({ maxAttempts: PositiveInteger })

const PermissionsCommonFields = {
  escalation: Schema.Literals(["deny", "ask-user", "auto-review"]),
  extraArgs: StringArray,
  inheritEnv: StringArray,
  env: StringRecord
}

const CodexPermissionsSchema = Schema.Struct({
  execution: Schema.Struct({
    sandbox: Schema.Literals(["read-only", "workspace-write"])
  }),
  ...PermissionsCommonFields
})

const ClaudePermissionModeSchema = Schema.Literals([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "manual",
  "plan"
])

const ClaudePermissionsSchema = Schema.Struct({
  execution: Schema.Struct({ permissionMode: ClaudePermissionModeSchema }),
  ...PermissionsCommonFields
})

const OutputSchema = Schema.Struct({
  format: Schema.Literals(["text", "json"]),
  schema: Schema.NullOr(UnknownRecord)
})

const CommonFields = {
  id: NonEmptyString,
  title: NonEmptyString,
  needs: StringArray,
  cwd: NullableString,
  workspace: WorkspaceSchema,
  inputs: Schema.Array(InputSchema),
  retry: RetrySchema,
  gate: Schema.Literals(["none", "approval"])
}

const AgentFields = {
  ...CommonFields,
  type: Schema.Literal("agent"),
  model: NonEmptyString,
  effort: NullableString,
  prompt: Schema.String,
  session: SessionSchema,
  output: OutputSchema
}

export const CodexAgentNodeSchema = Schema.Struct({
  ...AgentFields,
  provider: Schema.Literal("codex"),
  permissions: CodexPermissionsSchema
})

export const ClaudeAgentNodeSchema = Schema.Struct({
  ...AgentFields,
  provider: Schema.Literal("claude"),
  permissions: ClaudePermissionsSchema
})

export const AgentNodeSchema = Schema.Union([CodexAgentNodeSchema, ClaudeAgentNodeSchema])

export const CommandNodeSchema = Schema.Struct({
  ...CommonFields,
  type: Schema.Literal("command"),
  argv: NonEmptyStringArray,
  mutates: Schema.Boolean,
  inheritEnv: StringArray,
  env: StringRecord,
  allowedExitCodes: Schema.Array(Schema.Int).check(Schema.isMinLength(1))
})

export const WorkflowNodeSchema = Schema.Union([
  CodexAgentNodeSchema,
  ClaudeAgentNodeSchema,
  CommandNodeSchema
])

const RepeatConditionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("command-success"), node: NonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("agent-output"),
    node: NonEmptyString,
    pointer: Schema.String,
    equals: Schema.Unknown
  })
])

const RepeatSchema = Schema.Struct({
  id: NonEmptyString,
  members: NonEmptyStringArray,
  until: RepeatConditionSchema,
  maxRounds: PositiveInteger
})

const CallbackSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("command"),
    argv: NonEmptyStringArray,
    timeoutSeconds: PositiveNumber
  }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
    url: NonEmptyString,
    headers: StringRecord,
    timeoutSeconds: PositiveNumber
  }),
  Schema.Struct({ type: Schema.Literal("notification") })
])

export const WorkflowSchema = Schema.Struct({
  name: NonEmptyString,
  objective: NonEmptyString,
  cwd: NonEmptyString,
  concurrency: PositiveInteger,
  callback: CallbackSchema,
  milestones: Schema.Boolean,
  limits: Schema.Struct({ maxStarts: NullablePositiveInteger }),
  writeConflicts: Schema.Literals(["reject", "allow-with-approval"]),
  nodes: Schema.Array(WorkflowNodeSchema).check(Schema.isMinLength(1)),
  repeats: Schema.Array(RepeatSchema)
})

const NodeMatcherSchema = Schema.Struct({
  type: Schema.Literals(["agent", "command", "any"]),
  provider: Schema.Literals(["codex", "claude", "any"]),
  level: Schema.Literals(["root", "child", "any"]),
  origin: Schema.Literals(["initial", "loop-round", "any"]),
  id: NonEmptyString
})

const BoardPlacementSchema = Schema.Literals([
  "split-right",
  "dedicated-workspace",
  "current-workspace"
])
const PlacementPreferencesSchema = Schema.Struct({
  workspace: Schema.Literals(["dedicated", "origin"]),
  rules: Schema.Array(
    Schema.Struct({
      match: NodeMatcherSchema,
      surface: Schema.Literals(["tab", "split"])
    })
  ).check(Schema.isMinLength(1)),
  grouping: Schema.Union([
    Schema.Struct({ by: Schema.Literal("root-ancestor") }),
    Schema.Struct({ by: Schema.Literal("id-prefix"), separator: NonEmptyString })
  ]),
  maxSplitsPerTab: PositiveInteger
})
const ContinuationPreferencesSchema = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({ match: NodeMatcherSchema, autoContinue: Schema.Boolean })
  ).check(Schema.isMinLength(1))
})
const PaneCompletionSchema = Schema.Literals(["keep-open", "close-success"])
const FocusSchema = Schema.Literals(["never", "attention", "always"])
const NotificationChannelSchema = Schema.Literals(["herdr", "board", "silent"])

const UiPreferenceLayerSchema = Schema.Struct({
  board: Schema.NullOr(BoardPlacementSchema),
  placement: Schema.NullOr(PlacementPreferencesSchema),
  completedPanes: Schema.Struct({
    agent: Schema.NullOr(PaneCompletionSchema),
    command: Schema.NullOr(PaneCompletionSchema)
  }),
  focus: Schema.NullOr(FocusSchema),
  continuation: Schema.NullOr(ContinuationPreferencesSchema),
  notifications: Schema.Struct({
    attention: Schema.NullOr(NotificationChannelSchema),
    milestone: Schema.NullOr(NotificationChannelSchema),
    progress: Schema.NullOr(NotificationChannelSchema)
  })
})

const PreferenceScopeFields = {
  updatedAt: NonEmptyString,
  ui: UiPreferenceLayerSchema
}

const PreferenceScopeSchema = Schema.Struct(PreferenceScopeFields)
const ProjectPreferenceSchema = Schema.Struct({ cwd: NonEmptyString, ...PreferenceScopeFields })

export const PreferencesSchema = Schema.Struct({
  updatedAt: NonEmptyString,
  global: PreferenceScopeSchema,
  projects: Schema.Record(Schema.String, ProjectPreferenceSchema)
})

export const PaneReferenceSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  tabId: NonEmptyString,
  paneId: NonEmptyString,
  group: NonEmptyString,
  surface: Schema.Literals(["tab", "split"])
})

const AttemptStateSchema = Schema.Struct({
  attempt: PositiveInteger,
  status: Schema.Literals(["planned", "running", "completed", "failed", "cancelled"]),
  token: NonEmptyString,
  pane: Schema.NullOr(PaneReferenceSchema),
  providerSessionId: NullableString,
  startedAt: NullableString,
  finishedAt: NullableString,
  exitCode: Schema.NullOr(Schema.Int),
  error: NullableString,
  resultPath: NonEmptyString,
  outputPath: NonEmptyString
})

const NodeRunStateSchema = Schema.Struct({
  id: NonEmptyString,
  templateId: NonEmptyString,
  title: NonEmptyString,
  type: Schema.Literals(["agent", "command"]),
  provider: Schema.NullOr(Schema.Literals(["codex", "claude"])),
  needs: Schema.Array(NonEmptyString),
  origin: Schema.Literals(["initial", "loop-round"]),
  repeatId: NullableString,
  round: Schema.NullOr(PositiveInteger),
  status: Schema.Literals([
    "pending",
    "ready",
    "running",
    "awaiting-approval",
    "completed",
    "failed",
    "cancelled",
    "paused"
  ]),
  attempts: Schema.Array(AttemptStateSchema),
  resultPath: NullableString,
  result: Schema.NullOr(Schema.Unknown),
  error: NullableString
})

const SessionStateSchema = Schema.Struct({
  alias: NonEmptyString,
  provider: Schema.Literals(["codex", "claude"]),
  sessionId: NonEmptyString,
  sourceNodeId: NonEmptyString
})

const GateStateSchema = Schema.Struct({
  nodeId: NonEmptyString,
  title: NonEmptyString,
  content: Schema.String,
  digest: NonEmptyString,
  openedAt: NonEmptyString,
  approvedAt: NullableString
})

const HoldStateSchema = Schema.Struct({
  target: NonEmptyString,
  scope: Schema.Literals(["template", "instance"]),
  setAt: NonEmptyString
})

const RepeatRunStateSchema = Schema.Struct({
  id: NonEmptyString,
  round: PositiveInteger,
  status: Schema.Literals(["pending", "running", "completed", "max-rounds"]),
  instanceIds: StringArray,
  completedAt: NullableString
})

const SpawnIntentSchema = Schema.Struct({
  id: NonEmptyString,
  nodeId: NonEmptyString,
  attempt: PositiveInteger,
  token: NonEmptyString,
  status: Schema.Literals(["planned", "spawned"]),
  createdAt: NonEmptyString
})

const PendingRevisionSchema = Schema.Struct({
  workflow: WorkflowSchema,
  digest: NonEmptyString,
  summary: StringArray,
  createdAt: NonEmptyString
})

const PauseStateSchema = Schema.Struct({
  kind: Schema.Literals(["human", "fuse", "max-rounds"]),
  message: NonEmptyString,
  repeatId: NullableString,
  createdAt: NonEmptyString
})

export const RunOriginSchema = Schema.Struct({
  workspaceId: NonEmptyString,
  tabId: NonEmptyString,
  paneId: NonEmptyString,
  provider: Schema.Literals(["codex", "claude"]),
  sessionId: NonEmptyString
})

export const NodeDoneSubmissionSchema = Schema.Struct({
  runId: NonEmptyString,
  nodeId: NonEmptyString,
  token: NonEmptyString,
  outcome: Schema.Literals(["completed", "failed"]),
  hold: Schema.Boolean
})

export const HerdrAgentStatusEventSchema = Schema.Struct({
  event: Schema.Literal("pane_agent_status_changed"),
  data: Schema.Struct({
    pane_id: NonEmptyString,
    workspace_id: NonEmptyString,
    agent_status: Schema.Literals(["idle", "working", "blocked", "done", "unknown"])
  })
})

export const SpawnReceiptSchema = Schema.Struct({
  status: Schema.Literals(["created", "ready", "ambiguous"]),
  pane: PaneReferenceSchema,
  providerSessionId: NullableString,
  detail: NullableString
})

export const RunStateSchema = Schema.Struct({
  runtimeVersion: NonEmptyString,
  sequence: NonNegativeInteger,
  id: NonEmptyString,
  workflowName: NonEmptyString,
  objective: NonEmptyString,
  digest: NonEmptyString,
  status: Schema.Literals(["running", "paused", "completed", "failed", "stopped"]),
  createdAt: NonEmptyString,
  startedAt: NonEmptyString,
  finishedAt: NullableString,
  updatedAt: NonEmptyString,
  error: NullableString,
  pause: Schema.NullOr(PauseStateSchema),
  origin: Schema.NullOr(RunOriginSchema),
  allowWriteConflicts: Schema.Boolean,
  starts: NonNegativeInteger,
  fuseOverride: Schema.Boolean,
  repeatRoundExtensions: Schema.Record(Schema.String, PositiveInteger),
  pendingRevision: Schema.NullOr(PendingRevisionSchema),
  nodes: Schema.Record(Schema.String, NodeRunStateSchema),
  sessions: Schema.Record(Schema.String, SessionStateSchema),
  gates: Schema.Record(Schema.String, GateStateSchema),
  holds: Schema.Record(Schema.String, HoldStateSchema),
  repeats: Schema.Record(Schema.String, RepeatRunStateSchema),
  spawnIntents: Schema.Record(Schema.String, SpawnIntentSchema)
})

const EventTypeSchema = Schema.Literals([
  "run.started",
  "run.paused",
  "run.resumed",
  "run.completed",
  "run.failed",
  "run.stopped",
  "node.ready",
  "node.spawn-planned",
  "node.started",
  "node.completed",
  "node.failed",
  "node.retrying",
  "node.cancelled",
  "gate.opened",
  "gate.approved",
  "hold.set",
  "hold.released",
  "revision.proposed",
  "revision.approved",
  "revision.discarded",
  "repeat.round-started",
  "repeat.completed",
  "repeat.max-rounds",
  "ui.degraded"
])

export const EventRecordSchema = Schema.Struct({
  runtimeVersion: NonEmptyString,
  sequence: PositiveInteger,
  timestamp: NonEmptyString,
  runId: NonEmptyString,
  type: EventTypeSchema,
  message: Schema.String,
  nodeId: Schema.optionalKey(NonEmptyString),
  data: Schema.optionalKey(Schema.Unknown),
  patch: Schema.Array(
    Schema.Union([
      Schema.Struct({
        op: Schema.Literals(["add", "replace"]),
        path: Schema.String.check(Schema.isPattern(/^(?:\/(?:[^~/]|~[01])*)*$/)),
        value: Schema.Unknown
      }),
      Schema.Struct({
        op: Schema.Literal("remove"),
        path: Schema.String.check(Schema.isPattern(/^(?:\/(?:[^~/]|~[01])*)*$/))
      })
    ])
  )
})

export function jsonSchemaDocumentFor(
  schema: Parameters<typeof Schema.toJsonSchemaDocument>[0]
): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(schema, { additionalProperties: false })
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions })
  }
}
