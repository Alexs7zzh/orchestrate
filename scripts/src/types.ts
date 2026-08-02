export type Provider = "codex" | "claude" | "mock"
export type NodeType = "agent" | "command" | "supervisor"
export type RunStatus =
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "completed"
  | "failed"
  // Retained for stored-run compatibility; current workers settle stop directly.
  | "stopping"
  | "stopped"

export interface InputSpec {
  readonly from: string
  readonly as: string
  readonly include: "content" | "path"
}

export interface SessionSpec {
  readonly mode: "fresh" | "resume" | "fork"
  readonly from: string | null
  readonly saveAs: string | null
  readonly retain: boolean
  readonly reuseOnRepeat: boolean
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
  readonly delaySeconds: number
}

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access"
export type ClaudePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "dontAsk"
  | "manual"
  | "plan"

interface PermissionsCommon {
  readonly extraArgs: readonly string[]
  readonly inheritEnv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface CodexPermissions extends PermissionsCommon {
  readonly sandbox: CodexSandbox
}

export interface ClaudePermissions extends PermissionsCommon {
  readonly permissionMode: ClaudePermissionMode
}

export type MockPermissions = PermissionsCommon

export type AgentPermissions = CodexPermissions | ClaudePermissions | MockPermissions

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
  readonly timeoutMinutes: number | null
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
  // true runs the node as the provider's real interactive TUI in a herdr pane;
  // completion is signaled by the prompt contract via `orchestrate node-done`.
  readonly interactive: boolean
}

export interface CodexAgentNode extends AgentFields {
  readonly provider: "codex"
  readonly permissions: CodexPermissions
}

export interface ClaudeAgentNode extends AgentFields {
  readonly provider: "claude"
  readonly permissions: ClaudePermissions
}

export interface MockAgentNode extends AgentFields {
  readonly provider: "mock"
  readonly permissions: MockPermissions
}

export type AgentNode = CodexAgentNode | ClaudeAgentNode | MockAgentNode

export interface CommandNode extends CommonNode {
  readonly type: "command"
  readonly argv: readonly string[]
  readonly mutates: boolean
  readonly inheritEnv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly allowedExitCodes: readonly number[]
}

export interface AdaptiveEnvelope {
  readonly providers: readonly Provider[]
  readonly models: readonly string[]
  readonly nodeTypes: readonly ("agent" | "command")[]
  readonly cwdRoots: readonly string[]
  readonly writeRoots: readonly string[]
  readonly workspaceModes: readonly WorkspaceSpec["mode"][]
  readonly vcs: readonly WorkspaceSpec["vcs"][]
  readonly gitWorktree: {
    readonly allowed: boolean
    readonly branchPrefixes: readonly string[]
    readonly startPoints: readonly string[]
    readonly allowRemoveOnClean: boolean
  }
  readonly allowCommands: boolean
  readonly commandArgvPrefixes: readonly (readonly string[])[]
  readonly allowedCommandEnv: readonly Readonly<Record<string, string>>[]
  readonly codexSandboxes: readonly ("read-only" | "workspace-write" | "danger-full-access")[]
  readonly claudePermissionModes: readonly (
    | "acceptEdits"
    | "auto"
    | "bypassPermissions"
    | "dontAsk"
    | "manual"
    | "plan"
  )[]
  readonly allowedExtraArgs: readonly (readonly string[])[]
  readonly allowedInheritedEnv: readonly (readonly string[])[]
  readonly allowedProviderEnv: readonly Readonly<Record<string, string>>[]
  readonly resumableSessionAliases: readonly string[]
  readonly newSessionAliasPrefixes: readonly string[]
  readonly maxAddedNodesPerRound: number | null
}

export interface GoalTermination {
  readonly success: string
  readonly convergence: string
  readonly maxRounds: number | null
  readonly maxWallTimeMinutes: number | null
}

interface SupervisorFields extends CommonNode {
  readonly type: "supervisor"
  readonly model: string
  readonly effort: string | null
  readonly prompt: string
  readonly session: SessionSpec
  readonly goal: string
  readonly envelope: AdaptiveEnvelope
  readonly termination: GoalTermination
}

export interface CodexSupervisorNode extends SupervisorFields {
  readonly provider: "codex"
  readonly permissions: CodexPermissions
}

export interface ClaudeSupervisorNode extends SupervisorFields {
  readonly provider: "claude"
  readonly permissions: ClaudePermissions
}

export interface MockSupervisorNode extends SupervisorFields {
  readonly provider: "mock"
  readonly permissions: MockPermissions
}

export type SupervisorNode = CodexSupervisorNode | ClaudeSupervisorNode | MockSupervisorNode

