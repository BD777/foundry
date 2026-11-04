import { Alert } from "../../components/ui/alert";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readCandidateReview, type CandidateReviewData } from "../../api";
import { SectionLabel } from "../../components/ui/panel";
import { Skeleton } from "../../components/ui/loading";
import { ExecutionPanel, IssueMetaLine } from "./issue-section";

export function CandidateReview({
  issueId,
  revision,
}: {
  issueId: string;
  revision: number;
}) {
  const { t } = useTranslation("issueDetail");
  const [data, setData] = useState<CandidateReviewData>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setData(undefined);
    setError("");
    void readCandidateReview(issueId).then(
      (result) => {
        if (active) {
          if (result.revision !== revision) setError(t("candidate.changed"));
          else setData(result);
        }
      },
      (reason) => {
        if (active) setError(String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [issueId, revision]);
  return (
    <section className="w-full max-w-[760px] min-w-0">
      <SectionLabel>{t("candidate.title", { revision })}</SectionLabel>
      {error ? (
        <Alert tone="error" size="compact" title={error} />
      ) : !data ? (
        <Skeleton label={t("candidate.loading")} rows={3} variant="rows" />
      ) : (
        <>
          <IssueMetaLine>{data.review.cwd}</IssueMetaLine>
          {data.review.repositories.map((repo) => (
            <ExecutionPanel key={repo.path}>
              <SectionLabel>{repo.path}</SectionLabel>
              <p>
                <code>{repo.baseline.slice(0, 10)}</code> →{" "}
                <code>{repo.candidate?.slice(0, 10)}</code>
              </p>
              <pre className="max-h-144 max-w-full overflow-auto wrap-anywhere whitespace-pre-wrap">
                {repo.diff || t("candidate.noChanges")}
              </pre>
              {repo.truncated ? (
                <Alert
                  size="compact"
                  title={t("candidate.truncated")}
                  tone="warning"
                />
              ) : null}
            </ExecutionPanel>
          ))}
        </>
      )}
    </section>
  );
}
