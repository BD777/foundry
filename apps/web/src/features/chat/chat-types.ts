import type {
  AgentSession,
  AgentSessionTimerFire,
  AgentScheduledTask,
  ChatAttachment,
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
  WorkerRuntimeId,
} from "@foundry/protocol";
import type { ProcessDisplayItem } from "./chat-process-display";

/** User-editable runtime settings for one selected Chat agent. */
export interface ChatOverrideDraft {
  claudeEffort?: ClaudeEffort | "";
  claudePermissionMode?: ClaudePermissionMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexReasoningEffort?: CodexReasoningEffort | "";
  codexSandboxMode?: CodexSandboxMode;
  codexSpeed?: CodexSpeed;
  model?: string;
}

/** UI-neutral projection consumed by the Chat message view. */
export interface ChatViewMessage {
  at?: string;
  agentLabel?: string;
  attachments?: ChatAttachment[];
  copyAlways?: boolean;
  copyText?: string;
  idea?: string;
  id?: string;
  kind?: "boundary" | "failure" | "message" | "process" | "tool";
  processItems?: ProcessDisplayItem[];
  recoverable?: boolean;
  role: "user" | "bot";
  runtime?: Exclude<WorkerRuntimeId, "mock">;
  statusLabel?: string;
  streaming?: boolean;
  text: string;
  title?: string;
}

export interface ChatContextResourceItem {
  detail?: string;
  id: string;
  kind: "file" | "source" | "web";
  label: string;
  target: string;
  workspaceId?: string;
}

export interface ChatSubagentItem {
  detail?: string;
  id: string;
  kind: "subagent";
  label: string;
  runtime: Exclude<WorkerRuntimeId, "mock">;
  sessionId: string;
  status: "running" | "completed" | "failed" | "canceled";
  taskId: string;
  toolUseId?: string;
  workspaceId: string;
}

/** A live agent-created timer observed via the agent timer interface. */
export interface ChatTimerItem {
  detail?: string;
  /** Observed automatic firings, newest first. */
  fires: AgentSessionTimerFire[];
  id: string;
  kind: "timer";
  label: string;
  sessionId: string;
  task: AgentScheduledTask;
  workspaceId: string;
}

export type ChatContextSelection =
  ChatContextResourceItem | ChatSubagentItem | ChatTimerItem;

/** Compact, UI-neutral projection for the Codex-style thread sidecar. */
export interface ChatContextCardData {
  outputs: ChatContextResourceItem[];
  sources: ChatContextResourceItem[];
  subagents: ChatSubagentItem[];
  timers: ChatTimerItem[];
}

/** A durable Chat thread assembled from one or more agent sessions. */
export interface ChatSessionThread {
  id: string;
  sessions: AgentSession[];
  title: string;
}
