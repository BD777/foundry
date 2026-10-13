import { useTranslation } from "react-i18next";
import { ChevronRight, FolderOpen, Monitor } from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { isRemovedDevice } from "../../lib/devices";

/**
 * The sidebar's location entry: the current device and workspace, opening
 * the Workspaces page.
 */
export function CompactLocationSwitcher({
  device,
  workspace,
  onBrowse,
}: {
  device?: DeviceProjection;
  workspace?: WorkspaceProjection;
  onBrowse: () => void;
}) {
  const { t } = useTranslation("workspaces");
  return (
    <section className="fdy-location" aria-label={t("location.regionLabel")}>
      <Button
        className="fdy-location-trigger fdy-location-entry"
        variant="ghost"
        aria-label={t("location.open")}
        title={t("location.title")}
        onClick={onBrowse}
      >
        <span className="fdy-location-entry-rows">
          <span className="fdy-location-entry-row fdy-location-entry-device">
            <Monitor size={14} />
            <span className="fdy-location-trigger-name">
              {device?.label ?? t("location.selectDevice")}
            </span>
            {device && device.status !== "connected" ? (
              <small className="fdy-location-entry-status">
                {isRemovedDevice(device)
                  ? t("shared.deviceRemoved")
                  : t("shared.offline")}
              </small>
            ) : null}
          </span>
          <span className="fdy-location-entry-row fdy-location-entry-workspace">
            <FolderOpen size={15} />
            <span className="fdy-location-trigger-name">
              {workspace?.name ?? t("location.selectWorkspace")}
            </span>
          </span>
        </span>
        <ChevronRight size={13} />
      </Button>
    </section>
  );
}
