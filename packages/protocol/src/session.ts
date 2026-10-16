// Agent sessions: their inputs, transcript events, timers, background work,
// subagents, usage and recorded files.

import type { ChatAttachment, TranscriptMessage } from "./chat.js";
import type { RunStatus } from "./issue.js";
import type {
  ClaudeEffort,
  ClaudePermissionMode,
  CodexApprovalPolicy,
  CodexReasoningEffort,
  CodexSandboxMode,
  CodexTransport,
  CodexSpeed,
  WorkerRuntimeId,
} from "./profiles.js";
import type { ContextWindowSource } from "./model-context.js";
import type { SessionSkillRef } from "./skills.js";

/**
 * A file a session's own write tools changed, or its answer named, recorded
 * once per turn. Attribution comes from the agent's tool calls, never from
 * files that merely changed on disk while it ran.
 */
export interface SessionFileRecord {
  /** Absolute path on the device. */
  path: string;
  /** Relative to the workspace, when the file is inside it. */
  workspacePath?: string;
  /** "tool": a write tool changed it; "reference": only the answer names it. */
  origin: "tool" | "reference";
  op: "created" | "modified" | "deleted" | "referenced";
  /** Inside a Git work tree: listed under Changes, otherwise under Files. */
  inGitRepo: boolean;
  /** The input whose turn recorded it. */
  inputId?: string;
  /** "main", or the id of the subagent whose tool wrote it. */
  agent?: string;
  bytes?: number;
  /** Lines this turn's writes added and removed, once the turn ended. */
  added?: number;
  removed?: number;
  /** Lines added and removed since the session first wrote it. */
  totalAdded?: number;
  totalRemoved?: number;
}

/** A path an answer names that its device verified; linked in the text. */
export interface SessionFileReference {
  /** As it appears in the answer: a code span's content or a link target. */
  text: string;
  path: string;
  kind: "file" | "dir";
  /**
   * No file was there when the answer ended (a background subagent's
   * deliverable, say): it links once a session file is recorded at `path`,
   * and reading it before then says it does not exist yet.
   */
  pending?: boolean;
}

/** One of a session's recorded files, read from its device. */
export interface SessionFileRead {
  sessionId: string;
  path: string;
  workspacePath?: string;
  origin: "tool" | "reference";
  /** The file resolves inside the session's workspace. */
  insideWorkspace: boolean;
  /** text: `content`; image: `dataBase64` and `mimeType`; binary: size only. */
  kind: "text" | "image" | "binary" | "missing";
  content?: string;
  dataBase64?: string;
  mimeType?: string;
  truncated: boolean;
  bytes?: number;
  mtime?: string;
  /** Modified on the device after the turn that recorded it. */
  changedSinceRecorded: boolean;
}

/**
 * What a session's own writes changed in one file, read from its device.
 * "hook": the file as it was before the session's first write and after its
 * last (Claude), so concurrent edits to other files never show.
 * "git-snapshot": against a Git snapshot taken when the turn started (Codex),
 * which may include other edits to the same file.
 */
export interface SessionFileDiff {
  sessionId: string;
  path: string;
  workspacePath?: string;
  origin: "tool" | "reference";
  insideWorkspace: boolean;
  /** One turn's diff; absent: the whole session's. */
  inputId?: string;
  source: "hook" | "git-snapshot";
  /** Absent when the diff is unavailable, binary or too large. */
  before?: string;
  after?: string;
  /** empty: the session created it; beforeEdits / turnStart: see `source`. */
  beforeLabel: "empty" | "beforeEdits" | "turnStart";
  /** afterEdits: after the session's last write; deleted: it removed it. */
  afterLabel: "afterEdits" | "current" | "deleted";
  /** Something else also wrote the file while the session edited it. */
  mayIncludeOtherEdits: boolean;
  /** The file changed on the device after the session's last write. */
  changedSince: boolean;
  truncated: boolean;
  binary: boolean;
  tooLarge: boolean;
  /** noBaseline: no copy from before the session's edits was kept. */
  unavailable?: "noBaseline";
  /** Lines added and removed, when both sides are text. */
  added?: number;
  removed?: number;
}

export interface AgentSessionEvent {
  id: string;
  sessionId: string;
  at: string;
  label: string;
  detail: string;
  level: "info" | "warning" | "error";
  metadata?: AgentSessionEventMetadata;
  message?: TranscriptMessage;
}

/**
 * A timer/scheduled task an agent created inside its own session.
 *
 * Claude exposes session-scoped cron jobs (CronCreate/ScheduleWakeup). Claude
 * Code fires them while its process runs and brings them back when the
 * session resumes; the device resumes a session whose timer is due while no
 * process runs it. Codex headless sessions have no equivalent, so timers
 * never appear for Codex threads.
 */
