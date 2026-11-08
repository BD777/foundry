import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Monitor } from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceMigration,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import {
  cancelWorkspaceMigration,
  getWorkspaceMigration,
  startWorkspaceMigration,
} from "../../api";
import { ApiError } from "../../api/http";
import { errorText } from "../../lib/errors";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { CheckLabel } from "../ui/check-label";
import { FieldHint, Radio } from "../ui/field";
import { WorkspaceDialog } from "./workspace-dialog";
import {
  WorkspaceField,
  WorkspaceForm,
  WorkspaceFormActions,
} from "./workspace-form";
import {
  migrationActive,
  migrationReasonKey,
  moveTargetDenial,
  newerMigration,
  suggestMigrationTargetPath,
} from "./workspace-migration";
import { WorkspaceMoveProgress } from "./workspace-move-progress";
import { WorkspacePathPicker } from "./workspace-path-picker";
import { folderPathForSubmit } from "./workspace-path-lookup";

/** How often an open dialog reads a move under way. */
export const migrationPollMs = 2000;

/**
 * Moving a workspace to another device: choose the device and the folder
 * there, then follow the move. Closing the dialog leaves the move running;
 * opening it with `migrationId` shows that move.
 */
export function WorkspaceMoveDialog({
  workspace,
  devices,
  workspaces,
  migrationId,
  onClose,
  returnFocusTo,
}: {
  workspace: WorkspaceProjection;
  devices: DeviceProjection[];
  /** Every workspace, to suggest a folder beside those on the target. */
  workspaces: WorkspaceProjection[];
  migrationId?: string;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation(["workspaces", "common"]);
  const sourceId = workspace.deviceId ?? "";
  const source = devices.find((device) => device.id === sourceId);
  const sourceLabel = source?.label ?? workspace.deviceLabel ?? sourceId;
  // Only devices the person may add workspaces on; the current one is
  // where the workspace already is.
  const targets = useMemo(
    () =>
      devices
        .filter((device) => moveTargetDenial(device, sourceId) !== "current")
        .filter((device) => moveTargetDenial(device, sourceId) !== "notOwned")
        .sort(
          (a, b) =>
            Number(b.status === "connected") -
              Number(a.status === "connected") ||
            a.label.localeCompare(b.label),
        ),
    [devices, sourceId],
  );
  const firstOnline = targets.find((device) => device.status === "connected");
  const [targetId, setTargetId] = useState(firstOnline?.id ?? "");
  const suggestion = (deviceId: string) =>
    suggestMigrationTargetPath(
      workspace.localPath,
      workspaces
        .filter((row) => row.deviceId === deviceId)
        .map((row) => row.localPath),
    );
  const [path, setPath] = useState(() =>
    firstOnline ? suggestion(firstOnline.id) : "",
  );
  const pathEdited = useRef(false);
  const [migration, setMigration] = useState<WorkspaceMigration>();
  const [view, setView] = useState<"choose" | "progress">(
    migrationId ? "progress" : "choose",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const pending = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const target = targets.find((device) => device.id === targetId);
  const targetOnline = target?.status === "connected";
  const followedId = migration?.id ?? migrationId;
  const following = view === "progress" && !!followedId;
  const ended = !!migration && !migrationActive(migration);

  // A move under way is read every couple of seconds while the dialog is
  // open; the workspace list shows only its summary.
  useEffect(() => {
    if (!following || ended || !followedId) return;
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const read = async () => {
      try {
        const next = await getWorkspaceMigration(workspace.id, followedId, {
          signal: controller.signal,
        });
        if (cancelled) return;
        setLoadError("");
        setMigration((held) => (newerMigration(held, next) ? next : held));
        if (!migrationActive(next)) return;
      } catch (cause) {
        if (cancelled) return;
        setLoadError(errorText(cause, t("move.loadFailed")));
      }
      timer = window.setTimeout(() => void read(), migrationPollMs);
    };
    void read();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [following, ended, followedId, workspace.id, t]);

  function chooseTarget(device: DeviceProjection) {
    setTargetId(device.id);
    setError("");
    if (!pathEdited.current) setPath(suggestion(device.id));
  }

  async function start(input: { targetDeviceId: string; targetPath: string }) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setCancelError("");
    try {
      const started = await startWorkspaceMigration(workspace.id, input);
      setMigration(started);
      setView("progress");
    } catch (cause) {
      const key =
        cause instanceof ApiError ? migrationReasonKey(cause.code) : undefined;
      const message = errorText(cause, t("editor.saveFailed"));
      setError(key ? `${t(key)} ${message}` : message);
      setView("choose");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function cancel() {
    if (!migration || canceling) return;
    setCanceling(true);
    setCancelError("");
    try {
      const next = await cancelWorkspaceMigration(workspace.id, migration.id);
      setMigration((held) => (newerMigration(held, next) ? next : held));
    } catch (cause) {
      setCancelError(errorText(cause, t("editor.saveFailed")));
    } finally {
      setCanceling(false);
    }
  }

  if (view === "progress")
    return (
      <WorkspaceDialog
        returnFocusTo={returnFocusTo}
        title={
          !migration || migrationActive(migration)
            ? t("move.progressTitle", { name: workspace.name })
            : t("move.title", { name: workspace.name })
        }
        description={t("move.progressDescription", {
          source: migration?.sourceDeviceLabel ?? sourceLabel,
          target: migration?.targetDeviceLabel ?? target?.label ?? "",
        })}
        busy={busy}
        onClose={onClose}
      >
        <WorkspaceMoveProgress
          migration={migration}
          workspaceName={workspace.name}
          loadError={loadError}
          busy={busy}
          canceling={canceling}
          cancelError={cancelError}
          onCancel={() => void cancel()}
          onRetry={() =>
            migration
              ? void start({
                  targetDeviceId: migration.targetDeviceId,
                  targetPath: migration.targetPath,
                })
              : undefined
          }
          onChangeFolder={() => {
            if (migration) {
              setTargetId(migration.targetDeviceId);
              setPath(migration.targetPath);
              pathEdited.current = true;
            }
            setView("choose");
          }}
          onClose={onClose}
        />
      </WorkspaceDialog>
    );

  const canSubmit = !busy && targetOnline && !!path.trim();
  return (
    <WorkspaceDialog
      initialFocus={field}
      returnFocusTo={returnFocusTo}
      title={t("move.title", { name: workspace.name })}
      description={t("move.description")}
      busy={busy}
      onClose={onClose}
    >
      <WorkspaceForm
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || !target) return;
          void start({
            targetDeviceId: target.id,
            targetPath: folderPathForSubmit(path),
          });
        }}
      >
        <ul className="m-0 grid list-disc gap-1 pl-5 text-xs leading-[1.6] text-ink-muted">
          <li>{t("move.copiesAll")}</li>
          <li>{t("move.sourceStays", { device: sourceLabel })}</li>
          <li>{t("move.paused")}</li>
        </ul>
        <fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0">
          <legend className="mb-1.5 text-sm text-ink">
            {t("move.targetDevice")}
          </legend>
          {targets.map((device) => {
            const offline = device.status !== "connected";
            const reasonId = `fdy-move-target-reason-${device.id}`;
            return (
              <CheckLabel
                key={device.id}
                className="fdy-move-target gap-2.5 rounded-md border border-line px-3 py-2.5 text-sm hover:bg-panel-soft focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-(--fdy-control-focus) data-disabled:cursor-not-allowed data-disabled:opacity-70 data-selected:border-accent-line data-selected:bg-selection [&_strong]:text-sm [&_strong]:text-ink"
                data-selected={device.id === targetId || undefined}
                data-disabled={offline || undefined}
              >
                <Radio
                  name="fdy-move-target"
                  checked={device.id === targetId}
                  disabled={busy || offline}
                  aria-describedby={offline ? reasonId : undefined}
                  onChange={() => chooseTarget(device)}
                />
                <span>
                  <strong className="flex items-center gap-1.5">
                    <Monitor size={14} aria-hidden="true" />
                    {device.label}
                  </strong>
                  {offline ? (
                    <small id={reasonId}>{t("move.offline")}</small>
                  ) : null}
                </span>
              </CheckLabel>
            );
          })}
          {!targets.some((device) => device.status === "connected") ? (
            <p role="status" className="m-0 text-xs text-ink-muted">
              {t("move.noTargets")}
            </p>
          ) : null}
        </fieldset>
        {target && targetOnline ? (
          <WorkspaceField>
            {t("editor.folderOn", { device: target.label })}
            <WorkspacePathPicker
              deviceId={target.id}
              disabled={busy}
              inputRef={field}
              offline={!targetOnline}
              onChange={(next) => {
                pathEdited.current = true;
                setPath(next);
              }}
              value={path}
            />
          </WorkspaceField>
        ) : null}
        {target && targetOnline ? (
          <FieldHint className="mt-0">{t("move.folderNote")}</FieldHint>
        ) : null}
        {error ? <Alert tone="error" size="compact" title={error} /> : null}
        <WorkspaceFormActions>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            busy={busy}
            disabled={!canSubmit}
          >
            {busy ? t("move.starting") : t("move.submit")}
          </Button>
        </WorkspaceFormActions>
      </WorkspaceForm>
    </WorkspaceDialog>
  );
}
