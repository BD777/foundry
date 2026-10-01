import type {
  AcceptanceCriterion,
  CarrierKind,
  CriterionReviewEntry,
  Issue,
  ReviewBlocker,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";

export function verificationMethod(criterion: AcceptanceCriterion): string {
  if (criterion.evaluationMode === "agent")
    return i18n.t("issueDetail:method.agent");
  return criterion.checker
    ? i18n.t("issueDetail:method.checker", {
        description: criterion.checker.description,
      })
    : i18n.t("issueDetail:method.checkerMissing");
}

export function evidenceRequirementText(
  criterion: AcceptanceCriterion,
): string[] {
  return criterion.evidenceRequirements.map((r) =>
    i18n.t("issueDetail:evidenceRequirement", {
      description: r.description,
      minimum: r.minimumCount,
      carriers: r.acceptedCarriers
        .map((c: CarrierKind) => i18n.t(`issueDetail:carriers.${c}`))
        .join(i18n.t("issueDetail:carriers.separator")),
    }),
  );
}

export function issuePhase(issue: Issue) {
  const phase = (
    key: "accepted" | "abandoned" | "inProgress" | "verifying" | "waiting",
  ) => ({
    title: i18n.t(`issueDetail:phase.${key}.title`),
    next: i18n.t(`issueDetail:phase.${key}.next`),
  });
  if (issue.status === "accepted")
    return { ...phase("accepted"), tab: "evidence" as const };
  if (issue.status === "abandoned")
    return { ...phase("abandoned"), tab: "details" as const };
  if (issue.contractState !== "confirmed")
    return {
      title: issue.currentContractRevision
        ? i18n.t("issueDetail:phase.amendment.title")
        : i18n.t("issueDetail:phase.clarifying.title"),
      next: i18n.t("issueDetail:phase.clarifying.next"),
      tab: "details" as const,
    };
  if (issue.status === "in_progress")
    return { ...phase("inProgress"), tab: "details" as const };
  if (issue.status === "verifying")
    return { ...phase("verifying"), tab: "evidence" as const };
  if (issue.status === "blocked")
    return {
      title: i18n.t("issueDetail:phase.blocked.title"),
      next:
        issue.blockedReason?.message ??
        i18n.t("issueDetail:phase.blocked.next"),
      tab: "environment" as const,
    };
  return { ...phase("waiting"), tab: "environment" as const };
}

export function isStatusQuestion(text: string): boolean {
  // i18n-ignore: recognizes what a person typed, in either language
  return /^(这里|现在|当前|这个任务|任务)?(是)?什么状态[？?。!！\s]*$|^(现在|目前)?(进度如何|到哪了|在做什么|为什么没开始)[？?。!！\s]*$|^(what(?:'s| is) (?:the |current )?status|status|any update)[?.!\s]*$/i.test(
    text.trim(),
  );
}

export function verdictText(entry: CriterionReviewEntry): string {
  if (entry.freshness === "stale") return i18n.t("issueDetail:verdict.stale");
  if (entry.effectiveVerdict === "not_evaluated")
    return i18n.t("issueDetail:verdict.notEvaluated");
  if (entry.evidenceAvailability !== "available")
    return i18n.t("issueDetail:verdict.evidenceUnavailable");
  if (entry.freshness === "unknown")
    return i18n.t("issueDetail:verdict.freshnessUnknown");
  return i18n.t(`issueDetail:verdict.${entry.effectiveVerdict}`);
}

export function verificationErrorText(message: string): string {
  if (/operation is busy/i.test(message))
    return i18n.t("issueDetail:verificationError.busy");
  if (/offline/i.test(message))
    return i18n.t("issueDetail:verificationError.offline");
  if (/timeout|timed.out/i.test(message))
    return i18n.t("issueDetail:verificationError.timeout");
  if (/task_outcome_unknown|interrupted/i.test(message))
    return i18n.t("issueDetail:verificationError.interrupted");
  return i18n.t("issueDetail:verificationError.generic");
}

export function blockerText(blocker: ReviewBlocker): string {
  return i18n.t(`issueDetail:blocker.${blocker.code}`);
}