export interface AgentScheduledTask {
  id: string;
  kind: "cron" | "wakeup";
  /** Raw 5-field cron expression in local time. */
  schedule: string;
  /** Human-readable, already localized schedule description. */
  humanSchedule: string;
  /** false for one-shot reminders, true for recurring jobs. */
  recurring: boolean;
  /** Prompt submitted to the agent when the timer fires. */
  prompt: string;
  /**
   * When Claude Code fires it next (ISO 8601), its id's offset included, as
   * of the snapshot; readers recompute it from `schedule` as time passes.
   */
  nextFireAt?: string;
}

/**
 * The timers a session's agent holds (Claude's CronCreate, ScheduleWakeup,
 * /loop): they wake it later, so the session is not idle even when its
 * latest input completed. `status` still describes that input. The server
 * derives it from the latest timer snapshot the device reported.
 */
export interface AgentSessionSchedule {
  /** When the device reported these timers. */
  reportedAt: string;
  timers: AgentSessionScheduledTimer[];
}

/**
 * A timer of a session's schedule, without its prompt. `nextFireAt` is as
 * of the schedule's `reportedAt`; readers recompute it from `schedule` as
 * time passes.
 */
export interface AgentSessionScheduledTimer {
  id: string;
  kind: AgentScheduledTask["kind"];
  schedule: string;
  recurring: boolean;
  nextFireAt?: string;
  /**
   * When a snapshot first listed the timer: a recurring one ends
   * claudeRecurringTimerMaxAgeMs later.
   */
  firstSeenAt?: string;
}

/**
 * A session's timers as its device keeps them, prompts included: the
 * server sends a device that connects its sessions' timers
 * (`session_timers`), so it fires them while no process runs the session.
 */
export interface SessionTimers {
  sessionId: string;
  nativeSessionId: string;
  timers: SessionKeptTimer[];
}

/** A timer of a session's schedule with its prompt. */
export interface SessionKeptTimer extends AgentScheduledTask {
  firstSeenAt: string;
}

/** One automatic, timer-driven turn that ran without a Foundry turn open. */
export interface AgentSessionTimerFire {
  /** Scheduled task id when the firing task could be correlated. */
  id?: string;
  origin: "scheduled" | "background";
  prompt: string;
  response?: string;
  startedAt?: string;
  completedAt: string;
}

/**
 * Work the session's agent left running in the background: a command, a
 * monitor, a workflow, or a background subagent (shown under Subagents).
 * Only Claude reports background work; Codex's SDK ends everything with the
 * turn. Session events carry no command line: members read it, redacted,
 * with the task's output.
 */
export interface AgentBackgroundTask {
  id: string;
  provider: "claude" | "codex";
  kind: "command" | "monitor" | "workflow" | "subagent" | "other";
  description: string;
  /** Redacted command line, only in members' output reads. */
  command?: string;
  /** "ended": it is gone, and the agent did not say how it ended. */
  status: "running" | "completed" | "failed" | "stopped" | "ended";
  exitCode?: number;
  /** "user": stopped from Foundry; "agent_exit": its agent process ended. */
  stopReason?: "user" | "agent_exit";
  startedAt: string;
  endedAt?: string;
  /** The deadline the agent gave it (monitors), when it has one. */
  timeLimitMs?: number;
  /** The background subagent that started it. */
  ownerSubagentTaskId?: string;
  toolUseId?: string;
  /** The agent's redacted one-line summary of how it ended. */
  summary?: string;
  /** Whether the task writes an output log the device can show. */
  hasOutput: boolean;
}

/** The last 64 KB of a background task's output, for members. */
export interface AgentBackgroundTaskOutput {
  sessionId: string;
  taskId: string;
  /** Redacted command line, when the task ran one. */
  command?: string;
  /** Plain text: ANSI escapes stripped, secrets redacted. */
  content: string;
  /** True when earlier output was left out. */
  truncated: boolean;
  bytes: number;
  /** "missing": no output was written, or it was cleaned up. */
  kind: "text" | "binary" | "missing";
  /**
   * Present when `content` continues an earlier read: what the log gained
   * from this offset (the `lineEnd` that read returned) on.
   */
  from?: number;
  /** Where a later read continues (`after`). Older devices omit it. */
  lineEnd?: number;
  /**
   * How many characters of `content` cover the log before `lineEnd`; the
   * rest is a line still being written, which the next read sends again.
   */
  stable?: number;
  /** The device tells when this running task's log grows. */
  following?: boolean;
}

