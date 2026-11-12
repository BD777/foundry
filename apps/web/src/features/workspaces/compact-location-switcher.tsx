import { useTranslation } from "react-i18next";
import { ChevronRight, Folders } from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Tooltip } from "../../components/ui/tooltip";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { deviceConnection } from "../../lib/device-connection";

const entryClass =
  "grid h-auto w-full grid-cols-[18px_minmax(0,1fr)_14px] items-center justify-start gap-2.5 rounded-sm px-3 py-1.5 text-left text-sm font-semibold text-ink hover:bg-control-ghost-hover aria-expanded:bg-control-ghost-hover focus-visible:outline-0 focus-visible:shadow-[inset_0_0_0_1px_var(--fdy-accent)]";
/** The icon-only entry of a collapsed sidebar: a 40px square on wide screens. */
const collapsedEntryClass =
  "min-[861px]:mx-auto min-[861px]:min-h-10 min-[861px]:w-10 min-[861px]:grid-cols-[18px] min-[861px]:justify-center min-[861px]:p-0";
const hiddenWhenCollapsed = "min-[861px]:hidden";

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
    <section
      className="fdy-location grid min-w-0 gap-px"
      data-collapsed={collapsed}
      aria-label={t("location.regionLabel")}
    >
      <Tooltip content={`${t("location.open")} · ${context}`}>
        <Button
          className={cn(entryClass, collapsed && collapsedEntryClass)}
          variant="ghost"
          aria-label={`${t("location.open")} · ${context}`}
          title={`${t("location.open")} · ${context}`}
          onClick={onBrowse}
        >
          <Folders
            className="flex-none justify-self-center text-ink-muted"
            size={18}
            aria-hidden="true"
          />
          <span
            className={cn(
              "fdy-location-entry-rows flex min-w-0 flex-1 flex-col gap-0.5",
              collapsed && hiddenWhenCollapsed,
            )}
          >
            <span className="fdy-location-entry-row flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-md leading-[1.3] font-semibold">
                {workspaceLabel}
              </span>
            </span>
            {deviceLabel ? (
              <span className="fdy-location-entry-row fdy-location-entry-device flex min-w-0 items-center gap-2 text-2xs font-normal text-ink-muted">
                <span className="min-w-0 flex-1 truncate text-2xs leading-[1.3] font-normal">
                  {deviceLabel}
                </span>
                {status ? (
                  <small className="flex-none text-2xs text-ink-muted">
                    {status}
                  </small>
                ) : null}
              </span>
            ) : null}
          </span>
          <ChevronRight
            className={cn(
              "flex-none text-ink-muted",
              collapsed && hiddenWhenCollapsed,
            )}
            size={14}
            aria-hidden="true"
          />
        </Button>
      </Tooltip>
    </section>
  );
}
