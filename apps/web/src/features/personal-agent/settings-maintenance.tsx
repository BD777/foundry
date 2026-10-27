import { toast } from "../../components/ui/toast";
import { FieldHint } from "../../components/ui/field";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  PersonalAgentMaintenance,
  PersonalAgentContextPatch,
  ContextPatchReply,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import {
  listPersonalAgentMaintenance,
  listPersonalAgentContextPatches,
  actOnPersonalAgentMaintenance,
  previewPersonalAgentPatch,
  applyPersonalAgentPatch,
} from "../../api";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { serverErrorText } from "../../lib/errors";
import { navigateToChat } from "../../lib/in-app-navigation";
import { SettingsGroup } from "./settings-field";

export function MaintenanceSection({
  workspaces,
}: {
  workspaces: WorkspaceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const [jobs, setJobs] = useState<PersonalAgentMaintenance[]>([]);
  const [patches, setPatches] = useState<PersonalAgentContextPatch[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<{
    jobId: string;
    revision: number;
    index: number;
    source: ContextPatchReply;
  } | null>(null);
  const read = useCallback(async () => {
    const [j, p] = await Promise.all([
      listPersonalAgentMaintenance(),
      listPersonalAgentContextPatches(),
    ]);
    setJobs(j);
    setPatches(p);
  }, []);
  useEffect(() => {
    void read().catch((e) => setError(serverErrorText(e)));
  }, [read]);
  const active =
    jobs.some((j) =>
      ["pending", "waiting", "starting", "running"].includes(j.status),
    ) || patches.some((p) => p.status === "applying");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => void read().catch((e) => setError(serverErrorText(e))),
      10000,
    );
    return () => clearInterval(timer);
  }, [active, read]);
  async function perform(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try {
      await action();
      await read();
    } catch (e) {
      toast({
        tone: "error",
        title: t("maintenance.error"),
        description: serverErrorText(e),
      });
    } finally {
      setBusy("");
    }
  }
  function status(value: string) {
    const known = [
      "pending",
      "waiting",
      "starting",
      "running",
      "review",
      "complete",
      "failed",
      "dismissed",
      "superseded",
      "applying",
      "applied",
      "conflict",
    ];
    return known.includes(value)
      ? t(`maintenance.states.${value}` as never)
      : value;
  }
  function reason(value: string) {
    const known = [
      "assistant_paused",
      "maintenance_busy",
      "daily_maintenance_limit",
      "role_configuration_unavailable",
      "role_configuration_changed",
      "device_offline",
      "worker_update_required",
      "source_unavailable",
      "sandbox_unavailable",
      "account_unavailable",
      "input_acceptance_failed",
      "invalid_review_result",
      "native_failed",
      "native_canceled",
      "waiting_for_device_receipt",
      "source_changed_review_again",
      "permission_changed",
      "source_location_changed",
      "receipt_mismatch",
      "input_moved",
    ];
    return known.includes(value)
      ? t(`maintenance.reasons.${value}` as never)
      : value;
  }
  return (
    <SettingsGroup title={t("maintenance.title")}>
      <FieldHint>{t("maintenance.description")}</FieldHint>
      <FieldHint>{t("maintenance.boundaries")}</FieldHint>
      {error ? (
        <Alert tone="error" title={t("maintenance.error")}>
          {error}
        </Alert>
      ) : null}
      <Button
        size="sm"
        disabled={!!busy}
        onClick={() => void perform("refresh", read)}
      >
        {t("maintenance.refresh")}
      </Button>
      {!jobs.length ? <FieldHint>{t("maintenance.empty")}</FieldHint> : null}
      <ul className="fdy-pa-memory">
        {jobs.map((job) => (
          <li key={job.id} className="fdy-pa-memory-item">
            <p>
              {workspaces.find((w) => w.id === job.workspaceId)?.name ??
                job.workspaceId}{" "}
              ·{" "}
              {t(
                job.role === "memory"
                  ? "maintenance.memory"
                  : "maintenance.governance",
              )}{" "}
              · {status(job.status)}
            </p>
            {job.reason ? <FieldHint>{reason(job.reason)}</FieldHint> : null}
            {job.result ? (
              <>
                <p>{job.result.summary}</p>
                <ul>
                  {job.result.findings.map((f, i) => (
                    <li key={i}>
                      <p>{f.summary}</p>
                      <FieldHint>{f.sourceRefs.join(" · ")}</FieldHint>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <div className="fdy-pa-actions">
              {job.sessionId ? (
                <Button
                  size="sm"
                  onClick={() =>
                    navigateToChat(job.sessionId!, job.workspaceId)
                  }
                >
                  {t("maintenance.openRun")}
                </Button>
              ) : null}
              {["failed", "waiting"].includes(job.status) && job.attempt < 2 ? (
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() =>
                    void perform(job.id, () =>
                      actOnPersonalAgentMaintenance(
                        job.id,
                        job.revision,
                        "retry",
                      ),
                    )
                  }
                >
                  {t("maintenance.retry")}
                </Button>
              ) : null}
              {["review", "failed", "pending", "waiting"].includes(
                job.status,
              ) &&
              (!job.inputId || ["review", "failed"].includes(job.status)) ? (
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() =>
                    void perform(job.id, () =>
                      actOnPersonalAgentMaintenance(
                        job.id,
                        job.revision,
                        "dismiss",
                      ),
                    )
                  }
                >
                  {t("maintenance.dismiss")}
                </Button>
              ) : null}
            </div>
            {job.status === "review"
              ? job.result?.patches.map((patch, index) => {
                  const operation = patches.find(
                    (p) => p.jobId === job.id && p.index === index,
                  );
                  const shown =
                    preview?.jobId === job.id &&
                    preview.index === index &&
                    preview.revision === job.revision
                      ? preview.source
                      : null;
                  return (
                    <div key={patch.path} className="fdy-pa-field">
                      <p>
                        {patch.path} · {patch.reason}
                      </p>
                      {operation ? (
                        <p>
                          {status(operation.status)}
                          {operation.reason
                            ? ` · ${reason(operation.reason)}`
                            : ""}
                        </p>
                      ) : null}
                      <Button
                        size="sm"
                        disabled={!!busy}
                        onClick={() =>
                          void perform(`${job.id}:${index}`, async () => {
                            setPreview(null);
                            const source = await previewPersonalAgentPatch(
                              job.id,
                              job.revision,
                              index,
                            );
                            setPreview({
                              jobId: job.id,
                              revision: job.revision,
                              index,
                              source,
                            });
                          })
                        }
                      >
                        {t("maintenance.preview")}
                      </Button>
                      {shown ? (
                        <>
                          <FieldHint>{t("maintenance.current")}</FieldHint>
                          <pre className="fdy-pa-context-source">
                            {shown.hash === "missing"
                              ? t("maintenance.missing")
                              : shown.content}
                          </pre>
                          <FieldHint>{t("maintenance.proposed")}</FieldHint>
                          <pre className="fdy-pa-context-source">
                            {patch.content}
                          </pre>
                          {shown.hash !== patch.baseHash ? (
                            <Alert
                              tone="warning"
                              title={t("maintenance.stale")}
                            />
                          ) : (
                            <Button
                              size="sm"
                              disabled={!!busy || !!operation}
                              onClick={() =>
                                void perform(`${job.id}:${index}`, () =>
                                  applyPersonalAgentPatch(
                                    job.id,
                                    job.revision,
                                    index,
                                    shown.hash,
                                  ),
                                )
                              }
                            >
                              {t("maintenance.apply")}
                            </Button>
                          )}
                        </>
                      ) : null}
                    </div>
                  );
                })
              : null}
          </li>
        ))}
      </ul>
    </SettingsGroup>
  );
}
