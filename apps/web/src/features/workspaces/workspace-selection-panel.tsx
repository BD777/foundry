import { ToastFeedback } from "../../components/ui/toast";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowLeft, Check, Search } from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceMigrationSummary,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { PageSurface } from "../../components/ui/page-surface";
import { WorkspaceDetails } from "../../components/workspace/workspace-details";
import {
  WorkspaceEditor,
  type WorkspaceEdit,
} from "../../components/workspace/workspace-editor";
import { WorkspaceLocateDialog } from "../../components/workspace/workspace-locate-dialog";
import { oldCopiesOn } from "../../components/workspace/workspace-migration";
import { WorkspaceMoveDialog } from "../../components/workspace/workspace-move-dialog";
import { WorkspacePurgeDialog } from "../../components/workspace/workspace-purge-dialog";
import { WorkspaceOldCopyRow } from "./workspace-old-copy-row";
import { CompactLocationSwitcher } from "./compact-location-switcher";
import { useWorkspaceRowActions } from "./use-workspace-row-actions";
import { WorkspaceDeviceGroup } from "./workspace-device-group";
import { LocationEmpty } from "./location-empty";
import { WorkspaceRow } from "./workspace-row";
import { PageHeader } from "../../components/ui/page-header";

interface Props {
  compact?: boolean;
  /** Icon-only sidebar entry on wide screens. */
  collapsed?: boolean;
  activeWorkspaceId: string;
  devices: DeviceProjection[];
  workspaces: WorkspaceProjection[];
  /** The device whose group to bring into view, from the route. */
  focusDeviceId?: string;
  busyWorkspaceId: string;
  error: string;
  onReset: () => void;
  onSelect: (
    workspace: WorkspaceProjection,
    options?: { stayOnLocation?: boolean },
  ) => Promise<boolean>;
  /** The person may be about to switch to the workspace (hover, focus). */
  onPrepare: (workspace: WorkspaceProjection) => void;
  /** They moved on (the pointer left, the focus moved). */
  onPrepareEnd: () => void;
  /** Opens the device's own page: system, accounts, skills, settings. */
  onOpenDevice: (deviceId: string) => void;
  /**
   * Reloads data after a folder was added, renamed, located or removed;
   * `removedWorkspaceId` names the workspace removed.
   */
  onChanged: (change?: { removedWorkspaceId?: string }) => Promise<void>;
  /**
   * Registers a workspace's folder on its device again, after the device
   * stopped serving it.
   */
  onAddAgain: (
    workspace: WorkspaceProjection,
    device: DeviceProjection,
  ) => Promise<void>;
  onBrowse: () => void;
  onReturn: () => void;
}

/**
 * Workspaces: every folder, grouped by the device that holds it. Switching
 * happens only on Switch; adding, renaming and removing folders sit with the
 * device group and the row's menu. The sidebar entry opens this route.
 */
