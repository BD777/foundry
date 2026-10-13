import { useTranslation } from "react-i18next";
import { Monitor, Pencil, Trash2 } from "lucide-react";
import type { DeviceProjection, WorkerRelease } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { RowMenu } from "../../components/ui/row-menu";
import { deviceSummary } from "./device-details";
import { workerState, workerUpdateStepLabel } from "./device-worker";

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
            <RowMenu
              items={[
                {
                  key: "rename",
                  label: t("rename.action"),
                  icon: <Pencil size={15} />,
                  onSelect: () => onRename(row),
                },
                {
                  key: "remove",
                  label: t("list.removeFromFoundry"),
                  icon: <Trash2 size={15} />,
                  onSelect: () => onRemove(row),
                },
              ]}
              label={t("list.actionsFor", { device: row.label })}
              triggerRef={(element) => {
                if (element) triggers.set(row.id, element);
                else triggers.delete(row.id);
              }}
            />
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
  // A running update shows what it is doing, from the server's probes.
  const step =
    state === "updating" && device.workerUpdate
      ? workerUpdateStepLabel(t, device.workerUpdate)
      : undefined;
  const label = step ? t("worker.stepRunning", { step }) : undefined;
  return (
    <Badge tone={state === "updating" ? "brass" : "warn"}>
      {label ??
        t(
          state === "updating"
            ? "worker.stateUpdating"
            : state === "failed"
              ? "worker.stateFailed"
              : state === "stalled"
                ? "worker.stateStalled"
                : state === "updatable"
                  ? "worker.stateUpdatable"
                  : "worker.stateManual",
        )}
    </Badge>
  );
}
