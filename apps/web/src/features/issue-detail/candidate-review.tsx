import { useEffect, useState } from "react";
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
  const [data, setData] = useState<CandidateReviewData>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setData(undefined);
    setError("");
    void readCandidateReview(issueId).then(
      (result) => {
        if (active) {
          if (result.revision !== revision)
            setError("Candidate changed. Refresh the Issue before accepting.");
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
      <SectionLabel>Workspace candidate · revision {revision}</SectionLabel>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p role="status">Loading candidate changes…</p>
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
                {repo.diff || "No file changes."}
              </pre>
              {repo.truncated ? (
                <p>
                  Diff truncated. Review the remaining changes in the candidate
                  directory before accepting.
                </p>
              ) : null}
            </Panel>
          ))}
        </>
      )}
    </section>
  );
}
