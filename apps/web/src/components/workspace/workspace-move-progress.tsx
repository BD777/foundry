import { useTranslation } from "react-i18next";
import type {
  WorkspaceMigration,
  WorkspaceMigrationSummary,
} from "@bd777/foundry-protocol";
import { chatHref, foundryIdHref } from "../../lib/in-app-navigation";
import { Alert } from "../ui/alert";
import { AppLink } from "../ui/app-link";
import { Badge, type BadgeProps } from "../ui/badge";
import { Button } from "../ui/button";
import { FieldHint } from "../ui/field";
import { ConfirmButton } from "../ui/confirm-button";
import { LoadingState } from "../ui/loading";
import { ProgressMeter } from "../ui/progress-meter";
import { WorkspaceFormActions } from "./workspace-form";
import {
  migrationActive,
  migrationCancelable,
  migrationHasCounts,
  migrationProgress,
  migrationReasonKey,
  migrationStepKey,
  migrationCount,
  migrationSize,
} from "./workspace-migration";

const stateTone: Record<WorkspaceMigration["state"], BadgeProps["tone"]> = {
  preflight: "slate",
  copying: "slate",
  verifying: "slate",
  activating: "slate",
  retiring: "slate",
  complete: "online",
  canceled: "neutral",
  failed: "error",
};

const listClass =
  "m-0 grid list-none gap-1 p-0 text-xs leading-[1.5] text-ink-2 [&_code]:wrap-anywhere";

