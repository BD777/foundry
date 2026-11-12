import { useState } from "react";
import { WorkspaceServicesDialog } from "../../components/workspace/workspace-services";
import { workspaceDenial } from "../../lib/workspace-access";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  Check,
  ChevronRight,
  FolderOpen,
  FolderSearch,
  MonitorUp,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { RowMenu } from "../../components/ui/row-menu";
import { FieldHint } from "../../components/ui/field";
import type { WorkspaceEdit } from "../../components/workspace/workspace-editor";
import { workspaceRoleLabel } from "../../lib/workspace-access";
import {
  migrationActive,
  migrationFailed,
  migrationFrozen,
} from "../../components/workspace/workspace-migration";
import { WorkspaceMoveSummary } from "../../components/workspace/workspace-move-progress";
import { deviceConnection } from "../../lib/device-connection";

/** The id of a device group's note saying why folders cannot be added. */
export const addReasonId = (deviceId: string) =>
  `fdy-add-workspace-reason-${deviceId}`;

/**
 * One workspace on the Workspaces page: its details, Switch (the only action
 * that changes the current location), recovery when its device no longer
 * serves the folder, a move to another device under way, and rename, move
 * and remove in its menu.
 */
export function WorkspaceRow({
  workspace,
  device,
  current,
  busy,
  switching,
  addingAgainId,
  detailsRef,
  onDetails,
  onAddAgain,
  onLocate,
  onSwitch,
  onEdit,
  onMove,
  onViewMove,
  onPrepare,
  onPrepareEnd,
}: {
  workspace: WorkspaceProjection;
  device: DeviceProjection;
  current: boolean;
  /** Some workspace is being switched to. */
  busy: boolean;
  /** This one is being switched to. */
  switching: boolean;
  /** The workspace being added again, if any. */
  addingAgainId: string;
  detailsRef: (node: HTMLButtonElement | null) => void;
  onDetails: () => void;
  onAddAgain: () => void;
  onLocate: (trigger: HTMLElement) => void;
  onSwitch: () => void;
  onEdit: (edit: WorkspaceEdit) => void;
  /** Opens the move dialog to choose a device and folder. */
  onMove: () => void;
  /** Opens the move dialog on the move under way. */
  onViewMove: (trigger: HTMLElement) => void;
  onPrepare: () => void;
  onPrepareEnd: () => void;
}) {
  const { t } = useTranslation("workspaces");
  const [servicesOpen, setServicesOpen] = useState(false);
  const online = deviceConnection(device) === "online";
  const manageable =
    device.owned && (!workspace.accessRole || workspace.accessRole === "owner");
  // The device is connected but no longer serves the folder, or still has
  // the workspace but its folder is gone.
  const unavailable = workspace.unavailableOnDevice;
  const folderMissing = unavailable?.reason === "folder_missing";
  const unserved = !!unavailable && !folderMissing;
  const unservedNoteId = `fdy-unserved-${workspace.id}`;
  const addingAgain = addingAgainId === workspace.id;
  // Offline: the group's note says why.
  const offlineReason = online ? undefined : addReasonId(device.id);
  const migration = workspace.migration;
  const moving = migrationActive(migration) ? migration : undefined;
  // Copying, verifying or switching over: nothing runs in it meanwhile.
  const paused = migrationFrozen(moving);
  // The last move failed: nothing changed, the workspace runs here as before.
  const failedMove = migrationFailed(migration) ? migration : undefined;
  const failedNoteId = `fdy-move-failed-${workspace.id}`;
  const moveNoteId = `fdy-move-${workspace.id}`;
  const pausedNoteId = `fdy-move-paused-${workspace.id}`;
  const moveDenial = moving
    ? t("move.menuActive", { device: moving.targetDeviceLabel })
    : !online
      ? t("move.menuOffline", { device: device.label })
      : unavailable
        ? t("move.menuUnavailable", { device: device.label })
        : undefined;
  return (
    <article
      className="fdy-location-workspace-row flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1 transition-colors duration-150 hover:not-focus-within:bg-control-ghost-hover data-[current=true]:bg-selection data-[current=true]:hover:not-focus-within:bg-selection max-[700px]:flex-col max-[700px]:items-stretch max-[700px]:gap-1"
      data-current={current}
      data-unserved={unserved || undefined}
      data-folder-missing={folderMissing || undefined}
      onMouseEnter={onPrepare}
      onMouseLeave={onPrepareEnd}
      onFocus={onPrepare}
      onBlur={onPrepareEnd}
    >
      <Button
        variant="bare"
        className="fdy-location-workspace-details h-auto min-h-14 min-w-0 flex-1 justify-start gap-3 rounded-sm p-2 text-left whitespace-normal focus-visible:outline-0 focus-visible:shadow-[inset_0_0_0_1px_var(--fdy-control-focus)]"
        disabled={busy}
        aria-current={current ? "location" : undefined}
        aria-label={t("shared.viewDetails", { name: workspace.name })}
        aria-describedby={
          [
            unavailable ? unservedNoteId : "",
            moving ? moveNoteId : "",
            failedMove ? failedNoteId : "",
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onClick={onDetails}
        ref={detailsRef}
      >
        <FolderOpen size={19} />
        <span className="grid min-w-0 flex-1 gap-[5px]">
          <strong className="text-sm leading-[1.4] font-bold [overflow-wrap:anywhere] whitespace-normal text-ink">
            {workspace.name}
          </strong>
          <small className="text-2xs leading-normal font-normal [overflow-wrap:anywhere] whitespace-normal text-ink-muted">
            {workspace.localPath}
          </small>
          {unavailable ? (
            <small
              id={unservedNoteId}
              className="fdy-location-unserved-note text-2xs leading-normal font-normal [overflow-wrap:anywhere] whitespace-normal text-warning-text"
            >
              {t(
                folderMissing
                  ? "location.folderMissingNote"
                  : "location.notServedNote",
                { device: device.label },
              )}
            </small>
          ) : null}
          {moving ? (
            <WorkspaceMoveSummary
              id={moveNoteId}
              migration={moving}
              sourceLabel={device.label}
            />
          ) : null}
          {failedMove ? (
            <small
              id={failedNoteId}
              className="fdy-move-failed-note text-2xs leading-normal font-normal text-error-text"
            >
              {t("move.lastFailed", { device: failedMove.targetDeviceLabel })}
            </small>
          ) : null}
          {paused ? (
            <FieldHint
              as="small"
              id={pausedNoteId}
              className="mt-0 text-2xs leading-normal"
            >
              {t("move.pausedNote", { device: moving?.targetDeviceLabel })}
            </FieldHint>
          ) : null}
        </span>
        <span className="flex items-center gap-2 text-2xs text-ink-muted">
          {t("shared.details")}
          <ChevronRight size={14} />
        </span>
      </Button>
      {servicesOpen ? (
        <WorkspaceServicesDialog
          workspaceId={workspace.id}
          canControl={!workspaceDenial(workspace, "member")}
          onClose={() => setServicesOpen(false)}
        />
      ) : null}
      <div className="flex flex-none items-center gap-2 pr-1 max-[700px]:justify-end max-[700px]:px-1 max-[700px]:pt-0 max-[700px]:pb-1.5">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setServicesOpen(true)}
        >
          {t("services")}
        </Button>
        {workspace.accessRole && workspace.accessRole !== "owner" ? (
          <Badge tone="neutral">
            {t("location.sharedRole", {
              role: workspaceRoleLabel(workspace.accessRole),
            })}
          </Badge>
        ) : null}
        {moving ? (
          <>
            <Badge tone={paused ? "warn" : "slate"}>
              {t("move.badge", { device: moving.targetDeviceLabel })}
            </Badge>
            <Button
              size="sm"
              variant="secondary"
              aria-label={t("move.viewProgressFor", {
                name: workspace.name,
                device: moving.targetDeviceLabel,
              })}
              onClick={(event) => onViewMove(event.currentTarget)}
            >
              {t("move.viewProgress")}
            </Button>
          </>
        ) : null}
        {failedMove ? (
          <Button
            size="sm"
            variant="secondary"
            aria-label={t("move.viewDetailsFor", {
              name: workspace.name,
              device: failedMove.targetDeviceLabel,
            })}
            onClick={(event) => onViewMove(event.currentTarget)}
          >
            {t("move.viewDetails")}
          </Button>
        ) : null}
        {unserved && manageable ? (
          <span className="flex flex-col items-end gap-1">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !!addingAgainId || !online}
              aria-busy={addingAgain}
              aria-label={t("location.addAgainTo", {
                name: workspace.name,
                device: device.label,
              })}
              aria-describedby={offlineReason}
              onClick={onAddAgain}
            >
              <RotateCcw size={14} />
              {addingAgain ? t("location.addingAgain") : t("location.addAgain")}
            </Button>
          </span>
        ) : null}
        {unavailable && manageable ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !!addingAgainId || !online}
            aria-label={t("location.locateFor", {
              name: workspace.name,
              device: device.label,
            })}
            aria-describedby={offlineReason}
            onClick={(event) => onLocate(event.currentTarget)}
          >
            <FolderSearch size={14} />
            {t("location.locate")}
          </Button>
        ) : null}
        {current ? (
          <Badge tone="online">
            <Check size={13} />
            {t("location.currentBadge")}
          </Badge>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || paused}
            aria-busy={switching}
            aria-describedby={paused ? pausedNoteId : undefined}
            aria-label={t("location.switchTo", { name: workspace.name })}
            onClick={onSwitch}
          >
            {switching ? t("shared.switching") : t("location.switch")}
            {!switching ? <ArrowRight size={14} /> : null}
          </Button>
        )}
        {manageable ? (
          <RowMenu
            disabled={busy}
            items={[
              {
                key: "rename",
                label: t("deviceList.rename"),
                icon: <Pencil size={15} />,
                onSelect: () => onEdit({ kind: "rename", workspace }),
              },
              {
                key: "move",
                label: t("move.menuItem"),
                icon: <MonitorUp size={15} />,
                disabled: !!moveDenial,
                reason: moveDenial,
                onSelect: onMove,
              },
              {
                key: "remove",
                tone: "danger" as const,
                label: t("deviceList.remove"),
                icon: <Trash2 size={15} />,
                disabled: !!moving,
                reason: moving
                  ? t("move.menuActive", { device: moving.targetDeviceLabel })
                  : undefined,
                onSelect: () => onEdit({ kind: "remove", workspace }),
              },
            ]}
            label={t("deviceList.actionsFor", { name: workspace.name })}
          />
        ) : null}
      </div>
    </article>
  );
}
