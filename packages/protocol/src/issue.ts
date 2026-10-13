// Issues and their runs.

import type { ChatRecapMessage } from "./chat.js";
import type {
  ClaudeEffort,
  CodexReasoningEffort,
  CodexSpeed,
  WorkerRuntimeId,
} from "./profiles.js";
import type { SkillPackRef } from "./skills.js";

export type IssueStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "verifying"
  | "accepted"
  | "abandoned";

export interface IssueBlockedReason {
  kind: "needs_input" | "needs_permission" | "system_error";
  message: string;
}

export type IssueReadiness =
  "ready" | "split" | "proposal" | "direction" | "unsuitable" | "inferring";

export type RunStatus =
  "queued" | "running" | "blocked" | "completed" | "failed" | "canceled";

export interface RunEvent {
  id: string;
  runId: string;
  at: string;
  label: string;
  detail: string;
  level: "info" | "warning" | "error";
}

export interface AcceptanceArtifact {
  id: string;
  issueId: string;
  kind: "text" | "preview" | "diff" | "report";
  title: string;
  summary: string;
  primaryUri?: string;
}

export interface Run {
  id: string;
  issueId: string;
  workspaceId?: string;
  status: RunStatus;
  runtime: WorkerRuntimeId;
  startedLabel: string;
  startedAt?: string;
  completedAt?: string;
  environmentId?: string;
  environmentRevision?: number;
  executionCwd?: string;
  error?: string;
  events: RunEvent[];
}

export interface IssueConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  runId?: string;
  createdAt: string;
  /** Where a person's message came from when not the web, such as "feishu". */
  via?: string;
}

/** The Issue's clarification session and the person's latest message to it. */
export interface IssueClarification {
  sessionId: string;
  /** "replying" while the Agent answers, "failed" when it could not, "answered" once recorded. */
  status: "replying" | "failed" | "answered";
  error?: string;
  inputId: string;
  messageId: string;
  /** The draft the message was about. */
  revision: number;
  contentDigest: string;
  changeReason: string;
}

/**
 * What an Issue's execution asked the person: a decision (input) or an
 * approval (permission). The Issue blocks on it once the execution's turn
 * ends and resumes in its candidate with the answer.
 */
export interface IssueQuestion {
  id: string;
  kind: "input" | "permission";
  text: string;
  /** Suggested answers; the person may answer otherwise. */
  options?: string[];
  /** The execution session that asked. */
  runId: string;
  askedAt: string;
}

/** What a clarification input is about, sent with the session. */
export interface ClarificationTurn {
  draft: import("./evidence.js").IssueContract;
  /** The conversation before this message, for a session without native context. */
  messages: ChatRecapMessage[];
  message: string;
}

/** A clarification session's reply to one message. */
export interface ClarificationResponse {
  message: string;
  proposedContent?: import("./evidence.js").ContractContent;
}

export interface Issue {
  /** Account that started it; agent-created sessions inherit their parent's. */
  createdByUserId?: string;
  /** Dispatch-only confirmed content; never authored by the execution Agent. */
  executionContract?: import("./evidence.js").IssueContract;
  contractState?:
    "draft" | "confirmed" | "amendment_pending" | "legacy_unconfirmed";
  currentContractRevision?: number;
  draftContractRevision?: number;
  currentCandidateSnapshotId?: string;
  currentReviewSnapshotId?: string;
  verificationSummary?: import("./evidence.js").VerificationSummary;
  blockedReason?: IssueBlockedReason;
  codexSpeed?: CodexSpeed;
  model?: string;
  profileId?: string;
  claudeEffort?: ClaudeEffort;
  codexReasoningEffort?: CodexReasoningEffort;
  messages?: IssueConversationMessage[];
  clarification?: IssueClarification;
  question?: IssueQuestion;
  id: string;
  workspaceId?: string;
  shortId: string;
  title: string;
  status: IssueStatus;
  priority: "none" | "low" | "medium" | "high";
  readiness?: IssueReadiness;
  sourceInput: string;
  inferredTask: string;
  runtime: WorkerRuntimeId;
  skills: SkillPackRef[];
  acceptanceCriteria: string[];
  checks: string[];
  artifact?: AcceptanceArtifact;
  run?: Run;
  updatedLabel: string;
}
