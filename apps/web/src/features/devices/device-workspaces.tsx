import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowRight,
  Check,
  ChevronRight,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { TextInput } from "../../components/ui/field";
import { Badge } from "../../components/ui/badge";
import { WorkspaceEditor, type WorkspaceEdit } from "./workspace-editor";
import { WorkspaceDetails } from "./workspace-details";
import { workspaceRoleLabel } from "../../lib/workspace-access";

export function DeviceWorkspaces({
  device,
  workspaces,
  activeWorkspaceId,
  onOpen,
  onRefresh,
}: {
  device: DeviceProjection;
  workspaces: WorkspaceProjection[];
  activeWorkspaceId: string;
  onOpen: (workspaceId: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("workspaces");
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<WorkspaceEdit>();
  const [details, setDetails] = useState<WorkspaceProjection>();
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<WorkspaceProjection>();
  const pending = useRef(false);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const actionTriggers = useRef(new Map<string, HTMLButtonElement>());
  function editWorkspace(
    kind: "rename" | "remove",
    workspace: WorkspaceProjection,
  ) {
    dialogTrigger.current = actionTriggers.current.get(workspace.id) ?? null;
    setEdit({ kind, workspace });
  }
  async function open(id: string) {
    if (pending.current) return;
    pending.current = true;
    setBusyId(id);
    setError("");
    try {
      if (!(await onOpen(id))) throw new Error(t("deviceList.switchFailed"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("deviceList.switchFailedShort"),
      );
    } finally {
      pending.current = false;
      setBusyId("");
    }
  }
  const visible = workspaces.filter((row) =>
    `${row.name} ${row.localPath}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <section className="fdy-device-section">
      <header className="fdy-management-heading">
        <div>
          <h2>{t("deviceList.title")}</h2>
          <p>
            {device.owned
              ? t("deviceList.ownedIntro", { device: device.label })
              : t("deviceList.sharedIntro", { device: device.label })}
          </p>
        </div>
        {device.owned ? (
          <Button
            size="sm"
            variant="primary"
            disabled={device.status !== "connected" || !!busyId}
            onClick={(event) => {
              dialogTrigger.current = event.currentTarget;
              setEdit({ kind: "add" });
            }}
          >
            <Plus size={15} />
            {t("deviceList.add")}
          </Button>
        ) : null}
      </header>
      {device.status !== "connected" ? (
        <p>{t("deviceList.reconnect")}</p>
      ) : null}
      <TextInput
        tone="boxed"
        aria-label={t("deviceList.searchLabel")}
        placeholder={t("deviceList.searchPlaceholder")}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {message ? (
        <div className="fdy-workspace-success" role="status">
          <span>{message}</span>
          {created && created.id !== activeWorkspaceId ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busyId}
              onClick={() => void open(created.id)}
            >
              {t("deviceList.switchToThis")}
              <ArrowRight size={14} />
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="fdy-location-error">
          {error}
        </p>
      ) : null}
      <div className="fdy-device-workspace-list">
        {visible.map((workspace) => {
          const current = workspace.id === activeWorkspaceId;
          return (
            <article
              className="fdy-device-workspace-row"
              data-current={current}
              key={workspace.id}
            >
              <Button
                className="fdy-workspace-details-trigger"
                variant="ghost"
                disabled={!!busyId}
                aria-label={t("shared.viewDetails", { name: workspace.name })}
                onClick={() => setDetails(workspace)}
              >
                <FolderOpen size={20} />
                <span className="fdy-location-copy">
                  <strong>{workspace.name}</strong>
                  <small>{workspace.localPath}</small>
                </span>
                <span className="fdy-workspace-details-label">
                  {t("shared.details")}
                  <ChevronRight size={14} />
                </span>
              </Button>
              <div className="fdy-workspace-row-actions">
                {current ? (
                  <Badge tone="online">
                    <Check size={13} />
                    {t("deviceList.currentWorkspace")}
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!!busyId}
                    aria-busy={busyId === workspace.id}
                    onClick={() => void open(workspace.id)}
                  >
                    {busyId === workspace.id
                      ? t("shared.switching")
                      : t("deviceList.switchHere")}
                    <ArrowRight size={14} />
                  </Button>
                )}
                {workspace.accessRole && workspace.accessRole !== "owner" ? (
                  <Badge tone="neutral">
                    {t("deviceList.roleAccess", {
                      role: workspaceRoleLabel(workspace.accessRole),
                    })}
                  </Badge>
                ) : (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busyId}
                        aria-label={t("deviceList.actionsFor", {
                          name: workspace.name,
                        })}
                        ref={(element) => {
                          if (element)
                            actionTriggers.current.set(workspace.id, element);
                          else actionTriggers.current.delete(workspace.id);
                        }}
                      >
                        <MoreHorizontal size={17} />
                        {t("deviceList.actions")}
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
                          onSelect={() => editWorkspace("rename", workspace)}
                        >
                          <Pencil size={15} />
                          {t("deviceList.rename")}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className="fdy-workspace-menu-item"
                          onSelect={() => editWorkspace("remove", workspace)}
                        >
                          <Trash2 size={15} />
                          {t("deviceList.remove")}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!visible.length ? (
        <p>{query ? t("deviceList.noMatches") : t("deviceList.empty")}</p>
      ) : null}
      {edit ? (
        <WorkspaceEditor
          returnFocusTo={dialogTrigger.current}
          edit={edit}
          device={device}
          activeWorkspaceId={activeWorkspaceId}
          onClose={() => setEdit(undefined)}
          onSaved={async (kind, workspace) => {
            setMessage(
              t(
                kind === "add"
                  ? "deviceList.added"
                  : kind === "rename"
                    ? "deviceList.renamed"
                    : "deviceList.removed",
                { name: workspace.name },
              ),
            );
            setCreated(kind === "add" ? workspace : undefined);
            try {
              await onRefresh();
            } catch {
              setError(t("deviceList.refreshFailed"));
            }
          }}
        />
      ) : null}
      {details ? (
        <WorkspaceDetails
          workspace={details}
          device={device}
          onClose={() => setDetails(undefined)}
        />
      ) : null}
    </section>
  );
}
