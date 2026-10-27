import { ToastFeedback } from "../../components/ui/toast";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ArrowLeft, Check, Search } from "lucide-react";
import type {
  DeviceProjection,
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
import { isRemovedDevice } from "../../lib/devices";
import { CompactLocationSwitcher } from "./compact-location-switcher";
import { useWorkspaceRowActions } from "./use-workspace-row-actions";
import { WorkspaceDeviceGroup } from "./workspace-device-group";
import { WorkspaceRow } from "./workspace-row";

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
  const actions = useWorkspaceRowActions({
    activeWorkspaceId: props.activeWorkspaceId,
    workspaceCount: props.workspaces.length,
    onAddAgain: props.onAddAgain,
    onChanged: props.onChanged,
  });
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const busy = !!props.busyWorkspaceId;
  // A removed device is never a new choice; it stays listed, read-only, only
  // while it holds the current workspace.
  const groups = props.devices
    .filter(
      (device) => !isRemovedDevice(device) || device.id === activeDevice?.id,
    )
    .sort((a, b) =>
      a.id === activeDevice?.id
        ? -1
        : b.id === activeDevice?.id
          ? 1
          : a.label.localeCompare(b.label),
    );
  const focusDeviceId = props.focusDeviceId;
  useEffect(() => {
    if (focusDeviceId)
      groupRefs.current.get(focusDeviceId)?.scrollIntoView({ block: "start" });
  }, [focusDeviceId]);
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
    <PageSurface variant="devices" className="fdy-location-page">
      {current ? (
        <Button
          className="fdy-device-back"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={props.onReturn}
        >
          <ArrowLeft size={14} />
          {t("location.back")}
        </Button>
      ) : null}
      <header className="fdy-management-heading">
        <div>
          <h1>{t("location.title")}</h1>
          <p>{t("location.intro")}</p>
        </div>
      </header>
      <div className="fdy-location-current">
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
            components={{ strong: <strong /> }}
          />
        </span>
        {!current && props.workspaces.length ? (
          <span className="fdy-location-current-prompt">
            {t("location.chooseWorkspace")}
          </span>
        ) : null}
      </div>
      <label className="fdy-location-page-search">
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
        if (needle && !visible.length) return null;
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
                onPrepare={() => props.onPrepare(workspace)}
                onPrepareEnd={props.onPrepareEnd}
              />
            ))}
          </WorkspaceDeviceGroup>
        );
      })}
      {!groups.length ? (
        <p className="fdy-location-empty">{t("location.noDevices")}</p>
      ) : needle &&
        !props.workspaces.some(
          (row) =>
            matches(row) && groups.some((device) => device.id === row.deviceId),
        ) ? (
        <p className="fdy-location-empty">{t("location.noMatches")}</p>
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
