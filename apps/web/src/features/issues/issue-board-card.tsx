import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Issue } from "@bd777/foundry-protocol";
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

function priorityMeta(
  priority: Issue["priority"],
  labels: Record<"high" | "medium" | "low", string>,
): {
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
      label: labels.high,
      priority,
      visible: true,
    };
  }

  if (priority === "medium") {
    return {
      icon: <IssuePriorityDashMark />,
      label: labels.medium,
      priority,
      visible: true,
    };
  }

  return {
    icon: <ArrowLeft size={11} />,
    label: labels.low,
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
  const { t } = useTranslation("issues");
  const priority = priorityMeta(issue.priority, {
    high: t("card.priority.high"),
    medium: t("card.priority.medium"),
    low: t("card.priority.low"),
  });
  const readiness = issueReadinessMeta(issue);
  const review = issueReviewMeta(issue);
  const showRuntime = issueShowsRuntime(issue);
  const displayId = issueDisplayId(issue);

  return (
    <IssueCardRoot
      aria-label={t("card.open", { id: displayId })}
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
            {review.needsAttention
              ? t("review.needsAttention")
              : t("review.reviewCandidate")}
          </IssueCardPill>
        </IssueCardReviewLine>
      ) : null}
      {issue.status === "accepted" ? (
        <IssueCardIntegratedLine>{t("card.accepted")}</IssueCardIntegratedLine>
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
