import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Issue } from "@bd777/foundry-protocol";
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
  const { t, i18n } = useTranslation("issueDetail");
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
      <SectionLabel>{t("environment.title")}</SectionLabel>
      <Panel className="fdy-issue-execution-panel">
        {error ? (
          <Alert tone="error" title={t("environment.loadFailed")}>
            {error}
          </Alert>
        ) : null}
        {data ? (
          <>
            <InfoRow
              label={t("environment.candidateStatus")}
              variant="keyValue"
            >
              {environmentLabel(data.status)}
            </InfoRow>
            <InfoRow label={t("environment.candidateSize")} variant="keyValue">
              {data.bytes === undefined
                ? t("environment.notMeasured")
                : t("environment.size", {
                    size: (data.bytes / 1048576).toLocaleString(i18n.language, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    }),
                    count: data.files ?? 0,
                  })}
            </InfoRow>
            <p>
              {t("environment.counts", {
                registered: counts!.registered,
                prepared: counts!.prepared,
                unavailable: counts!.unavailable,
              })}
            </p>
            <p>{t("environment.availabilityNote")}</p>
            {data.cwd ? (
              <p className="fdy-detail-helper-copy">{data.cwd}</p>
            ) : null}
            {data.error ? (
              <Alert
                tone="warning"
                title={t("environment.needsAttention")}
                details={diagnosticSummary(data.error).details}
              >
                {diagnosticSummary(data.error).summary}
              </Alert>
            ) : null}
            {data.content?.untracked.length ? (
              <details>
                <summary>
                  {t("environment.untracked", {
                    total: data.content.untracked.length,
                  })}
                </summary>
                <pre className="fdy-candidate-diff">
                  {data.content.untracked.join("\n")}
                </pre>
                <p>{t("environment.untrackedNote")}</p>
              </details>
            ) : null}
            {data.preview ? (
              <p>
                {t("environment.preview", { state: data.preview.state })}{" "}
                {data.preview.url ? (
                  <a href={data.preview.url} target="_blank" rel="noreferrer">
                    {t("environment.openPreview")}
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
                {t("environment.stop")}
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
                {t("environment.startPreview")}
              </Button>
            ) : null}
            {["running", "queued"].includes(data.preview?.state ?? "") ? (
              <Button
                disabled={pending}
                onClick={() => void act("preview_stop")}
                variant="secondary"
              >
                {t("environment.stopPreview")}
              </Button>
            ) : null}
            {issue.status === "accepted" && data.status !== "cleaned" ? (
              <Button
                disabled={pending}
                onClick={() => void act("cleanup")}
                variant="secondary"
              >
                {t("environment.cleanup")}
              </Button>
            ) : null}
          </>
        ) : !error ? (
          <p>{t("environment.loading")}</p>
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
