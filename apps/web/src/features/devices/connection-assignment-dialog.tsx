import { ToastFeedback } from "../../components/ui/toast";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProfileDefinition } from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Checkbox } from "../../components/ui/field";
import { RuntimeMark } from "../../components/ui/runtime-mark";

export interface ConnectionAssignmentDialogProps {
  /** All selectable model providers, including ones already assigned. */
  connections: ProfileDefinition[];
  /**
   * Persisted state on open: the connection ids the device can currently use.
   * Cancelling must leave this set exactly as it was.
   */
  initialSelectedIds: string[];
  /** Controlled visibility; closing never writes. */
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** Go to the independent Model providers management page. */
  onManage: () => void;
  /**
   * Why a connection would not run on this device yet (its runtime is not
   * installed there), shown in its row; undefined when it would.
   */
  connectionNote?: (connection: ProfileDefinition) => string | undefined;
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
  connectionNote,
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
    <Dialog
      busy={busy}
      description={t("assignment.description")}
      footer={
        <>
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
          <Button
            disabled={busy}
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="secondary"
          >
            {t("common:actions.cancel")}
          </Button>
          <Button
            disabled={busy || !changed || connections.length === 0}
            onClick={() => void save()}
            size="sm"
            variant="primary"
          >
            {busy ? t("common:actions.saving") : t("common:actions.save")}
          </Button>
        </>
      }
      layout="compact"
      onClose={() => onOpenChange(false)}
      open={open}
      title={t("assignment.title")}
    >
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
            const note = connectionNote?.(connection);
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
                  {note ? (
                    <small className="fdy-runtime-state-note">{note}</small>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {error ? <ToastFeedback tone="error" title={error} /> : null}
    </Dialog>
  );
}
