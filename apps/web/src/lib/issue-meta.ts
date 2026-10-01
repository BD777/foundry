import type {
  Issue,
  IssueBlockedReason,
  IssueReadiness,
  IssueStatus,
} from "@bd777/foundry-protocol";
import { i18n } from "../i18n";
import type { BadgeTone } from "./asset-meta";
import { runPhase } from "./run-meta";

export const issueStatuses: IssueStatus[] = [
  "pending",
  "in_progress",
  "blocked",
  "verifying",
  "accepted",
  "abandoned",
];

/** Legacy storage and older servers remain readable during rollout. */
export function issueDisplayStatus(issue: Issue): IssueStatus {
  const legacy: Record<string, IssueStatus> = {
    inbox: "pending",
    ready: "pending",
    producing: "in_progress",
    review: "verifying",
    integrated: "accepted",
    interrupted: "blocked",
  };
  return legacy[issue.status] ?? issue.status;
}

export function blockedReasonMeta(
  issue: Issue,
): { label: string; message: string } | undefined {
  if (issueDisplayStatus(issue) !== "blocked") return undefined;
  const reason: IssueBlockedReason = issue.blockedReason ?? {
    kind: issue.run?.status === "failed" ? "system_error" : "needs_input",
    message: issue.run?.error ?? i18n.t("issues:blocked.defaultMessage"),
  };
  return {
    label: i18n.t(`issues:blocked.reason.${reason.kind}`),
    message: reason.message,
  };
}

export function statusMeta(status: IssueStatus): {
  label: string;
  tone: BadgeTone;
} {
  const tones: Record<IssueStatus, BadgeTone> = {
    pending: "neutral",
    in_progress: "brass",
    blocked: "warn",
    verifying: "warn",
    accepted: "online",
    abandoned: "slate",
  };

  return { label: i18n.t(`issues:status.${status}`), tone: tones[status] };
}

/**
 * The badge for one Issue: its state, except that a blocked Issue says why,
 * since waiting for the person's reply is a normal step, not a failure.
 */
export function issueBadgeMeta(issue: Issue): {
  label: string;
  tone: BadgeTone;
} {
  const status = issueDisplayStatus(issue);
  if (status !== "blocked") return statusMeta(status);
  const kind =
    issue.blockedReason?.kind ??
    (issue.run?.status === "failed" ? "system_error" : "needs_input");
  const tones: Record<IssueBlockedReason["kind"], BadgeTone> = {
    needs_input: "brass",
    needs_permission: "warn",
    system_error: "error",
  };
  return { label: i18n.t(`issues:blocked.badge.${kind}`), tone: tones[kind] };
}

export function readinessMeta(readiness: IssueReadiness | undefined): {
  label: string;
  tone: BadgeTone;
} {
  const tones: Record<IssueReadiness, BadgeTone> = {
    direction: "slate",
    inferring: "neutral",
    proposal: "brass",
    ready: "online",
    split: "warn",
    unsuitable: "neutral",
  };
  const key = readiness ?? "ready";
  return { label: i18n.t(`issues:readiness.${key}`), tone: tones[key] };
}

export function issueReadinessMeta(issue: Issue): {
  label: string;
  tone: BadgeTone;
} {
  if (issue.contractState === "amendment_pending")
    return { label: i18n.t("issues:readiness.amendmentPending"), tone: "warn" };
  if (issue.contractState !== "confirmed")
    return { label: i18n.t("issues:readiness.awaitingContract"), tone: "warn" };
  return readinessMeta(issue.readiness);
}

export function issueSpark(status: IssueStatus): boolean {
  return (
    status === "in_progress" || status === "verifying" || status === "accepted"
  );
}

export function issueShowsRuntime(issue: Issue): boolean {
  return (
    issue.runtime !== "mock" &&
    (issue.status === "in_progress" ||
      issue.status === "verifying" ||
      issue.status === "accepted")
  );
}

export function issuePhaseLabel(issue: Issue): string {
  if (issue.run) {
    return runPhase(issue.run);
  }
  return i18n.t("issues:phase.preparing");
}

export function issueReviewMeta(issue: Issue): {
  checks: string;
  needsAttention: boolean;
  tone: BadgeTone;
} {
  const needsAttention = issue.checks.some((check) =>
    check.toLowerCase().includes("attention"),
  );
  return {
    checks: i18n.t(
      needsAttention
        ? "issues:review.needsAttention"
        : "issues:review.awaitingReview",
    ),
    needsAttention,
    tone: "warn",
  };
}

export function issueSortValue(issue: Issue): number {
  const statusOrder: Record<IssueStatus, number> = {
    pending: 10,
    in_progress: 11,
    blocked: 12,
    verifying: 13,
    accepted: 14,
    abandoned: 15,
  };
  return statusOrder[issueDisplayStatus(issue)] * 1000;
}

export function preferredIssueId(issues: Issue[]): string {
  return (
    issues.find((issue) => issue.status === "verifying")?.id ??
    issues[0]?.id ??
    ""
  );
}

export function issueDisplayId(issue: Issue): string {
  const numeric = issue.shortId.match(/\d+/)?.[0] ?? issue.id.match(/\d+/)?.[0];
  return numeric ? `#${numeric}` : issue.shortId;
}

export function issueTemplate(status: IssueStatus): string {
  return i18n.t(`issues:template.${status}`);
}
