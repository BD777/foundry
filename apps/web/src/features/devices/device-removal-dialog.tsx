import { ToastFeedback } from "../../components/ui/toast";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { ApiError, removeDevice } from "../../api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { deviceConnection } from "../../lib/device-connection";

function errorStatus(cause: unknown): number | undefined {
  if (typeof cause === "object" && cause !== null && "status" in cause) {
    const status = (cause as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/** The server refused because turns run on the connected device now. */
function turnsRunning(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    cause.status === 409 &&
    cause.code === "device_turns_running"
  );
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
  // Set once the server said turns run now: the next submit stops them.
  const [stopRunningTurns, setStopRunningTurns] = useState(false);
  const pending = useRef(false);
  const online = deviceConnection(device) === "online";
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
      const removed = await removeDevice(device.id, { stopRunningTurns });
      await onRemoved(removed);
      onClose();
    } catch (cause) {
      if (turnsRunning(cause)) {
        setStopRunningTurns(true);
        return;
      }
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
    <Dialog
      title={t("removal.title")}
      description={t("removal.description")}
      busy={busy}
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <form
        aria-busy={busy}
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <strong>{device.label}</strong>
        <code className="text-xs text-ink-muted wrap-anywhere">
          {device.id}
        </code>
        <ul className="m-0 grid list-disc gap-2 pl-4.5 text-sm text-ink-muted [&>li]:leading-normal">
          <li>{t("removal.workspaces", { count: workspaces.length })}</li>
          <li>{t("removal.localKept")}</li>
          <li>{t("removal.connectionsKept")}</li>
          <li>{t(online ? "removal.online" : "removal.offline")}</li>
        </ul>
        {blocked ? (
          <p
            className="m-0 rounded-md bg-warning-surface p-3 text-sm"
            role="status"
          >
            {t("removal.blocked")}
          </p>
        ) : null}
        {stopRunningTurns ? (
          <p
            className="m-0 rounded-md bg-warning-surface p-3 text-sm"
            role="status"
          >
            {t("removal.turnsRunning")}
          </p>
        ) : null}
        {error ? <ToastFeedback tone="error" title={error} /> : null}
        <footer className="flex justify-end gap-2.5">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button variant="danger" type="submit" disabled={busy || blocked}>
            {busy
              ? t("removal.removing")
              : t(
                  stopRunningTurns ? "removal.stopAndRemove" : "removal.remove",
                )}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
