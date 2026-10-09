import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Monitor, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { DeviceProjection, WorkerRelease } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { deviceSummary } from "./device-details";
import { workerState } from "./device-worker";

/** The device list: one row per device, opening it or acting on it. */
export function DeviceList({
  devices,
  release,
  workspaceCount,
  triggers,
  onOpen,
  onRename,
  onRemove,
}: {
  devices: DeviceProjection[];
  /** The worker this server serves, to mark devices that are behind it. */
  release?: WorkerRelease;
  workspaceCount: (deviceId: string) => number;
  /** Each row's menu button, so a dialog returns focus to it. */
  triggers: Map<string, HTMLButtonElement>;
  onOpen: (deviceId: string) => void;
  onRename: (device: DeviceProjection) => void;
  onRemove: (device: DeviceProjection) => void;
}) {
  const { t } = useTranslation("devices");
  return (
    <div className="fdy-device-list">
      {devices.map((row) => (
        <div
          className="fdy-device-list-row fdy-device-removal-row"
          key={row.id}
        >
          <Button
            className="fdy-device-removal-row-main"
            variant="bare"
            onClick={() => onOpen(row.id)}
          >
            <Monitor size={25} />
            <span>
              <strong>{row.label}</strong>
              <small>
                {[
                  row.system && row.system.hostname !== row.label
                    ? row.system.hostname
                    : undefined,
                  deviceSummary(row),
                  t("list.workspaceCount", {
                    count: workspaceCount(row.id),
                  }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            </span>
            <WorkerStateBadge device={row} release={release} />
            <Badge tone={row.status === "connected" ? "online" : "neutral"}>
              {t(
                row.status === "connected" ? "status.online" : "status.offline",
              )}
            </Badge>
            <span>{t("list.view")}</span>
          </Button>
          {!row.owned ? (
            <Badge tone="neutral">{t("list.sharedWithYou")}</Badge>
          ) : (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button
                  className="fdy-device-removal-menu-trigger"
                  size="sm"
                  variant="ghost"
                  aria-label={t("list.actionsFor", { device: row.label })}
                  ref={(element) => {
                    if (element) triggers.set(row.id, element);
                    else triggers.delete(row.id);
                  }}
                >
                  <MoreHorizontal size={17} />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="fdy-workspace-actions-menu"
                  align="end"
                  sideOffset={6}
                >
                  <DropdownMenu.Item
                    className="fdy-workspace-menu-item"
                    onSelect={() => onRename(row)}
                  >
                    <Pencil size={15} />
                    {t("rename.action")}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="fdy-workspace-menu-item"
                    onSelect={() => onRemove(row)}
                  >
                    <Trash2 size={15} />
                    {t("list.removeFromFoundry")}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      ))}
    </div>
  );
}

function WorkerStateBadge({
  device,
  release,
}: {
  device: DeviceProjection;
  release?: WorkerRelease;
}) {
  const { t } = useTranslation("devices");
  const state = workerState(device, release);
  if (state === "current" || !device.owned) return null;
  return (
    <Badge tone={state === "updating" ? "brass" : "warn"}>
      {t(
        state === "updating"
          ? "worker.stateUpdating"
          : state === "stalled"
            ? "worker.stateStalled"
            : state === "updatable"
              ? "worker.stateUpdatable"
              : "worker.stateManual",
      )}
    </Badge>
  );
}
