import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WorkspaceMigrationPurgePreview,
  WorkspaceMigrationSummary,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { purgeWorkspaceMigrationSource } from "../../api";
import { errorText } from "../../lib/errors";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { CheckLabel } from "../ui/check-label";
import { Checkbox, FieldHint } from "../ui/field";
import { LoadingState } from "../ui/loading";
import { WorkspaceDialog } from "./workspace-dialog";
import { migrationSize } from "./workspace-migration";
import {
  LocationDescription,
  WorkspaceForm,
  WorkspaceFormActions,
} from "./workspace-form";

/** How many paths a list shows before "and N more". */
const shownPaths = 12;

function PathList({ paths }: { paths: string[] }) {
  const { t } = useTranslation("workspaces");
  return (
    <ul className="m-0 grid max-h-40 list-none gap-0.5 overflow-auto rounded-sm bg-inset p-2 font-mono text-2xs leading-[1.5] text-ink-2">
      {paths.slice(0, shownPaths).map((path) => (
        <li key={path} className="wrap-anywhere">
          {path}
        </li>
      ))}
      {paths.length > shownPaths ? (
        <li className="font-sans text-ink-muted">
          {t("purge.more", { count: paths.length - shownPaths })}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Deleting the old copy a complete move left on the source device: first
 * what would be removed and what changed after the move (kept unless the
 * person ticks the box), then the deletion and what it did.
 */
export function WorkspacePurgeDialog({
  workspace,
  migration,
  sourceLabel,
  onClose,
  onDone,
  returnFocusTo,
}: {
  workspace: WorkspaceProjection;
  migration: WorkspaceMigrationSummary;
  sourceLabel: string;
  onClose: () => void;
  /** After a deletion the server answered. */
  onDone?: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation(["workspaces", "common"]);
  const [preview, setPreview] = useState<WorkspaceMigrationPurgePreview>();
  const [result, setResult] = useState<WorkspaceMigrationPurgePreview>();
  const [includeChanged, setIncludeChanged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const names = {
    device: sourceLabel,
    target: migration.targetDeviceLabel,
    name: workspace.name,
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    purgeWorkspaceMigrationSource(workspace.id, migration.id, {
      confirm: false,
    })
      .then((answer) => {
        if (!cancelled) setPreview(answer);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause, t("purge.failed")));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id, migration.id, attempt, t]);

  async function confirm() {
    if (pending.current || !preview) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const answer = await purgeWorkspaceMigrationSource(
        workspace.id,
        migration.id,
        { confirm: true, includeChanged },
      );
      setResult(answer);
      onDone?.();
    } catch (cause) {
      setError(errorText(cause, t("purge.failed")));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const changed = preview?.changed ?? [];
  const keptCount = result?.changed.length ?? 0;
  return (
    <WorkspaceDialog
      returnFocusTo={returnFocusTo}
      title={t("purge.title", names)}
      description={t("purge.description", names)}
      busy={busy}
      onClose={onClose}
    >
      <WorkspaceForm
        aria-busy={busy || loading}
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        {result ? (
          <Alert
            tone="success"
            size="compact"
            title={t(
              result.done ? "purge.doneTitle" : "purge.keptTitle",
              names,
            )}
          >
            {t("purge.doneBytes", {
              size: migrationSize(result.bytes),
              count: result.removed.length,
            })}
            {!result.done && keptCount ? (
              <> {t("purge.keptNote", { count: keptCount })}</>
            ) : null}
          </Alert>
        ) : loading ? (
          <LoadingState label={t("purge.loading", names)} />
        ) : preview ? (
          <>
            <section className="grid gap-1.5">
              <h3 className="m-0 text-xs font-semibold text-ink">
                {t("purge.removedTitle", {
                  size: migrationSize(preview.bytes),
                })}
              </h3>
              <PathList paths={preview.removed} />
            </section>
            <section className="grid gap-1.5">
              <h3 className="m-0 text-xs font-semibold text-ink">
                {t("purge.changedTitle", { count: changed.length })}
              </h3>
              {changed.length ? (
                <>
                  <PathList paths={changed} />
                  <FieldHint className="mt-0">
                    {t("purge.changedNote", names)}
                  </FieldHint>
                  <CheckLabel>
                    <Checkbox
                      checked={includeChanged}
                      disabled={busy}
                      onChange={(event) =>
                        setIncludeChanged(event.currentTarget.checked)
                      }
                    />
                    <span>
                      {t("purge.includeChanged")}
                      <FieldHint as="small" className="mt-0">
                        {t("purge.includeChangedHint")}
                      </FieldHint>
                    </span>
                  </CheckLabel>
                </>
              ) : (
                <LocationDescription className="mt-0">
                  {t("purge.nothingChanged")}
                </LocationDescription>
              )}
            </section>
            <p className="m-0 text-xs font-medium text-error-text">
              {t("purge.irreversible", names)}
            </p>
          </>
        ) : null}
        {error ? (
          <Alert
            tone="error"
            size="compact"
            title={error}
            actions={
              !preview && !loading ? (
                <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  {t("common:actions.retry")}
                </Button>
              ) : undefined
            }
          />
        ) : null}
        <WorkspaceFormActions>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {result ? t("common:actions.close") : t("common:actions.cancel")}
          </Button>
          {!result ? (
            <Button
              variant="danger"
              type="submit"
              busy={busy}
              disabled={!preview || loading}
            >
              {busy
                ? t("purge.deleting")
                : includeChanged && changed.length
                  ? t("purge.confirmWithChanged")
                  : t("purge.confirm")}
            </Button>
          ) : null}
        </WorkspaceFormActions>
      </WorkspaceForm>
    </WorkspaceDialog>
  );
}
