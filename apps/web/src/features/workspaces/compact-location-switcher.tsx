import { useTranslation } from "react-i18next";
import { Folders } from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { SidebarContextEntry } from "../../components/ui/sidebar-context-entry";
import { deviceConnection } from "../../lib/device-connection";

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
  const connection = deviceConnection(device);
  const status =
    connection === "reconnecting"
      ? t("shared.reconnecting")
      : connection === "offline"
        ? t("shared.offline")
        : undefined;
  const context = [workspaceLabel, deviceLabel, status]
    .filter(Boolean)
    .join(" · ");
  return (
    <SidebarContextEntry
      ariaLabel={`${t("location.open")} · ${context}`}
      className="fdy-location"
      collapsed={collapsed}
      detail={[deviceLabel, status].filter(Boolean).join(" · ")}
      icon={Folders}
      label={workspaceLabel}
      onBrowse={onBrowse}
      regionLabel={t("location.regionLabel")}
    />
  );
}
