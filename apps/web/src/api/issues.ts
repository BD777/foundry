import type { Issue } from "@bd777/foundry-protocol";
import type { CreateIssueInput } from "../api-types";
import { request, type RequestOptions } from "./http";

const issuePath = (issueId: string) =>
  `/api/issues/${encodeURIComponent(issueId)}`;

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
  /** The device tells when this read would answer differently. */
  notifiesChanges?: boolean;
}
export function readIssueEnvironment(
  issueId: string,
  options: RequestOptions = {},
): Promise<IssueEnvironmentRead> {
  return request("GET", `${issuePath(issueId)}/environment`, options);
}
export function issueEnvironmentAction(
  issueId: string,
  action: "cancel" | "cleanup" | "preview_start" | "preview_stop",
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

export function steerIssue(
  issueId: string,
  message: string,
  expectedRunId: string,
): Promise<unknown> {
  return request("POST", `${issuePath(issueId)}/environment/steer`, {
    body: { message, expectedRunId },
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
