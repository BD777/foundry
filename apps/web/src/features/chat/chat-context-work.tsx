import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  hasFutureScheduledWork,
  type SessionWork,
  type WorkAction,
} from "@bd777/foundry-protocol";
import { WorkspaceServicesDialog } from "../../components/workspace/workspace-services";
import { RowMenu } from "../../components/ui/row-menu";
import { WorkStatusIcon } from "../../components/work/work-status-icon";
import { chatHref, navigateToChat } from "../../lib/in-app-navigation";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import type { SessionWorkController } from "./use-session-work";
import { FinishedFold } from "./chat-context-folds";
import {
  needsConfirmation,
  isFinishedWork,
  workActions,
  isSidebarWork,
} from "./chat-work-state";

function WorkRow({
  item,
  controller,
  canControl,
  onInspect,
}: {
  item: SessionWork;
  controller: SessionWorkController;
  canControl: boolean;
  onInspect?: (item: SessionWork) => (() => void) | undefined;
}) {
  const { t, i18n } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const pending = needsConfirmation(item);
  const childSession =
    item.kind === "agent" && item.source === "foundry" && item.sourceId;
  const unassigned = item.management === "observed" && !item.native;
  const waitingAgain =
    hasFutureScheduledWork(item) &&
    ["completed", "failed", "stopped"].includes(item.observation.status);
  const status = unassigned
    ? "unknown"
    : pending
      ? "pending"
      : item.management === "managed" && item.desiredState === "paused"
        ? "paused"
        : item.management === "managed" && item.desiredState === "stopped"
          ? "stopped"
          : waitingAgain
            ? "idle"
            : item.observation.status;
  const statusLabel = unassigned
    ? t("work.unassignedStatus")
    : status === "pending"
      ? t("work.pending")
      : status === "paused"
        ? t("work.paused")
        : waitingAgain
          ? `${t("work.status.idle")} · ${t(`work.runStatus.${item.observation.status as "completed" | "failed" | "stopped"}`)}`
          : t(`work.status.${item.observation.status}`);
  const scheduler = controller.list?.coverage.scheduler;
  const error =
    item.observation.error &&
    item.observation.error === controller.list?.coverage.schedulerError &&
    (scheduler === "not_observed" || scheduler === "stale")
      ? t(
          scheduler === "stale"
            ? "work.schedulerStale"
            : "work.schedulerMissing",
        )
      : item.observation.error;
  const inspect = onInspect?.(item);
  const sharedCount =
    item.sharedSessionCount ?? item.relatedSessionIds?.length ?? 0;
  const shared = sharedCount > 0;
  const actions = canControl ? workActions(item) : [];
  if (
    canControl &&
    controller.sessionId &&
    item.relatedSessionIds?.includes(controller.sessionId)
  )
    actions.push("unlink");
  const label = (action: WorkAction) =>
    (action === "resume" && item.kind === "process" && isFinishedWork(item)) ||
    (action === "run" && isFinishedWork(item))
      ? t("work.restart")
      : action === "pause" && item.kind === "process"
        ? t("work.suspend")
        : action === "adopt" && item.source === "launchd"
          ? t("work.adoptStop")
          : t(`work.action.${action}`);
  const coverageLabel = (value: string) => {
    const states = [
      "unverified",
      "observed",
      "partial",
      "managed_and_native",
      "managed_native_and_attributed",
    ] as const;
    const state = states.find((state) => state === value) || "not_observed";
    return t(`work.coverageState.${state}`);
  };
  const kindLabel =
    item.kind === "agent"
      ? t(childSession ? "work.childSession" : "work.nativeAgent")
      : t(
          item.kind === "process" && item.source === "foundry"
            ? "work.service"
            : `work.kind.${item.kind}`,
        );
  const sourceLabel = childSession
    ? t("work.childSessionSource")
    : item.native
      ? t("work.nativeSource", { source: t(`work.source.${item.source}`) })
      : item.source === "claude" && item.kind === "schedule"
        ? t("work.migratedSchedule")
        : item.source === "foundry" && item.kind === "process"
          ? t("work.serviceSource")
          : t(`work.source.${item.source}`);
  const rowCopy = (
    <span className="fdy-chat-work-copy">
      <strong>{item.title}</strong>{" "}
      <span className="fdy-chat-work-source">
        {sourceLabel}
        {!childSession ? (
          expanded ? (
            <ChevronDown aria-hidden="true" size={12} />
          ) : (
            <ChevronRight aria-hidden="true" size={12} />
          )
        ) : null}
      </span>
    </span>
  );
  const at = (value: string) =>
    new Date(value).toLocaleString(i18n.language, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return (
    <div className="fdy-chat-work-row" data-work-id={item.id}>
      <div className="fdy-chat-work-heading">
        <WorkStatusIcon
          kind={item.kind}
          status={status}
          label={`${kindLabel} · ${statusLabel}`}
        />
        {childSession ? (
          <Button asChild variant="bare" className="fdy-chat-work-open">
            <a
              title={item.title}
              href={chatHref(childSession, item.workspaceId)}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                navigateToChat(childSession, item.workspaceId);
              }}
            >
              {rowCopy}
            </a>
          </Button>
        ) : (
          <Button
            variant="bare"
            className="fdy-chat-work-open"
            title={item.title}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {rowCopy}
          </Button>
        )}
        <RowMenu
          label={t("work.actionsFor", { title: item.title })}
          disabled={Boolean(controller.busy)}
          items={actions.map((action) => ({
            key: action,
            label: label(action),
            onSelect: () => void controller.control(action, item),
            ...(shared && ["stop", "pause", "resume"].includes(action)
              ? {
                  confirm: {
                    title: t("work.sharedActionTitle", {
                      action: label(action),
                    }),
                    body: t("work.sharedActionBody", {
                      count: sharedCount + 1,
                    }),
                    action: label(action),
                  },
                }
              : {}),
          }))}
        />
      </div>
      {item.kind === "process" && item.source === "foundry" ? (
        <Button
          size="sm"
          variant="link"
          className="fdy-chat-work-service-link"
          onClick={() => setServicesOpen(true)}
        >
          {t("work.manageWorkspaceService")}
        </Button>
      ) : null}
      {servicesOpen ? (
        <WorkspaceServicesDialog
          workspaceId={item.workspaceId}
          canControl={canControl}
          onClose={() => setServicesOpen(false)}
        />
      ) : null}
      {shared ? (
        <p className="fdy-chat-work-note">
          {t("work.sharedService", { count: sharedCount + 1 })}{" "}
          <Button
            size="inline"
            variant="link"
            onClick={() => navigateToChat(item.sessionId, item.workspaceId)}
          >
            {t("work.serviceOwner")}
          </Button>
        </p>
      ) : null}
      {item.observation.nextFireAt && item.desiredState === "enabled" ? (
        <p className="fdy-chat-work-note">
          {t("work.next", { time: at(item.observation.nextFireAt) })}
        </p>
      ) : null}
      {item.desiredState === "paused" &&
      item.observation.status === "running" ? (
        <p className="fdy-chat-work-note">{t("work.currentContinues")}</p>
      ) : null}
      {unassigned ? (
        <p className="fdy-chat-work-note">{t("work.unattributed")}</p>
      ) : null}
      {controller.busy === item.id ? (
        <p className="fdy-chat-work-note" role="status">
          {t("work.applying")}
        </p>
      ) : null}
      {error ? (
        <p className="fdy-chat-work-error" role="status">
          {error}
        </p>
      ) : null}
      {expanded && inspect ? (
        <Button size="sm" variant="link" onClick={inspect}>
          {t("work.inspect")}
        </Button>
      ) : null}
      {expanded ? (
        <dl className="fdy-chat-work-details">
          <dt>{t("work.taskTitle")}</dt>
          <dd>{item.title}</dd>
          <dt>{t("work.created")}</dt>
          <dd>{at(item.createdAt)}</dd>
          <dt>{t("work.observed")}</dt>
          <dd>{at(item.observation.at)}</dd>
          <dt>{t("work.actual")}</dt>
          <dd>{t(`work.status.${item.observation.status}`)}</dd>
          {item.kind === "schedule" ? (
            <>
              <dt>{t("work.schedule")}</dt>
              <dd>
                {item.spec.schedule || (item.spec.at ? at(item.spec.at) : "—")}
                {item.spec.timeZone ? ` · ${item.spec.timeZone}` : ""}
              </dd>
            </>
          ) : null}
          {item.spec.prompt ? (
            <>
              <dt>{t("work.prompt")}</dt>
              <dd>
                <pre>{item.spec.prompt}</pre>
              </dd>
            </>
          ) : null}
          <dt>{t("work.discovery")}</dt>
          <dd>
            {t("work.coverage", {
              schedules: coverageLabel(
                controller.list?.coverage.hostSchedules || "not_observed",
              ),
              processes: coverageLabel(
                controller.list?.coverage.processes || "not_observed",
              ),
            })}
          </dd>
          {item.native ? (
            <>
              <dt>{t("work.nativeVersion")}</dt>
              <dd>
                {item.native.runtime} {item.native.version}
              </dd>
              <dt>{t("work.nativeDiscovery")}</dt>
              <dd>{item.native.discovery}</dd>
              {item.native.lastRun ? (
                <>
                  <dt>{t("work.nativeRun")}</dt>
                  <dd>
                    {t(`work.status.${item.native.lastRun.status}`)} ·{" "}
                    {at(item.native.lastRun.startedAt)}
                    {item.native.lastRun.endedAt
                      ? ` → ${at(item.native.lastRun.endedAt)}`
                      : ""}
                  </dd>
                </>
              ) : null}
              <dt>{t("work.nativeControls")}</dt>
              <dd>
                {(["stop", "pause", "resume"] as const)
                  .map(
                    (action) =>
                      `${t(`work.action.${action}`)}: ${t(`work.capability.${item.native!.controls[action]}`)}`,
                  )
                  .join(" · ")}
              </dd>
              <dt>{t("work.nativeIdentity")}</dt>
              <dd>
                <code>{item.native.taskId}</code>
              </dd>
            </>
          ) : null}
          {item.relatedSessionIds?.length ? (
            <>
              <dt>{t("work.relatedSessions")}</dt>
              <dd className="fdy-work-session-links">
                {(
                  item.relatedSessions ??
                  item.relatedSessionIds.map((id) => ({
                    id,
                    title: id,
                    workspaceId: "",
                  }))
                ).map((ref) => (
                  <Button
                    key={ref.id}
                    size="sm"
                    variant="link"
                    onClick={() =>
                      navigateToChat(ref.id, ref.workspaceId || undefined)
                    }
                  >
                    {ref.title}
                  </Button>
                ))}
              </dd>
            </>
          ) : null}
          <dt>{t("work.identity")}</dt>
          <dd>
            <code>{item.id}</code>
          </dd>
        </dl>
      ) : null}
    </div>
  );
}
function WorkInventoryError({
  controller,
  canControl,
}: {
  controller: SessionWorkController;
  canControl: boolean;
}) {
  const { t } = useTranslation("chat");
  const retryControl = Boolean(controller.controlError && canControl);
  return (
    <Alert
      tone="error"
      title={t(
        controller.controlError ? "work.controlFailed" : "work.loadFailed",
      )}
    >
      {controller.error}{" "}
      <Button
        size="inline"
        variant="link"
        disabled={Boolean(controller.busy)}
        onClick={() =>
          void (retryControl ? controller.retryControl() : controller.refresh())
        }
      >
        {t(retryControl ? "work.retryControl" : "work.refresh")}
      </Button>
    </Alert>
  );
}

