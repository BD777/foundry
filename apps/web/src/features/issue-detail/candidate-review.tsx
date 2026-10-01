import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readCandidateReview, type CandidateReviewData } from "../../api";
import { Panel, SectionLabel } from "../../components/ui/panel";
import "./issue-execution.css";

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
    <section className="fdy-detail-block">
      <SectionLabel>{t("candidate.title", { revision })}</SectionLabel>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p role="status">{t("candidate.loading")}</p>
      ) : (
        <>
          <p className="fdy-detail-helper-copy">{data.review.cwd}</p>
          {data.review.repositories.map((repo) => (
            <Panel className="fdy-issue-execution-panel" key={repo.path}>
              <SectionLabel>{repo.path}</SectionLabel>
              <p>
                <code>{repo.baseline.slice(0, 10)}</code> →{" "}
                <code>{repo.candidate?.slice(0, 10)}</code>
              </p>
              <pre className="fdy-candidate-diff">
                {repo.diff || t("candidate.noChanges")}
              </pre>
              {repo.truncated ? <p>{t("candidate.truncated")}</p> : null}
            </Panel>
          ))}
        </>
      )}
    </section>
  );
}
