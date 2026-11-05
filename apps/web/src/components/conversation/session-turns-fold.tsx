import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n";
import { Button } from "../ui/button";
import { TraceChevron } from "../ui/trace";
import type { SessionTurnsFold } from "./conversation-types";

const SENDERS_SHOWN = 3;

function validTime(at?: string): Date | undefined {
  const time = at ? new Date(at) : undefined;
  return time && !Number.isNaN(time.getTime()) ? time : undefined;
}

/** "13:12–13:46", or with the dates when the turns span days. */
function timeRange(firstAt?: string, lastAt?: string): string {
  const first = validTime(firstAt);
  const last = validTime(lastAt) ?? first;
  if (!first || !last) return "";
  const sameDay = first.toDateString() === last.toDateString();
  const today = first.toDateString() === new Date().toDateString();
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(sameDay && today ? {} : { month: "2-digit", day: "2-digit" }),
  };
  const start = first.toLocaleString(i18n.language, options);
  const end = last.toLocaleString(
    i18n.language,
    sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : options,
  );
  return start === end ? start : `${start}–${end}`;
}

/** The fold's title: who started its turns, in words. */
function foldSummary(
  fold: SessionTurnsFold,
  t: ReturnType<typeof useTranslation<"conversation">>["t"],
): string {
  const { session, scheduled, background } = fold.origins;
  if (session === fold.turnCount)
    return t("sessionTurns.summary", { count: fold.turnCount });
  const parts = [
    session ? t("sessionTurns.fromSessions", { count: session }) : "",
    scheduled ? t("sessionTurns.fromTimers", { count: scheduled }) : "",
    background ? t("sessionTurns.afterBackground", { count: background }) : "",
  ].filter(Boolean);
  return `${t("sessionTurns.notYours", { count: fold.turnCount })} · ${parts.join(t("sessionTurns.separator"))}`;
}

/**
 * The row that stands for turns the person did not start: how many, who
 * started them (other sessions, timers, background work), when. It opens and
 * closes them; the sessions it names open.
 */
export function SessionTurnsFoldRow({
  fold,
  onToggle,
}: {
  fold: SessionTurnsFold;
  /** Opens or closes the fold; its trigger tells where the row is. */
  onToggle: (trigger: HTMLElement) => void;
}) {
  const { t } = useTranslation("conversation");
  const shown = fold.senders.slice(0, SENDERS_SHOWN);
  const more = fold.senders.length - shown.length;
  const range = timeRange(fold.firstAt, fold.lastAt);
  return (
    <section
      className="fdy-chat-session-turns flex min-h-8 w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-ink-muted"
      data-open={fold.expanded ? "true" : "false"}
    >
      <Button
        aria-expanded={fold.expanded}
        className="group/trace inline-flex min-h-8 max-w-full items-center justify-start gap-2 rounded-lg bg-transparent px-0 py-[5px] text-sm leading-none font-[650] text-ink-muted hover:bg-transparent hover:text-ink [&_svg]:flex-none"
        onClick={(event) => onToggle(event.currentTarget)}
        title={fold.expanded ? t("sessionTurns.hide") : t("sessionTurns.show")}
        variant="ghost"
      >
        <TraceChevron />
        <span className="min-w-0 truncate">{foldSummary(fold, t)}</span>
        {range ? (
          <time
            className="flex-none text-xs font-normal text-ink-faint tabular-nums"
            dateTime={fold.firstAt}
          >
            {range}
          </time>
        ) : null}
      </Button>
      {shown.length ? (
        <span className="min-w-0 truncate text-xs leading-normal text-ink-faint">
          {t("message.sentBy")}{" "}
          {shown.map((sender, index) => (
            <Fragment key={sender.sessionId}>
              {index > 0 ? t("sessionTurns.separator") : null}
              {sender.onOpen ? (
                <Button
                  onClick={sender.onOpen}
                  size="inline"
                  title={t("sessionTurns.openSender", { title: sender.label })}
                  variant="link"
                >
                  {sender.label}
                </Button>
              ) : (
                <strong className="font-medium text-ink-muted">
                  {sender.label}
                </strong>
              )}
            </Fragment>
          ))}
          {more > 0 ? <> {t("sessionTurns.more", { count: more })}</> : null}
        </span>
      ) : null}
    </section>
  );
}
