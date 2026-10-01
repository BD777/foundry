import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AcceptanceCriterion,
  CriterionReviewEntry,
  HumanAssessment,
  Verification,
} from "@bd777/foundry-protocol";
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
  const { t } = useTranslation("issueDetail");
  const result = verification?.result;
  return (
    <article className="fdy-issue-card">
      <h3>{criterion?.title ?? t("criterion.fallbackTitle")}</h3>
      <p>{criterion?.statement}</p>
      <strong>
        {verification?.status === "queued"
          ? t("criterion.queued")
          : verification?.status === "running"
            ? t("criterion.running")
            : verification?.status === "failed"
              ? t("criterion.failed")
              : verdictText(entry)}
      </strong>
      <p>
        {t(`criterion.authority.${entry.authority}`)} ·{" "}
        {criterion?.required === false
          ? t("shared.optional")
          : t("shared.required")}
      </p>
      {verification && ["queued", "running"].includes(verification.status) ? (
        <p role="status">{t("criterion.checking")}</p>
      ) : null}
      {result ? (
        <>
          <p>{result.summary}</p>
          {result.findings.map((finding) => (
            <section className="fdy-criterion-summary" key={finding.id}>
              <h4>{finding.statement}</h4>
              <p>
                <strong>{t("criterion.expected")}</strong>
                {finding.expected}
              </p>
              <p>
                <strong>{t("criterion.observed")}</strong>
                {finding.observed}
              </p>
              {finding.evidenceCitations.map((citation, index) => (
                <EvidencePreview
                  key={`${citation.materialId}-${index}`}
                  issueId={issueId}
                  materialId={citation.materialId}
                  selector={citation.selector}
                  label={t("criterion.viewEvidence")}
                />
              ))}
              {finding.referenceCitations.map((citation, index) => (
                <EvidencePreview
                  key={`${citation.materialId}-${index}`}
                  issueId={issueId}
                  materialId={citation.materialId}
                  selector={citation.selector}
                  label={t("criterion.viewReference")}
                />
              ))}
            </section>
          ))}
          {result.limitations.length ? (
            <p>
              <strong>{t("criterion.limitations")}</strong>
              {result.limitations.join(t("shared.clauseSeparator"))}
            </p>
          ) : null}
          <details>
            <summary>{t("criterion.reasoning")}</summary>
            <p>{result.reasoning}</p>
          </details>
        </>
      ) : (
        <p>{t("criterion.noResult")}</p>
      )}
      {verification?.error ? (
        <p role="alert">{verificationErrorText(verification.error.message)}</p>
      ) : null}
      {criterion ? (
        <details>
          <summary>{t("criterion.method")}</summary>
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
          {t("criterion.recheck")}
        </Button>
      ) : null}
      {assessments.map((a) => (
        <details key={a.id}>
          <summary>
            {a.id === entry.humanAssessmentId
              ? t("criterion.opinionCurrent")
              : t("criterion.opinionEarlier")}
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
        <summary>{t("criterion.technicalRecord")}</summary>
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
  const { t } = useTranslation("issueDetail");
  const [reason, setReason] = useState("");
  return (
    <details>
      <summary>{t("assessment.summary")}</summary>
      <p>{t("assessment.body")}</p>
      <Textarea
        aria-label={t("assessment.reasonLabel")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("assessment.placeholder")}
      />
      {(["pass", "fail", "inconclusive"] as const).map((verdict) => (
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
          {t(`assessment.${verdict}`)}
        </Button>
      ))}
    </details>
  );
}
