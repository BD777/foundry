import type {
  AgentConfigScope,
  AgentConnectionType,
  AgentProfileProjection,
  AgentRuntimeSettings,
  AgentSession,
  BrowserEvent,
  BrowserEventType,
  BrowserNoticeType,
  ChatAttachment,
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
  FoundryDataProjection,
  WorkerRuntimeId,
  WorkspaceAccessRole,
} from "@bd777/foundry-protocol";

/** A library skill as the composer's "/" menu offers it. */
export interface WorkspaceSkillSummary {
  id: string;
  name: string;
  description?: string;
}

export type FoundryData = FoundryDataProjection & {
  /**
   * The library skills the workspace selected or gets by default, for the
   * composer's menu. The whole catalog (promotedSkills) is read only by the
   * pages that show it.
   */
  workspaceSkills?: WorkspaceSkillSummary[];
};

export type { FoundryDataField } from "@bd777/foundry-protocol";

/**
 * An event of the workspace-data stream (onAnyStreamEvent): every browser
 * event but notices, which reach only the feature they name (onStreamEvent).
 */
export type FoundryStreamEvent = BrowserEvent<
  Exclude<BrowserEventType, BrowserNoticeType>
>;

export interface CreateIssueInput {
  codexSpeed?: CodexSpeed;
  model?: string;
  profileId?: string;
  claudeEffort?: ClaudeEffort;
  codexReasoningEffort?: CodexReasoningEffort;
  runtime?: WorkerRuntimeId;
  sourceInput: string;
  workspaceId?: string;
  /** The person confirmed setting up Git in a workspace without it. */
  initializeGit?: boolean;
}

export interface CreateWorkspaceInput {
  deviceId?: string;
  path: string;
}

export interface WorkspaceInspection {
  workspaceId: string;
  sourcePath: string;
  inspectedAt: string;
  scannedAt?: string;
  gitState: "ready" | "unborn" | "not_git" | "nested" | "error";
  branch: string;
  head: string;
  containingRepository: string;
  trackedChanges?: boolean;
  uniqueRepositoryCount: number;
  linkedWorktreeCount: number;
  repositories: Array<{
    id: string;
    path: string;
    kind: "root" | "independent" | "submodule";
    baseline: string;
    status: "ready" | "unborn" | "conflict" | "unavailable";
    error?: string;
    linkedWorktree?: boolean;
  }>;
  errors: string[];
}

export interface ListWorkspaceSubdirectoriesInput {
  deviceId?: string;
  path: string;
}

export interface ReadWorkspaceFileInput {
  path: string;
  workspaceId: string;
}

export interface UploadChatAttachmentsInput {
  files: File[];
  workspaceId: string;
}

export interface CreateAgentSessionInput {
  skillSelection?: import("@bd777/foundry-protocol").SkillSelection;
  agentId: string;
  attachments?: ChatAttachment[];
  /** Continues this device-native chat: the new session adopts it. */
  chatId?: string;
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexReasoningEffort?: CodexReasoningEffort;
  codexSandboxMode?: CodexSandboxMode;
  codexSpeed?: CodexSpeed;
  importedContext?: string;
  /**
   * Names the input (a lowercase UUID): a retried send with the same id
   * gets the session that took it instead of starting a second turn.
   */
  inputId?: string;
  issueId?: string;
  parentSessionId?: string;
  model?: string;
  nativeSessionId?: string;
  profileId?: string;
  profileTransitionNote?: string;
  prompt: string;
  provider: AgentSession["provider"];
  source?: "chat" | "diagnostic" | "naming" | "agent";
  workspaceId: string;
}

/**
 * A message for an existing session: steers it while it runs, otherwise it
 * is the next input. Agent and runtime fields switch the session first.
 */
export type SendAgentSessionMessageInput = Omit<
  CreateAgentSessionInput,
  | "agentId"
  | "chatId"
  | "importedContext"
  | "issueId"
  | "nativeSessionId"
  | "parentSessionId"
  | "provider"
  | "source"
  | "workspaceId"
> &
  Partial<Pick<CreateAgentSessionInput, "agentId" | "provider">> & {
    /** Refuse (409) rather than steer when the session is already running. */
    requireIdle?: boolean;
  };

export interface CreateAgentProfileInput {
  apiKey?: string;
  baseUrl?: string;
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexReasoningEffort?: CodexReasoningEffort;
  codexSandboxMode?: CodexSandboxMode;
  contextWindows?: Record<string, number>;
  codexSpeed?: CodexSpeed;
  configScope: AgentConfigScope;
  connectionType: AgentConnectionType;
  deviceId?: string;
  id?: string;
  label: string;
  model?: string;
  promptPrefix?: string;
  runtime: AgentProfileProjection["runtime"];
  workspaceId?: string;
}

export interface SaveAgentRuntimeSettingsInput {
  deviceId?: string;
  settings: AgentRuntimeSettings;
}

export type AccountRole = "admin" | "member";

export interface AccountUser {
  id: string;
  username: string;
  displayName: string;
  role: AccountRole;
  /** Interface language the person chose; "" follows the browser. */
  locale?: "" | "en" | "zh-CN";
  disabledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthState {
  needsSetup: boolean;
  user?: AccountUser;
}

export interface AccountInvite {
  id: string;
  role: AccountRole;
  /** Workspace the new account joins on acceptance. */
  workspaceId?: string;
  workspaceRole?: WorkspaceAccessRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedBy?: string;
  usedAt?: string;
  revokedAt?: string;
}

/** The invite token is returned once, at creation. */
export interface CreatedAccountInvite extends AccountInvite {
  token: string;
}

export interface InvitePreview {
  role: AccountRole;
  expiresAt: string;
  workspaceName?: string;
  workspaceRole?: WorkspaceAccessRole;
}

/** A workspace member as the workspace's members see them. */
export interface WorkspaceMember {
  userId: string;
  username: string;
  displayName: string;
  role: WorkspaceAccessRole;
  disabled?: boolean;
  /** The account that paired the workspace's device; always an Owner. */
  deviceOwner?: boolean;
  addedAt: string;
}

export interface NewAccountInput {
  username: string;
  displayName?: string;
  password: string;
}
