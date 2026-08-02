import { Schema } from "effect"

const NonNegativeNumber = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
const PositiveNumber = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)))
const PositiveInteger = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
const NullablePositiveNumber = Schema.NullOr(PositiveNumber)
const NullablePositiveInteger = Schema.NullOr(PositiveInteger)
const NullableString = Schema.NullOr(Schema.String)
const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const StringArray = Schema.Array(Schema.String)
// Prefix-semantics lists match with startsWith at runtime, so an empty entry
// would silently grant everything; every element must be non-empty.
const PrefixStringArray = Schema.Array(NonEmptyString)
const ArgvPrefixSchema = Schema.Array(NonEmptyString).check(Schema.isMinLength(1))

const InputSchema = Schema.Struct({
  from: Schema.String,
  as: NonEmptyString,
  include: Schema.Literals(["content", "path"])
})

const SessionSchema = Schema.Struct({
  mode: Schema.Literals(["fresh", "resume", "fork"]),
  from: NullableString,
  saveAs: NullableString,
  retain: Schema.Boolean,
  reuseOnRepeat: Schema.Boolean
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
  path: Schema.String,
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

const RetrySchema = Schema.Struct({
  maxAttempts: PositiveInteger,
  delaySeconds: NonNegativeNumber
})

const PermissionsCommonFields = {
  extraArgs: StringArray,
  inheritEnv: StringArray,
  env: Schema.Record(Schema.String, Schema.String)
}

const CodexPermissionsSchema = Schema.Struct({
  sandbox: Schema.Literals(["read-only", "workspace-write", "danger-full-access"]),
  ...PermissionsCommonFields
})

const ClaudePermissionsSchema = Schema.Struct({
  permissionMode: Schema.Literals([
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "dontAsk",
    "manual",
    "plan"
  ]),
  ...PermissionsCommonFields
})

const MockPermissionsSchema = Schema.Struct({
  ...PermissionsCommonFields
})

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown)

const OutputSchema = Schema.Struct({
  format: Schema.Literals(["text", "json"]),
  schema: Schema.NullOr(JsonObjectSchema)
})

const CommonFields = {
  id: Schema.String,
  title: Schema.String,
  needs: StringArray,
  cwd: NullableString,
  workspace: WorkspaceSchema,
  inputs: Schema.Array(InputSchema),
  timeoutMinutes: NullablePositiveNumber,
  retry: RetrySchema,
  // "approval" pauses the run when the node becomes runnable and presents the
  // fully rendered prompt (or command argv + inputs) for digest-bound approval
  // before any attempt starts.
  gate: Schema.Literals(["none", "approval"])
}

const AgentFields = {
  ...CommonFields,
  type: Schema.Literal("agent"),
  model: Schema.String,
  effort: NullableString,
  prompt: Schema.String,
  session: SessionSchema,
  output: OutputSchema,
  // true runs the node as the provider's real interactive TUI in a herdr pane;
  // completion is signaled by the prompt contract via `orchestrate node-done`.
  interactive: Schema.Boolean
}

const CodexAgentNodeSchema = Schema.Struct({
  ...AgentFields,
  provider: Schema.Literal("codex"),
  permissions: CodexPermissionsSchema
})

const ClaudeAgentNodeSchema = Schema.Struct({
  ...AgentFields,
  provider: Schema.Literal("claude"),
  permissions: ClaudePermissionsSchema
})

const MockAgentNodeSchema = Schema.Struct({
  ...AgentFields,
  provider: Schema.Literal("mock"),
  permissions: MockPermissionsSchema
})

export const AgentNodeSchema = Schema.Union([CodexAgentNodeSchema, ClaudeAgentNodeSchema])

export const CommandNodeSchema = Schema.Struct({
  ...CommonFields,
  type: Schema.Literal("command"),
  argv: StringArray,
  mutates: Schema.Boolean,
  inheritEnv: StringArray,
  env: Schema.Record(Schema.String, Schema.String),
  allowedExitCodes: Schema.Array(Schema.Int)
})

const EnvelopeCommonFields = {
  models: StringArray,
  nodeTypes: Schema.Array(Schema.Literals(["agent", "command"])),
  cwdRoots: StringArray,
  writeRoots: StringArray,
  workspaceModes: Schema.Array(Schema.Literals(["shared", "existing", "git-worktree"])),
  vcs: Schema.Array(VcsSchema),
  gitWorktree: Schema.Struct({
    allowed: Schema.Boolean,
    branchPrefixes: PrefixStringArray,
    startPoints: StringArray,
    allowRemoveOnClean: Schema.Boolean
  }),
  allowCommands: Schema.Boolean,
  commandArgvPrefixes: Schema.Array(ArgvPrefixSchema),
  allowedCommandEnv: Schema.Array(Schema.Record(Schema.String, Schema.String)),
  codexSandboxes: Schema.Array(
    Schema.Literals(["read-only", "workspace-write", "danger-full-access"])
  ),
  claudePermissionModes: Schema.Array(
    Schema.Literals(["acceptEdits", "auto", "bypassPermissions", "dontAsk", "manual", "plan"])
  ),
  allowedExtraArgs: Schema.Array(StringArray),
  allowedInheritedEnv: Schema.Array(StringArray),
  allowedProviderEnv: Schema.Array(Schema.Record(Schema.String, Schema.String)),
  resumableSessionAliases: StringArray,
  newSessionAliasPrefixes: PrefixStringArray,
  maxAddedNodesPerRound: NullablePositiveInteger
}

const EnvelopeSchema = Schema.Struct({
  providers: Schema.Array(Schema.Literals(["codex", "claude"])),
  ...EnvelopeCommonFields
})

const InternalEnvelopeSchema = Schema.Struct({
  providers: Schema.Array(Schema.Literals(["codex", "claude", "mock"])),
  ...EnvelopeCommonFields
})

const TerminationSchema = Schema.Struct({
  success: Schema.String,
  convergence: Schema.String,
  maxRounds: NullablePositiveInteger,
  maxWallTimeMinutes: NullablePositiveNumber
})

const SupervisorFields = {
  ...CommonFields,
  type: Schema.Literal("supervisor"),
  model: Schema.String,
  effort: NullableString,
  prompt: Schema.String,
  session: SessionSchema,
  goal: Schema.String,
  termination: TerminationSchema
}

const CodexSupervisorNodeSchema = Schema.Struct({
  ...SupervisorFields,
  provider: Schema.Literal("codex"),
  permissions: CodexPermissionsSchema,
  envelope: EnvelopeSchema
})

const ClaudeSupervisorNodeSchema = Schema.Struct({
  ...SupervisorFields,
  provider: Schema.Literal("claude"),
  permissions: ClaudePermissionsSchema,
  envelope: EnvelopeSchema
})

const MockSupervisorNodeSchema = Schema.Struct({
  ...SupervisorFields,
  provider: Schema.Literal("mock"),
  permissions: MockPermissionsSchema,
  envelope: InternalEnvelopeSchema
})

export const SupervisorNodeSchema = Schema.Union([
  CodexSupervisorNodeSchema,
  ClaudeSupervisorNodeSchema
])

export const WorkflowNodeSchema = Schema.Union([
  CodexAgentNodeSchema,
  ClaudeAgentNodeSchema,
  CommandNodeSchema,
  CodexSupervisorNodeSchema,
  ClaudeSupervisorNodeSchema
])

const InternalWorkflowNodeSchema = Schema.Union([
  CodexAgentNodeSchema,
  ClaudeAgentNodeSchema,
  MockAgentNodeSchema,
  CommandNodeSchema,
  CodexSupervisorNodeSchema,
  ClaudeSupervisorNodeSchema,
  MockSupervisorNodeSchema
])

const CallbackSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("command"),
    argv: Schema.Array(NonEmptyString),
    timeoutSeconds: PositiveNumber
  }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
    url: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    timeoutSeconds: PositiveNumber
  }),
  Schema.Struct({ type: Schema.Literal("notification") })
])

