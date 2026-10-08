import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { inspectWorkspace } from "../../api";
import type { WorkspaceInspection } from "../../api-types";
import { Button } from "../ui/button";
import { WorkspaceDialog } from "./workspace-dialog";
import { isRemovedDevice } from "../../lib/devices";

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
  const removed = isRemovedDevice(device);
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
      <dl className="fdy-workspace-details">
        <dt>{t("details.device")}</dt>
        <dd>
          {device.label} ·{" "}
          {removed
            ? t("details.deviceRemoved")
            : connected
              ? t("shared.online")
              : t("shared.offline")}
        </dd>
        <dt>{t("details.folder")}</dt>
        <dd>
          <code>{workspace.localPath}</code>
        </dd>
        {connected && inspection ? (
          <>
            <dt>{t("details.repository")}</dt>
            <dd>
              {inspection.containingRepository ||
                (inspection.gitState === "not_git"
                  ? t("details.notGit")
                  : t("details.noContainingRepository"))}
            </dd>
            <dt>{t("details.branch")}</dt>
            <dd>
              {inspection.branch || t("details.noBranch")} ·{" "}
              {inspection.trackedChanges
                ? t("details.uncommittedChanges")
                : inspection.gitState === "ready"
                  ? t("details.cleanTracked")
                  : t(`overview.gitStates.${inspection.gitState}`)}
            </dd>
            <dt>{t("details.repositories")}</dt>
            <dd>{inspection.uniqueRepositoryCount}</dd>
            <dt>{t("details.inspected")}</dt>
            <dd>{inspection.inspectedAt}</dd>
          </>
        ) : null}
      </dl>
      {busy ? <p role="status">{t("details.inspecting")}</p> : null}
      {removed ? (
        <p className="fdy-location-description">{t("details.removedNote")}</p>
      ) : !connected ? (
        <p className="fdy-location-description">{t("details.offlineNote")}</p>
      ) : null}
      {err ? (
        <p className="fdy-location-error" role="alert">
          {err}
        </p>
      ) : null}
      {inspection?.errors.map((message) => (
        <p role="alert" key={message}>
          {message}
        </p>
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
