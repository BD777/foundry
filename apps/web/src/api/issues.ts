import type { Issue } from "@bd777/foundry-protocol";
import type { CreateIssueInput } from "../api-types";
import { request, type RequestOptions } from "./http";
import type { WindowedAgentSession } from "./sessions";

const issuePath = (issueId: string) =>
  `/api/issues/${encodeURIComponent(issueId)}`;

/** One Issue by id; 403/404 when the caller may not view it. */
export function getIssue(
  issueId: string,
  options: RequestOptions = {},
): Promise<Issue> {
  return request("GET", issuePath(issueId), options);
}

export function createIssue(
  input: CreateIssueInput,
  idempotencyKey = crypto.randomUUID(),
): Promise<Issue> {
  return request("POST", "/api/issues", { body: input, idempotencyKey });
}

export interface CandidateReviewData {
  status: string;
  revision: number;
  review: {
    cwd: string;
    repositories: Array<{
      path: string;
      baseline: string;
      candidate?: string;
      diff: string;
      truncated: boolean;
    }>;
  };
}

export interface IssueEnvironmentData {
  status: string;
  cwd?: string;
  revision?: number;
  bytes?: number;
  files?: number;
  error?: string;
  hasPreview?: boolean;
  preview?: { state: string; url?: string; error?: string };
  content?: {
    tracked: string[];
    untracked: string[];
    ignored: string[];
    truncated: boolean;
  };
  repositories: Array<{
    path: string;
    kind?: string;
    status: string;
    availability?: string;
    error?: string;
  }>;
}
export interface IssueEnvironmentRead {
  environment: IssueEnvironmentData;
}
export function readIssueEnvironment(
  issueId: string,
  options: RequestOptions = {},
): Promise<IssueEnvironmentRead> {
  return request("GET", `${issuePath(issueId)}/environment`, options);
}
export function issueEnvironmentAction(
  issueId: string,
  action: "cleanup" | "preview_start" | "preview_stop",
): Promise<unknown> {
  return request("POST", `${issuePath(issueId)}/environment/${action}`, {
    body: {},
  });
}

export function readCandidateReview(
  issueId: string,
): Promise<CandidateReviewData> {
  return request("GET", `${issuePath(issueId)}/candidate-review`);
}

/**
 * An Issue's latest executions (its issue_execution sessions), oldest first,
 * each with its newest `eventsLimit` events, as a chat reads its sessions
 * (getAgentSessionThread); older events are paged per session.
 */
export function listIssueExecutions(
  issueId: string,
  options: RequestOptions & { eventsLimit?: number } = {},
): Promise<WindowedAgentSession[]> {
  const query = options.eventsLimit
    ? `?eventsLimit=${options.eventsLimit}`
    : "";
  return request("GET", `${issuePath(issueId)}/executions${query}`, {
    signal: options.signal,
  });
}

export function abandonIssue(
  issueId: string,
  expectedRunId?: string,
): Promise<Issue> {
  return request("POST", `${issuePath(issueId)}/abandon`, {
    body: { expectedRunId: expectedRunId ?? "" },
  });
}

/** Answers the question an Issue's execution asked; the Issue continues in its candidate. */
export function answerIssueQuestion(
  issueId: string,
  questionId: string,
  answer: string,
): Promise<Issue> {
  return request("POST", `/api/issues/${issueId}/answer`, {
    body: { questionId, answer },
  });
}

export function requestChanges(
  issueId: string,
  message?: string,
  expectedRunId?: string,
): Promise<Issue> {
  return request("POST", `/api/issues/${issueId}/request-changes`, {
    body: { message, expectedRunId },
  });
}

/**
 * A person's message in an Issue's conversation: the draft they saw and why
 * it may change, for a clarification; the execution they saw, for feedback.
 */
export interface IssueMessageInput {
  text: string;
  expectedRevision?: number;
  expectedContentDigest?: string;
  changeReason?: string;
  expectedRunId?: string;
}

/** Where the server sent a message, and the Issue after it. */
export interface IssueMessageResult {
  route: "status" | "answer" | "clarify" | "continue";
  issue: Issue;
}

/**
 * Hands a message to the Issue: the server decides where it is due (its
 * status, the answer to its question, its clarification or feedback).
 */
export function sendIssueMessage(
  issueId: string,
  input: IssueMessageInput,
  idempotencyKey: string,
): Promise<IssueMessageResult> {
  return request("POST", `${issuePath(issueId)}/messages`, {
    body: input,
    idempotencyKey,
  });
}
