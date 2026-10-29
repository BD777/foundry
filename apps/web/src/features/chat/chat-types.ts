import type {
  AgentBackgroundTask,
  AgentContextCompaction,
  AgentQuestion,
  AgentSession,
  AgentSessionTimerFire,
  SessionFileDiffAvailability,
  SessionFileRecord,
  AgentScheduledTask,
  AgentSessionScheduledTimer,
  AgentTurnUsage,
  ChatAttachment,
  ClaudeEffort,
  ClaudeTimerWake,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexSpeed,
  SubagentUsage,
  WorkerRuntimeId,
  ConfiguredContextWindow,
} from "@bd777/foundry-protocol";
import type { ProcessDisplayItem } from "../../components/conversation/chat-process-display";
import type {
  ConversationFileReference,
  ConversationLiveActivity,
  ConversationSteerState,
  ConversationToolFrame,
  FailureDiagnostic,
  StepUsage,
} from "../../components/conversation/conversation-types";

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
  /** The client id of the message this tab sent, once the transcript shows it. */
  clientId?: string;
  at?: string;
  agentLabel?: string;
  attachments?: ChatAttachment[];
  copyAlways?: boolean;
  copyText?: string;
  /** How long a process group ran, from its start to its last step. */
  durationMs?: number;
  /**
   * When a process group began: where the segment before it (the input, a
   * steered message, an answer) ended. Its live timer counts from here.
   */
  startedAt?: string;
  /** Tokens of the model requests behind a process group's steps. */
  stepUsage?: StepUsage;
  idea?: string;
  id?: string;
  /** "waiting": queued work that waits for its offline device, without a timer. */
  kind?: "boundary" | "failure" | "message" | "process" | "tool" | "waiting";
  processItems?: ProcessDisplayItem[];
  recoverable?: boolean;
  failureDiagnostic?: FailureDiagnostic;
  role: "user" | "bot";
  runtime?: Exclude<WorkerRuntimeId, "mock">;
  /** A user message another session sent: that session's id. */
  sentBySessionId?: string;
  statusLabel?: string;
  streaming?: boolean;
  text: string;
  title?: string;
  /** The turn's provider usage, on the answer that ends the turn. */
  usage?: AgentTurnUsage;
  /** Paths the answer names that its device verified, linked in its text. */
  fileReferences?: ConversationFileReference[];
  /** The files the answer's turn wrote or named, on the answer ending it. */
  turnFiles?: { turnId: string; count: number };
  /** Questions the answer asks the person without waiting (Codex). */
  questions?: AgentQuestion[];
  /** The native item the questions came in; the answer names it. */
  questionItemId?: string;
  /** On a boundary: the context compaction it marks (DEV-083). */
  compaction?: AgentContextCompaction;
  /** On the running process row: the tool call running now (DEV-089). */
  liveActivity?: ConversationLiveActivity;
  /** On a message steered into a running turn: whether the agent read it. */
  steer?: ConversationSteerState;
  /**
   * The Claude task running the one tool call a steered message waits
   * behind: stopping it returns the call, and Claude reads the message.
   */
  steerBlockerTask?: { sessionId: string; taskId: string };
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
/**
 * A timer's firing. `answerUnloaded`: its turn is older than the events
 * loaded, so its answer is not here yet (it comes with them).
 */
export type ChatTimerFire = AgentSessionTimerFire & {
  answerUnloaded?: true;
  /** The run ended in an error (its response is the error). */
  failed?: true;
};

export interface ChatTimerItem {
  detail?: string;
  /** Observed automatic firings, newest first. */
  fires: ChatTimerFire[];
  /** Its run in progress, when one runs while no Foundry turn does. */
  running?: ChatTimerFire;
  /** What the session's events say of its last wake (see timerNextRun). */
  wake: ClaudeTimerWake;
  /**
   * The session was busy when it was read (a turn, a timer's run or
   * background work): a timer that fell due waits for it.
   */
  busy: boolean;
  id: string;
  kind: "timer";
  label: string;
  sessionId: string;
  task: AgentScheduledTask;
  /**
   * The timer as the session's schedule on the server holds it: when it
   * fires next comes from here. Absent when the agent no longer holds it
   * (deleted, expired, or never adopted): it is not active.
   */
  scheduled?: AgentSessionScheduledTimer;
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
  /** Lines the chat's writes added and removed, across its turns. */
  lineChanges?: ChatLineChanges;
  /** The same counts for each turn that wrote it. */
  turnLineChanges?: Record<string, ChatLineChanges>;
  /**
   * Whether the chat's writes, and each turn's, have a text diff; absent
   * when the device did not say (older workers).
   */
  diff?: SessionFileDiffAvailability;
  turnDiff?: Record<string, SessionFileDiffAvailability>;
  /** The latest session whose tools wrote it: diffs read its ledger. */
  diffSessionId?: string;
  /** Opened from one answer's files: shows that turn's diff. */
  diffTurnId?: string;
  /** Opened from a pending link: no session file is recorded here yet. */
  pending?: true;
}

