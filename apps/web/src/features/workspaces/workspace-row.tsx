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
import type { WorkspaceEdit } from "../../components/workspace/workspace-editor";
import { isRemovedDevice } from "../../lib/devices";
import { workspaceRoleLabel } from "../../lib/workspace-access";

/** The id of a device group's note saying why folders cannot be added. */
export const addReasonId = (deviceId: string) =>
  `fdy-add-workspace-reason-${deviceId}`;

/**
 * One workspace on the Workspaces page: its details, Switch (the only action
 * that changes the current location), recovery when its device no longer
 * serves the folder, and rename/remove in its menu.
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
  onPrepare: () => void;
  onPrepareEnd: () => void;
}) {
  const { t } = useTranslation("workspaces");
  const [servicesOpen, setServicesOpen] = useState(false);
  const removed = isRemovedDevice(device);
  const online = device.status === "connected";
  const manageable =
    device.owned &&
    !removed &&
    (!workspace.accessRole || workspace.accessRole === "owner");
  // The device is connected but no longer serves the folder, or still has
  // the workspace but its folder is gone.
  const unavailable = removed ? undefined : workspace.unavailableOnDevice;
  const folderMissing = unavailable?.reason === "folder_missing";
  const unserved = !!unavailable && !folderMissing;
  const unservedNoteId = `fdy-unserved-${workspace.id}`;
  const addingAgain = addingAgainId === workspace.id;
  // Offline: the group's note says why.
  const offlineReason = online ? undefined : addReasonId(device.id);
  return (
    <article
      className="fdy-location-workspace-row"
      data-current={current}
      data-removed-device={removed || undefined}
      data-unserved={unserved || undefined}
      data-folder-missing={folderMissing || undefined}
      onMouseEnter={() => {
        if (!removed) onPrepare();
      }}
      onMouseLeave={onPrepareEnd}
      onFocus={() => {
        if (!removed) onPrepare();
      }}
      onBlur={onPrepareEnd}
    >
      <Button
        variant="bare"
        className="fdy-location-workspace-details"
        disabled={busy}
        aria-current={current ? "location" : undefined}
        aria-label={t("shared.viewDetails", { name: workspace.name })}
        aria-describedby={unavailable ? unservedNoteId : undefined}
        onClick={onDetails}
        ref={detailsRef}
      >
        <FolderOpen size={19} />
        <span className="fdy-location-copy">
          <strong>{workspace.name}</strong>
          <small>{workspace.localPath}</small>
          {unavailable ? (
            <small id={unservedNoteId} className="fdy-location-unserved-note">
              {t(
                folderMissing
                  ? "location.folderMissingNote"
                  : "location.notServedNote",
                { device: device.label },
              )}
            </small>
          ) : null}
        </span>
        <span className="fdy-workspace-details-label">
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
      <div className="fdy-location-workspace-actions">
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
        {unserved && manageable ? (
          <span className="fdy-location-add-again">
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
          <>
            <Badge tone="online">
              <Check size={13} />
              {t("location.currentBadge")}
            </Badge>
            {removed ? (
              <Badge tone="neutral">{t("shared.deviceRemoved")}</Badge>
            ) : null}
          </>
        ) : removed ? (
          <Badge tone="neutral">{t("shared.deviceRemoved")}</Badge>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            aria-busy={switching}
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
                key: "remove",
                tone: "danger" as const,
                label: t("deviceList.remove"),
                icon: <Trash2 size={15} />,
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
