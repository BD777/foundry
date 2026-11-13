import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ChevronRight,
  CircleAlert,
  Hand,
  KeyRound,
  MessageCircleQuestion,
  MessagesSquare,
  RotateCcw,
} from "lucide-react";
import type {
  PersonalAgentInboxEntry,
  PersonalAgentNeedsYou,
  PersonalAgentNeedsYouItem,
} from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  ContextEmpty,
  ContextHeading,
  ContextList,
  ContextRow,
  ContextRowCopy,
  ContextRowIcon,
  ContextSection,
} from "../../components/ui/context-card";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import type { IconBoxProps } from "../../components/ui/icon-box";
import { navigateToChat } from "../../lib/in-app-navigation";
import { pendingTitle } from "../../lib/pending-display";
import { clockTime } from "../../lib/time-format";
import { inboxReason, inboxSummaryReason } from "./assistant-model";

/** The rows the card shows; the rest wait behind "All". */
const shownRows = 3;

/** What kind of thing waits, by shape and tone: never by colour alone. */
function kindMark(source: string): {
  icon: typeof Hand;
  tone: IconBoxProps["tone"];
} {
  if (source === "question" || source === "issue_question")
    return { icon: MessageCircleQuestion, tone: "brass" };
  if (source === "turn_failed" || source === "bundle_update")
    return { icon: CircleAlert, tone: "error" };
  if (source === "account" || source === "connector")
    return { icon: KeyRound, tone: "warn" };
  if (source === "message_channel")
    return { icon: MessagesSquare, tone: "warn" };
  return { icon: Hand, tone: "warn" };
}

/** Where an item came from, in names the person knows; never ids. */
export function needsYouFromLine(
  from: PersonalAgentNeedsYouItem["from"],
  t: TFunction<"personalAgent">,
): string {
  const name = from.name?.trim() ?? "";
  const detail = from.detail?.trim() ?? "";
  switch (from.kind) {
    case "assistant":
      return name
        ? t("home.needsYou.from.assistant", { name })
        : t("home.needsYou.from.assistantOwn");
    case "helper":
      return name
        ? t("home.needsYou.from.helper", { name })
        : t("home.needsYou.from.helperUnnamed");
    case "channel":
      return detail
        ? t("home.needsYou.from.channel", { name, detail })
        : t("home.needsYou.from.channelOnly", { name });
    case "chat":
      if (!detail) return name;
      return name
        ? t("home.needsYou.from.chat", { name, detail })
        : t("home.needsYou.from.chatUntitled", { detail });
    case "issue":
      return name ? t("home.needsYou.from.issue", { name }) : "";
    case "personal":
      return t("home.needsYou.from.personal");
    default:
      return name;
  }
}

/** 「等你处理」: the count, the newest rows, and the whole list. */
export function NeedsYouSection({
  needsYou,
  onOpenAll,
  total,
}: {
  needsYou: PersonalAgentNeedsYou;
  onOpenAll: () => void;
  /**
   * Everything that needs the person (the sidebar's count). When this
   * assistant sees less, the card says its count is this assistant's and
   * "All" names the whole count, so the two never read as a contradiction.
   */
  total?: number;
}) {
  const { t } = useTranslation("personalAgent");
  const { t: tp } = useTranslation("pending");
  const scoped = total !== undefined && total !== needsYou.open;
  const title = t(scoped ? "home.needsYou.titleScoped" : "home.needsYou.title");
  const all = (
    <Button
      aria-label={
        scoped
          ? t("home.needsYou.allLabelCount", { count: total })
          : t("home.needsYou.allLabel")
      }
      className="-mr-1.5 h-6 gap-0.5 px-1.5 text-xs text-ink-muted"
      onClick={onOpenAll}
      size="sm"
      variant="ghost"
    >
      {scoped
        ? t("home.needsYou.allCount", { count: total })
        : t("home.needsYou.all")}
      <ChevronRight aria-hidden="true" size={13} />
    </Button>
  );
  if (!needsYou.open)
    return (
      <ContextSection aria-label={t("home.needsYou.label")} className="py-3.5">
        <ContextHeading
          action={
            scoped ? (
              all
            ) : (
              <ContextEmpty>{t("home.needsYou.empty")}</ContextEmpty>
            )
          }
          className="mb-0"
        >
          {title}
        </ContextHeading>
      </ContextSection>
    );
  return (
    <ContextSection aria-label={t("home.needsYou.label")}>
      <ContextHeading action={all} count={needsYou.open}>
        {title}
      </ContextHeading>
      <ContextList className="gap-1">
        {needsYou.items.slice(0, shownRows).map((item) => {
          const { icon: Icon, tone } = kindMark(item.source);
          const headline = pendingTitle(item, tp);
          const from = needsYouFromLine(item.from, t);
          return (
            <ContextRow
              data-source={item.source}
              key={item.id}
              onClick={onOpenAll}
              title={from ? `${headline}\n${from}` : headline}
            >
              <ContextRowIcon tone={tone}>
                <Icon aria-hidden="true" size={15} />
              </ContextRowIcon>
              <ContextRowCopy detail={from || undefined} title={headline} />
            </ContextRow>
          );
        })}
      </ContextList>
    </ContextSection>
  );
}

