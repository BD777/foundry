import type {
  AgentBackgroundTask,
  AgentScheduledTask,
  ConfiguredContextWindow,
  SessionFileDiffAvailability,
  SessionFileRecord,
  SessionToolFrame,
  SubagentUsage,
} from "./session.js";

/**
 * What a chat's side panel shows of a session. The server derives it from
 * the session's state events, whichever of its events a reader loaded
 * (apps/server/internal/store/session_panel.go is its one definition), and
 * sends it with the newest window of a session read and, as it changes, as
 * agent_session_panel. Readers render it; they do not derive it again.
 */
export interface AgentSessionPanel {
  usage: AgentSessionPanelUsage;
  /** Something here is worth the panel's focus: work, outputs, timers. */
  focus: boolean;
  subagents: AgentSessionPanelSubagent[];
  /**
   * Commands, monitors and workflows of the newest background snapshot
   * (Claude only): running ones by start, then the most recently finished.
   * Background subagents are listed under `subagents`.
   */
  background: AgentSessionPanelBackgroundTask[];
  /** The timers of the newest timer snapshot. */
  timers: AgentSessionPanelTimer[];
  /** When that snapshot was taken: one-off times resolve from it. */
  timerSnapshotAt?: string;
  /** Each timer's last wake the events show (its last fire, or a resume). */
  timerWakes: AgentSessionPanelTimerWake[];
  /** The newest ended run of a timer the session holds, when it failed. */
  failedTimerRun?: AgentSessionPanelTimerRun;
  /** A turn, a timer's run or background work runs. */
  busy: boolean;
  /** One per path, by path. */
  files: AgentSessionPanelFile[];
  /** Local addresses (dev servers) its runs named, newest first. */
  previews: AgentSessionPanelLink[];
  /** The workspaces it loaded, in the order it first loaded them. */
  sources: AgentSessionPanelLink[];
  /** Its newest tool screenshot. */
  screen?: SessionToolFrame;
}

/** How full the context is, and what the session's turns used. */
export interface AgentSessionPanelUsage {
  /** The model the newest context report names. */
  model?: string;
  /** The newest model request's whole input. */
  usedTokens?: number;
  contextWindow?: number;
  configured?: ConfiguredContextWindow;
  /** Turns that reported usage, and what they used together. */
  turns: number;
  totals: AgentSessionPanelTotals;
  lastTurnDurationMs?: number;
  compactions: number;
  lastCompaction?: AgentSessionPanelCompaction;
}

export interface AgentSessionPanelTotals {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Summed over the `costTurns` turns whose cost is known. */
  costUsd?: number;
  costTurns: number;
}

/** The latest compaction: when, and its divider in the transcript. */
export interface AgentSessionPanelCompaction {
  at: string;
  messageId: string;
}

export interface AgentSessionPanelSubagent {
  /** The event that started it. */
  id: string;
  taskId: string;
  toolUseId?: string;
  detail?: string;
  /** A subagent still running when its session ended ended with it. */
  status: "running" | "completed" | "failed" | "canceled";
  usage?: SubagentUsage;
}

export interface AgentSessionPanelBackgroundTask {
  task: AgentBackgroundTask;
  /** The background subagent that started it, by its description. */
  owner?: string;
}

export interface AgentSessionPanelTimer {
  task: AgentScheduledTask;
  /** Its runs, newest first. */
  runs: AgentSessionPanelTimerRun[];
  /** Its run Claude started on its own and has not ended. */
  running?: AgentSessionPanelTimerRun;
}

/** A timer's run (AgentSessionTimerFire, as the panel shows it). */
export interface AgentSessionPanelTimerRun {
  id?: string;
  origin: "scheduled" | "background";
  prompt: string;
  response?: string;
  startedAt?: string;
  completedAt: string;
  /** Its answer is in the session's transcript only (an earlier turn's). */
  answerUnloaded?: true;
  /** The run ended in an error (its response is the error). */
  failed?: true;
}

export interface AgentSessionPanelTimerWake {
  id: string;
  firedAt: string;
}

/** A file the session's tools wrote or its answers named. */
export interface AgentSessionPanelFile {
  path: string;
  workspacePath?: string;
  origin: SessionFileRecord["origin"];
  op: SessionFileRecord["op"];
  inGitRepo: boolean;
  /** Turns (inputs, else the session) that recorded it, oldest first. */
  turnIds: string[];
  bytes?: number;
  /** Lines its writes added and removed, across its turns. */
  lineChanges?: AgentSessionPanelLineChanges;
  /** The same counts for each turn that wrote it. */
  turnLineChanges?: Record<string, AgentSessionPanelLineChanges>;
  diff?: SessionFileDiffAvailability;
  turnDiff?: Record<string, SessionFileDiffAvailability>;
}

export interface AgentSessionPanelLineChanges {
  added: number;
  removed: number;
}

/** A preview address or a loaded workspace: the event that named it. */
export interface AgentSessionPanelLink {
  id: string;
  target: string;
}
