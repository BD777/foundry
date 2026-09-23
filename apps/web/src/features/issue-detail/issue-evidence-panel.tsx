import { useEffect, useState } from "react";
import type {
  HumanAssessment,
  Issue,
  IssueContract,
  ReviewSnapshot,
  Verification,
} from "@foundry/protocol";
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

export function IssueEvidencePanel({
  issue,
  onRefresh,
}: {
  issue: Issue;
  onRefresh: (id: string) => void;
}) {
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
      <p className="fdy-issue-tab-intro">
        这里看实际做到了什么、判断依据和还缺什么。目标与检查方式保留在“目标与约定”。
      </p>
      <section className="fdy-issue-card">
        <h3>
          {issue.status === "accepted"
            ? "成果已接受并集成"
            : !issue.currentContractRevision
              ? "尚未进入验收"
              : review?.eligible
                ? "已具备接受条件，请审阅实际依据"
                : "尚不能接受"}
        </h3>
        {!issue.currentContractRevision ? (
          <p>
            先在主聊天明确并确认标准。参考材料和实现说明都不能代替实际证据。
          </p>
        ) : null}
        {issue.status === "in_progress" ? (
          <p>实现仍在进行中。完成后再准备固定候选并采集材料，目前不能接受。</p>
        ) : null}
        {issue.currentContractRevision && !review ? (
          <p role="status">正在读取验收状态与已确认标准…</p>
        ) : null}
        {review &&
        !review.candidateSnapshotId &&
        issue.status !== "in_progress" ? (
          <p>
            尚未准备本次验收候选。请在下方“准备当前版本的验收”，再采集真实材料。
          </p>
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
        {running ? (
          <p role="status">正在检查实际材料。完成后这里会自动更新。</p>
        ) : null}
        <Button variant="ghost" disabled={busy} onClick={() => void run(load)}>
          刷新结果
        </Button>
      </section>
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
      {review && issue.currentContractRevision ? (
        <section className="fdy-issue-card">
          <h3>最终接受</h3>
          <p>
            接受这里展示的准确版本与审阅结果，系统再次核对后集成到
            Workspace。全部集成成功才显示“已接受”。
          </p>
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
              ? "已接受并集成"
              : issue.status === "abandoned"
                ? "已放弃 · 只读历史"
                : "接受这版成果"}
          </Button>
        </section>
      ) : null}
      {error ? (
        <Alert tone="warning" title="这一步尚未完成">
          <p>{error}</p>
          <p>没有绕过验收门槛；处理原因后重试。</p>
        </Alert>
      ) : null}
      <details className="fdy-issue-card">
        <summary>高级材料管理与技术记录</summary>
        <EvidenceMaterials issue={issue} onChange={load} />
        <pre>{JSON.stringify(review, null, 2)}</pre>
      </details>
    </div>
  );
}
