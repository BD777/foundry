import { useEffect, useState } from "react";
import type { Issue } from "@foundry/protocol";
import {
  readIssueEnvironment,
  issueEnvironmentAction,
  type IssueEnvironmentData,
} from "../../api";
import { Button } from "../../components/ui/button";
import { Panel, SectionLabel } from "../../components/ui/panel";
import { Alert } from "../../components/ui/alert";
import { InfoRow } from "../../components/ui/info-row";
import { RepositoryList } from "./repository-list";
import { environmentCounts, environmentLabel } from "./environment-model";
import { diagnosticSummary } from "../../lib/diagnostic-summary";
import "./issue-execution.css";

export function IssueEnvironment({
  issue,
  onRefresh,
}: {
  issue: Issue;
  onRefresh: (issueId?: string) => void;
}) {
  const [data, setData] = useState<IssueEnvironmentData>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const counts = data ? environmentCounts(data) : undefined;
  useEffect(() => {
    let active = true;
    const load = () => {
      void readIssueEnvironment(issue.id).then(
        (value) => {
          if (active) {
            setData(value);
            setError("");
          }
        },
        (reason) => {
          if (active) setError(String(reason));
        },
      );
    };
    load();
    const timer = setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [issue.id, issue.status, reload]);
  async function act(
    action: "cancel" | "cleanup" | "preview_start" | "preview_stop",
  ) {
    setPending(true);
    setError("");
    try {
      await issueEnvironmentAction(issue.id, action);
      setReload((value) => value + 1);
      onRefresh(issue.id);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="fdy-detail-block">
      <SectionLabel>Execution environment</SectionLabel>
      <Panel className="fdy-issue-execution-panel">
        {error ? (
          <Alert tone="error" title="Could not load environment">
            {error}
          </Alert>
        ) : null}
        {data ? (
          <>
            <InfoRow label="Candidate status" variant="keyValue">
              {environmentLabel(data.status)}
            </InfoRow>
            <InfoRow label="Candidate size" variant="keyValue">
              {data.bytes === undefined
                ? "Not measured"
                : `${(data.bytes / 1048576).toFixed(1)} MiB · ${data.files ?? 0} files`}
            </InfoRow>
            <p>
              {counts!.registered} registered · {counts!.prepared} prepared ·{" "}
              {counts!.unavailable} unavailable
            </p>
            <p>
              Source availability describes registered repositories. Only
              prepared candidates belong to this Issue’s execution environment.
            </p>
            {data.cwd ? (
              <p className="fdy-detail-helper-copy">{data.cwd}</p>
            ) : null}
            {data.error ? (
              <Alert
                tone="warning"
                title="Environment needs attention"
                details={diagnosticSummary(data.error).details}
              >
                {diagnosticSummary(data.error).summary}
              </Alert>
            ) : null}
            {data.content?.untracked.length ? (
              <details>
                <summary>
                  Files outside the accepted baseline (
                  {data.content.untracked.length})
                </summary>
                <pre className="fdy-candidate-diff">
                  {data.content.untracked.join("\n")}
                </pre>
                <p>
                  Commit these files into the source baseline or add intended
                  ignore rules before Accept.
                </p>
              </details>
            ) : null}
            {data.preview ? (
              <p>
                Preview: {data.preview.state}{" "}
                {data.preview.url ? (
                  <a href={data.preview.url} target="_blank" rel="noreferrer">
                    Open preview
                  </a>
                ) : null}{" "}
                {data.preview.error}
              </p>
            ) : null}
            {issue.status === "in_progress" ? (
              <Button
                disabled={pending}
                onClick={() => void act("cancel")}
                variant="secondary"
              >
                Stop execution
              </Button>
            ) : null}
            {issue.status === "verifying" &&
            data.hasPreview &&
            !["running", "queued"].includes(data.preview?.state ?? "") ? (
              <Button
                disabled={pending}
                onClick={() => void act("preview_start")}
                variant="secondary"
              >
                Start preview
              </Button>
            ) : null}
            {["running", "queued"].includes(data.preview?.state ?? "") ? (
              <Button
                disabled={pending}
                onClick={() => void act("preview_stop")}
                variant="secondary"
              >
                Stop preview
              </Button>
            ) : null}
            {issue.status === "accepted" && data.status !== "cleaned" ? (
              <Button
                disabled={pending}
                onClick={() => void act("cleanup")}
                variant="secondary"
              >
                Clean accepted worktrees
              </Button>
            ) : null}
          </>
        ) : !error ? (
          <p>Loading environment…</p>
        ) : null}
      </Panel>
      {data ? (
        <RepositoryList
          repositories={data.repositories}
          environmentStatus={data.status}
        />
      ) : null}
    </section>
  );
}