export interface AgentSessionEventMetadata {
  nativeAccountError?: "account_on_hold";
  nativeAccountInputId?: string;
  /** A Claude background task's own output log, on its end event. */
  taskOutputFile?: string;
  /**
   * The session's background work at the time of the event (latest wins):
   * running tasks and the most recent finished ones.
   */
  backgroundTaskSnapshot?: AgentBackgroundTask[];
  /** A file the session's tools wrote or its answer named, once per turn. */
  sessionFile?: SessionFileRecord;
  /** Paths the turn's answer names that the device verified (turn end). */
  fileReferences?: SessionFileReference[];
  prompt?: string;
  subagentType?: string;
  taskId?: string;
  taskType?: string;
  toolUseId?: string;
  /** Authoritative timer snapshot for the session at the time of the event. */
  timerSnapshot?: AgentScheduledTask[];
  /** Present on events marking an automatic timer-triggered background turn. */
  timerFire?: AgentSessionTimerFire;
  /** Present on the event that ends a turn the provider reported usage for. */
  turnUsage?: AgentTurnUsage;
  /** What a Claude subagent has used so far, on its progress and end events. */
  subagentUsage?: SubagentUsage;
  /**
   * A model request's final tokens (Claude), reported when its stream ends.
   * Steps of that request share the id; the event itself is not shown.
   */
  requestUsage?: ModelRequestUsage;
  /**
   * How full the session's context is after a main-agent model request or
   * a compaction (latest wins), on "Model request usage" events.
   */
  contextUsage?: AgentContextUsage;
  /**
   * What this Codex session showed about its compatible endpoint's Responses
   * WebSocket; the server keeps it for the profile and base URL.
   */
  codexTransport?: CodexTransportReport;
  /**
   * On a message's event (an input, or a message steered into a running
   * turn): the session that sent it. Absent for what the person typed.
   */
  sentBySessionId?: string;
}

/** A Codex session's transport observation, for the profile it ran. */
export interface CodexTransportReport {
  profileId: string;
  baseUrl: string;
  transport: CodexTransport;
  detail?: string;
}

/**
 * The session's context as its runtime reports it. `inputTokens` is the
 * whole input of the latest main-agent model request: Claude's prompt with
 * its cache reads and writes, Codex's last request input, cached included.
 */
export interface AgentContextUsage {
  /** Absent when unknown, e.g. after a compaction that reports no size. */
  inputTokens?: number;
  /** The model's context window, once the runtime has reported it. */
  contextWindow?: number;
  /**
   * The window Foundry set for a compatible endpoint's model, and where it
   * came from. The runtime may still report another window: Claude Code keeps
   * its own for models it knows, Codex caps at the model's maximum and
   * reports 95% of it as usable.
   */
  configuredWindow?: ConfiguredContextWindow;
  /** The model that served the request. */
  model?: string;
  /** Present when the runtime compacted the context. */
  compaction?: AgentContextCompaction;
}

export interface ConfiguredContextWindow {
  tokens: number;
  source: ContextWindowSource;
}

export interface AgentContextCompaction {
  trigger: "auto" | "manual";
  /** Tokens in the context before it was compacted. */
  preTokens?: number;
}

/**
 * A subagent's own work as Claude reports it: one token total, without an
 * input/output split. Not part of its parent's per-step token counts.
 */