/** One move's state, progress, what holds it up and what it leaves behind. */
export function WorkspaceMoveProgress({
  migration,
  workspaceName,
  loadError,
  busy,
  canceling,
  cancelError,
  onCancel,
  onRetry,
  onChangeFolder,
  onClose,
}: {
  migration?: WorkspaceMigration;
  workspaceName: string;
  loadError: string;
  /** A new move is being started (Retry). */
  busy: boolean;
  canceling: boolean;
  cancelError: string;
  onCancel: () => void;
  onRetry: () => void;
  onChangeFolder: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["workspaces", "common"]);
  if (!migration)
    return (
      <div className="grid gap-3 text-sm">
        {loadError ? (
          <Alert tone="warning" size="compact" title={loadError} />
        ) : (
          <LoadingState label={t("common:states.loading")} />
        )}
      </div>
    );
  const names = {
    source: migration.sourceDeviceLabel,
    target: migration.targetDeviceLabel,
  };
  const active = migrationActive(migration);
  const stepKey = active ? migrationStepKey(migration.step) : undefined;
  const progress = migrationProgress(migration);
  const showCounts =
    migrationHasCounts(migration) &&
    (migration.state === "copying" || migration.state === "verifying");
  const size = migrationSize;
  const reasonKey = migrationReasonKey(migration.reasonCode);
  const waitingDevice =
    migration.waitingFor === "source_device"
      ? names.source
      : migration.waitingFor === "target_device"
        ? names.target
        : "";
  const reason = reasonKey ? t(reasonKey) : migration.reason;
  const failed = migration.state === "failed";
  const canceled = migration.state === "canceled";
  const complete = migration.state === "complete";
  const blocked = failed && migration.blockers.length > 0;
  const cancelable =
    migrationCancelable(migration) && !migration.cancelRequested;
  return (
    <div className="grid min-w-0 gap-3 text-sm" aria-busy={busy || undefined}>
      <div
        className="grid gap-2"
        role="status"
        aria-live="polite"
        aria-atomic="false"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={stateTone[migration.state]}>
            {t(`move.states.${migration.state}`)}
          </Badge>
          {stepKey ? (
            <span className="text-xs text-ink-2">{t(stepKey, names)}</span>
          ) : null}
        </div>
        {active ? (
          <>
            <ProgressMeter
              aria-label={t("move.progressLabel")}
              value={progress?.value}
              max={progress?.max}
            />
            {showCounts ? (
              <span className="text-xs text-ink-muted tabular-nums">
                {t("move.counts", {
                  files: migrationCount(migration.files),
                  totalFiles: migrationCount(migration.totalFiles),
                  bytes: size(migration.bytes),
                  totalBytes: size(migration.totalBytes),
                })}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {active && waitingDevice ? (
        <Alert
          tone="info"
          size="compact"
          title={t("move.waitingFor", { device: waitingDevice })}
        >
          {migration.reason && !reasonKey ? migration.reason : null}
        </Alert>
      ) : active && migration.reasonCode && reason ? (
        <Alert tone="info" size="compact" title={reason} />
      ) : null}
      {migration.cancelRequested && active ? (
        <Alert
          tone="info"
          size="compact"
          title={t("move.cancelRequested", names)}
        />
      ) : null}
      {failed ? (
        <Alert
          tone="error"
          size="compact"
          title={t("move.failedTitle")}
          details={reasonKey && migration.reason ? migration.reason : undefined}
          actions={
            <>
              <Button size="sm" busy={busy} onClick={onRetry}>
                {blocked ? t("move.tryAgain") : t("move.retry")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={onChangeFolder}
              >
                {t("move.changeFolder")}
              </Button>
            </>
          }
        >
          {reason} {t("move.unchangedNote", names)}
        </Alert>
      ) : null}
      {canceled ? (
        <Alert
          tone="info"
          size="compact"
          title={t("move.canceledTitle")}
          actions={
            <Button size="sm" busy={busy} onClick={onRetry}>
              {t("move.retry")}
            </Button>
          }
        >
          {t("move.unchangedNote", names)}
        </Alert>
      ) : null}
      {complete ? (
        <Alert
          tone="success"
          size="compact"
          title={t("move.completeTitle", { name: workspaceName, ...names })}
        >
          {t("move.completeNote", { path: migration.targetPath, ...names })}
        </Alert>
      ) : null}
      {migration.blockers.length ? (
        <section className="grid gap-1.5">
          <h3 className="m-0 text-xs font-semibold text-ink">
            {t("move.blockersTitle")}
          </h3>
          <ul className={listClass}>
            {migration.blockers.map((blocker) => {
              const href =
                blocker.kind === "session"
                  ? chatHref(blocker.id, migration.workspaceId)
                  : foundryIdHref(blocker.id);
              const kind = t(`move.blockerKinds.${blocker.kind}`);
              return (
                <li key={`${blocker.kind}:${blocker.id}`}>
                  <span className="text-ink-muted">{kind}: </span>
                  {href ? (
                    <AppLink
                      href={href}
                      className="text-ink underline underline-offset-2"
                    >
                      {blocker.title || blocker.id}
                    </AppLink>
                  ) : (
                    <span>{blocker.title || blocker.id}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {migration.warnings.length ? (
        <section className="grid gap-1.5">
          <h3 className="m-0 text-xs font-semibold text-ink">
            {t("move.warningsTitle", { count: migration.warnings.length })}
          </h3>
          <ul className={listClass}>
            {migration.warnings.slice(0, 20).map((warning, index) => (
              <li key={`${warning.path}:${index}`}>
                <span className="text-ink-muted">
                  {t(`move.warningKinds.${warning.kind}`)}:{" "}
                </span>
                <code>{warning.path}</code>
                {warning.detail ? (
                  <span className="text-ink-muted"> · {warning.detail}</span>
                ) : null}
              </li>
            ))}
            {migration.warnings.length > 20 ? (
              <li className="text-ink-muted">
                {t("purge.more", { count: migration.warnings.length - 20 })}
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
      {migration.notCarried.length ? (
        <section className="grid gap-1.5">
          <h3 className="m-0 text-xs font-semibold text-ink">
            {t("move.notCarriedTitle", { device: names.target })}
          </h3>
          <ul className={listClass}>
            {migration.notCarried.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <span className="text-ink-muted">
                  {t(`move.notCarriedKinds.${item.kind}`)}:{" "}
                </span>
                {item.label || item.id}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {active && migration.state === "activating" ? (
        <p className="m-0 text-xs text-ink-muted">
          {t("move.cancelLocked", names)}
        </p>
      ) : null}
      {loadError ? (
        <Alert tone="warning" size="compact" title={loadError} />
      ) : null}
      {cancelError ? (
        <Alert tone="error" size="compact" title={cancelError} />
      ) : null}
      {active ? (
        <FieldHint className="mt-0">{t("move.backgroundNote")}</FieldHint>
      ) : null}
      <WorkspaceFormActions>
        {cancelable ? (
          <ConfirmButton
            variant="danger"
            busy={canceling}
            confirmLabel={t("move.cancelConfirm")}
            onConfirm={onCancel}
          >
            {t("move.cancel")}
          </ConfirmButton>
        ) : null}
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {t("common:actions.close")}
        </Button>
      </WorkspaceFormActions>
    </div>
  );
}

/**
 * A move under way in a line: its state and step, how far the copy got,
 * and the device it waits for. For the workspace row and overview.
 */
export function WorkspaceMoveSummary({
  migration,
  sourceLabel,
  id,
}: {
  migration: WorkspaceMigrationSummary;
  sourceLabel: string;
  id?: string;
}) {
  const { t } = useTranslation("workspaces");
  const names = { source: sourceLabel, target: migration.targetDeviceLabel };
  const stepKey = migrationStepKey(migration.step);
  const progress = migrationProgress(migration);
  const waiting =
    migration.waitingFor === "source_device"
      ? names.source
      : migration.waitingFor === "target_device"
        ? names.target
        : "";
  return (
    <span id={id} className="fdy-move-summary grid min-w-0 gap-1">
      <span className="text-2xs leading-normal text-ink-2 [overflow-wrap:anywhere]">
        {t(`move.states.${migration.state}`)}
        {stepKey ? ` · ${t(stepKey, names)}` : ""}
        {migrationHasCounts(migration) &&
        (migration.state === "copying" || migration.state === "verifying")
          ? ` · ${t("move.counts", {
              files: migrationCount(migration.files ?? 0),
              totalFiles: migrationCount(migration.totalFiles ?? 0),
              bytes: migrationSize(migration.bytes ?? 0),
              totalBytes: migrationSize(migration.totalBytes ?? 0),
            })}`
          : ""}
      </span>
      <ProgressMeter
        className="max-w-80"
        aria-label={t("move.progressLabel")}
        value={progress?.value}
        max={progress?.max}
      />
      {waiting ? (
        <span className="text-2xs leading-normal text-warning-text">
          {t("move.waitingFor", { device: waiting })}
        </span>
      ) : null}
    </span>
  );
}
