import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  FolderOpen,
  Monitor,
  Search,
} from "lucide-react";
import type { DeviceProjection, WorkspaceProjection } from "@foundry/protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { PageSurface } from "../../components/ui/page-surface";
import { WorkspaceDetails } from "../../components/workspace/workspace-details";
import { workspaceRoleLabel } from "../../lib/workspace-access";

interface Props {
  compact?: boolean;
  activeWorkspaceId: string;
  devices: DeviceProjection[];
  workspaces: WorkspaceProjection[];
  busyWorkspaceId: string;
  error: string;
  onReset: () => void;
  onSelect: (
    workspace: WorkspaceProjection,
    options?: { stayOnLocation?: boolean },
  ) => Promise<boolean>;
  onPrepare: (workspace: WorkspaceProjection) => void;
  onManage: (deviceId?: string) => void;
  onBrowse: () => void;
  onReturn: () => void;
}

/**
 * The server can project a tombstoned device with status "removed" before the
 * shared protocol union is regenerated; read the value structurally so this
 * view works with either shape.
 */
const isRemovedDevice = (device?: DeviceProjection): boolean =>
  (device?.status as string | undefined) === "removed";

/** The sidebar is an entrance; selection has its own route, never a popover. */
export function WorkspaceSelectionPanel(props: Props) {
  const current = props.workspaces.find(
    (row) => row.id === props.activeWorkspaceId,
  );
  const activeDevice = props.devices.find(
    (row) => row.id === current?.deviceId,
  );
  const [selectedDeviceId, setPreviewDeviceId] = useState("");
  // Removed devices are never a new choice. The active device is kept as the
  // preview even when it has been removed, so the current historical context
  // stays visible read-only instead of being silently replaced.
  const selectableDevices = props.devices.filter(
    (device) => !isRemovedDevice(device),
  );
  const previewDeviceId =
    selectedDeviceId || current?.deviceId || selectableDevices[0]?.id || "";
  const [query, setQuery] = useState("");
  const [detailsWorkspace, setDetailsWorkspace] =
    useState<WorkspaceProjection>();
  const preview = props.devices.find((row) => row.id === previewDeviceId);
  const previewRemoved = isRemovedDevice(preview);
  // The picker column offers live devices, plus a read-only row for the
  // current device when it was removed; other tombstoned devices are hidden
  // from new selection (their history data is never deleted server-side).
  const pickerDevices =
    previewRemoved && preview
      ? selectableDevices.some((device) => device.id === preview.id)
        ? selectableDevices
        : [...selectableDevices, preview]
      : selectableDevices;
  const busy = !!props.busyWorkspaceId;
  if (props.compact)
    return (
      <section className="fdy-location" aria-label="Current working location">
        <Button
          className="fdy-location-trigger fdy-location-entry"
          variant="ghost"
          aria-label="Open working location"
          title="Working location"
          onClick={props.onBrowse}
        >
          <span className="fdy-location-entry-rows">
            <span className="fdy-location-entry-row fdy-location-entry-device">
              <Monitor size={14} />
              <span className="fdy-location-trigger-name">
                {activeDevice?.label ?? "Select device"}
              </span>
              <span
                className="fdy-location-dot"
                data-online={activeDevice?.status === "connected"}
                data-removed={isRemovedDevice(activeDevice)}
                aria-label={
                  isRemovedDevice(activeDevice)
                    ? "Device removed"
                    : activeDevice?.status === "connected"
                      ? "Online"
                      : "Offline"
                }
              />
            </span>
            <span className="fdy-location-entry-row fdy-location-entry-workspace">
              <FolderOpen size={15} />
              <span className="fdy-location-trigger-name">
                {current?.name ?? "Select workspace"}
              </span>
            </span>
          </span>
          <ChevronRight size={13} />
        </Button>
      </section>
    );
  const visible = props.workspaces.filter(
    (row) =>
      row.deviceId === previewDeviceId &&
      `${row.name} ${row.localPath}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <PageSurface variant="devices" className="fdy-location-page">
      <Button
        className="fdy-device-back"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={props.onReturn}
      >
        <ArrowLeft size={14} />
        Back to workspace
      </Button>
      <header className="fdy-management-heading">
        <div>
          <h1>Working location</h1>
          <p>
            Choose a device, then switch to one of its workspaces. Your current
            work stays unchanged until you switch; switching keeps you on this
            page.
          </p>
        </div>
      </header>
      <div className="fdy-location-current">
        <Check size={15} />
        <span>
          Current:{" "}
          <strong>
            {activeDevice && current
              ? `${activeDevice.label} / ${current.name}`
              : "No workspace selected"}
          </strong>
        </span>
      </div>
      <div className="fdy-location-browser">
        <section
          className="fdy-location-device-list"
          aria-label="Choose device"
        >
          <h2>1. Device</h2>
          {pickerDevices.map((device) => {
            const removed = isRemovedDevice(device);
            return (
              <Button
                key={device.id}
                className="fdy-location-page-option"
                variant="ghost"
                disabled={busy || removed}
                aria-pressed={device.id === previewDeviceId}
                aria-disabled={removed || undefined}
                title={removed ? "Device removed from Foundry" : undefined}
                onClick={() => {
                  if (removed) return;
                  setPreviewDeviceId(device.id);
                  setQuery("");
                  props.onReset();
                }}
              >
                <Monitor size={17} />
                <span className="fdy-location-copy">
                  <strong>{device.label}</strong>
                  <small>
                    {removed
                      ? "Removed · history kept read-only"
                      : `${device.status === "connected" ? "Online" : "Offline"} · ${props.workspaces.filter((row) => row.deviceId === device.id).length} workspaces`}
                  </small>
                </span>
                {device.id === previewDeviceId ? (
                  <Check size={15} />
                ) : (
                  <ChevronRight size={15} />
                )}
              </Button>
            );
          })}
          {!pickerDevices.length ? (
            <p className="fdy-location-empty">No devices registered.</p>
          ) : null}
        </section>
        <section
          className="fdy-location-workspace-list"
          aria-label="Choose workspace"
        >
          <div className="fdy-location-workspace-heading">
            <h2>2. Workspace</h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => props.onManage(preview?.id)}
              disabled={busy || previewRemoved || !preview}
            >
              Manage workspaces <ArrowRight size={13} />
            </Button>
          </div>
          <label className="fdy-location-page-search">
            <Search size={15} />
            <TextInput
              aria-label="Find workspace"
              placeholder="Search by name or folder…"
              value={query}
              disabled={busy}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          {previewRemoved ? (
            <p className="fdy-location-hint">
              Removed device · Its workspaces stay as read-only history and
              cannot be switched to.
            </p>
          ) : preview?.status === "disconnected" ? (
            <p className="fdy-location-hint">
              Offline · You can browse history; execution needs reconnection.
            </p>
          ) : null}
          {visible.map((workspace) => {
            const isCurrent = workspace.id === current?.id;
            const isBusy = workspace.id === props.busyWorkspaceId;
            return (
              <article
                key={workspace.id}
                className="fdy-location-workspace-row"
                data-current={isCurrent}
                data-removed-device={previewRemoved || undefined}
                onMouseEnter={() => {
                  if (!previewRemoved) props.onPrepare(workspace);
                }}
                onFocus={() => {
                  if (!previewRemoved) props.onPrepare(workspace);
                }}
              >
                <Button
                  variant="ghost"
                  className="fdy-location-workspace-details"
                  disabled={busy}
                  aria-current={isCurrent ? "location" : undefined}
                  aria-label={`View details for ${workspace.name}`}
                  onClick={() => setDetailsWorkspace(workspace)}
                >
                  <FolderOpen size={19} />
                  <span className="fdy-location-copy">
                    <strong>{workspace.name}</strong>
                    <small>{workspace.localPath}</small>
                  </span>
                  <span className="fdy-workspace-details-label">
                    Details
                    <ChevronRight size={14} />
                  </span>
                </Button>
                <div className="fdy-location-workspace-actions">
                  {workspace.accessRole && workspace.accessRole !== "owner" ? (
                    <Badge tone="neutral">
                      Shared · {workspaceRoleLabel(workspace.accessRole)}
                    </Badge>
                  ) : null}
                  {isCurrent ? (
                    <>
                      <Badge tone="online">
                        <Check size={13} />
                        Current
                      </Badge>
                      {previewRemoved ? (
                        <Badge tone="neutral">Device removed</Badge>
                      ) : null}
                    </>
                  ) : previewRemoved ? (
                    <Badge tone="neutral">Device removed</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      aria-busy={isBusy}
                      aria-label={`Switch to ${workspace.name}`}
                      onClick={() =>
                        void props.onSelect(workspace, {
                          stayOnLocation: true,
                        })
                      }
                    >
                      {isBusy ? "Switching…" : "Switch"}
                      {!isBusy ? <ArrowRight size={14} /> : null}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
          {!visible.length ? (
            <p className="fdy-location-empty">
              {query
                ? "No matching workspaces."
                : "No workspaces on this device. Add one in Manage workspaces."}
            </p>
          ) : null}
          {props.error ? (
            <p className="fdy-location-error" role="alert">
              {props.error}
            </p>
          ) : null}
          {detailsWorkspace && preview ? (
            <WorkspaceDetails
              workspace={detailsWorkspace}
              device={preview}
              onClose={() => setDetailsWorkspace(undefined)}
            />
          ) : null}
        </section>
      </div>
    </PageSurface>
  );
}
