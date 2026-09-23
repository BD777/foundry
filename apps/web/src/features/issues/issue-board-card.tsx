import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import type { Issue } from "@foundry/protocol";
import {
  issueDisplayId,
  issuePhaseLabel,
  issueReviewMeta,
  issueShowsRuntime,
  issueSpark,
  issueReadinessMeta,
  issueDisplayStatus,
  statusMeta,
  blockedReasonMeta,
} from "../../lib/issue-meta";
import {
  IssueCardCopy,
  IssueCardFooter,
  IssueCardFooterSpacer,
  IssueCardId,
  IssueCardIntegratedLine,
  IssueCardPill,
  IssueCardPriority,
  IssueCardProgress,
  IssuePriorityDashMark,
  IssueCardReviewLine,
  IssueCardRoot,
  IssueCardSpark,
  IssueCardStatusLine,
  IssueCardTitle,
  IssueCardTopline,
  IssueCardUpdated,
} from "./issue-card";
import { RuntimeMark } from "../../components/ui/runtime-mark";

function priorityMeta(priority: Issue["priority"]): {
  icon: ReactNode;
  label: string;
  priority: "high" | "low" | "medium";
  visible: boolean;
} {
  if (priority === "none") {
    return {
      icon: null,
      label: "",
      priority: "low",
      visible: false,
    };
  }

  if (priority === "high") {
    return {
      icon: <ArrowRight size={11} />,
      label: "High",
      priority,
      visible: true,
    };
  }

  if (priority === "medium") {
    return {
      icon: <IssuePriorityDashMark />,
      label: "Medium",
      priority,
      visible: true,
    };
  }

  return {
    icon: <ArrowLeft size={11} />,
    label: "Low",
    priority: "low",
    visible: true,
  };
}

export function IssueCard({
  issue,
  onOpen,
  selected,
}: {
  issue: Issue;
  onOpen: () => void;
  selected: boolean;
}) {
  const priority = priorityMeta(issue.priority);
  const readiness = issueReadinessMeta(issue);
  const review = issueReviewMeta(issue);
  const showRuntime = issueShowsRuntime(issue);
  const displayId = issueDisplayId(issue);

  return (
    <IssueCardRoot
      aria-label={`Open ${displayId}`}
      onClick={onOpen}
      selected={selected}
      status={issueDisplayStatus(issue)}
    >
      <IssueCardTopline>
        <IssueCardId>{displayId}</IssueCardId>
        {issueSpark(issue.status) ? (
          <IssueCardSpark>
            <Sparkles size={13} />
          </IssueCardSpark>
        ) : null}
      </IssueCardTopline>
      <IssueCardTitle>{issue.title}</IssueCardTitle>
      <IssueCardCopy>
        {blockedReasonMeta(issue)?.message ?? issue.sourceInput}
      </IssueCardCopy>
      {issue.status === "pending" ? (
        <IssueCardStatusLine>
          <IssueCardPill tone={readiness.tone}>{readiness.label}</IssueCardPill>
        </IssueCardStatusLine>
      ) : null}
      {issue.status === "in_progress" ? (
        <IssueCardProgress label={issuePhaseLabel(issue)} />
      ) : null}
      {issue.status === "verifying" ? (
        <IssueCardReviewLine meta={review.checks}>
          <IssueCardPill dot={false} tone={review.tone}>
            {review.checks === "Needs attention"
              ? "Needs attention"
              : "Review candidate"}
          </IssueCardPill>
        </IssueCardReviewLine>
      ) : null}
      {issue.status === "accepted" ? (
        <IssueCardIntegratedLine>Accepted</IssueCardIntegratedLine>
      ) : null}
      {issue.status === "blocked" ? (
        <IssueCardStatusLine>
          <IssueCardPill tone="slate">
            {blockedReasonMeta(issue)?.label}
          </IssueCardPill>
        </IssueCardStatusLine>
      ) : null}
      <IssueCardFooter>
        {priority.visible ? (
          <IssueCardPriority icon={priority.icon} priority={priority.priority}>
            {priority.label}
          </IssueCardPriority>
        ) : null}
        <IssueCardFooterSpacer />
        {showRuntime ? <RuntimeMark runtime={issue.runtime} /> : null}
        <IssueCardUpdated>{issue.updatedLabel}</IssueCardUpdated>
      </IssueCardFooter>
    </IssueCardRoot>
  );
}
