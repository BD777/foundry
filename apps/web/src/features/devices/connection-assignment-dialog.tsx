import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProfileDefinition } from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/field";
import { RuntimeMark } from "../../components/ui/runtime-mark";

export interface ConnectionAssignmentDialogProps {
  /** All selectable server connections, including ones already assigned. */
  connections: ProfileDefinition[];
  /**
   * Persisted state on open: the connection ids the device can currently use.
   * Cancelling must leave this set exactly as it was.
   */
  initialSelectedIds: string[];
  /** Radix-controlled visibility; closing never writes. */
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** Go to the independent Server connections management page. */
  onManage: () => void;
  /**
   * Persists one device's complete resulting set in a single write. Reject to
   * keep the dialog open with its draft intact, so the user can retry.
   */
  onSave: (profileIds: string[]) => Promise<void>;
}

/**
 * Multi-select picker for granting one device access to existing server
 * connections. Toggles edit a local draft only; nothing is written until Save,
 * which submits the full resulting set once.
 */
export function ConnectionAssignmentDialog({
  connections,
  initialSelectedIds,
  onOpenChange,
  open,
  onManage,
  onSave,
}: ConnectionAssignmentDialogProps) {
  const { t } = useTranslation(["profiles", "common"]);
  const [draft, setDraft] = useState<Set<string>>(
    () => new Set(initialSelectedIds),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The draft is initialised from the persisted set exactly once, on the
  // closed -> open transition. While the picker is open its draft belongs to
  // the user: a background snapshot changing bindings mid-edit must not wipe
  // an unsaved choice. A successful Save closes the picker, so the next open
  // re-arms from whatever the server then reports. (A future conflict/merge
  // prompt can build on this; the minimum guarantee is never losing the draft.)
  const latestInitialRef = useRef(initialSelectedIds);
  latestInitialRef.current = initialSelectedIds;
  useEffect(() => {
    if (!open) return;
    setDraft(new Set(latestInitialRef.current));
    setError("");
    setBusy(false);
    // Open transitions only; initialSelectedIds identity/content is read via
    // the ref and intentionally absent from the dependencies.
  }, [open]);

  const savedSet = new Set(initialSelectedIds);
  const changed =
    draft.size !== savedSet.size || [...draft].some((id) => !savedSet.has(id));

  function toggle(id: string) {
    if (busy) return;
    setError("");
    setDraft((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    if (busy || !changed) return;
    setBusy(true);
    setError("");
    try {
      await onSave([...draft]);
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("assignment.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fdy-connection-assign-overlay" />
        <Dialog.Content
          className="fdy-connection-assign-dialog"
          aria-describedby="connection-assign-description"
        >
          <header className="fdy-connection-assign-header">
            <div>
              <Dialog.Title>{t("assignment.title")}</Dialog.Title>
              <Dialog.Description id="connection-assign-description">
                {t("assignment.description")}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                aria-label={t("assignment.close")}
                disabled={busy}
                size="icon"
                variant="ghost"
              >
                <X size={17} />
              </Button>
            </Dialog.Close>
          </header>

          {connections.length === 0 ? (
            <div className="fdy-connection-assign-empty">
              <p>{t("assignment.empty")}</p>
              <Button onClick={onManage} size="sm" variant="secondary">
                <ExternalLink size={14} />
                {t("assignment.openConnections")}
              </Button>
            </div>
          ) : (
            <div className="fdy-connection-assign-list">
              {connections.map((connection) => {
                const checked = draft.has(connection.id);
                return (
                  <label
                    className={
                      checked
                        ? "fdy-connection-assign-row is-selected"
                        : "fdy-connection-assign-row"
                    }
                    key={connection.id}
                    data-selected={checked ? "true" : "false"}
                  >
                    <Checkbox
                      aria-checked={checked}
                      aria-label={t("assignment.grant", {
                        connection: connection.label,
                      })}
                      checked={checked}
                      className="fdy-connection-assign-check"
                      disabled={busy}
                      onChange={() => toggle(connection.id)}
                    />
                    <RuntimeMark runtime={connection.runtime} />
                    <span className="fdy-connection-assign-copy">
                      <strong>{connection.label}</strong>
                      <small>
                        {connection.model || connection.baseUrl} ·{" "}
                        {checked
                          ? t("assignment.selected")
                          : t("assignment.notSelected")}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {error ? (
            <p className="fdy-connection-assign-error" role="alert">
              {error}
            </p>
          ) : null}

          <footer className="fdy-connection-assign-actions">
            <Button
              className="fdy-connection-assign-manage"
              disabled={busy}
              onClick={onManage}
              size="sm"
              variant="ghost"
            >
              <ExternalLink size={14} />
              {t("assignment.manage")}
            </Button>
            <Dialog.Close asChild>
              <Button disabled={busy} size="sm" variant="secondary">
                {t("common:actions.cancel")}
              </Button>
            </Dialog.Close>
            <Button
              disabled={busy || !changed || connections.length === 0}
              onClick={() => void save()}
              size="sm"
              variant="primary"
            >
              {busy ? t("common:actions.saving") : t("common:actions.save")}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
