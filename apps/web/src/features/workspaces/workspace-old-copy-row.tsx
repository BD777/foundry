import { useTranslation } from "react-i18next";
import { FolderX, Trash2 } from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceMigrationSummary,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { FieldHint } from "../../components/ui/field";
import { deviceConnection } from "../../lib/device-connection";

/**
 * What a complete move left on its source device: the old folder and local
 * state, kept until the person deletes them. Listed in the source device's
 * group of the Workspaces page.
 */
export function WorkspaceOldCopyRow({
  workspace,
  migration,
  device,
  busy,
  onDelete,
}: {
  workspace: WorkspaceProjection;
  migration: WorkspaceMigrationSummary;
  /** The source device, holding the old copy. */
  device: DeviceProjection;
  busy: boolean;
  onDelete: (trigger: HTMLElement) => void;
}) {
  const { t } = useTranslation("workspaces");
  const online = deviceConnection(device) === "online";
  const noteId = `fdy-old-copy-${migration.id}`;
  return (
    <article
      className="fdy-location-old-copy flex min-w-0 items-center gap-2.5 rounded-md px-2 py-1 max-[700px]:flex-col max-[700px]:items-stretch max-[700px]:gap-1"
      aria-label={t("move.oldCopyTitle", { name: workspace.name })}
    >
      <div className="flex min-h-14 min-w-0 flex-1 items-center gap-3 p-2 text-ink-muted">
        <FolderX size={19} aria-hidden="true" />
        <span className="grid min-w-0 flex-1 gap-[5px]">
          <strong className="text-sm leading-[1.4] font-bold [overflow-wrap:anywhere] text-ink-2">
            {t("move.oldCopyTitle", { name: workspace.name })}
          </strong>
          <FieldHint
            as="small"
            id={noteId}
            className="mt-0 text-2xs leading-normal"
          >
            {t("move.oldCopyNote", {
              name: workspace.name,
              device: migration.targetDeviceLabel,
            })}
            {online
              ? ""
              : ` ${t("move.oldCopyOffline", { device: device.label })}`}
          </FieldHint>
        </span>
      </div>
      <div className="flex flex-none items-center gap-2 pr-1 max-[700px]:justify-end max-[700px]:px-1 max-[700px]:pb-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !online}
          aria-label={t("move.deleteOldCopyFor", {
            name: workspace.name,
            device: device.label,
          })}
          aria-describedby={noteId}
          onClick={(event) => onDelete(event.currentTarget)}
        >
          <Trash2 size={14} />
          {t("move.deleteOldCopy")}
        </Button>
      </div>
    </article>
  );
}
