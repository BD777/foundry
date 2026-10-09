import type {
  AgentSession,
  AgentSessionTimerFire,
  AgentScheduledTask,
  AgentTurnUsage,
  ChatAttachment,
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
  SubagentUsage,
  WorkerRuntimeId,
} from "@bd777/foundry-protocol";
import type { ProcessDisplayItem } from "./chat-process-display";
import type { StepUsage } from "../../components/conversation/conversation-types";

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
  /** How long a process group ran, from its first to its last step. */
  durationMs?: number;
  /** When a process group's first step happened, for its live timer. */
  startedAt?: string;
  /** Tokens of the model requests behind a process group's steps. */
  stepUsage?: StepUsage;
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
  /** The turn's provider usage, on the answer that ends the turn. */
  usage?: AgentTurnUsage;
}

export interface ChatContextResourceItem {
  /** An output the latest reply names. */
  mentioned?: boolean;
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
  /** The subagent's own tokens, tool calls and time, as Claude reports them. */
  usage?: SubagentUsage;
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
