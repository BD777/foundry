import type {
  AgentBackgroundTask,
  AgentSession,
  AgentSessionTimerFire,
  SessionFileRecord,
  SessionFileReference,
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
  /** Paths the answer names that its device verified, linked in its text. */
  fileReferences?: SessionFileReference[];
  /** The files the answer's turn wrote or named, on the answer ending it. */
  turnFiles?: { turnId: string; count: number };
}

export interface ChatContextResourceItem {
  detail?: string;
  id: string;
  kind: "source" | "web";
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

/** Work the agent left running in the background, as one panel row. */
export interface ChatBackgroundTaskItem {
  /** `<session>:background:<task>`: stable while the task changes. */
  id: string;
  kind: "background-task";
  label: string;
  task: AgentBackgroundTask;
  /** The background subagent that started it, by its description. */
  ownerLabel?: string;
  sessionId: string;
  workspaceId: string;
}

/** A file the chat's tools wrote or its answers named, as one panel row. */
export interface ChatSessionFileItem {
  /** The absolute path: one row per file across the chat's sessions. */
  id: string;
  kind: "session-file";
  label: string;
  path: string;
  workspacePath?: string;
  origin: SessionFileRecord["origin"];
  op: SessionFileRecord["op"];
  inGitRepo: boolean;
  /** Turns (inputs) that wrote or named it, oldest first. */
  turnIds: string[];
  /** The latest session that recorded it; reads go through its ledger. */
  sessionId: string;
  workspaceId: string;
  deviceLabel?: string;
  bytes?: number;
}

export type ChatContextSelection =
  | ChatBackgroundTaskItem
  | ChatContextResourceItem
  | ChatSessionFileItem
  | ChatSubagentItem
  | ChatTimerItem;

/** Compact, UI-neutral projection for the Codex-style thread sidecar. */
export interface ChatContextCardData {
  /** Files inside a Git work tree (diffs come in a later phase). */
  changes: ChatSessionFileItem[];
  /** Every other file, such as deliverables written to /tmp. */
  files: ChatSessionFileItem[];
  /** Local previews (dev servers) the chat started or named. */
  previews: ChatContextResourceItem[];
  sources: ChatContextResourceItem[];
  subagents: ChatSubagentItem[];
  timers: ChatTimerItem[];
  /** Commands, monitors and workflows (not subagents), running first. */
  background: ChatBackgroundTaskItem[];
}

/** A durable Chat thread assembled from one or more agent sessions. */
export interface ChatSessionThread {
  id: string;
  sessions: AgentSession[];
  title: string;
}
