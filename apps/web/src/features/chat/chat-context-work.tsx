import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isStandaloneWork,
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
  isCurrentWork,
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
          {t("work.sharedService", { count: sharedCount + 1 })}
          <Button
            size="sm"
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
              <dd>
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
export function SessionWorkSection({
  controller,
  canControl,
  onInspect,
}: {
  controller: SessionWorkController;
  canControl: boolean;
  onInspect?: (item: SessionWork) => (() => void) | undefined;
}) {
  const { t } = useTranslation("chat");
  const list = controller.list;
  if (!list)
    return controller.error ? (
      <section className="fdy-chat-context-section">
        <Alert tone="error" title={t("work.loadFailed")}>
          {controller.error}
          <Button
            size="sm"
            variant="link"
            onClick={() => void controller.refresh()}
          >
            {t("work.refresh")}
          </Button>
        </Alert>
      </section>
    ) : null;
  const items = list.items.filter(
    (w) => w.desiredState !== "removed" && isStandaloneWork(w),
  );
  const ended = items.filter(isFinishedWork);
  const stoppable = items.filter(
    (item) =>
      isCurrentWork(item) &&
      !(item.sharedSessionCount || item.relatedSessionIds?.length) &&
      workActions(item).includes("stop"),
  );
  const knownWorkEnded = items.length > 0 && items.every(isFinishedWork);
  const pending = items.filter(needsConfirmation).length;
  const lastOperation = list.operations?.[0];
  const unresolvedOperation =
    lastOperation && lastOperation.state !== "verified";
  if (!items.length && !controller.error && !unresolvedOperation) return null;
  const unassigned = items.filter(
    (w) => w.management === "observed" && !w.native,
  );
  return (
    <section
      className="fdy-chat-context-section fdy-chat-work"
      aria-label={t("work.title")}
    >
      <div className="fdy-chat-work-header">
        <h3>{t("work.title")}</h3>
        {canControl && stoppable.length > 1 ? (
          <RowMenu
            label={t("work.actions")}
            disabled={Boolean(controller.busy)}
            items={[
              {
                key: "stop_all",
                label: t("work.stopAll", { count: stoppable.length }),
                onSelect: () => void controller.control("stop_all"),
                confirm: {
                  title: t("work.stopAll", { count: stoppable.length }),
                  body: t("work.stopAllScope"),
                  action: t("work.action.stop"),
                },
              },
            ]}
          />
        ) : null}
      </div>
      {unresolvedOperation ? (
        <p className="fdy-chat-work-note" role="status">
          {knownWorkEnded &&
          lastOperation.action === "stop_all" &&
          lastOperation.state === "pending"
            ? t("work.discoveryPending")
            : t("work.receipt", {
                state: t(`work.receiptState.${lastOperation.state}`),
              })}
          {lastOperation.unmanaged
            ? t("work.unmanaged", { count: lastOperation.unmanaged })
            : null}
        </p>
      ) : null}
      {list.barrier &&
      items.some(
        (item) => item.management === "managed" && !isFinishedWork(item),
      ) ? (
        <p className="fdy-chat-work-note">{t("work.barrier")}</p>
      ) : null}
      {pending ? (
        <p className="fdy-chat-work-note" role="status">
          {t("work.pendingCount", { count: pending })}
        </p>
      ) : null}
      {controller.error ? (
        <Alert
          tone="error"
          title={t(
            controller.controlError ? "work.controlFailed" : "work.loadFailed",
          )}
        >
          {controller.error}
          <Button
            size="sm"
            variant="link"
            disabled={Boolean(controller.busy)}
            onClick={() =>
              void (controller.controlError
                ? controller.retryControl()
                : controller.refresh())
            }
          >
            {t(controller.controlError ? "work.retryControl" : "work.refresh")}
          </Button>
        </Alert>
      ) : null}
      {(["schedule", "process", "agent"] as const).map((kind) => {
        const group = items.filter(
          (w) =>
            w.kind === kind &&
            (w.management === "managed" || Boolean(w.native)) &&
            !isFinishedWork(w),
        );
        return group.length ? (
          <div key={kind} className="fdy-chat-work-group">
            <h4>{t(`work.group.${kind}`, { count: group.length })}</h4>
            {group.map((item) => (
              <WorkRow
                key={item.id}
                item={item}
                controller={controller}
                canControl={canControl}
                onInspect={onInspect}
              />
            ))}
          </div>
        ) : null;
      })}
      {unassigned.length ? (
        <div className="fdy-chat-work-group">
          <h4>{t("work.unassigned", { count: unassigned.length })}</h4>
          {unassigned.map((item) => (
            <WorkRow
              key={item.id}
              item={item}
              controller={controller}
              canControl={canControl}
              onInspect={onInspect}
            />
          ))}
        </div>
      ) : null}
      {ended.length ? (
        <FinishedFold
          appearance="plain"
          label={t("work.history", { count: ended.length })}
          memoryKey={items[0] && `${items[0].threadId}:work-history`}
        >
          {ended.map((item) => (
            <WorkRow
              key={item.id}
              item={item}
              controller={controller}
              canControl={canControl}
              onInspect={onInspect}
            />
          ))}
        </FinishedFold>
      ) : null}
    </section>
  );
}