/**
 * 「没处理的消息」: saved messages whose attempt failed or that still wait.
 * Each reads as its words and why in one line («“你好” · 模型额度用完…»),
 * then what to do, its error behind a disclosure; several sharing a reason
 * are summed up once above them.
 */
export function UnprocessedSection({
  error,
  failed,
  waiting,
  retrying,
  onRetry,
}: {
  error: string;
  failed: PersonalAgentInboxEntry[];
  waiting: PersonalAgentInboxEntry[];
  retrying: boolean;
  onRetry: (entry: PersonalAgentInboxEntry) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const count = failed.length + waiting.length;
  if (!count && !error) return null;
  const now = new Date();
  const reason = inboxSummaryReason(failed, now);
  return (
    <ContextSection aria-label={t("inbox.card")}>
      <ContextHeading count={count}>{t("inbox.card")}</ContextHeading>
      {error ? (
        <Alert
          className="mb-2.5"
          size="compact"
          title={t("inbox.readFailed")}
          tone="error"
        >
          {error}
        </Alert>
      ) : null}
      {count > 1 ? (
        <p className="mb-2.5 text-sm leading-[1.45] font-semibold text-ink">
          {reason && !waiting.length
            ? t("inbox.summaryWhy", {
                count,
                reason: reasonText(reason, t),
              })
            : t("inbox.summary", { count })}
        </p>
      ) : null}
      <ul className="grid gap-3">
        {failed.map((entry) => {
          const why =
            count > 1 && reason && !waiting.length
              ? ""
              : reasonText(inboxReason(entry, now), t);
          return (
            <li className="grid min-w-0 gap-1.5" key={entry.id}>
              <p className="line-clamp-2 text-xs leading-[1.45] wrap-anywhere">
                <span className="text-ink-muted">“{entry.text}”</span>
                {why ? <span className="text-ink"> · {why}</span> : null}
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Button
                  disabled={retrying}
                  onClick={() => onRetry(entry)}
                  size="sm"
                  variant="secondary"
                >
                  <RotateCcw aria-hidden="true" size={13} />
                  {t("inbox.retry")}
                </Button>
                {entry.sessionId ? (
                  <Button
                    onClick={() => navigateToChat(entry.sessionId!)}
                    size="sm"
                    variant="ghost"
                  >
                    {t("inbox.openAttempt")}
                  </Button>
                ) : null}
                {entry.resultError ? (
                  <Disclosure className="open:basis-full">
                    <DisclosureSummary>{t("inbox.detail")}</DisclosureSummary>
                    <p className="max-h-[160px] overflow-auto text-2xs leading-[1.5] wrap-anywhere whitespace-pre-wrap text-ink-faint">
                      {entry.resultError}
                    </p>
                  </Disclosure>
                ) : null}
              </div>
            </li>
          );
        })}
        {waiting.map((entry) => (
          <li className="grid min-w-0 gap-1.5" key={entry.id}>
            <p className="line-clamp-2 text-xs leading-[1.45] wrap-anywhere">
              <span className="text-ink-muted">“{entry.text}”</span>
              <span className="text-ink">
                {" · "}
                {t(waitingReasonKey(entry.waitingReason))}
              </span>
            </p>
            <div>
              <Button
                disabled={retrying}
                onClick={() => onRetry(entry)}
                size="sm"
                variant="secondary"
              >
                <RotateCcw aria-hidden="true" size={13} />
                {t("inbox.retryWithSettings")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </ContextSection>
  );
}

function reasonText(
  reason: ReturnType<typeof inboxReason>,
  t: TFunction<"personalAgent">,
): string {
  if (reason.kind === "quota_exhausted" && reason.resetAt)
    return reason.resetPassed
      ? t("inbox.reason.quota_exhaustedReset")
      : t("inbox.reason.quota_exhaustedResets", {
          time: clockTime(reason.resetAt, { date: "short" }),
        });
  return t(`inbox.reason.${reason.kind}`);
}

export function waitingReasonKey(reason: string | undefined) {
  return reason === "device_offline"
    ? "inbox.deviceOffline"
    : reason === "worker_update_required"
      ? "inbox.workerUpdateRequired"
      : reason === "account_unavailable"
        ? "inbox.accountUnavailable"
        : reason === "assistant_paused"
          ? "inbox.paused"
          : "inbox.pending";
}
