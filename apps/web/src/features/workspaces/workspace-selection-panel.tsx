import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  FolderOpen,
  Monitor,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { PageSurface } from "../../components/ui/page-surface";
import { WorkspaceDetails } from "../../components/workspace/workspace-details";
import { workspaceRoleLabel } from "../../lib/workspace-access";
import {
  WorkspaceEditor,
  type WorkspaceEdit,
} from "../../components/workspace/workspace-editor";
import { isRemovedDevice } from "../../lib/devices";

interface Props {
  compact?: boolean;
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
  onPrepare: (workspace: WorkspaceProjection) => void;
  /** Opens the device's own page: system, accounts, skills, settings. */
  onOpenDevice: (deviceId: string) => void;
  /** Reloads data after a folder was added, renamed or removed. */
  onChanged: () => Promise<void>;
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
  const [edit, setEdit] = useState<{
    edit: WorkspaceEdit;
    device: DeviceProjection;
  }>();
  const [message, setMessage] = useState("");
  const [changeError, setChangeError] = useState("");
  const dialogTrigger = useRef<HTMLElement | null>(null);
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
      <section className="fdy-location" aria-label={t("location.regionLabel")}>
        <Button
          className="fdy-location-trigger fdy-location-entry"
          variant="ghost"
          aria-label={t("location.open")}
          title={t("location.title")}
          onClick={props.onBrowse}
        >
          <span className="fdy-location-entry-rows">
            <span className="fdy-location-entry-row fdy-location-entry-device">
              <Monitor size={14} />
              <span className="fdy-location-trigger-name">
                {activeDevice?.label ?? t("location.selectDevice")}
              </span>
              {activeDevice && activeDevice.status !== "connected" ? (
                <small className="fdy-location-entry-status">
                  {isRemovedDevice(activeDevice)
                    ? t("shared.deviceRemoved")
                    : t("shared.offline")}
                </small>
              ) : null}
            </span>
            <span className="fdy-location-entry-row fdy-location-entry-workspace">
              <FolderOpen size={15} />
              <span className="fdy-location-trigger-name">
                {current?.name ?? t("location.selectWorkspace")}
              </span>
            </span>
          </span>
          <ChevronRight size={13} />
        </Button>
      </section>
    );
  const needle = query.trim().toLowerCase();
  const matches = (row: WorkspaceProjection) =>
    `${row.name} ${row.localPath}`.toLowerCase().includes(needle);
  return (
    <PageSurface variant="devices" className="fdy-location-page">
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
      {message ? (
        <p className="fdy-workspace-success" role="status">
          {message}
        </p>
      ) : null}
      {props.error || changeError ? (
        <p className="fdy-location-error" role="alert">
          {props.error || changeError}
        </p>
      ) : null}
      {groups.map((device) => {
        const removed = isRemovedDevice(device);
        const online = device.status === "connected";
        const rows = props.workspaces.filter(
          (row) => row.deviceId === device.id,
        );
        const visible = rows.filter(matches);
        if (needle && !visible.length) return null;
        return (
          <section
            key={device.id}
            className="fdy-location-group"
            aria-label={device.label}
            data-focused={device.id === focusDeviceId || undefined}
            ref={(element) => {
              if (element) groupRefs.current.set(device.id, element);
              else groupRefs.current.delete(device.id);
            }}
          >
            <header className="fdy-location-group-heading">
              <Monitor size={17} />
              <h2>{device.label}</h2>
              <small>
                {removed
                  ? t("location.removedHistory")
                  : online
                    ? t("shared.workspaceCount", { count: rows.length })
                    : t("location.offlineSummary", {
                        workspaces: t("shared.workspaceCount", {
                          count: rows.length,
                        }),
                      })}
              </small>
              <span className="fdy-location-group-actions">
                {device.owned && !removed ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !online}
                    title={online ? undefined : t("deviceList.reconnect")}
                    onClick={(event) => {
                      dialogTrigger.current = event.currentTarget;
                      setMessage("");
                      setEdit({ edit: { kind: "add" }, device });
                    }}
                  >
                    <Plus size={14} />
                    {t("location.addWorkspace")}
                  </Button>
                ) : null}
                {!removed ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("location.openDeviceFor", {
                      device: device.label,
                    })}
                    onClick={() => props.onOpenDevice(device.id)}
                  >
                    {t("location.openDevice")}
                    <ArrowRight size={14} />
                  </Button>
                ) : null}
              </span>
            </header>
            {visible.map((workspace) => {
              const isCurrent = workspace.id === current?.id;
              const isBusy = workspace.id === props.busyWorkspaceId;
              const manageable =
                device.owned &&
                !removed &&
                (!workspace.accessRole || workspace.accessRole === "owner");
              return (
                <article
                  key={workspace.id}
                  className="fdy-location-workspace-row"
                  data-current={isCurrent}
                  data-removed-device={removed || undefined}
                  onMouseEnter={() => {
                    if (!removed) props.onPrepare(workspace);
                  }}
                  onFocus={() => {
                    if (!removed) props.onPrepare(workspace);
                  }}
                >
                  <Button
                    variant="bare"
                    className="fdy-location-workspace-details"
                    disabled={busy}
                    aria-current={isCurrent ? "location" : undefined}
                    aria-label={t("shared.viewDetails", {
                      name: workspace.name,
                    })}
                    onClick={() => setDetails({ workspace, device })}
                  >
                    <FolderOpen size={19} />
                    <span className="fdy-location-copy">
                      <strong>{workspace.name}</strong>
                      <small>{workspace.localPath}</small>
                    </span>
                    <span className="fdy-workspace-details-label">
                      {t("shared.details")}
                      <ChevronRight size={14} />
                    </span>
                  </Button>
                  <div className="fdy-location-workspace-actions">
                    {workspace.accessRole &&
                    workspace.accessRole !== "owner" ? (
                      <Badge tone="neutral">
                        {t("location.sharedRole", {
                          role: workspaceRoleLabel(workspace.accessRole),
                        })}
                      </Badge>
                    ) : null}
                    {isCurrent ? (
                      <>
                        <Badge tone="online">
                          <Check size={13} />
                          {t("location.currentBadge")}
                        </Badge>
                        {removed ? (
                          <Badge tone="neutral">
                            {t("shared.deviceRemoved")}
                          </Badge>
                        ) : null}
                      </>
                    ) : removed ? (
                      <Badge tone="neutral">{t("shared.deviceRemoved")}</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        aria-busy={isBusy}
                        aria-label={t("location.switchTo", {
                          name: workspace.name,
                        })}
                        onClick={() =>
                          void props.onSelect(workspace, {
                            stayOnLocation: true,
                          })
                        }
                      >
                        {isBusy ? t("shared.switching") : t("location.switch")}
                        {!isBusy ? <ArrowRight size={14} /> : null}
                      </Button>
                    )}
                    {manageable ? (
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            aria-label={t("deviceList.actionsFor", {
                              name: workspace.name,
                            })}
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
                              onSelect={() => {
                                setMessage("");
                                setEdit({
                                  edit: { kind: "rename", workspace },
                                  device,
                                });
                              }}
                            >
                              <Pencil size={15} />
                              {t("deviceList.rename")}
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className="fdy-workspace-menu-item"
                              onSelect={() => {
                                setMessage("");
                                setEdit({
                                  edit: { kind: "remove", workspace },
                                  device,
                                });
                              }}
                            >
                              <Trash2 size={15} />
                              {t("deviceList.remove")}
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    ) : null}
                  </div>
                </article>
              );
            })}
            {!rows.length ? (
              <p className="fdy-location-empty">{t("location.noWorkspaces")}</p>
            ) : null}
          </section>
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
      {edit ? (
        <WorkspaceEditor
          returnFocusTo={dialogTrigger.current}
          edit={edit.edit}
          device={edit.device}
          activeWorkspaceId={props.activeWorkspaceId}
          onClose={() => setEdit(undefined)}
          onSaved={async (kind, workspace) => {
            setChangeError("");
            setMessage(
              t(
                kind === "add"
                  ? // With no workspace before, the first one becomes current.
                    props.activeWorkspaceId
                    ? "deviceList.added"
                    : "deviceList.addedFirst"
                  : kind === "rename"
                    ? "deviceList.renamed"
                    : "deviceList.removed",
                { name: workspace.name },
              ),
            );
            try {
              await props.onChanged();
            } catch {
              setChangeError(t("deviceList.refreshFailed"));
            }
          }}
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
