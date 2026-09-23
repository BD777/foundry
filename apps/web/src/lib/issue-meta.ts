import type {
  Issue,
  IssueBlockedReason,
  IssueReadiness,
  IssueStatus,
} from "@foundry/protocol";
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
    message:
      issue.run?.error ??
      "Provide the information or decision needed to continue.",
  };
  const labels = {
    needs_input: "Needs input",
    needs_permission: "Needs permission",
    system_error: "System error",
  };
  return { label: labels[reason.kind], message: reason.message };
}

export function statusMeta(status: IssueStatus): {
  label: string;
  tone: BadgeTone;
} {
  const meta: Record<IssueStatus, { label: string; tone: BadgeTone }> = {
    pending: { label: "Pending", tone: "neutral" },
    in_progress: { label: "In progress", tone: "brass" },
    blocked: { label: "Blocked", tone: "warn" },
    verifying: { label: "Verifying", tone: "warn" },
    accepted: { label: "Accepted", tone: "online" },
    abandoned: { label: "Abandoned", tone: "slate" },
  };

  return meta[status];
}

export function readinessMeta(readiness: IssueReadiness | undefined): {
  label: string;
  tone: BadgeTone;
} {
  const labels: Record<IssueReadiness, { label: string; tone: BadgeTone }> = {
    direction: { label: "Needs human direction", tone: "slate" },
    inferring: { label: "Inferring readiness…", tone: "neutral" },
    proposal: { label: "Needs proposal", tone: "brass" },
    ready: { label: "Ready to execute", tone: "online" },
    split: { label: "Needs split", tone: "warn" },
    unsuitable: { label: "Not automatable", tone: "neutral" },
  };

  return labels[readiness ?? "ready"];
}

export function issueReadinessMeta(issue: Issue): {
  label: string;
  tone: BadgeTone;
} {
  if (issue.contractState === "amendment_pending")
    return { label: "Contract amendment pending", tone: "warn" };
  if (issue.contractState !== "confirmed")
    return { label: "Awaiting contract confirmation", tone: "warn" };
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
  return "Preparing execution";
}

export function issueReviewMeta(issue: Issue): {
  checks: string;
  tone: BadgeTone;
} {
  const needsAttention = issue.checks.some((check) =>
    check.toLowerCase().includes("attention"),
  );
  return {
    checks: needsAttention ? "Needs attention" : "Awaiting your review",
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
  const labels: Record<IssueStatus, string> = {
    blocked: "Describe the information or decision needed to continue.",
    pending: "Capture this idea and prepare the goal and completion criteria.",
    accepted: "Describe a follow-up after the last accepted workspace change.",
    in_progress: "Create an issue that can start working locally.",
    verifying: "Create an issue with clear verification criteria.",
    abandoned: "Describe a new direction after an abandoned Issue.",
  };
  return labels[status];
}
