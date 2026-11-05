import { ToastFeedback } from "../../components/ui/toast";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProfileDefinition } from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Checkbox } from "../../components/ui/field";
import { cn } from "../../lib/cn";
import { RuntimeMark } from "../../components/agent-runtime/runtime-mark";

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
            className="mr-auto"
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
        <Alert
          size="compact"
          title={t("assignment.empty")}
          actions={
            <Button onClick={onManage} size="sm" variant="secondary">
              <ExternalLink size={14} />
              {t("assignment.openConnections")}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-1.5">
          {connections.map((connection) => {
            const checked = draft.has(connection.id);
            const note = connectionNote?.(connection);
            return (
              <label
                className={cn(
                  "fdy-connection-assign-row grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-3 py-2.5 transition-colors duration-120 hover:bg-control-ghost-hover",
                  // Selection is the checkbox plus one fill that differs from
                  // hover, and a selected row keeps it under the pointer.
                  checked && "is-selected bg-selection hover:bg-selection",
                )}
                key={connection.id}
                data-selected={checked ? "true" : "false"}
              >
                <Checkbox
                  aria-checked={checked}
                  aria-label={t("assignment.grant", {
                    connection: connection.label,
                  })}
                  checked={checked}
                  className="flex-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  disabled={busy}
                  onChange={() => toggle(connection.id)}
                />
                <RuntimeMark runtime={connection.runtime} />
                <span className="grid min-w-0 gap-0.5">
                  <strong className="truncate text-sm font-semibold text-ink">
                    {connection.label}
                  </strong>
                  <small className="truncate text-2xs text-ink-muted">
                    {connection.model || connection.baseUrl} ·{" "}
                    {checked
                      ? t("assignment.selected")
                      : t("assignment.notSelected")}
                  </small>
                  {note ? (
                    <small className="mt-0.5 block truncate text-2xs leading-[1.45] text-ink-muted">
                      {note}
                    </small>
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
