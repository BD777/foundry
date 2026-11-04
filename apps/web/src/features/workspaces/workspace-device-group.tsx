import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Monitor, Plus } from "lucide-react";
import type { DeviceProjection } from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { addReasonId } from "./workspace-row";
import { LocationEmpty } from "./location-empty";

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
  const online = device.status === "connected";
  const reasonId = addReasonId(device.id);
  const count = t("shared.workspaceCount", { count: workspaceCount });
  return (
    <section
      className="fdy-location-group grid min-w-0 scroll-mt-4 gap-1.5 border-t border-line pt-[18px]"
      aria-label={device.label}
      data-focused={focused || undefined}
      ref={groupRef}
    >
      <header className="fdy-location-group-heading flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-2 pb-1">
        <Monitor size={17} />
        <h2 className="text-md font-semibold text-ink">{device.label}</h2>
        <small className="text-xs text-ink-muted">
          {online ? count : t("location.offlineSummary", { workspaces: count })}
        </small>
        <span className="ml-auto flex items-center gap-1">
          {device.owned ? (
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
        </span>
      </header>
      {device.owned && !online ? (
        <p id={reasonId} className="px-2 text-xs leading-[1.4] text-ink-muted">
          {t("deviceList.reconnect")}
        </p>
      ) : null}
      {children}
      {!workspaceCount ? (
        <LocationEmpty>{t("location.noWorkspaces")}</LocationEmpty>
      ) : null}
    </section>
  );
}
