import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Monitor, Plus } from "lucide-react";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { isRemovedDevice } from "../../lib/devices";
import { addReasonId } from "./workspace-row";

/**
 * A device's group on the Workspaces page: its name and workspace count,
 * adding a folder to it, opening its own page, and its workspace rows.
 */
export function WorkspaceDeviceGroup({
  device,
  workspaceCount,
  focused,
  busy,
  groupRef,
  onAdd,
  onOpenDevice,
  children,
}: {
  device: DeviceProjection;
  /** All of the device's workspaces, matching the search or not. */
  workspaceCount: number;
  /** The route brought this group into view. */
  focused: boolean;
  busy: boolean;
  groupRef: (element: HTMLElement | null) => void;
  onAdd: (trigger: HTMLElement) => void;
  onOpenDevice: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("workspaces");
  const removed = isRemovedDevice(device);
  const online = device.status === "connected";
  const reasonId = addReasonId(device.id);
  const count = t("shared.workspaceCount", { count: workspaceCount });
  return (
    <section
      className="fdy-location-group"
      aria-label={device.label}
      data-focused={focused || undefined}
      ref={groupRef}
    >
      <header className="fdy-location-group-heading">
        <Monitor size={17} />
        <h2>{device.label}</h2>
        <small>
          {removed
            ? t("location.removedHistory")
            : online
              ? count
              : t("location.offlineSummary", { workspaces: count })}
        </small>
        <span className="fdy-location-group-actions">
          {device.owned && !removed ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !online}
              aria-describedby={online ? undefined : reasonId}
              onClick={(event) => onAdd(event.currentTarget)}
            >
              <Plus size={14} />
              {t("location.addWorkspace")}
            </Button>
          ) : null}
          {!removed ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={t("location.openDeviceFor", { device: device.label })}
              onClick={onOpenDevice}
            >
              {t("location.openDevice")}
              <ArrowRight size={14} />
            </Button>
          ) : null}
        </span>
      </header>
      {device.owned && !removed && !online ? (
        <p id={reasonId} className="fdy-location-group-note">
          {t("deviceList.reconnect")}
        </p>
      ) : null}
      {children}
      {!workspaceCount ? (
        <p className="fdy-location-empty">{t("location.noWorkspaces")}</p>
      ) : null}
    </section>
  );
}
