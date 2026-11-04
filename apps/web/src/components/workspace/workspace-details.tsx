import { Alert } from "../ui/alert";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { inspectWorkspace } from "../../api";
import type { WorkspaceInspection } from "../../api-types";
import { Button } from "../ui/button";
import { WorkspaceDialog } from "./workspace-dialog";
import { LocationDescription } from "./workspace-form";

function Detail({ children, label }: { children: ReactNode; label: string }) {
  return (
    <>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="m-0 wrap-anywhere max-[700px]:mb-2.5">{children}</dd>
    </>
  );
}

/** Read-only workspace inspection; opening it never switches the location. */
export function WorkspaceDetails({
  workspace,
  device,
  onClose,
}: {
  workspace: WorkspaceProjection;
  device: DeviceProjection;
  onClose: () => void;
}) {
  const { t } = useTranslation("workspaces");
  const [inspection, setInspection] = useState<WorkspaceInspection>();
  const [err, setErr] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const connected = device.status === "connected";
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    setBusy(true);
    setErr("");
    inspectWorkspace(workspace.id)
      .then((data) => {
        if (!disposed) setInspection(data);
      })
      .catch((cause) => {
        if (!disposed)
          setErr(cause instanceof Error ? cause.message : t("details.failed"));
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [workspace.id, connected, revision]);
  return (
    <WorkspaceDialog
      title={workspace.name}
      description={t("details.description")}
      onClose={onClose}
    >
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-3.5 text-sm leading-[1.6] max-[700px]:grid-cols-[minmax(0,1fr)] max-[700px]:gap-y-1.5">
        <Detail label={t("details.device")}>
          {device.label} ·{" "}
          {connected ? t("shared.online") : t("shared.offline")}
        </Detail>
        <Detail label={t("details.folder")}>
          <code>{workspace.localPath}</code>
        </Detail>
        {connected && inspection ? (
          <>
            <Detail label={t("details.repository")}>
              {inspection.containingRepository ||
                (inspection.gitState === "not_git"
                  ? t("details.notGit")
                  : t("details.noContainingRepository"))}
            </Detail>
            <Detail label={t("details.branch")}>
              {inspection.branch || t("details.noBranch")} ·{" "}
              {inspection.trackedChanges
                ? t("details.uncommittedChanges")
                : inspection.gitState === "ready"
                  ? t("details.cleanTracked")
                  : t(`overview.gitStates.${inspection.gitState}`)}
            </Detail>
            <Detail label={t("details.repositories")}>
              {inspection.uniqueRepositoryCount}
            </Detail>
            <Detail label={t("details.inspected")}>
              {inspection.inspectedAt}
            </Detail>
          </>
        ) : null}
      </dl>
      {busy ? <p role="status">{t("details.inspecting")}</p> : null}
      {!connected ? (
        <LocationDescription>{t("details.offlineNote")}</LocationDescription>
      ) : null}
      {err ? <Alert tone="error" size="compact" title={err} /> : null}
      {inspection?.errors.map((message) => (
        <Alert tone="error" size="compact" key={message} title={message} />
      ))}
      {connected ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          {err ? t("details.retry") : t("details.refresh")}
        </Button>
      ) : null}
    </WorkspaceDialog>
  );
}
