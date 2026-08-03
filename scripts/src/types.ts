export type Provider = "codex" | "claude"
export type NodeType = "agent" | "command"
export type NodeOrigin = "initial" | "loop-round"
export type NodeLevel = "root" | "child"
export type RunStatus = "running" | "paused" | "completed" | "failed" | "stopped"
export type NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"

export interface InputSpec {
  readonly from: string
  readonly as: string
  readonly include: "content" | "path"
  // A previous-round input is omitted in round one. It is valid only when
  // both nodes belong to the same repeat group.
  readonly round: "current" | "previous"
}

export interface SessionSpec {
  readonly mode: "fresh" | "resume" | "fork"
  readonly from: string | null
  readonly saveAs: string | null
}

export interface GitWorktreeSpec {
  readonly branch: string
  readonly startPoint: string
  readonly removeOnClean: boolean
}

export type Vcs = "git" | "plastic" | "other" | "none"

interface WorkspaceCommon {
  readonly writes: readonly string[]
  readonly exclusiveResources: readonly string[]
}

export interface SharedWorkspace extends WorkspaceCommon {
  readonly mode: "shared"
  readonly path: string | null
  readonly vcs: Vcs
}

export interface ExistingWorkspace extends WorkspaceCommon {
  readonly mode: "existing"
  readonly path: string
  readonly vcs: Vcs
}

export interface GitWorktreeWorkspace extends WorkspaceCommon {
  readonly mode: "git-worktree"
  readonly path: string | null
  readonly vcs: "git"
  readonly git: GitWorktreeSpec
}

export type WorkspaceSpec = SharedWorkspace | ExistingWorkspace | GitWorktreeWorkspace

export interface RetrySpec {
  readonly maxAttempts: number
}

export type CodexSandbox = "read-only" | "workspace-write"
export type CodexPermissionCeiling = CodexSandbox | "danger-full-access"
export type AgentEscalation = "deny" | "ask-user" | "auto-review"
export type ClaudePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "dontAsk"
  | "manual"
  | "plan"

