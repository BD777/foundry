import { useEffect, useState } from "react";
import type { DeviceProjection, WorkspaceProjection } from "@foundry/protocol";
import { inspectWorkspace } from "../../api";
import type { WorkspaceInspection } from "../../api-types";
import { Button } from "../ui/button";
import { WorkspaceDialog } from "./workspace-dialog";

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
  const [inspection, setInspection] = useState<WorkspaceInspection>();
  const [err, setErr] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  // The server projects tombstoned devices with status "removed"; accept it
  // structurally until the shared protocol union is regenerated.
  const removed = (device.status as string) === "removed";
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
          setErr(cause instanceof Error ? cause.message : "Inspection failed.");
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
      description="Workspace details · Viewing details does not switch your working location."
      onClose={onClose}
    >
      <dl className="fdy-workspace-details">
        <dt>Device</dt>
        <dd>
          {device.label} ·{" "}
          {removed ? "Removed from Foundry" : connected ? "Online" : "Offline"}
        </dd>
        <dt>Folder</dt>
        <dd>
          <code>{workspace.localPath}</code>
        </dd>
        {connected && inspection ? (
          <>
            <dt>Repository</dt>
            <dd>
              {inspection.containingRepository ||
                (inspection.gitState === "not_git"
                  ? "Not a Git repository"
                  : "No containing repository")}
            </dd>
            <dt>Branch</dt>
            <dd>
              {inspection.branch || "No branch"} ·{" "}
              {inspection.trackedChanges
                ? "Uncommitted changes"
                : inspection.gitState === "ready"
                  ? "Clean tracked files"
                  : inspection.gitState}
            </dd>
            <dt>Repositories</dt>
            <dd>{inspection.uniqueRepositoryCount}</dd>
            <dt>Inspected</dt>
            <dd>{inspection.inspectedAt}</dd>
          </>
        ) : null}
      </dl>
      {busy ? <p role="status">Inspecting the folder on this device…</p> : null}
      {removed ? (
        <p className="fdy-location-description">
          Removed device · This workspace is retained as read-only history and
          can no longer be inspected live or switched to. Local files were not
          deleted.
        </p>
      ) : !connected ? (
        <p className="fdy-location-description">
          Offline · Saved path only. Live repository status is unavailable.
        </p>
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
          {err ? "Retry inspection" : "Refresh inspection"}
        </Button>
      ) : null}
    </WorkspaceDialog>
  );
}