export function WorkspaceSelectionPanel(props: Props) {
  const { t } = useTranslation(["workspaces", "common"]);
  const current = props.workspaces.find(
    (row) => row.id === props.activeWorkspaceId,
  );
  const activeDevice = props.devices.find(
    (row) => row.id === current?.deviceId,
  );
  const [query, setQuery] = useState("");
  const [details, setDetails] = useState<{
    workspace: WorkspaceProjection;
    device: DeviceProjection;
  }>();
  // A dialog returns focus to `trigger`; one opened from a row's menu has
  // none and returns focus to the menu's button.
  const [edit, setEdit] = useState<{
    edit: WorkspaceEdit;
    device: DeviceProjection;
    trigger: HTMLElement | null;
  }>();
  const [locate, setLocate] = useState<{
    workspace: WorkspaceProjection;
    device: DeviceProjection;
    trigger: HTMLElement | null;
  }>();
  // A move's dialog: choosing where, or following the move `migrationId`.
  const [move, setMove] = useState<{
    workspace: WorkspaceProjection;
    migrationId?: string;
    trigger: HTMLElement | null;
  }>();
  // Held as opened: once deleted, the old copy leaves the list.
  const [purge, setPurge] = useState<{
    workspace: WorkspaceProjection;
    migration: WorkspaceMigrationSummary;
    device: DeviceProjection;
    trigger: HTMLElement | null;
  }>();
  const actions = useWorkspaceRowActions({
    activeWorkspaceId: props.activeWorkspaceId,
    workspaceCount: props.workspaces.length,
    onAddAgain: props.onAddAgain,
    onChanged: props.onChanged,
  });
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const busy = !!props.busyWorkspaceId;
  const groups = [...props.devices].sort((a, b) =>
    a.id === activeDevice?.id
      ? -1
      : b.id === activeDevice?.id
        ? 1
        : a.label.localeCompare(b.label),
  );
  const focusDeviceId = props.focusDeviceId;
  const focusShown = groups.some((device) => device.id === focusDeviceId);
  // Once the group is listed, and after the page's own scroll reset on
  // opening (useViewScrollReset, the next frame).
  useEffect(() => {
    if (!focusDeviceId || !focusShown) return;
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() =>
        groupRefs.current
          .get(focusDeviceId)
          ?.scrollIntoView({ block: "start" }),
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusDeviceId, focusShown]);
  if (props.compact)
    return (
      <CompactLocationSwitcher
        collapsed={props.collapsed}
        device={activeDevice}
        workspace={current}
        onBrowse={props.onBrowse}
      />
    );
  const needle = query.trim().toLowerCase();
  const matches = (row: WorkspaceProjection) =>
    `${row.name} ${row.localPath}`.toLowerCase().includes(needle);
  const error = props.error || actions.changeError;
  return (
    <PageSurface variant="devices" className="max-w-[1060px]">
      {current ? (
        <Button
          className="fdy-device-back justify-self-start"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={props.onReturn}
        >
          <ArrowLeft size={14} />
          {t("location.back")}
        </Button>
      ) : null}
      <PageHeader
        title={t("location.title")}
        description={t("location.intro")}
      />
      <div className="fdy-location-current flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <Check size={15} />
        <span>
          <Trans
            t={t}
            i18nKey="location.currentLocation"
            values={{
              location:
                activeDevice && current
                  ? `${activeDevice.label} / ${current.name}`
                  : t("location.noWorkspaceSelected"),
            }}
            components={{ strong: <strong className="text-ink" /> }}
          />
        </span>
        {!current && props.workspaces.length ? (
          <span className="text-ink">{t("location.chooseWorkspace")}</span>
        ) : null}
      </div>
      <label className="flex items-center gap-2 rounded-sm border border-line px-2.5">
        <Search size={15} />
        <TextInput
          aria-label={t("location.findLabel")}
          placeholder={t("location.searchPlaceholder")}
          value={query}
          disabled={busy}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      {actions.message ? (
        <ToastFeedback tone="success" title={actions.message} />
      ) : null}
      {error ? <ToastFeedback tone="error" title={error} /> : null}
      {groups.map((device) => {
        const rows = props.workspaces.filter(
          (row) => row.deviceId === device.id,
        );
        const visible = rows.filter(matches);
        const oldCopies = oldCopiesOn(props.workspaces, device.id).filter(
          matches,
        );
        if (needle && !visible.length && !oldCopies.length) return null;
        return (
          <WorkspaceDeviceGroup
            key={device.id}
            device={device}
            workspaceCount={rows.length}
            focused={device.id === focusDeviceId}
            busy={busy}
            groupRef={(element) => {
              if (element) groupRefs.current.set(device.id, element);
              else groupRefs.current.delete(device.id);
            }}
            onAdd={(trigger) => {
              actions.clearMessage();
              setEdit({ edit: { kind: "add" }, device, trigger });
            }}
            onOpenDevice={() => props.onOpenDevice(device.id)}
          >
            {visible.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                device={device}
                current={workspace.id === current?.id}
                busy={busy}
                switching={workspace.id === props.busyWorkspaceId}
                addingAgainId={actions.addingAgainId}
                detailsRef={(node) => {
                  if (node)
                    actions.detailsButtons.current.set(workspace.id, node);
                  else actions.detailsButtons.current.delete(workspace.id);
                }}
                onDetails={() => setDetails({ workspace, device })}
                onAddAgain={() => void actions.addAgain(workspace, device)}
                onLocate={(trigger) => {
                  actions.clearMessage();
                  setLocate({ workspace, device, trigger });
                }}
                onSwitch={() =>
                  void props.onSelect(workspace, { stayOnLocation: true })
                }
                onEdit={(next) => {
                  actions.clearMessage();
                  setEdit({ edit: next, device, trigger: null });
                }}
                onMove={() => {
                  actions.clearMessage();
                  setMove({ workspace, trigger: null });
                }}
                onViewMove={(trigger) =>
                  setMove({
                    workspace,
                    migrationId: workspace.migration?.id,
                    trigger,
                  })
                }
                onPrepare={() => props.onPrepare(workspace)}
                onPrepareEnd={props.onPrepareEnd}
              />
            ))}
            {oldCopies.map((workspace) =>
              workspace.migration ? (
                <WorkspaceOldCopyRow
                  key={workspace.migration.id}
                  workspace={workspace}
                  migration={workspace.migration}
                  device={device}
                  busy={busy}
                  onDelete={(trigger) =>
                    setPurge({
                      workspace,
                      migration: workspace.migration!,
                      device,
                      trigger,
                    })
                  }
                />
              ) : null,
            )}
          </WorkspaceDeviceGroup>
        );
      })}
      {!groups.length ? (
        <LocationEmpty>{t("location.noDevices")}</LocationEmpty>
      ) : needle &&
        !props.workspaces.some(
          (row) =>
            matches(row) && groups.some((device) => device.id === row.deviceId),
        ) ? (
        <LocationEmpty>{t("location.noMatches")}</LocationEmpty>
      ) : null}
      {locate ? (
        <WorkspaceLocateDialog
          workspace={locate.workspace}
          device={locate.device}
          returnFocusTo={locate.trigger}
          onClose={() => setLocate(undefined)}
          onDone={actions.relinked}
        />
      ) : null}
      {move ? (
        <WorkspaceMoveDialog
          workspace={
            props.workspaces.find((row) => row.id === move.workspace.id) ??
            move.workspace
          }
          devices={props.devices}
          workspaces={props.workspaces}
          migrationId={move.migrationId}
          returnFocusTo={move.trigger}
          onClose={() => setMove(undefined)}
        />
      ) : null}
      {purge ? (
        <WorkspacePurgeDialog
          workspace={purge.workspace}
          migration={purge.migration}
          sourceLabel={purge.device.label}
          // Its row goes once deleted: focus returns to the device group.
          returnFocusTo={purge.trigger?.isConnected ? purge.trigger : null}
          onClose={() => setPurge(undefined)}
        />
      ) : null}
      {edit ? (
        <WorkspaceEditor
          returnFocusTo={edit.trigger}
          edit={edit.edit}
          device={edit.device}
          activeWorkspaceId={props.activeWorkspaceId}
          onClose={() => setEdit(undefined)}
          onSaved={(kind, workspace) =>
            actions.saved(edit.edit, kind, workspace)
          }
        />
      ) : null}
      {details ? (
        <WorkspaceDetails
          workspace={details.workspace}
          device={details.device}
          onClose={() => setDetails(undefined)}
        />
      ) : null}
    </PageSurface>
  );
}