const WorkflowFields = {
  version: Schema.Literal(1),
  name: Schema.String,
  objective: Schema.String,
  cwd: Schema.String,
  concurrency: PositiveInteger,
  heartbeat: Schema.Struct({
    intervalMinutes: NullablePositiveNumber,
    milestones: Schema.Boolean,
    callback: CallbackSchema
  }),
  limits: Schema.Struct({
    nodeWallTimeMinutes: NullablePositiveNumber,
    workflowWallTimeMinutes: NullablePositiveNumber,
    maxAgentStarts: NullablePositiveInteger,
    maxGoalRounds: NullablePositiveInteger
  }),
  writeConflicts: Schema.Literals(["reject", "allow-with-approval"])
}

// The published contract: what `orchestrate validate` enforces by default and
// what generate-schema.ts emits. It has no test-only mock provider.
export const WorkflowSchema = Schema.Struct({
  ...WorkflowFields,
  nodes: Schema.Array(WorkflowNodeSchema)
})

// The internal contract adds the mock provider for the bundled tests. It is
// only reachable behind ORCHESTRATE_ENABLE_MOCK_PROVIDER=1.
export const InternalWorkflowSchema = Schema.Struct({
  ...WorkflowFields,
  nodes: Schema.Array(InternalWorkflowNodeSchema)
})