function WorkInventoryRetrying() {
  const { t } = useTranslation("chat");
  return (
    <Alert tone="info" size="compact" title={t("work.retryingTitle")}>
      {t("work.retrying")}
    </Alert>
  );
}

type WorkSectionProps = {
  controller: SessionWorkController;
  canControl: boolean;
  onInspect?: (item: SessionWork) => (() => void) | undefined;
};

function WorkKindSection({
  kind,
  controller,
  canControl,
  onInspect,
}: WorkSectionProps & {
  kind: "schedule" | "agent";
}) {
  const { t } = useTranslation("chat");
  const list = controller.list!;
  const items = list.items.filter(
    (item) => isSidebarWork(item) && item.kind === kind,
  );
  const ended = items.filter(isFinishedWork);
  const current = items.filter((item) => !isFinishedWork(item));
  const unassigned = current.filter(
    (item) => item.management === "observed" && !item.native,
  );
  const ids = new Set(items.map((item) => item.id));
  // Global receipts may contain hidden processes. Only project receipts whose
  // complete target set belongs to this section; never change the inventory.
  const lastOperation = list.operations?.find(
    (op) => op.items.length > 0 && op.items.every((item) => ids.has(item.id)),
  );
  const unresolved = lastOperation && lastOperation.state !== "verified";
  const error = controller.controlError
    ? ids.has(controller.controlTargetId ?? "")
    : kind === "schedule" && Boolean(controller.error);
  const retrying = kind === "schedule" && controller.retrying && !error;
  if (!items.length && !error && !retrying) return null;
  const pending = items.filter(needsConfirmation).length;
  const title = t(kind === "schedule" ? "work.title" : "work.agentsTitle");
  const row = (item: SessionWork) => (
    <WorkRow
      key={item.id}
      item={item}
      controller={controller}
      canControl={canControl}
      onInspect={onInspect}
    />
  );
  return (
    <section
      className="fdy-chat-context-section fdy-chat-work"
      aria-label={title}
      data-work-kind={kind}
    >
      <div className="fdy-chat-work-header">
        <h3>{title}</h3>
      </div>
      {unresolved ? (
        <p className="fdy-chat-work-note" role="status">
          {t("work.receipt", {
            state: t(`work.receiptState.${lastOperation.state}`),
          })}
        </p>
      ) : null}
      {list.barrier && current.some((item) => item.management === "managed") ? (
        <p className="fdy-chat-work-note">{t("work.barrier")}</p>
      ) : null}
      {pending ? (
        <p className="fdy-chat-work-note" role="status">
          {t("work.pendingCount", { count: pending })}
        </p>
      ) : null}
      {error ? (
        <WorkInventoryError controller={controller} canControl={canControl} />
      ) : null}
      {retrying ? <WorkInventoryRetrying /> : null}
      {current.filter((item) => !unassigned.includes(item)).map(row)}
      {unassigned.length ? (
        <div className="fdy-chat-work-group">
          <h4>{t("work.unassigned", { count: unassigned.length })}</h4>
          {unassigned.map(row)}
        </div>
      ) : null}
      {ended.length ? (
        <FinishedFold
          appearance="plain"
          label={t(
            kind === "schedule" ? "work.timerHistory" : "work.agentHistory",
            { count: ended.length },
          )}
          memoryKey={`${controller.sessionId || items[0]?.threadId || "work"}:${kind}-history`}
        >
          {ended.map(row)}
        </FinishedFold>
      ) : null}
    </section>
  );
}

/** Timers and agents have independent histories; commands/services stay elsewhere. */
export function SessionWorkSection(props: WorkSectionProps) {
  if (!props.controller.list)
    return props.controller.error ? (
      <section className="fdy-chat-context-section">
        <WorkInventoryError
          controller={props.controller}
          canControl={props.canControl}
        />
      </section>
    ) : props.controller.retrying ? (
      <section className="fdy-chat-context-section">
        <WorkInventoryRetrying />
      </section>
    ) : null;
  return (
    <>
      <WorkKindSection {...props} kind="schedule" />
      <WorkKindSection {...props} kind="agent" />
    </>
  );
}
