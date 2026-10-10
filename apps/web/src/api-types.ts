import type {
  AgentConfigScope,
  AgentConnectionType,
  AgentProjection,
  AgentProfileProjection,
  AgentRuntimeSettings,
  AgentSession,
  AgentSessionEvent,
  AgentSubagentSummary,
  AssetProjection,
  ChatAttachment,
  ChatLayout,
  ChatQueue,
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
} from "@bd777/foundry-protocol";
import type { ChatTitleMetadata } from "./api";

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

/** A top-level field of GET /api/foundry-data besides `workspace`. */
export type FoundryDataField = Exclude<keyof FoundryData, "workspace">;

/** A device went online or offline. */
export interface DeviceStatusChangedPayload {
  workspaceId: string;
  deviceId: string;
  status: DeviceProjection["status"];
  /**
   * The device as workspace data lists it to a viewer who does not own it
   * (no `owned`, no `runtimeSettings`). Older servers send status only.
   */
  device?: DeviceProjection;
}

/**
 * One subagent of a session as its list shows it, sent when it starts and
 * when it ends. Without `subagent` the list may have changed in a way the
 * server cannot name: it is read again.
 */
export interface AgentSubagentUpdate {
  workspaceId: string;
  sessionId: string;
  subagent?: AgentSubagentSummary;
}

export type FoundryStreamEvent =
  | {
      type: "device_status_changed";
      payload: DeviceStatusChangedPayload;
    }
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
  | { type: "issue_created"; payload: Issue }
  | { type: "issue_updated"; payload: Issue }
  | { type: "issue_run_event"; payload: RunEvent }
  | {
      type:
        | "agent_session_created"
        | "agent_session_started"
        | "agent_session_blocked"
        | "agent_session_resumed"
        | "agent_session_completed"
        | "agent_session_native_session_id";
      payload: AgentSession;
    }
  | {
      type: "agent_session_event";
      payload: AgentSessionEvent;
    }
  | {
      type: "agent_subagent_updated";
      payload: AgentSubagentUpdate;
    }
  | {
      type: "feishu_bot_updated";
      payload: WorkspaceFeishuConfig;
    }
  | {
      type: "workspace_members_updated";
      payload: { workspaceId: string };
    }
  | { type: "chat_queue_changed"; payload: ChatQueue }
  | {
      /**
       * Chat titles of the workspace changed: `titles` are the changed chats'
       * entries as GET /api/chat-titles lists them, `removed` the changed
       * chats it no longer lists. Without either, read the list again.
       */
      type: "chat_titles_changed";
      payload: {
        workspaceId: string;
        titles?: ChatTitleMetadata[];
        removed?: string[];
      };
    }
  | {
      /**
       * The workspace's chat groups and order were saved or deleted: `layout`
       * as GET /api/chat-layout answers it (a later revision supersedes it).
       * Without it, read the layout again.
       */
      type: "chat_layout_changed";
      payload: { workspaceId: string; layout?: ChatLayout };
    }
  | {
      /**
       * Workspace data no other event carries changed: of one workspace, or
       * of every workspace when `workspaceId` is "" (devices, profiles,
       * provider health, skills). Coalesced by the server. `resources`
       * names the fields that changed; without it any may have.
       */
      type: "foundry_data_changed";
      payload: { workspaceId: string; resources?: FoundryDataField[] };
    }
  | {
      /**
       * Chats of the workspace's chat list as it shows them, and the ids of
       * chats it no longer shows.
       */
      type: "chats_changed";
      payload: { workspaceId: string; chats: ChatThread[]; removed: string[] };
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