const DynamicNodes = Schema.Array(
  Schema.Union([CodexAgentNodeSchema, ClaudeAgentNodeSchema, CommandNodeSchema])
)
const InternalDynamicNodes = Schema.Array(
  Schema.Union([
    CodexAgentNodeSchema,
    ClaudeAgentNodeSchema,
    MockAgentNodeSchema,
    CommandNodeSchema
  ])
)

function decisionSchema(nodes: typeof DynamicNodes | typeof InternalDynamicNodes) {
  return Schema.Union([
    Schema.Struct({
      status: Schema.Literal("complete"),
      reason: Schema.String,
      addNodes: nodes.check(Schema.isMaxLength(0))
    }),
    Schema.Struct({
      status: Schema.Literal("pause"),
      reason: Schema.String,
      addNodes: nodes.check(Schema.isMaxLength(0))
    }),
    Schema.Struct({
      status: Schema.Literal("continue"),
      reason: Schema.String,
      addNodes: nodes.check(Schema.isMinLength(1))
    })
  ])
}

export const SupervisorDecisionSchema = decisionSchema(DynamicNodes)
export const InternalSupervisorDecisionSchema = decisionSchema(InternalDynamicNodes)

const ModelPreferenceSchema = Schema.Struct({
  model: Schema.String,
  effort: NullableString
})

const CodexPreferenceSchema = Schema.Struct({
  mutating: Schema.NullOr(ModelPreferenceSchema),
  readOnly: Schema.NullOr(ModelPreferenceSchema),
  permissionCeiling: Schema.Literals(["read-only", "workspace-write", "danger-full-access"]),
  inheritEnv: StringArray
})

const ClaudePreferenceSchema = Schema.Struct({
  mutating: Schema.NullOr(ModelPreferenceSchema),
  readOnly: Schema.NullOr(ModelPreferenceSchema),
  approvedPermissionModes: Schema.Array(
    Schema.Literals(["plan", "manual", "dontAsk", "acceptEdits", "auto", "bypassPermissions"])
  ).check(Schema.isMaxLength(6)),
  inheritEnv: StringArray
})

const PreferenceScopeSchema = Schema.Struct({
  updatedAt: Schema.String,
  providers: Schema.Struct({
    codex: Schema.NullOr(CodexPreferenceSchema),
    claude: Schema.NullOr(ClaudePreferenceSchema)
  }),
  callback: Schema.NullOr(
    Schema.Struct({
      type: Schema.Literals(["none", "notification", "command", "webhook"]),
      intervalMinutes: NullablePositiveNumber
    })
  ),
  writeConflicts: Schema.NullOr(Schema.Literals(["reject", "allow-with-approval"])),
  concurrency: Schema.NullOr(PositiveInteger),
  limits: Schema.NullOr(
    Schema.Struct({
      nodeWallTimeMinutes: NullablePositiveNumber,
      workflowWallTimeMinutes: NullablePositiveNumber,
      maxAgentStarts: NullablePositiveInteger,
      maxGoalRounds: NullablePositiveInteger
    })
  ),
  worktrees: Schema.NullOr(Schema.Boolean),
  verifyCommands: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        argv: StringArray,
        cwd: Schema.String
      })
    ).check(Schema.isMaxLength(3))
  )
})

const ProjectPreferenceSchema = Schema.Struct({
  cwd: Schema.String,
  ...PreferenceScopeSchema.fields
})

export const PreferencesSchema = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.String,
  providersAvailable: Schema.Struct({
    checkedAt: Schema.String,
    codex: Schema.Boolean,
    claude: Schema.Boolean
  }),
  global: PreferenceScopeSchema,
  projects: Schema.Record(Schema.String, ProjectPreferenceSchema)
})

export function jsonSchemaDocumentFor(
  schema: Parameters<typeof Schema.toJsonSchemaDocument>[0]
): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(schema, {
    additionalProperties: false
  })
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions })
  }
}
