import { useState } from "react";
import type {
  AcceptanceCriterion,
  CriterionReviewEntry,
  HumanAssessment,
  Verification,
} from "@foundry/protocol";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/field";
import { EvidencePreview, ReferencePreviews } from "./evidence-preview";
import { assessVerification } from "./evidence-api";
import {
  verdictText,
  verificationMethod,
  verificationErrorText,
} from "./issue-language";

export function CriterionResultCard({
  issueId,
  entry,
  criterion,
  verification,
  assessments,
  terminal,
  busy,
  run,
  recheck,
}: {
  issueId: string;
  entry: CriterionReviewEntry;
  criterion?: AcceptanceCriterion;
  verification?: Verification;
  assessments: HumanAssessment[];
  terminal: boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  recheck: () => Promise<unknown>;
}) {
  const authority = {
    program: "固定程序检查",
    agent_preliminary: "独立 Agent 初判",
    human: "人工判断",
    none: "尚未形成判断",
  };
  const result = verification?.result;
  return (
    <article className="fdy-issue-card">
      <h3>{criterion?.title ?? "完成标准"}</h3>
      <p>{criterion?.statement}</p>
      <strong>
        {verification?.status === "queued"
          ? "等待检查：前面的标准检查结束后会自动开始。"
          : verification?.status === "running"
            ? "正在检查真实材料…"
            : verification?.status === "failed"
              ? "检查未完成，不能据此接受。"
              : verdictText(entry)}
      </strong>
      <p>
        {authority[entry.authority]}
        {criterion?.required === false ? " · 补充目标" : " · 必须满足"}
      </p>
      {verification && ["queued", "running"].includes(verification.status) ? (
        <p role="status">正在检查材料，请等待实际结果…</p>
      ) : null}
      {result ? (
        <>
          <p>{result.summary}</p>
          {result.findings.map((finding) => (
            <section className="fdy-criterion-summary" key={finding.id}>
              <h4>{finding.statement}</h4>
              <p>
                <strong>预期：</strong>
                {finding.expected}
              </p>
              <p>
                <strong>实际观察：</strong>
                {finding.observed}
              </p>
              {finding.evidenceCitations.map((citation, index) => (
                <EvidencePreview
                  key={`${citation.materialId}-${index}`}
                  issueId={issueId}
                  materialId={citation.materialId}
                  selector={citation.selector}
                  label="查看实际依据"
                />
              ))}
              {finding.referenceCitations.map((citation, index) => (
                <EvidencePreview
                  key={`${citation.materialId}-${index}`}
                  issueId={issueId}
                  materialId={citation.materialId}
                  selector={citation.selector}
                  label="对照参考（不是实际证据）"
                />
              ))}
            </section>
          ))}
          {result.limitations.length ? (
            <p>
              <strong>局限：</strong>
              {result.limitations.join("；")}
            </p>
          ) : null}
          <details>
            <summary>完整判断过程</summary>
            <p>{result.reasoning}</p>
          </details>
        </>
      ) : (
        <p>尚无可审阅的判断；先准备当前版本并采集约定的实际材料。</p>
      )}
      {verification?.error ? (
        <p role="alert">{verificationErrorText(verification.error.message)}</p>
      ) : null}
      {criterion ? (
        <details>
          <summary>对照已确认标准与验证方法</summary>
          <p>{verificationMethod(criterion)}</p>
          <p>{criterion.rubric.text}</p>
        </details>
      ) : null}
      {!terminal ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void run(recheck)}
        >
          重新检查这一条
        </Button>
      ) : null}
      {assessments.map((a) => (
        <details key={a.id}>
          <summary>
            人工意见 ·{" "}
            {a.id === entry.humanAssessmentId ? "当前有效" : "历史记录"}
          </summary>
          <p>{a.rationale.text}</p>
          <ReferencePreviews issueId={issueId} media={a.rationale.media} />
        </details>
      ))}
      {!terminal && verification?.mode === "agent" && result ? (
        <Assessment
          issueId={issueId}
          verification={verification}
          busy={busy}
          run={run}
        />
      ) : null}
      <details>
        <summary>技术记录</summary>
        <pre>
          {JSON.stringify(
            {
              entry,
              reasons: entry.reasons,
              verificationId: verification?.id,
              error: verification?.error,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </article>
  );
}

function Assessment({
  issueId,
  verification,
  busy,
  run,
}: {
  issueId: string;
  verification: Verification;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  return (
    <details>
      <summary>对初判有不同意见？</summary>
      <p>
        说明你基于哪些实际材料得出不同判断；原始初判不会被覆盖。不能用意见补造缺失证据。
      </p>
      <Textarea
        aria-label="人工判断理由"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="结合上面的实际依据说明理由…"
      />
      {(
        [
          ["pass", "认可达标"],
          ["fail", "认为未达标"],
          ["inconclusive", "仍不能判断"],
        ] as const
      ).map(([verdict, label]) => (
        <Button
          key={verdict}
          variant="secondary"
          disabled={busy || !reason.trim()}
          onClick={() =>
            void run(() =>
              assessVerification(
                issueId,
                verification,
                verdict,
                reason,
                crypto.randomUUID(),
              ),
            )
          }
        >
          {label}
        </Button>
      ))}
    </details>
  );
}
