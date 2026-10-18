import { useState } from "react";
import { Bot, ChevronDown, ChevronRight, Clock, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isStandaloneWork,
  hasFutureScheduledWork,
  type SessionWork,
  type WorkAction,
} from "@bd777/foundry-protocol";
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
  const pending = needsConfirmation(item);
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
  const actions = canControl ? workActions(item) : [];
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
  const Icon =
    item.kind === "schedule" ? Clock : item.kind === "agent" ? Bot : Terminal;
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
      <Button
        variant="ghost"
        className="fdy-chat-context-row"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon aria-hidden="true" size={16} />
        <span className="fdy-chat-context-row-copy">
          <strong>{item.title}</strong>
          <em>
            {t(`work.source.${item.source}`)} · {t(`work.kind.${item.kind}`)}
          </em>
        </span>
        <span className="fdy-chat-context-status">
          {item.management === "observed"
            ? t("work.unassignedStatus")
            : pending
              ? t("work.pending")
              : item.desiredState === "paused"
                ? t("work.paused")
                : item.desiredState === "stopped"
                  ? t("work.stopped")
                  : hasFutureScheduledWork(item) &&
                      ["completed", "failed", "stopped"].includes(
                        item.observation.status,
                      )
                    ? t(
                        `work.runStatus.${item.observation.status as "completed" | "failed" | "stopped"}`,
                      )
                    : t(`work.status.${item.observation.status}`)}
        </span>
        {expanded ? (
          <ChevronDown aria-hidden="true" size={14} />
        ) : (
          <ChevronRight aria-hidden="true" size={14} />
        )}
      </Button>
      {item.observation.nextFireAt && item.desiredState === "enabled" ? (
        <p className="fdy-chat-work-note">
          {t("work.next", { time: at(item.observation.nextFireAt) })}
        </p>
      ) : null}
      {item.desiredState === "paused" &&
      item.observation.status === "running" ? (
        <p className="fdy-chat-work-note">{t("work.currentContinues")}</p>
      ) : null}
      {item.management === "observed" ? (
        <p className="fdy-chat-work-note">{t("work.unattributed")}</p>
      ) : null}
      {actions.length ? (
        <div
          className="fdy-chat-work-actions"
          aria-busy={controller.busy === item.id}
        >
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant="secondary"
              aria-label={t("work.actionFor", {
                action: label(action),
                title: item.title,
              })}
              disabled={Boolean(controller.busy)}
              onClick={() => void controller.control(action, item)}
            >
              {label(action)}
            </Button>
          ))}
        </div>
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
    (item) => isCurrentWork(item) && workActions(item).includes("stop"),
  );
  const knownWorkEnded = items.length > 0 && items.every(isFinishedWork);
  const pending = items.filter(needsConfirmation).length;
  const lastOperation = list.operations?.[0];
  const unresolvedOperation =
    lastOperation && lastOperation.state !== "verified";
  if (!items.length && !controller.error && !unresolvedOperation) return null;
  const unassigned = items.filter((w) => w.management === "observed");
  return (
    <section
      className="fdy-chat-context-section fdy-chat-work"
      aria-label={t("work.title")}
    >
      {items.some((item) => !isFinishedWork(item)) ||
      controller.error ||
      (!items.length && unresolvedOperation) ? (
        <h3>{t("work.title")}</h3>
      ) : null}
      {canControl && stoppable.length > 1 ? (
        <>
          <div className="fdy-chat-work-actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={Boolean(controller.busy)}
              onClick={() => void controller.control("stop_all")}
            >
              {controller.busy === "stop_all"
                ? t("work.applying")
                : t("work.stopAll", { count: stoppable.length })}
            </Button>
          </div>
          <p className="fdy-chat-work-note">{t("work.stopAllScope")}</p>
        </>
      ) : null}
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
            w.kind === kind && w.management === "managed" && !isFinishedWork(w),
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
