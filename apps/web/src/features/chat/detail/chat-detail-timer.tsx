import { Alert } from "../../../components/ui/alert";
import type { AgentScheduledTask } from "@bd777/foundry-protocol";
import { CircleAlert, Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MarkdownContent } from "../../../components/conversation/markdown-content";
import { i18n } from "../../../i18n";
import {
  timerNextRun,
  timerRunContextFull,
} from "../context/chat-schedule-model";
import type { ChatTimerItem } from "../chat-types";
import {
  MetaDetail,
  MetaHeading,
  MetaList,
  MetaPre,
  MetaRow,
} from "./chat-detail-parts";

export function formatTimerDateTime(iso?: string): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString(i18n.language, { hour12: false });
}

/** Each run by when it fired, with its answer once it ended. */
function TimerFireHistory({
  fires,
  running,
}: {
  fires: ChatTimerItem["fires"];
  running?: ChatTimerItem["running"];
}) {
  const { t } = useTranslation("chat");
  if (fires.length === 0) {
    return <Alert size="compact" title={t("detail.timer.noFires")} />;
  }
  return (
    <div className="grid gap-2">
      <MetaHeading>
        {t("detail.timer.fireHistory", { count: fires.length })}
      </MetaHeading>
      {fires.map((fire, index) => (
        <details
          className="fdy-chat-timer-fire rounded-lg border border-line-soft px-3 py-2 open:[&>summary]:mb-2 [&_p]:text-xs [&_p]:leading-[1.6]"
          key={`${fire.startedAt ?? fire.completedAt}-${index}`}
          open={index === 0}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-ink [&::-webkit-details-marker]:hidden">
            {fire.failed ? (
              <CircleAlert aria-hidden="true" size={13} />
            ) : (
              <Clock aria-hidden="true" size={13} />
            )}
            {t(fire.failed ? "detail.timer.failedAt" : "detail.timer.firedAt", {
              time: formatTimerDateTime(fire.startedAt || fire.completedAt),
            })}
          </summary>
          {timerRunContextFull(fire) ? (
            <Alert
              className="mb-2"
              size="compact"
              title={t("detail.timer.contextFull")}
              tone="warning"
            >
              {t("detail.timer.contextFullFix")}
            </Alert>
          ) : null}
          {fire.response ? (
            <div className="fdy-markdown text-xs leading-[1.6]">
              <MarkdownContent>{fire.response}</MarkdownContent>
            </div>
          ) : (
            <Alert
              size="compact"
              title={
                fire === running
                  ? t("detail.timer.fireRunning")
                  : fire.answerUnloaded
                    ? t("detail.timer.fireTextUnloaded")
                    : t("detail.timer.noFireText")
              }
            />
          )}
        </details>
      ))}
    </div>
  );
}

function TimerNextRun({ item }: { item: ChatTimerItem }) {
  const { t } = useTranslation("chat");
  const scheduled = item.scheduled;
  if (!scheduled) return <>{t("detail.timer.inactive")}</>;
  if (item.running) {
    return (
      <>
        {item.running.startedAt
          ? t("detail.timer.runningSince", {
              time: formatTimerDateTime(item.running.startedAt),
            })
          : t("detail.timer.running")}
      </>
    );
  }
  // Recomputed on each render, from its last wake: the reported next fire
  // goes stale within a cycle.
  const next = timerNextRun(scheduled, item.wake, item.busy);
  if (next.due)
    return <>{t(item.busy ? "detail.timer.due" : "detail.timer.dueNow")}</>;
  return (
    <>{formatTimerDateTime(next.at?.toISOString() ?? scheduled.nextFireAt)}</>
  );
}

export function TimerDetail({ item }: { item: ChatTimerItem }) {
  const task: AgentScheduledTask = item.task;
  const { t } = useTranslation("chat");
  return (
    <MetaDetail>
      <MetaList>
        <MetaRow label={t("detail.timer.type")}>
          {task.recurring
            ? t("detail.timer.recurring")
            : t("detail.timer.oneShot")}
        </MetaRow>
        <MetaRow label={t("detail.timer.nextFire")}>
          <TimerNextRun item={item} />
        </MetaRow>
        <MetaRow label={t("detail.timer.cron")}>
          <code>{task.schedule}</code>
        </MetaRow>
      </MetaList>
      <MetaHeading>{t("detail.timer.prompt")}</MetaHeading>
      <MetaPre>{task.prompt}</MetaPre>
      <TimerFireHistory fires={item.fires} running={item.running} />
    </MetaDetail>
  );
}