interface PermissionsCommon {
  readonly escalation: AgentEscalation
  readonly extraArgs: readonly string[]
  readonly inheritEnv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface CodexPermissions extends PermissionsCommon {
  readonly execution: {
    readonly sandbox: CodexSandbox
  }
}

export interface ClaudePermissions extends PermissionsCommon {
  readonly execution: {
    readonly permissionMode: ClaudePermissionMode
  }
}

export interface OutputSpec {
  readonly format: "text" | "json"
  readonly schema: Readonly<Record<string, unknown>> | null
}

export interface CommonNode {
  readonly id: string
  readonly type: NodeType
  readonly title: string
  readonly needs: readonly string[]
  readonly cwd: string | null
  readonly workspace: WorkspaceSpec
  readonly inputs: readonly InputSpec[]
  readonly retry: RetrySpec
  readonly gate: "none" | "approval"
}

interface AgentFields extends CommonNode {
  readonly type: "agent"
  readonly model: string
  readonly effort: string | null
  readonly prompt: string
  readonly session: SessionSpec
  readonly output: OutputSpec
}

export interface CodexAgentNode extends AgentFields {
  readonly provider: "codex"
  readonly permissions: CodexPermissions
}

export interface ClaudeAgentNode extends AgentFields {
  readonly provider: "claude"
  readonly permissions: ClaudePermissions
}

export type AgentNode = CodexAgentNode | ClaudeAgentNode

export interface CommandNode extends CommonNode {
  readonly type: "command"
  readonly argv: readonly string[]
  readonly mutates: boolean
  readonly inheritEnv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly allowedExitCodes: readonly number[]
}

export type WorkflowNode = AgentNode | CommandNode

export interface CommandSuccessCondition {
  readonly type: "command-success"
  // A listed allowed exit code settles the repeat. Any other numeric exit
  // completes the round as not clean and starts the next round; retry applies
  // only when the command pane cannot produce an exit result.
  readonly node: string
}

export interface AgentOutputCondition {
  readonly type: "agent-output"
  readonly node: string
  // RFC 6901 JSON pointer into the schema-validated result document.
  readonly pointer: string
  readonly equals: unknown
}

export type RepeatCondition = CommandSuccessCondition | AgentOutputCondition

export interface RepeatSpec {
  readonly id: string
  readonly members: readonly string[]
  readonly until: RepeatCondition
  readonly maxRounds: number
}

// A dependency from outside a repeat to one of its members is a dependency on
// the whole repeat. It releases only when the repeat settles, and an input from
// that member resolves to its final-round instance.

export interface CallbackNone {
  readonly type: "none"
}

export interface CallbackCommand {
  readonly type: "command"
  readonly argv: readonly string[]
  readonly timeoutSeconds: number
}

export interface CallbackWebhook {
  readonly type: "webhook"
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutSeconds: number
}

export interface CallbackNotification {
  readonly type: "notification"
}

export type CallbackSpec = CallbackNone | CallbackCommand | CallbackWebhook | CallbackNotification

export interface WorkflowSpec {
  readonly name: string
  readonly objective: string
  readonly cwd: string
  // Maximum simultaneously open node panes. This is a human-attention budget.
  readonly concurrency: number
  readonly callback: CallbackSpec
  readonly milestones: boolean
  readonly limits: {
    readonly maxStarts: number | null
  }
  readonly writeConflicts: "reject" | "allow-with-approval"
  readonly nodes: readonly WorkflowNode[]
  readonly repeats: readonly RepeatSpec[]
}

export interface ValidationIssue {
  readonly severity: "error" | "warning"
  readonly code: string
  readonly message: string
  readonly nodes?: readonly string[]
}

export interface ValidationResult {
  readonly workflow: WorkflowSpec | null
  readonly issues: readonly ValidationIssue[]
  readonly digest: string | null
}

export interface PaneReference {
  readonly workspaceId: string
  readonly tabId: string
  readonly paneId: string
  readonly group: string
  readonly surface: "tab" | "split"
}

export interface AttemptState {
  readonly attempt: number
  readonly status: "planned" | "running" | "completed" | "failed" | "cancelled"
  readonly token: string
  readonly pane: PaneReference | null
  readonly providerSessionId: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly exitCode: number | null
  readonly error: string | null
  readonly resultPath: string
  readonly outputPath: string
}

export interface NodeRunState {
  readonly id: string
  readonly templateId: string
  readonly title: string
  readonly type: NodeType
  readonly provider: Provider | null
  readonly needs: readonly string[]
  readonly origin: NodeOrigin
  readonly repeatId: string | null
  readonly round: number | null
  readonly status: NodeStatus
  readonly attempts: readonly AttemptState[]
  readonly resultPath: string | null
  readonly result: unknown
  readonly error: string | null
}

export interface SessionState {
  readonly alias: string
  readonly provider: Provider
  readonly sessionId: string
  readonly sourceNodeId: string
}

export interface GateState {
  readonly nodeId: string
  readonly title: string
  readonly content: string
  readonly digest: string
  readonly openedAt: string
  readonly approvedAt: string | null
}

export interface HoldState {
  readonly target: string
  readonly scope: "template" | "instance"
  readonly setAt: string
}

export interface RepeatRunState {
  readonly id: string
  readonly round: number
  readonly status: "pending" | "running" | "completed" | "max-rounds"
  readonly instanceIds: readonly string[]
  readonly completedAt: string | null
}

export interface SpawnIntent {
  readonly id: string
  readonly nodeId: string
  readonly attempt: number
  readonly token: string
  readonly status: "planned" | "spawned"
  readonly createdAt: string
}

export interface PendingRevision {
  readonly workflow: WorkflowSpec
  readonly digest: string
  readonly summary: readonly string[]
  readonly createdAt: string
}

export interface PauseState {
  readonly kind: "human" | "fuse" | "max-rounds"
  readonly message: string
  readonly repeatId: string | null
  readonly createdAt: string
}

export interface RunOrigin {
  readonly workspaceId: string
  readonly tabId: string
  readonly paneId: string
  readonly provider: Provider
  readonly sessionId: string
}

export interface RunState {
  readonly runtimeVersion: string
  readonly sequence: number
  readonly id: string
  readonly workflowName: string
  readonly objective: string
  readonly digest: string
  readonly status: RunStatus
  readonly createdAt: string
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly updatedAt: string
  readonly error: string | null
  readonly pause: PauseState | null
  readonly origin: RunOrigin | null
  readonly allowWriteConflicts: boolean
  readonly starts: number
  readonly fuseOverride: boolean
  readonly repeatRoundExtensions: Readonly<Record<string, number>>
  readonly pendingRevision: PendingRevision | null
  readonly nodes: Readonly<Record<string, NodeRunState>>
  readonly sessions: Readonly<Record<string, SessionState>>
  readonly gates: Readonly<Record<string, GateState>>
  readonly holds: Readonly<Record<string, HoldState>>
  readonly repeats: Readonly<Record<string, RepeatRunState>>
  readonly spawnIntents: Readonly<Record<string, SpawnIntent>>
}

export type EventType =
  | "run.started"
  | "run.paused"
  | "run.resumed"
  | "run.completed"
  | "run.failed"
  | "run.stopped"
  | "node.ready"
  | "node.spawn-planned"
  | "node.started"
  | "node.completed"
  | "node.failed"
  | "node.retrying"
  | "node.cancelled"
  | "gate.opened"
  | "gate.approved"
  | "hold.set"
  | "hold.released"
  | "revision.proposed"
  | "revision.approved"
  | "revision.discarded"
  | "repeat.round-started"
  | "repeat.completed"
  | "repeat.max-rounds"
  | "ui.degraded"

export type StatePatchOperation =
  | { readonly op: "add" | "replace"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string }

// Journal patches use RFC 6902 paths. The first run.started record adds the
// complete initial state at the document root; later records contain only the
// mutations caused by that event, so replay is exact without duplicating the
// growing state document in every line.
export interface EventRecord {
  readonly runtimeVersion: string
  readonly sequence: number
  readonly timestamp: string
  readonly runId: string
  readonly type: EventType
  readonly message: string
  readonly nodeId?: string
  readonly data?: unknown
  readonly patch: readonly StatePatchOperation[]
}

export type EventSeverity = "attention" | "milestone" | "progress"
export type NotificationChannel = "herdr" | "board" | "silent"

export interface NodeMatcher {
  readonly type: NodeType | "any"
  readonly provider: Provider | "any"
  readonly level: NodeLevel | "any"
  readonly origin: NodeOrigin | "any"
  readonly id: string
}

export interface PlacementRule {
  readonly match: NodeMatcher
  readonly surface: "tab" | "split"
}

export interface ContinueRule {
  readonly match: NodeMatcher
  readonly autoContinue: boolean
}

export interface UiPreferences {
  readonly board: "split-right" | "dedicated-workspace" | "current-workspace"
  readonly placement: {
    readonly workspace: "dedicated" | "origin"
    readonly rules: readonly PlacementRule[]
    readonly grouping:
      | { readonly by: "root-ancestor" }
      | { readonly by: "id-prefix"; readonly separator: string }
    readonly maxSplitsPerTab: number
  }
  readonly completedPanes: {
    readonly agent: "keep-open" | "close-success"
    readonly command: "keep-open" | "close-success"
  }
  readonly focus: "never" | "attention" | "always"
  readonly continuation: {
    readonly rules: readonly ContinueRule[]
  }
  readonly notifications: Readonly<Record<EventSeverity, NotificationChannel>>
}

export interface UiPreferenceLayer {
  readonly board: UiPreferences["board"] | null
  readonly placement: UiPreferences["placement"] | null
  readonly completedPanes: {
    readonly agent: UiPreferences["completedPanes"]["agent"] | null
    readonly command: UiPreferences["completedPanes"]["command"] | null
  }
  readonly focus: UiPreferences["focus"] | null
  readonly continuation: UiPreferences["continuation"] | null
  readonly notifications: {
    readonly attention: NotificationChannel | null
    readonly milestone: NotificationChannel | null
    readonly progress: NotificationChannel | null
  }
}

export interface PreferenceScope {
  readonly updatedAt: string
  readonly ui: UiPreferenceLayer
}

export interface ProjectPreference extends PreferenceScope {
  readonly cwd: string
}

export interface PreferencesFile {
  readonly updatedAt: string
  readonly global: PreferenceScope
  readonly projects: Readonly<Record<string, ProjectPreference>>
}

export type CrankEvent =
  | { readonly type: "run" }
  | { readonly type: "reconcile" }
  | {
      readonly type: "node-done"
      readonly nodeId: string
      readonly token: string
      readonly outcome: "completed" | "failed"
      readonly hold: boolean
      readonly result: unknown
      readonly error: string | null
      readonly providerSessionId: string | null
    }
  | {
      readonly type: "node-exit"
      readonly nodeId: string
      readonly token: string
      readonly code: number
      readonly error: string | null
      readonly result?: string | null
    }
  | {
      readonly type: "spawn-observed"
      readonly nodeId: string
      readonly intentId: string
      readonly pane: PaneReference
      readonly providerSessionId: string | null
    }
  | {
      readonly type: "spawn-failed"
      readonly nodeId: string
      readonly intentId: string
      readonly error: string
    }
  | { readonly type: "approve-gate"; readonly nodeId: string; readonly digest: string }
  | {
      readonly type: "propose-revision"
      readonly workflow: WorkflowSpec
      readonly digest: string
      readonly summary: readonly string[]
    }
  | { readonly type: "approve-revision"; readonly digest: string }
  | { readonly type: "discard-revision" }
  | { readonly type: "pause" }
  | {
      readonly type: "resume"
      readonly overrideFuse: boolean
      readonly continueRounds: number | null
      readonly acceptRepeat: string | null
    }
  | { readonly type: "stop" }
  | { readonly type: "hold"; readonly nodeId: string }
  | { readonly type: "release"; readonly nodeId: string }
  | { readonly type: "restore"; readonly deadPaneIds: readonly string[] }

export type CrankAction =
  | { readonly type: "close-pane"; readonly paneId: string }
  | { readonly type: "open-board" }

export interface TransitionResult {
  readonly workflow: WorkflowSpec
  readonly state: RunState
  readonly actions: readonly CrankAction[]
  readonly events: readonly EventRecord[]
}
