import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { removeDevice } from "../../api";
import { Button } from "../../components/ui/button";
import { WorkspaceDialog } from "./workspace-dialog";

function errorStatus(cause: unknown): number | undefined {
  if (typeof cause === "object" && cause !== null && "status" in cause) {
    const status = (cause as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

export function DeviceRemovalDialog({
  device,
  workspaces,
  activeWorkspaceId,
  onClose,
  onRemoved,
  returnFocusTo,
}: {
  device: DeviceProjection;
  workspaces: WorkspaceProjection[];
  activeWorkspaceId: string;
  onClose: () => void;
  onRemoved: (device: DeviceProjection) => Promise<void>;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation(["devices", "common"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const online = device.status === "connected";
  const ownsCurrentWorkspace = workspaces.some(
    (workspace) => workspace.id === activeWorkspaceId,
  );
  const blocked = ownsCurrentWorkspace;

  async function submit() {
    if (pending.current || blocked) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const removed = await removeDevice(device.id);
      await onRemoved(removed);
      onClose();
    } catch (cause) {
      const status = errorStatus(cause);
      const fallback =
        cause instanceof Error ? cause.message : t("removal.failed");
      const message =
        status === 409
          ? fallback
          : status === 404
            ? t("removal.notFound")
            : fallback;
      setError(message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <WorkspaceDialog
      title={t("removal.title")}
      description={t("removal.description")}
      busy={busy}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <form
        aria-busy={busy}
        className="fdy-device-removal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <strong>{device.label}</strong>
        <code className="fdy-device-removal-id">{device.id}</code>
        <ul className="fdy-device-removal-scope">
          <li>{t("removal.workspaces", { count: workspaces.length })}</li>
          <li>{t("removal.localKept")}</li>
          <li>{t("removal.connectionsKept")}</li>
          <li>{t(online ? "removal.online" : "removal.offline")}</li>
        </ul>
        {blocked ? (
          <p className="fdy-device-removal-blocked" role="status">
            {t("removal.blocked")}
          </p>
        ) : null}
        {error ? (
          <p className="fdy-device-removal-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="fdy-device-removal-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            className="fdy-device-removal-danger"
            disabled={busy || blocked}
          >
            {busy ? t("removal.removing") : t("removal.remove")}
          </Button>
        </footer>
      </form>
    </WorkspaceDialog>
  );
}
