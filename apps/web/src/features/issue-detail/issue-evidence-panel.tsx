import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  HumanAssessment,
  Issue,
  IssueContract,
  ReviewSnapshot,
  Verification,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import {
  acceptReviewedCandidate,
  getEvidenceReview,
  listContracts,
  listHumanAssessments,
  listVerifications,
  verifyCriteria,
} from "./evidence-api";
import { useEvidenceUpdates } from "./use-evidence-updates";
import { EvidenceMaterials } from "./evidence-materials";
import { CriterionResultCard } from "./criterion-result-card";
import { VerificationActions } from "./verification-actions";
import { blockerText } from "./issue-language";
import { ExitRulesList } from "./exit-rules-list";
import { AlignmentConflict, alignmentConflicts } from "./alignment-conflict";
import { requestChanges } from "../../api";

export function IssueEvidencePanel({
  issue,
  onRefresh,
}: {
  issue: Issue;
  onRefresh: (id: string) => void;
}) {
  const { t } = useTranslation("issueDetail");
  const terminal = issue.status === "accepted" || issue.status === "abandoned";
  const [review, setReview] = useState<ReviewSnapshot>();
  const [contract, setContract] = useState<IssueContract>();
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [assessments, setAssessments] = useState<HumanAssessment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    const [r, c, v, a] = await Promise.all([
      getEvidenceReview(issue.id),
      listContracts(issue.id),
      listVerifications(issue.id),
      listHumanAssessments(issue.id),
    ]);
    setReview(r);
    setContract(c.items.find((item) => item.revision === r.contractRevision));
    setVerifications(v.items);
    setAssessments(a.items);
  };
  useEvidenceUpdates(issue.id, load, setError);
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [
    issue.id,
    issue.currentContractRevision,
    issue.currentCandidateSnapshotId,
  ]);
  const conflicts = alignmentConflicts(error);
  // The review's own blocking reason explains it and offers alignment.
  const baselineMoved =
    error.startsWith("baseline_changed") &&
    Boolean(review?.blockingReasons.some((b) => b.code === "baseline_changed"));
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      onRefresh(issue.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A refused action can change what is possible next (a moved baseline
      // offers alignment), so read the authoritative state again.
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const running = verifications.some(
    (v) =>
      review?.criterionResults.some((entry) => entry.verificationId === v.id) &&
      ["queued", "running"].includes(v.status),
  );
  return (
    <div className="fdy-contract-summary">
      <p className="fdy-issue-tab-intro">{t("evidence.intro")}</p>
      <section className="fdy-issue-card">
        <h3>
          {issue.status === "accepted"
            ? t("evidence.titleAccepted")
            : !issue.currentContractRevision
              ? t("evidence.titleNotStarted")
              : review?.eligible
                ? t("evidence.titleEligible")
                : t("evidence.titleNotYet")}
        </h3>
        {!issue.currentContractRevision ? (
          <p>{t("evidence.confirmFirst")}</p>
        ) : null}
        {issue.status === "in_progress" ? (
          <p>{t("evidence.inProgress")}</p>
        ) : null}
        {issue.currentContractRevision && !review ? (
          <p role="status">{t("evidence.loading")}</p>
        ) : null}
        {review &&
        !review.candidateSnapshotId &&
        issue.status !== "in_progress" ? (
          <p>{t("evidence.noCandidate")}</p>
        ) : null}
        {review?.blockingReasons.length ? (
          <ul>
            {[...new Set(review.blockingReasons.map(blockerText))].map(
              (text) => (
                <li key={text}>{text}</li>
              ),
            )}
          </ul>
        ) : null}
        {running ? <p role="status">{t("evidence.checking")}</p> : null}
        {conflicts.length ? (
          <AlignmentConflict
            files={conflicts}
            busy={busy}
            onResolve={() =>
              void run(() =>
                requestChanges(
                  issue.id,
                  // i18n-ignore: feedback the execution Agent reads
                  `Bringing the Workspace's newer accepted changes into this candidate left merge conflicts in: ${conflicts.join(", ")}. Resolve them so the accepted changes and this Issue's confirmed contract both hold.`,
                ),
              )
            }
          />
        ) : null}
        <Button variant="ghost" disabled={busy} onClick={() => void run(load)}>
          {t("evidence.refresh")}
        </Button>
      </section>
      {/* The next step comes right after the conclusion (G4). */}
      {!terminal &&
      review &&
      contract &&
      issue.contractState === "confirmed" ? (
        <VerificationActions
          issue={issue}
          contract={contract}
          review={review}
          disabled={busy || running || issue.status === "in_progress"}
          run={run}
        />
      ) : null}
      {review?.criterionResults.map((entry) => (
        <CriterionResultCard
          key={entry.criterionId}
          issueId={issue.id}
          entry={entry}
          criterion={contract?.criteria.find((c) => c.id === entry.criterionId)}
          verification={verifications.find(
            (v) => v.id === entry.verificationId,
          )}
          assessments={assessments.filter(
            (a) => a.criterionId === entry.criterionId,
          )}
          terminal={terminal}
          busy={busy || running || !review.candidateSnapshotId}
          run={run}
          recheck={() =>
            verifyCriteria(
              issue.id,
              review.contractRevision,
              review.candidateSnapshotId,
              [entry.criterionId],
              crypto.randomUUID(),
            )
          }
        />
      ))}
      {review && issue.currentContractRevision ? (
        <section className="fdy-issue-card">
          <h3>{t("evidence.finalTitle")}</h3>
          <p>{t("evidence.finalBody")}</p>
          {review.exitRules ? <ExitRulesList rules={review.exitRules} /> : null}
          <Button
            disabled={terminal || busy || !review.eligible || running}
            onClick={() =>
              void run(() =>
                acceptReviewedCandidate(
                  issue.id,
                  review,
                  `accept-${review.id}-${review.digest}`,
                ),
              )
            }
          >
            {issue.status === "accepted"
              ? t("evidence.accepted")
              : issue.status === "abandoned"
                ? t("evidence.abandoned")
                : t("evidence.accept")}
          </Button>
        </section>
      ) : null}
      {error && !conflicts.length && !baselineMoved ? (
        <Alert tone="warning" title={t("shared.stepUnfinished")}>
          <p>{error}</p>
          <p>{t("evidence.errorBody")}</p>
        </Alert>
      ) : null}
      <details className="fdy-issue-card">
        <summary>{t("evidence.advanced")}</summary>
        <EvidenceMaterials issue={issue} onChange={load} />
        <pre>{JSON.stringify(review, null, 2)}</pre>
      </details>
    </div>
  );
}
