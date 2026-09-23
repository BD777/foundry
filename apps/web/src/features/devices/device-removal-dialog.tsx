import { useRef, useState } from "react";
import type { DeviceProjection, WorkspaceProjection } from "@foundry/protocol";
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
        cause instanceof Error
          ? cause.message
          : "Could not remove this device.";
      const message =
        status === 409
          ? fallback
          : status === 404
            ? "This device is no longer registered. Refresh the list."
            : fallback;
      setError(message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <WorkspaceDialog
      title="Remove device from Foundry?"
      description="This unregisters the device on this Foundry server. It cannot be undone from the list, but nothing on the machine itself is deleted."
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
          <li>
            {workspaces.length} workspace
            {workspaces.length === 1 ? "" : "s"} on this device leave the device
            and workspace lists. Chats, issues and run history are kept and
            still shown where the device is marked removed.
          </li>
          <li>
            Local folders and repositories, Claude/Codex sign-ins, provider keys
            stored on the machine, and worker settings are not deleted.
          </li>
          <li>
            Server API connections and their sealed keys stay available for
            every other device; only this device&apos;s access is revoked.
          </li>
          <li>
            {online
              ? "The worker is online. It will be disconnected now, will not reconnect, and must be set up again on this machine to return."
              : "The device is offline. It will be refused if it contacts this server again; set it up again on the machine to bring it back."}
          </li>
        </ul>
        {blocked ? (
          <p className="fdy-device-removal-blocked" role="status">
            This device owns your current working location. Switch to a
            workspace on another device before removing it.
          </p>
        ) : null}
        {error ? (
          <p className="fdy-device-removal-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="fdy-device-removal-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            className="fdy-device-removal-danger"
            disabled={busy || blocked}
          >
            {busy ? "Removing…" : "Remove device"}
          </Button>
        </footer>
      </form>
    </WorkspaceDialog>
  );
}
