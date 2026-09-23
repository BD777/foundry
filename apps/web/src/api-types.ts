import type {
  AgentConfigScope,
  AgentConnectionType,
  AgentProjection,
  AgentProfileProjection,
  AgentRuntimeSettings,
  AgentSession,
  AgentSessionEvent,
  AssetProjection,
  ChatAttachment,
  ChatThread,
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
  DeviceProjection,
  DeviceSkill,
  DeviceSkillRoot,
  FoundryDataProjection,
  Issue,
  PromotedSkill,
  RunEvent,
  ProviderHealth,
  SkillPackRef,
  WorkerRuntimeId,
  WorkspaceFileEntry,
  WorkspaceAccessRole,
  WorkspaceFeishuConfig,
  WorkspaceProjection,
  WorkspaceSkillBinding,
} from "@foundry/protocol";

export type FoundryData = FoundryDataProjection;

export type FoundryStreamEvent =
  | {
      type: "evidence_updated";
      payload: {
        issueId: string;
        workspaceId: string;
        entityId: string;
        version: number;
        status: string;
      };
    }
  | { type: "issue_updated"; payload: Issue }
  | { type: "issue_run_event"; payload: RunEvent }
  | {
      type:
        | "agent_session_created"
        | "agent_session_started"
        | "agent_session_completed"
        | "agent_session_native_session_id";
      payload: AgentSession;
    }
  | {
      type: "agent_session_event";
      payload: AgentSessionEvent;
    }
  | {
      type: "feishu_bot_updated";
      payload: WorkspaceFeishuConfig;
    }
  | {
      type: "workspace_members_updated";
      payload: { workspaceId: string };
    };

export interface CreateIssueInput {
  codexSpeed?: CodexSpeed;
  model?: string;
  profileId?: string;
  claudeEffort?: ClaudeEffort;
  codexReasoningEffort?: CodexReasoningEffort;
  runtime?: WorkerRuntimeId;
  sourceInput: string;
  workspaceId?: string;
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
  agentId: string;
  attachments?: ChatAttachment[];
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexReasoningEffort?: CodexReasoningEffort;
  codexSandboxMode?: CodexSandboxMode;
  codexSpeed?: CodexSpeed;
  importedContext?: string;
  issueId?: string;
  parentSessionId?: string;
  model?: string;
  nativeSessionId?: string;
  profileId?: string;
  profileTransitionNote?: string;
  prompt: string;
  provider: AgentSession["provider"];
  source?: "chat" | "diagnostic" | "naming" | "agent";
  threadId?: string;
  workspaceId: string;
}

export interface CreateAgentProfileInput {
  apiKey?: string;
  baseUrl?: string;
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexReasoningEffort?: CodexReasoningEffort;
  codexSandboxMode?: CodexSandboxMode;
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