export interface SubagentUsage {
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/**
 * What one turn cost, as the agent's SDK reported it. Token counts share one
 * meaning across providers: `inputTokens` is every prompt token the model
 * read, and cache reads/writes are parts of it, not additions to it.
 */
export interface AgentTurnUsage {
  /** Wall time from the runtime taking the turn to its final result. */
  durationMs: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Includes `reasoningTokens` when the provider reports them. */
  outputTokens: number;
  reasoningTokens?: number;
  /** Model requests in the turn (Claude reports them; Codex does not). */
  modelRequests?: number;
  /**
   * What Claude priced the turn at, in US dollars at list price; absent when
   * unknown (Codex, or the first turn of a resumed Claude process).
   */
  costUsd?: number;
}

export interface AgentSubagentTranscriptMessage {
  content: string;
  id: string;
  role: "user" | "assistant" | "tool";
  title?: string;
  kind?: TranscriptMessage["kind"];
  callId?: string;
  status?: TranscriptMessage["status"];
  /** Tokens of the subagent's model request behind this step. */
  requestUsage?: ModelRequestUsage;
}

export interface AgentSubagentTranscript {
  messages: AgentSubagentTranscriptMessage[];
  prompt?: string;
  sessionId: string;
  status: "running" | "completed" | "failed";
  subagentType?: string;
  taskId: string;
  title: string;
  toolUseId: string;
  usage?: SubagentUsage;
}

export interface AgentSubagentSummary {
  prompt?: string;
  responseTexts: string[];
  sessionId: string;
  status: "running" | "completed" | "failed";
  subagentType?: string;
  taskId: string;
  title: string;
  toolUseId: string;
  usage?: SubagentUsage;
}

/**
 * A subagent as a chat lists it: its answers only as fingerprints (see
 * subagentResponseFingerprint, distinct, in order), without its prompt.
 */
export interface AgentSubagentDigest {
  responseFingerprints: string[];
  sessionId: string;
  status: "running" | "completed" | "failed";
  subagentType?: string;
  taskId: string;
  title: string;
  toolUseId: string;
  usage?: SubagentUsage;
}

/**
 * One message delivered to a session: the unit of dispatch. It is not a
 * session of its own; identity, permissions and lineage stay with the session.
 */
export interface SessionInput {
  id: string;
  prompt: string;
  attachments?: ChatAttachment[];
  profileTransitionNote?: string;
  importedContext?: string;
  /** When the server received it; its transcript events carry the same time. */
  at?: string;
  /**
   * Set when the input is a timer's prompt: the device resumed the session
   * because the timer was due while no agent process ran it.
   */
  timerFire?: AgentSessionTimerFire;
  /** The session that sent the input; absent for what the person typed. */
  sentBySessionId?: string;
}

/** Label of the transcript event each session input writes. */
export const sessionInputEventLabel = "User message";

/**
 * Label of the transcript notice that a queued session's input waits for
 * its device (offline, or online but not starting it yet).
 */
export const sessionDeviceWaitEventLabel = "Waiting for device";

/**
 * One native agent session (a Claude Code or Codex session) for its whole
 * life. Conversation turns stay inside the native agent.
 */
export interface AgentSession {
  /** Account that started it; agent-created sessions inherit their parent's. */
  createdByUserId?: string;
  id: string;
  /** Equals `id`; kept so readers of legacy per-turn rows still group them. */
  threadId?: string;
  /**
   * The native session it resumes on the runtime it runs on; absent starts
   * one there. The server owns which native sessions a session has.
   */
  nativeSessionId?: string;
  /**
   * Set until a fork first answers: `nativeSessionId` starts as a copy of
   * this native session (Claude's forkSession).
   */
  forkNativeSessionId?: string;
  workspaceId: string;
  agentId: string;
  deviceId: string;
  provider: Exclude<WorkerRuntimeId, "mock">;
  profileId?: string;
  profileFingerprint?: string;
  profileLabel?: string;
  /** "digest": a Personal Agent digest summary session (read-only). */
  source?:
    | "chat"
    | "diagnostic"
    | "naming"
    | "verification"
    | "agent"
    | "issue"
    | "digest";
  /**
   * The job the session does for Foundry; absent for a chat. An
   * issue_execution session implements its Issue; an issue_clarification
   * session talks the Issue through with the person, read-only; a
   * personal_agent session is the person's assistant, started by the person
   * in their Personal Agent Workspace.
   */
  role?: "issue_execution" | "issue_clarification" | "personal_agent";
  /** Orchestration lineage: the session that created this one. A record, not a permission. */
  parentSessionId?: string;
  /** When set, the session executes inside an Issue candidate worktree. */
  issueId?: string;
  /** Present for the active status "blocked" (rate limit / permission wait). */
  blockedReason?: string;
  /** source=naming job targeting an orchestration group to rename. */
  groupNameTarget?: string;
  /** Set when this session caused a new orchestration group to be created. */
  createdGroupId?: string;
  model?: string;
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
  codexReasoningEffort?: CodexReasoningEffort;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexSpeed?: CodexSpeed;
  status: RunStatus;
  title: string;
  /** The session's opening goal. */
  prompt: string;
  /** The latest input; `status` describes handling it. */
  input?: SessionInput;
  /**
   * Server-resolved workspace skill selection for this session. The runtime
   * is forced to expose only these; an empty present list means none.
   */
  skillRefs?: SessionSkillRef[];
  /** The answer to the latest input. */
  response?: string;
  error?: string;
  startedAt?: string;
  lastActivityAt?: string;
  /**
   * Last conversation activity: the latest input, or the answer that
   * completed it. Chat lists order by it.
   */
  activityAt?: string;
  completedAt?: string;
  createdLabel: string;
  answerRevision?: string;
  updatedLabel: string;
  /** Present while the agent holds timers that will wake the session. */
  scheduled?: AgentSessionSchedule;
  events?: AgentSessionEvent[];
}

/**
 * A session as a link to it names it (GET /api/agent-sessions/{id}/link):
 * where it is and the title its chat shows. Only for a viewer who may view it.
 */
export interface SessionLink {
  id: string;
  workspaceId: string;
  title: string;
}

/**
 * One model request's tokens. A request can produce several steps; each
 * carries the same id, and its last report counts.
 */
export interface ModelRequestUsage {
  requestId: string;
  /** Prompt tokens, cache reads and writes included. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}
