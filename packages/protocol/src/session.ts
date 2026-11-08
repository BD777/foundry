// Agent sessions: their inputs, transcript events, timers, background work,
// subagents, usage and recorded files.
import type { SessionToolFrame, SubagentUsage } from "./contract.gen.js";
export type {
  AgentBackgroundTask,
  AgentBackgroundTaskOutput,
  AgentContextCompaction,
  AgentContextUsage,
  AgentScheduledTask,
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventMetadata,
  AgentSessionGoal,
  AgentSessionGoalSnapshot,
  AgentSessionGoalStatus,
  AgentSessionSchedule,
  AgentSessionScheduledTimer,
  AgentSessionTimerFire,
  AgentSubagentTranscript,
  AgentSubagentTranscriptMessage,
  AgentTurnUsage,
  CodexTransportReport,
  ConfiguredContextWindow,
  ModelRequestUsage,
  SessionExecutionBudget,
  SessionFileDiff,
  SessionFileDiffAvailability,
  SessionFileRead,
  SessionFileRecord,
  SessionFileReference,
  SessionInput,
  SessionToolFrame,
  SessionToolFrameSource,
  SubagentUsage,
} from "./contract.gen.js";

/**
 * A session keeps its newest frames within both bounds; older ones are
 * dropped (on the device and in the list) once a newer frame does not fit.
 */
export const sessionToolFrameLimits = {
  count: 200,
  bytes: 50 * 1024 * 1024,
} as const;

/** GET /api/agent-sessions/{id}/frames: the kept frames, oldest first. */
export interface SessionToolFrameList {
  frames: SessionToolFrame[];
  /** Older frames dropped by the limits. */
  dropped: number;
  limits: { count: number; bytes: number };
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
 * A session as a link to it names it (GET /api/agent-sessions/{id}/link):
 * where it is and the title its chat shows. Only for a viewer who may view it.
 */
export interface SessionLink {
  archivedAt?: string;
  id: string;
  workspaceId: string;
  title: string;
}
