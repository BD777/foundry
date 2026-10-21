import { useTranslation } from "react-i18next";
import { ChevronRight, Folders } from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Tooltip } from "../../components/ui/tooltip";
import { Button } from "../../components/ui/button";
import { isRemovedDevice } from "../../lib/devices";

/**
 * The sidebar's location entry: the current device and workspace, opening
 * the Workspaces page.
 */
export function CompactLocationSwitcher({
  collapsed = false,
  device,
  workspace,
  onBrowse,
}: {
  collapsed?: boolean;
  device?: DeviceProjection;
  workspace?: WorkspaceProjection;
  onBrowse: () => void;
}) {
  const { t } = useTranslation("workspaces");
  const workspaceLabel = workspace?.name ?? t("location.selectWorkspace");
  const deviceLabel = device?.label;
  const status =
    device && device.status !== "connected"
      ? isRemovedDevice(device)
        ? t("shared.deviceRemoved")
        : t("shared.offline")
      : undefined;
  const context = [workspaceLabel, deviceLabel, status]
    .filter(Boolean)
    .join(" · ");
  return (
    <section
      className="fdy-location"
      data-collapsed={collapsed}
      aria-label={t("location.regionLabel")}
    >
      <Tooltip content={`${t("location.open")} · ${context}`}>
        <Button
          className="fdy-location-trigger fdy-location-entry"
          variant="ghost"
          aria-label={`${t("location.open")} · ${context}`}
          title={`${t("location.open")} · ${context}`}
          onClick={onBrowse}
        >
          <Folders
            className="fdy-location-entry-icon"
            size={18}
            aria-hidden="true"
          />
          <span className="fdy-location-entry-rows">
            <span className="fdy-location-entry-row fdy-location-entry-workspace">
              <span className="fdy-location-trigger-name">
                {workspaceLabel}
              </span>
            </span>
            {deviceLabel ? (
              <span className="fdy-location-entry-row fdy-location-entry-device">
                <span className="fdy-location-trigger-name">{deviceLabel}</span>
                {status ? (
                  <small className="fdy-location-entry-status">{status}</small>
                ) : null}
              </span>
            ) : null}
          </span>
          <ChevronRight
            className="fdy-location-entry-chevron"
            size={14}
            aria-hidden="true"
          />
        </Button>
      </Tooltip>
    </section>
  );
}