/**
 * A workspace file or folder an answer named that no session recorded,
 * shown in the workspace browser; the device decides whether it is readable.
 */
export interface ChatWorkspacePathItem {
  id: string;
  kind: "workspace-path";
  label: string;
  /** Relative to the workspace folder. */
  path: string;
  /** As the answer resolved it: absolute, for the panel's caption. */
  detail: string;
  directory: boolean;
  workspaceId: string;
}

/**
 * A file of the chat's device outside the workspace an answer named, for
 * the device's owner: read from the device only when shown.
 */
export interface ChatDeviceFileItem {
  id: string;
  kind: "device-file";
  label: string;
  /** As the answer named it: absolute or `~/…`. */
  path: string;
  deviceId: string;
  deviceLabel?: string;
  /** Kept for the panel's actions; a device file is not in a workspace. */
  workspaceId?: undefined;
}

/**
 * A session's tool screenshots in the panel (DEV-075): its newest frame,
 * and the frame to show when one was chosen (otherwise the newest).
 */
export interface ChatScreenItem {
  id: string;
  kind: "screen";
  label: string;
  sessionId: string;
  workspaceId?: string;
  latest: ConversationToolFrame;
  frameId?: string;
}

export interface ChatLineChanges {
  added: number;
  removed: number;
}

export type ChatContextSelection =
  | ChatBackgroundTaskItem
  | ChatContextResourceItem
  | ChatSessionFileItem
  | ChatSubagentItem
  | ChatTimerItem
  | ChatWorkspacePathItem
  | ChatDeviceFileItem
  | ChatScreenItem;

/** Compact, UI-neutral projection for the Codex-style thread sidecar. */
/** The open session's status line: its context, then the rest folded. */
export interface ChatSessionStatus {
  sessionId: string;
  nativeSessionId?: string;
  runtime: AgentSession["provider"];
  profileLabel?: string;
  /** The model that answered, else the one the session asked for. */
  model?: string;
  effort?: ClaudeEffort | CodexReasoningEffort;
  claudePermissionMode?: ClaudePermissionMode;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  /**
   * A verifier: it runs in the read-only verification sandbox whatever its
   * permission settings say, and messages cannot change them.
   */
  verification?: boolean;
  deviceLabel?: string;
  /** The latest model request's whole input against the model's window. */
  context: {
    usedTokens?: number;
    contextWindow?: number;
    /** The window Foundry set for the model, and where it came from. */
    configured?: ConfiguredContextWindow;
  };
  /** Turns that reported usage, and what they used together. */
  turns: number;
  totals: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    /** Summed over the `costTurns` turns whose cost is known. */
    costUsd?: number;
    costTurns: number;
  };
  lastTurnDurationMs?: number;
  compactions: number;
  /** The latest compaction: when, and its divider in the transcript. */
  lastCompaction?: { at: string; messageId: string };
}

export interface ChatContextCardData {
  /** The open session's status line; absent before the chat has one. */
  status?: ChatSessionStatus;
  /** Files inside a Git work tree (diffs come in a later phase). */
  changes: ChatSessionFileItem[];
  /** Every other file, such as deliverables written to /tmp. */
  files: ChatSessionFileItem[];
  /** Local previews (dev servers) the chat started or named. */
  previews: ChatContextResourceItem[];
  /** The newest session with tool screenshots, by its newest one. */
  screen?: ChatScreenItem;
  sources: ChatContextResourceItem[];
  /** The workspace folder on its device, when known: answers' paths link. */
  workspaceRoot?: string;
  /**
   * The viewer owns the chat's device and has not turned device files off:
   * paths outside the workspace link too, read from this device.
   */
  deviceFiles?: { deviceId: string; deviceLabel?: string };
  subagents: ChatSubagentItem[];
  timers: ChatTimerItem[];
  /** Commands, monitors and workflows (not subagents), running first. */
  background: ChatBackgroundTaskItem[];
  /**
   * The session that started this chat, when another one did: named, and
   * opened by `onOpen` when the viewer may open it.
   */
  startedBy?: { sessionId: string; label: string; onOpen?: () => void };
}

/** Rows of the side panel still running while the chat's turn has ended. */
export interface ChatRunningBackgroundWork {
  /** Running commands, monitors and workflows in the Background section. */
  taskIds: string[];
  /** Running subagents in the Subagents section. */
  subagentIds: string[];
  /** A timer's run the agent started on its own, by its row. */
  timerRun?: { id: string; startedAt?: string };
}

/** A durable Chat thread assembled from one or more agent sessions. */
export interface ChatSessionThread {
  id: string;
  sessions: AgentSession[];
  title: string;
}
