import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Issue } from "@bd777/foundry-protocol";
import { cancelAgentSession, issueEnvironmentAction } from "../../api";
import { Button } from "../../components/ui/button";
import { HelpHint } from "../../components/ui/help-hint";
import { SectionLabel } from "../../components/ui/panel";
import { Alert } from "../../components/ui/alert";
import { InfoRow } from "../../components/ui/info-row";
import { RepositoryList } from "./repository-list";
import { environmentCounts, environmentLabel } from "./environment-model";
import { diagnosticSummary } from "../../lib/diagnostic-summary";
import { bytesIn } from "../../lib/format";
import { useIssueEnvironment } from "./use-issue-environment";
import { Skeleton } from "../../components/ui/loading";
import { ExecutionPanel, IssueMetaLine } from "./issue-section";

export function IssueEnvironment({ issue }: { issue: Issue }) {
  const { t } = useTranslation("issueDetail");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const { data, error: readError } = useIssueEnvironment(issue, reload);
  // A read that succeeds after a failed action clears its error, as before.
  useEffect(() => setActionError(""), [data]);
  const error = actionError || readError;
  const counts = data ? environmentCounts(data) : undefined;
  async function act(
    action: "cancel" | "cleanup" | "preview_start" | "preview_stop",
  ) {
    setPending(true);
    setActionError("");
    try {
      // The execution is a session: it stops as one.
      if (action === "cancel") await cancelAgentSession(issue.run!.id);
      else await issueEnvironmentAction(issue.id, action);
      setReload((value) => value + 1);
    } catch (reason) {
      setActionError(String(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="w-full max-w-[760px] min-w-0">
      <SectionLabel>{t("environment.title")}</SectionLabel>
      <ExecutionPanel>
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
                    size: bytesIn(data.bytes, "MB", {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    }),
                    count: data.files ?? 0,
                  })}
            </InfoRow>
            <p className="flex flex-wrap items-center gap-1.5">
              {t("environment.counts", {
                registered: counts!.registered,
                prepared: counts!.prepared,
                unavailable: counts!.unavailable,
              })}
              <HelpHint label={t("environment.countsHelp")}>
                {t("environment.availabilityNote")}
              </HelpHint>
            </p>
            {data.cwd ? <IssueMetaLine>{data.cwd}</IssueMetaLine> : null}
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
                <pre className="max-h-144 max-w-full overflow-auto wrap-anywhere whitespace-pre-wrap">
                  {data.content.untracked.join("\n")}
                </pre>
                <Alert
                  size="compact"
                  title={t("environment.untrackedFix")}
                  tone="warning"
                />
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
            {issue.status === "in_progress" &&
            issue.run?.status === "running" ? (
              <Button
                className="justify-self-start"
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
                className="justify-self-start"
                disabled={pending}
                onClick={() => void act("preview_start")}
                variant="secondary"
              >
                {t("environment.startPreview")}
              </Button>
            ) : null}
            {["running", "queued"].includes(data.preview?.state ?? "") ? (
              <Button
                className="justify-self-start"
                disabled={pending}
                onClick={() => void act("preview_stop")}
                variant="secondary"
              >
                {t("environment.stopPreview")}
              </Button>
            ) : null}
            {issue.status === "accepted" && data.status !== "cleaned" ? (
              <Button
                className="justify-self-start"
                disabled={pending}
                onClick={() => void act("cleanup")}
                variant="secondary"
              >
                {t("environment.cleanup")}
              </Button>
            ) : null}
          </>
        ) : !error ? (
          <Skeleton label={t("environment.loading")} />
        ) : null}
      </ExecutionPanel>
      {data ? (
        <RepositoryList
          repositories={data.repositories}
          environmentStatus={data.status}
        />
      ) : null}
    </section>
  );
}