export type WorkflowNode = AgentNode | CommandNode | SupervisorNode
export type DynamicNode = AgentNode | CommandNode

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
  readonly version: 1
  readonly name: string
  readonly objective: string
  readonly cwd: string
  readonly concurrency: number
  readonly heartbeat: {
    readonly intervalMinutes: number | null
    readonly milestones: boolean
    readonly callback: CallbackSpec
  }
  readonly limits: {
    readonly nodeWallTimeMinutes: number | null
    readonly workflowWallTimeMinutes: number | null
    readonly maxAgentStarts: number | null
    readonly maxGoalRounds: number | null
  }
  readonly writeConflicts: "reject" | "allow-with-approval"
  readonly nodes: readonly WorkflowNode[]
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

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "cancelled"

// The pending-interactive record for one attempt of an interactive agent node:
// the one-time node-done token, the hosting herdr pane, and idle-nudge state.
// Present only while the attempt awaits its node-done call.
export interface InteractiveAttemptState {
  readonly token: string
  readonly paneId: string | null
  readonly attempt: number
  readonly startedAt: string
  readonly idleSince: string | null
}

export interface NodeRunState {
  readonly id: string
  readonly status: NodeStatus
  readonly attempts: number
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly exitCode: number | null
  readonly error: string | null
  readonly resultPath: string | null
  readonly sessionId: string | null
  readonly workspacePath: string | null
  readonly processPid: number | null
  readonly processIdentity: ProcessIdentity | null
  // Optional so runs recorded before interactive nodes existed parse cleanly.
  readonly interactive?: InteractiveAttemptState | null
}

export interface ProcessIdentity {
  readonly startedAt: string
  readonly commandDigest: string
  readonly executable: string
}

export interface SessionState {
  readonly alias: string
  readonly provider: Provider
  readonly sessionId: string
}

// A human-authored replacement for the remaining plan of a paused run: the
// complete revised workflow document (canonical form) awaiting digest-bound
// approval via `orchestrate resume --approve-revision`.
export interface PendingRevision {
  readonly workflow: WorkflowSpec
  readonly digest: string
  readonly summary: readonly string[]
  readonly createdAt: string
}

export interface RunState {
  readonly id: string
  readonly contractVersion: number
  readonly workflowName: string
  readonly objective: string
  readonly digest: string
  readonly status: RunStatus
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly updatedAt: string
  readonly pid: number | null
  readonly workerToken: string | null
  readonly error: string | null
  readonly pauseReason: string | null
  readonly pauseCode: string | null
  readonly allowWriteConflicts: boolean
  readonly emergencyFuseOverride: boolean
  // Presentation-only mirroring choice (never part of the approved workflow
  // or its digest); optional so runs recorded before this field parse cleanly.
  readonly mirror?: "herdr" | null
  readonly stopRequested: boolean
  readonly agentStarts: number
  readonly goalRounds: Readonly<Record<string, number>>
  readonly supervisorStartedAt: Readonly<Record<string, string>>
  readonly supervisorBarriers: Readonly<Record<string, readonly string[]>>
  readonly overriddenLimits: readonly string[]
  readonly pendingPatch: {
    readonly supervisorId: string
    readonly decision: SupervisorDecision
    readonly reasons: readonly string[]
    readonly digest: string
  } | null
  readonly pendingInput: {
    readonly supervisorId: string
    readonly reason: string
    readonly digest: string
  } | null
  // A pending human mid-run revision proposed with `orchestrate revise`;
  // optional so runs recorded before revisions existed parse cleanly.
  readonly pendingRevision?: PendingRevision | null
  // A gated node that became runnable: the run pauses before its first attempt
  // and the fully rendered content awaits digest-bound approval.
  readonly pendingGate: {
    readonly nodeId: string
    readonly title: string
    readonly content: string
    readonly digest: string
  } | null
  readonly approvedPendingGate: boolean
  // Node ids whose approval gate was satisfied; the scheduler launches them
  // like ungated nodes from then on (retries and later supervisor rounds do
  // not re-gate).
  readonly satisfiedGates: readonly string[]
  readonly supervisorResponses: Readonly<
    Record<
      string,
      {
        readonly message: string
        readonly inputDigest: string
        readonly respondedAt: string
      }
    >
  >
  readonly approvedPendingPatch: boolean
  readonly nodes: Readonly<Record<string, NodeRunState>>
  readonly sessions: Readonly<Record<string, SessionState>>
  readonly dynamicNodes: readonly DynamicNode[]
}

export interface SupervisorDecision {
  readonly status: "complete" | "continue" | "pause"
  readonly reason: string
  readonly addNodes: readonly DynamicNode[]
}

export interface EventRecord {
  readonly timestamp: string
  readonly runId: string
  readonly type: string
  readonly message: string
  readonly nodeId?: string
  readonly data?: unknown
}
