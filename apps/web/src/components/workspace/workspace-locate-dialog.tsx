import { ToastFeedback } from "../ui/toast";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import type {
  DeviceProjection,
  WorkspaceProjection,
  WorkspaceRelinkResult,
  WorkspaceRelinkSuggestion,
} from "@bd777/foundry-protocol";
import { listWorkspaceRelinkSuggestions, relinkWorkspace } from "../../api";
import { ActionRow } from "../ui/action-row";
import { Button } from "../ui/button";
import { WorkspaceDialog } from "./workspace-dialog";
import { WorkspacePathPicker } from "./workspace-path-picker";
import {
  folderPathForSubmit,
  parentFolderInput,
} from "./workspace-path-lookup";

/**
 * Locating points a workspace at its folder's new path: the same workspace,
 * with its chats, sessions, Issues and settings.
 */
export function WorkspaceLocateDialog({
  workspace,
  device,
  onClose,
  onDone,
  returnFocusTo,
}: {
  workspace: WorkspaceProjection;
  device: DeviceProjection;
  onClose: () => void;
  /** After the server answered; the dialog closes once it resolves. */
  onDone: (result: WorkspaceRelinkResult) => Promise<void>;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation(["workspaces", "common"]);
  const { id: workspaceId, name, localPath: lastPath } = workspace;
  const deviceLabel = device.label;
  // Locating starts beside the last folder, so the picker lists the folders
  // next to where it was.
  const [value, setValue] = useState(parentFolderInput(lastPath));
  const [suggestions, setSuggestions] = useState<WorkspaceRelinkSuggestion[]>(
    [],
  );
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const offline = device.status !== "connected";

  useEffect(() => {
    if (offline) return;
    let cancelled = false;
    setLooking(true);
    // No suggestions (or none readable now) leaves the path field alone.
    listWorkspaceRelinkSuggestions(workspaceId)
      .then((items) => {
        if (!cancelled) setSuggestions(items);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setLooking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, offline]);

  async function submit() {
    if (pending.current || offline || !value.trim()) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const path = folderPathForSubmit(value);
    try {
      const result = await relinkWorkspace(workspaceId, path);
      // The change has succeeded. Refresh errors must not invite resubmission.
      await onDone(result);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("editor.saveFailed"));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const chosen = folderPathForSubmit(value);
  return (
    <WorkspaceDialog
      initialFocus={field}
      returnFocusTo={returnFocusTo}
      title={t("locate.title")}
      description={t("locate.description", {
        name,
        path: lastPath,
        device: deviceLabel,
      })}
      busy={busy}
      onClose={onClose}
    >
      <form
        aria-busy={busy}
        className="fdy-workspace-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {looking ? (
          <p className="fdy-location-description" role="status">
            {t("locate.looking", { device: deviceLabel })}
          </p>
        ) : null}
        {suggestions.length ? (
          <div
            className="fdy-workspace-locate-suggestions"
            role="group"
            aria-label={t("locate.suggestionsLabel")}
          >
            <span className="fdy-workspace-locate-suggestions-title">
              {t("locate.suggestionsLabel")}
            </span>
            {suggestions.map((suggestion) => {
              const selected = chosen === suggestion.path;
              return (
                <ActionRow
                  key={suggestion.path}
                  className="fdy-workspace-locate-suggestion"
                  density="compact"
                  selected={selected}
                  aria-current={undefined}
                  aria-pressed={selected}
                  disabled={busy}
                  onClick={() => setValue(suggestion.path)}
                >
                  <FolderOpen size={15} aria-hidden="true" />
                  <span className="fdy-location-copy">
                    <strong>{suggestion.path}</strong>
                    <small>{t(`locate.reasons.${suggestion.reason}`)}</small>
                  </span>
                </ActionRow>
              );
            })}
          </div>
        ) : null}
        <label className="fdy-workspace-field">
          {t("editor.folderOn", { device: deviceLabel })}
          <WorkspacePathPicker
            deviceId={device.id}
            disabled={busy}
            inputRef={field}
            offline={offline}
            onChange={setValue}
            value={value}
          />
        </label>
        <p className="fdy-location-description">{t("locate.note")}</p>
        {offline ? (
          <p role="status">{t("locate.reconnect", { device: deviceLabel })}</p>
        ) : null}
        {error ? <ToastFeedback tone="error" title={error} /> : null}
        <footer className="fdy-workspace-form-actions">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || offline || !value.trim()}
          >
            {busy ? t("locate.locating") : t("locate.submit")}
          </Button>
        </footer>
      </form>
    </WorkspaceDialog>
  );
}
