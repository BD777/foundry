import { FieldHint } from "../../components/ui/field";
import type { AgentScheduledTask } from "@bd777/foundry-protocol";
import { CircleAlert, Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MarkdownContent } from "../../components/conversation/markdown-content";
import { i18n } from "../../i18n";
import { timerNextRun, timerRunContextFull } from "./chat-schedule-model";
import type { ChatTimerItem } from "./chat-types";

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
    return <p className="fdy-chat-detail-note">{t("detail.timer.noFires")}</p>;
  }
  return (
    <div className="fdy-chat-timer-fires">
      <h4>{t("detail.timer.fireHistory", { count: fires.length })}</h4>
      {fires.map((fire, index) => (
        <details
          className="fdy-chat-timer-fire"
          key={`${fire.startedAt ?? fire.completedAt}-${index}`}
          open={index === 0}
        >
          <summary>
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
            <FieldHint>{t("detail.timer.contextFullHint")}</FieldHint>
          ) : null}
          {fire.response ? (
            <div className="fdy-chat-timer-fire-response fdy-markdown">
              <MarkdownContent>{fire.response}</MarkdownContent>
            </div>
          ) : (
            <p className="fdy-chat-detail-note">
              {fire === running
                ? t("detail.timer.fireRunning")
                : fire.answerUnloaded
                  ? t("detail.timer.fireTextUnloaded")
                  : t("detail.timer.noFireText")}
            </p>
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
    <article className="fdy-chat-meta-detail">
      <dl className="fdy-chat-meta-list">
        <div>
          <dt>{t("detail.timer.type")}</dt>
          <dd>
            {task.recurring
              ? t("detail.timer.recurring")
              : t("detail.timer.oneShot")}
          </dd>
        </div>
        <div>
          <dt>{t("detail.timer.nextFire")}</dt>
          <dd>
            <TimerNextRun item={item} />
          </dd>
        </div>
        <div>
          <dt>{t("detail.timer.cron")}</dt>
          <dd>
            <code>{task.schedule}</code>
          </dd>
        </div>
      </dl>
      <h4>{t("detail.timer.prompt")}</h4>
      <pre className="fdy-chat-meta-pre">{task.prompt}</pre>
      <TimerFireHistory fires={item.fires} running={item.running} />
    </article>
  );
}
