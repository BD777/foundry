import { Fragment, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowRight,
  ArrowUpRight,
  Ban,
  Check,
  CircleAlert,
  CornerDownLeft,
  Hand,
  Hourglass,
  Inbox,
  Info,
  KeyRound,
  MessageCircleQuestion,
  ListChecks,
  MessagesSquare,
  PackageX,
  Quote,
  RotateCcw,
  ScrollText,
  X,
} from "lucide-react";
import type { ChatAttachment } from "@bd777/foundry-protocol";
import {
  ApiError,
  type PendingItem,
  type PendingOrigin,
  type PendingSettableState,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ClampedText } from "../../components/ui/clamped-text";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { IconBox } from "../../components/ui/icon-box";
import { MetaLine } from "../../components/ui/meta-line";
import { RowMenu, type RowMenuItem } from "../../components/ui/row-menu";
import { cn } from "../../lib/cn";
import { clockTime, relativeWhen } from "../../lib/time-format";
import {
  pendingApprovalDetail,
  pendingCanReply,
  pendingFailure,
  pendingHeadline,
  pendingInboxReason,
  pendingNoticeText,
  pendingOptionLabel,
  pendingOrigin,
  pendingPersonal,
  pendingPrimary,
  pendingResolved,
  pendingStatusKey,
  pendingTitle,
  textContains,
  type PendingFailure,
} from "./pending-model";
import type { PendingItems } from "./use-pending-items";
import { PendingItemRef } from "./pending-item-ref";
import { ConnectorWriteItemCard } from "./connector-write-item-card";
import { PendingReply } from "./pending-reply";

/** What kind of thing waits, by shape and tone: never by color alone. */
const kindIcon = {
  question: { icon: MessageCircleQuestion, tone: "brass" },
  issue_question: { icon: MessageCircleQuestion, tone: "brass" },
  turn_failed: { icon: CircleAlert, tone: "error" },
  needs_hands: { icon: Hand, tone: "warn" },
  account: { icon: KeyRound, tone: "warn" },
  connector: { icon: KeyRound, tone: "warn" },
  helper_stuck: { icon: Hourglass, tone: "warn" },
  bundle_update: { icon: PackageX, tone: "error" },
  message_channel: { icon: MessagesSquare, tone: "warn" },
  connector_write: { icon: MessagesSquare, tone: "warn" },
  notice: { icon: Info, tone: "brass" },
  assistant_question: { icon: MessagesSquare, tone: "brass" },
  item_wait: { icon: ListChecks, tone: "brass" },
} as const;

/**
 * One pending item, read top to bottom: what it asks (a plain headline, the
 * fix for a failed turn), a quiet line saying what kind it is and when, then
 * the one thing to do. A question's options are that action, its
 * recommended option filled; a failed turn goes to the chat; a step only the
 * person can take opens where it is done. Reply stays beside it; opening the
 * message, the context or the error, and marking done sit in one "…" menu.
 * "Not for me" is a visible action. `compact` is the density of the bar
 * above a chat's composer;
 * `where` says whether the item is shown inside its own chat.
 */
export function PendingItemCard({
  item,
  onOpenMessage,
  pending,
  density = "comfortable",
  where = "page",
  readOnly = false,
  showOrigin = false,
}: {
  item: PendingItem;
  /** Opens the transcript at the item's message (or its Issue). */
  onOpenMessage: (item: PendingItem) => void;
  pending: Pick<PendingItems, "changeState" | "reply" | "retry" | "decide">;
  density?: "comfortable" | "compact";
  where?: "page" | "chat";
  /** Shown, not acted on: an item the person's assistant handles. */
  readOnly?: boolean;
  /** Name the assistant, chat or project the item came from. */
  showOrigin?: boolean;
}) {
  const { t } = useTranslation("pending");
  const titleId = useId();
  const recommendedId = useId();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const [shown, setShown] = useState<"" | "context" | "error">("");
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "state">("");
  const [sendingOption, setSendingOption] = useState("");
  const [error, setError] = useState("");
  // A saved message reads and acts differently from every other item
  // (DEV-254): its words and why in one line, retry / not-process / attempt
  // in one row, the error behind a disclosure below them.
  if (item.source === "assistant_inbox")
    return (
      <InboxItemCard
        item={item}
        onOpenMessage={onOpenMessage}
        pending={pending}
        showOrigin={showOrigin}
      />
    );
  if (item.source === "connector_write")
    return (
      <ConnectorWriteItemCard
        item={item}
        pending={pending}
        showOrigin={showOrigin}
      />
    );
  if (item.source === "notice")
    return (
      <NoticeItemCard
        item={item}
        onOpenMessage={onOpenMessage}
        pending={pending}
        showOrigin={showOrigin}
      />
    );
  const resolved = pendingResolved(item);
  const own = pendingPersonal(item);
  const failure = pendingFailure(item);
  const known = failure && failure.kind !== "other";
  const primary = pendingPrimary(item);
  const headline = own
    ? {
        text: item.title,
        showExcerpt:
          item.source === "bundle_update" || item.source === "message_channel",
      }
    : pendingHeadline(item);
  const title = pendingTitle(item, t);
  const origin = pendingOrigin(
    item,
    t("page.untitled"),
    t("page.personal"),
    t("page.defaultAssistant"),
  );
  const hint = known ? failureHint(failure, t) : "";
  const noticeText = pendingNoticeText(item, t);
  // What the assistant said when the item came to the person (§h). An item
  // it made from its own words shows their first line as its title, so the
  // note shows only when it says more (a draft on later lines, a cut title).
  const note = (item.note ?? "").trim();
  // The assistant handed it over itself: its words say why it needs the
  // person. An item made from those words already shows them as its title,
  // so only the fact of the hand-over is shown then.
  const handedByAssistant =
    item.handler !== "assistant" && item.handedReason === "assistant";
  // A long text's title is the text cut short; the note or excerpt that holds
  // all of it leads instead, once, so the card never shows it twice.
  const lead =
    [handedByAssistant ? note : "", headline.showExcerpt ? item.excerpt : ""]
      .map((text) => text.trim())
      .find(
        (text) => textContains(text, title) && !textContains(title, text),
      ) ?? "";
  const handedNote =
    handedByAssistant && !textContains(lead || title, note) ? note : "";
  // The words the card leads with are the assistant's own when it wrote them
  // handing the item over: its "I" is the assistant, its "you" the person.
  const leadSpeaker =
    handedByAssistant && note !== "" && textContains(note, lead || title)
      ? t("item.speaker", {
          name: item.assistantName || t("page.defaultAssistant"),
        })
      : "";
  const handedReasonText =
    item.handler !== "assistant" &&
    item.handedReason &&
    item.handedReason !== "assistant"
      ? t(`item.handed.${item.handedReason}`)
      : "";
  const assistantDecided = resolved && item.outcome === "assistant_answered";
  // The assistant closed it with a reason and no answer: not a decision.
  const assistantClosed = resolved && item.outcome === "assistant_closed";
  const closeReason = (item.closeReason ?? "").trim();
  // What an approval asks the person to allow: the command or the paths.
  const approvalDetail = pendingApprovalDetail(item);
  // A classified failure says what to do; its raw error waits in the menu.
  const detail =
    known ||
    !headline.showExcerpt ||
    textContains(lead || title, item.excerpt) ||
    (handedNote !== "" && textContains(handedNote, item.excerpt))
      ? ""
      : item.excerpt;
  const canReply = !resolved && !readOnly && pendingCanReply(item);
  const when = resolved
    ? t("item.resolved", {
        state: t(pendingStatusKey(item)),
        when: relativeWhen(item.resolvedAt || item.updatedAt),
      })
    : relativeWhen(item.createdAt);
  const compact = density === "compact";
  const { icon: KindIcon, tone } = kindIcon[item.source];

  const openReply = () => {
    setReplying(true);
    setError("");
    window.requestAnimationFrame(() => replyRef.current?.focus());
  };
  const send = async (
    text: string,
    option = "",
    attachments: ChatAttachment[] = [],
  ) => {
    if (!text.trim() || busy) return false;
    setBusy("send");
    setSendingOption(option);
    setError("");
    try {
      await pending.reply(item, text, attachments);
      setDraft("");
      setReplying(false);
      return true;
    } catch (reason) {
      setError(
        t("item.sendFailed", {
          error: reason instanceof Error ? reason.message : String(reason),
        }),
      );
      return false;
    } finally {
      setBusy("");
      setSendingOption("");
    }
  };
  const change = async (state: PendingSettableState) => {
    setBusy("state");
    setError("");
    try {
      await pending.changeState(item, state);
    } catch (reason) {
      setError(
        t("item.changeFailed", {
          error: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    } finally {
      setBusy("");
    }
  };

  const openLabel =
    item.source === "bundle_update"
      ? t("item.openSkillLibrary")
      : item.source === "message_channel"
        ? t("item.openMessageChannels")
        : own
          ? t("item.openConnectors")
          : item.issueId
            ? t("page.openIssue")
            : item.source === "item_wait"
              ? t("item.openItem")
              : where === "chat"
                ? t("item.jumpToMessage")
                : t("item.openMessage");
  const primaryOpenLabel =
    item.source === "turn_failed" && !item.issueId
      ? where === "chat"
        ? t("item.jumpToMessage")
        : t("item.fixInChat")
      : openLabel;

  const menu: RowMenuItem[] = [];
  if (primary !== "open" || readOnly)
    menu.push({
      key: "open",
      label: openLabel,
      icon: <ArrowUpRight aria-hidden="true" size={15} />,
      onSelect: () => onOpenMessage(item),
    });
  if (item.context)
    menu.push({
      key: "context",
      label:
        shown === "context" ? t("item.hideContext") : t("item.showContext"),
      icon: <ScrollText aria-hidden="true" size={15} />,
      onSelect: () =>
        setShown((value) => (value === "context" ? "" : "context")),
    });
  if (known)
    menu.push({
      key: "error",
      label: shown === "error" ? t("item.hideError") : t("item.showError"),
      icon: <CircleAlert aria-hidden="true" size={15} />,
      onSelect: () => setShown((value) => (value === "error" ? "" : "error")),
    });
  // An item the assistant handles offers only where it was found.
  if (resolved && !readOnly)
    menu.push({
      key: "reopen",
      label: t("item.reopen"),
      icon: <RotateCcw aria-hidden="true" size={15} />,
      onSelect: () => void change("open"),
    });

  let action: ReactNode = null;
  if (readOnly) {
    action = null;
  } else if (primary === "options")
    action = (
      <div
        aria-label={t("item.options")}
        className="flex min-w-0 flex-wrap items-center gap-1.5"
        role="group"
      >
        {item.options!.map((option) => {
          const label = pendingOptionLabel(option);
          const recommended = option === item.recommendation;
          // The option's name is its label; the recommended mark is only
          // described, so the name stays exactly the option (DEV-296).
          return (
            <Fragment key={option}>
              <Button
                aria-describedby={recommended ? recommendedId : undefined}
                className="h-auto min-h-[27px] py-1 text-left whitespace-normal"
                data-busy={sendingOption === option ? "true" : undefined}
                disabled={Boolean(busy)}
                onClick={() => void send(label, option)}
                size="sm"
                variant={recommended ? "primary" : "secondary"}
              >
                <span>{label}</span>
                {recommended ? (
                  <span
                    aria-hidden="true"
                    className="fdy-pending-item-recommended flex-none font-normal whitespace-nowrap opacity-80"
                  >
                    · {t("item.recommended")}
                  </span>
                ) : null}
              </Button>
              {recommended ? (
                <span className="sr-only" id={recommendedId}>
                  {t("item.recommended")}
                </span>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    );
  else if (primary === "reply" && !replying)
    action = (
      <Button disabled={Boolean(busy)} onClick={openReply} size="sm">
        <CornerDownLeft aria-hidden="true" size={14} />
        {t("item.reply")}
      </Button>
    );
  else if (primary === "open")
    action = (
      <Button onClick={() => onOpenMessage(item)} size="sm">
        {primaryOpenLabel}
        <ArrowRight aria-hidden="true" size={14} />
      </Button>
    );
  // A decision the assistant made is undone in its conversation: the person
  // reads what it said there and replies, if they disagree.
  else if (assistantDecided && item.sessionId)
    action = (
      <Button onClick={() => onOpenMessage(item)} size="sm" variant="secondary">
        {t("item.openAssistantAnswer")}
        <ArrowRight aria-hidden="true" size={14} />
      </Button>
    );

  const secondaryReply =
    canReply && primary !== "reply" && !replying ? (
      <Button
        disabled={Boolean(busy)}
        onClick={openReply}
        size="sm"
        variant="ghost"
      >
        <CornerDownLeft aria-hidden="true" size={14} />
        {t("item.reply")}
      </Button>
    ) : null;
  // Three ways the person closes an item, side by side: settled (done),
  // dropped (abandoned), or not theirs (dismissed). A helper waiting on the
  // question is told which (the server sends it the no-answer reply).
  const closers =
    !resolved && !readOnly ? (
      <>
        <Button
          disabled={Boolean(busy)}
          onClick={() => void change("done")}
          size="sm"
          variant="ghost"
        >
          <Check aria-hidden="true" size={14} />
          {t("item.done")}
        </Button>
        <Button
          disabled={Boolean(busy)}
          onClick={() => void change("abandoned")}
          size="sm"
          variant="ghost"
        >
          <Ban aria-hidden="true" size={14} />
          {t("item.abandon")}
        </Button>
        <Button
          disabled={Boolean(busy)}
          onClick={() => void change("dismissed")}
          size="sm"
          variant="ghost"
        >
          <X aria-hidden="true" size={14} />
          {t("item.notNeeded")}
        </Button>
      </>
    ) : null;

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        "fdy-pending-item grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 not-first:border-t not-first:border-line-soft",
        compact ? "gap-x-2.5 px-1 py-2" : "px-4 py-3.5 max-[640px]:px-3",
      )}
      data-state={item.state}
    >
      <IconBox
        aria-hidden="true"
        className={resolved ? "opacity-60" : undefined}
        size={compact ? "composer" : "chat"}
        tone={resolved ? "muted" : tone}
      >
        <KindIcon size={compact ? 13 : 15} />
      </IconBox>
      <div className="grid min-w-0 gap-1">
        {lead ? (
          <div
            className="fdy-pending-item-title fdy-pending-item-lead min-w-0"
            id={titleId}
          >
            <ClampedText
              clamp={4}
              lessLabel={t("item.showLess")}
              moreLabel={t("item.showMore")}
              size={compact ? "xs" : "sm"}
              tone={resolved ? "muted" : "ink"}
            >
              {leadSpeaker ? (
                <strong className="fdy-pending-item-speaker font-semibold">
                  {leadSpeaker}{" "}
                </strong>
              ) : null}
              {lead}
            </ClampedText>
          </div>
        ) : (
          <strong
            className={cn(
              "fdy-pending-item-title min-w-0 leading-[1.45] font-semibold wrap-anywhere",
              compact ? "text-xs" : "text-sm",
              resolved ? "text-ink-muted" : "text-ink",
            )}
            id={titleId}
          >
            {leadSpeaker ? (
              <span className="fdy-pending-item-speaker">{leadSpeaker} </span>
            ) : null}
            {title}
          </strong>
        )}
        {item.origin && !resolved ? (
          <PendingOriginLine origin={item.origin} />
        ) : null}
        <PendingItemRef item={item} />
        <MetaLine className="text-2xs leading-[1.4] text-ink-faint">
          {showOrigin ? (
            <span className="text-ink">
              {t(`item.origin.${origin.kind}`, { name: origin.name })}
            </span>
          ) : null}
          <span className="text-ink-muted">{t(`source.${item.source}`)}</span>
          {handedByAssistant && !handedNote ? (
            <span className="fdy-pending-item-handed-meta text-ink-muted">
              {t("item.handedMeta")}
            </span>
          ) : null}
          <time
            className="tabular-nums"
            dateTime={resolved ? item.resolvedAt : item.createdAt}
            title={resolved ? item.resolvedAt : item.createdAt}
          >
            {when}
          </time>
          {item.occurrences > 1 ? (
            <span>{t("item.occurrences", { count: item.occurrences })}</span>
          ) : null}
          {noticeText ? (
            <span className="fdy-pending-item-card-sent">{noticeText}</span>
          ) : null}
        </MetaLine>
        {hint ? (
          <p className="fdy-pending-item-fix text-xs leading-[1.5] text-ink-muted">
            {hint}
          </p>
        ) : null}
        {assistantDecided ? (
          <p className="fdy-pending-item-decided min-w-0">
            <Badge dot={false} size="xs" tone="brass">
              {t("item.assistantDecided")}
            </Badge>
          </p>
        ) : null}
        {assistantDecided && item.answer?.trim() ? (
          <ClampedText
            clamp={2}
            lessLabel={t("item.showLess")}
            moreLabel={t("item.showMore")}
            size="sm"
            tone="ink"
          >
            {item.answer.trim()}
          </ClampedText>
        ) : null}
        {assistantClosed && !closeReason ? (
          <p className="fdy-pending-item-closed min-w-0">
            <Badge dot={false} size="xs">
              {t("item.assistantClosed")}
            </Badge>
          </p>
        ) : null}
        {assistantClosed && closeReason ? (
          <ClampedText
            clamp={2}
            className="fdy-pending-item-closed"
            lessLabel={t("item.showLess")}
            moreLabel={t("item.showMore")}
            size="sm"
            tone="ink"
          >
            {t("item.assistantClosedReason", { reason: closeReason })}
          </ClampedText>
        ) : null}
        {handedNote ||
        (handedReasonText && item.handedReason !== "assistant_timeout") ? (
          <div className="fdy-pending-item-handed min-w-0 rounded-lg bg-panel-soft px-2.5 py-2">
            <ClampedText
              clamp={3}
              lessLabel={t("item.showLess")}
              moreLabel={t("item.showMore")}
              size="sm"
              tone="ink"
            >
              <strong className="font-semibold">
                {t("item.fromAssistant")}
              </strong>{" "}
              {handedNote || handedReasonText}
            </ClampedText>
          </div>
        ) : handedReasonText ? (
          <p className="fdy-pending-item-reason min-w-0 text-xs leading-[1.5] text-ink-muted wrap-anywhere">
            {handedReasonText}
          </p>
        ) : null}
        {detail ? (
          <ClampedText
            clamp={3}
            className="fdy-pending-item-excerpt"
            lessLabel={t("item.showLess")}
            moreLabel={t("item.showMore")}
            size="xs"
          >
            {detail}
          </ClampedText>
        ) : null}
        {approvalDetail ? (
          <div className="fdy-pending-item-approval min-w-0 rounded-lg bg-panel-soft px-2.5 py-2">
            <ClampedText
              clamp={3}
              className="font-mono break-all"
              lessLabel={t("item.showLess")}
              moreLabel={t("item.showMore")}
              size="xs"
              tone="ink"
            >
              {approvalDetail}
            </ClampedText>
          </div>
        ) : null}
        {shown ? (
          <blockquote
            aria-label={
              shown === "context" ? t("item.context") : t("item.error")
            }
            className="fdy-pending-item-shown max-h-60 overflow-y-auto rounded-r-sm border-l-2 border-line-strong py-0.5 pl-2.5 text-xs leading-[1.55] whitespace-pre-wrap text-ink-muted wrap-anywhere"
          >
            {shown === "context" ? item.context : item.excerpt}
          </blockquote>
        ) : null}
        {replying ? (
          <PendingReply
            compact={compact}
            draft={draft}
            inputRef={replyRef}
            item={item}
            onCancel={() => setReplying(false)}
            onDraftChange={setDraft}
            onSend={(text, attachments) => send(text, "", attachments)}
            sending={busy === "send"}
            title={title}
          />
        ) : null}
        {error ? <Alert size="compact" title={error} tone="error" /> : null}
        {action || secondaryReply || closers ? (
          <div
            className={cn(
              "flex min-w-0 flex-wrap items-center gap-1.5",
              compact ? "mt-1" : "mt-1.5",
            )}
          >
            {action}
            {secondaryReply}
            {closers}
          </div>
        ) : null}
      </div>
      <RowMenu
        disabled={Boolean(busy)}
        items={menu}
        label={t("item.more", { title })}
      />
    </article>
  );
}

/**
 * A note the assistant's session sends the person that needs no decision
 * (DEV-278): what it says, where it came from, and two things it allows —
 * open the conversation, or say it was read.
 */
function NoticeItemCard({
  item,
  onOpenMessage,
  pending,
  showOrigin,
}: {
  item: PendingItem;
  onOpenMessage: (item: PendingItem) => void;
  pending: Pick<PendingItems, "changeState">;
  showOrigin: boolean;
}) {
  const { t } = useTranslation("pending");
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resolved = pendingResolved(item);
  const note = (item.note || item.excerpt || item.title).trim();
  const origin = pendingOrigin(
    item,
    t("page.untitled"),
    t("page.personal"),
    t("page.defaultAssistant"),
  );
  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await pending.changeState(item, "dismissed");
    } catch (reason) {
      setError(
        t("item.changeFailed", {
          error: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <article
      aria-labelledby={titleId}
      className="fdy-pending-item grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-4 py-3.5 not-first:border-t not-first:border-line-soft max-[640px]:px-3"
      data-source={item.source}
      data-state={item.state}
    >
      <IconBox
        aria-hidden="true"
        className={resolved ? "opacity-60" : undefined}
        size="chat"
        tone={resolved ? "muted" : "brass"}
      >
        <Info size={15} />
      </IconBox>
      <div className="grid min-w-0 gap-1.5">
        <p
          className={cn(
            "min-w-0 text-sm leading-[1.45] wrap-anywhere",
            resolved ? "text-ink-muted" : "text-ink",
          )}
          id={titleId}
        >
          {note}
        </p>
        <PendingItemRef item={item} />
        <MetaLine className="text-2xs leading-[1.4] text-ink-faint">
          {showOrigin ? (
            <span className="text-ink">
              {t(`item.origin.${origin.kind}`, { name: origin.name })}
            </span>
          ) : null}
          <span className="text-ink-muted">{t("source.notice")}</span>
          <time
            className="tabular-nums"
            dateTime={resolved ? item.resolvedAt : item.createdAt}
            title={resolved ? item.resolvedAt : item.createdAt}
          >
            {resolved
              ? t("item.resolved", {
                  state: t(`state.${item.state}`),
                  when: relativeWhen(item.resolvedAt || item.updatedAt),
                })
              : relativeWhen(item.createdAt)}
          </time>
        </MetaLine>
        {!resolved ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {item.sessionId ? (
              <Button onClick={() => onOpenMessage(item)} size="sm">
                {t("item.openMessage")}
                <ArrowRight aria-hidden="true" size={14} />
              </Button>
            ) : null}
            <Button
              disabled={busy}
              onClick={() => void dismiss()}
              size="sm"
              variant="ghost"
            >
              <Check aria-hidden="true" size={14} />
              {t("item.gotIt")}
            </Button>
          </div>
        ) : null}
        {error ? <Alert size="compact" title={error} tone="error" /> : null}
      </div>
    </article>
  );
}

/**
 * A saved message the assistant did not process: its words and why on one
 * line, then retry (the one thing to do), not-process (which closes it) and
 * its last attempt in one row of equal-size actions; the attempt's error
 * sits behind a disclosure on its own line, never among the buttons.
 */
function InboxItemCard({
  item,
  onOpenMessage,
  pending,
  showOrigin,
}: {
  item: PendingItem;
  onOpenMessage: (item: PendingItem) => void;
  pending: Pick<PendingItems, "changeState" | "retry">;
  showOrigin: boolean;
}) {
  const { t } = useTranslation("pending");
  const titleId = useId();
  const [busy, setBusy] = useState<"" | "retry" | "dismiss">("");
  const [error, setError] = useState("");
  const resolved = pendingResolved(item);
  const failed = Boolean(item.failureCategory) || item.rule === "canceled";
  const reason = pendingInboxReason(item, t);
  // The time the message was sent, not when its item was recorded (DEV-254).
  const when = item.messageAt || item.createdAt;
  const origin = pendingOrigin(
    item,
    t("page.untitled"),
    t("page.personal"),
    t("page.defaultAssistant"),
  );
  const run = async (action: "retry" | "dismiss") => {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      if (action === "retry") await pending.retry(item);
      else await pending.changeState(item, "dismissed");
    } catch (reason) {
      setError(
        action === "retry"
          ? inboxRetryMessage(reason, t)
          : t("item.inboxDismissFailed"),
      );
    } finally {
      setBusy("");
    }
  };
  return (
    <article
      aria-labelledby={titleId}
      className="fdy-pending-item fdy-pending-item-inbox grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-4 py-3.5 not-first:border-t not-first:border-line-soft max-[640px]:px-3"
      data-source={item.source}
      data-state={item.state}
    >
      <IconBox
        aria-hidden="true"
        className={resolved ? "opacity-60" : undefined}
        size="chat"
        tone={resolved ? "muted" : failed ? "error" : "warn"}
      >
        <Inbox size={15} />
      </IconBox>
      <div className="grid min-w-0 gap-1.5">
        {/* One line: the message is cut with an ellipsis, the reason stays whole. */}
        <p
          className="flex min-w-0 items-baseline text-sm leading-[1.45]"
          id={titleId}
        >
          <span
            className={cn(
              "min-w-0 truncate font-semibold",
              resolved ? "text-ink-muted" : "text-ink",
            )}
            title={item.title}
          >
            “{item.title}”
          </span>
          <span className="shrink-0 whitespace-nowrap text-ink-muted">
            {" · "}
            {reason}
          </span>
        </p>
        <PendingItemRef item={item} />
        <MetaLine className="text-2xs leading-[1.4] text-ink-faint">
          {showOrigin ? (
            <span className="text-ink">
              {t(`item.origin.${origin.kind}`, { name: origin.name })}
            </span>
          ) : null}
          <time
            className="tabular-nums"
            dateTime={resolved ? item.resolvedAt : when}
            title={resolved ? item.resolvedAt : when}
          >
            {resolved
              ? t("item.resolved", {
                  state: t(`state.${item.state}`),
                  when: relativeWhen(item.resolvedAt || item.updatedAt),
                })
              : relativeWhen(when)}
          </time>
        </MetaLine>
        {!resolved ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Button
              data-busy={busy === "retry" ? "true" : undefined}
              disabled={Boolean(busy)}
              onClick={() => void run("retry")}
              size="sm"
            >
              <RotateCcw aria-hidden="true" size={14} />
              {t("item.inboxRetry")}
            </Button>
            <Button
              disabled={Boolean(busy)}
              onClick={() => void run("dismiss")}
              size="sm"
              variant="ghost"
            >
              <X aria-hidden="true" size={14} />
              {t("item.inboxDismiss")}
            </Button>
            {item.sessionId ? (
              <Button
                disabled={Boolean(busy)}
                onClick={() => onOpenMessage(item)}
                size="sm"
                variant="ghost"
              >
                <ArrowUpRight aria-hidden="true" size={14} />
                {t("item.inboxOpenAttempt")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {item.context ? (
          <Disclosure>
            <DisclosureSummary>{t("item.inboxDetail")}</DisclosureSummary>
            <p className="max-h-[160px] overflow-auto text-2xs leading-[1.5] wrap-anywhere whitespace-pre-wrap text-ink-faint">
              {item.context}
            </p>
          </Disclosure>
        ) : null}
        {error ? <Alert size="compact" title={error} tone="error" /> : null}
      </div>
    </article>
  );
}

/** A refused retry says why in the person's words, never the server's (DEV-254). */
function inboxRetryMessage(reason: unknown, t: TFunction<"pending">): string {
  const code = reason instanceof ApiError ? reason.code : undefined;
  if (code === "inbox_retry_not_settled")
    return t("item.inboxRetryRefusal.notSettled");
  if (code === "inbox_retry_changed")
    return t("item.inboxRetryRefusal.changed");
  return t("item.inboxRetryRefusal.failed");
}

function failureHint(failure: PendingFailure, t: TFunction<"pending">): string {
  if (failure.kind === "usage_limit")
    return failure.resets
      ? t("failure.usage_limit.hintResets", { when: failure.resets })
      : t("failure.usage_limit.hint");
  if (failure.kind === "provider_mismatch")
    return t("failure.provider_mismatch.hint", {
      chat: failure.chatProvider ?? "",
      current: failure.currentProvider ?? "",
    });
  // An unclassified failure has no advice beyond its title.
  if (failure.kind === "other") return "";
  return t(`failure.${failure.kind}.hint`);
}

/**
 * Where an item began, so the person recalls what it is about: their own
 * words that set its work going, and where and when they said them.
 */
function PendingOriginLine({ origin }: { origin: PendingOrigin }) {
  const { t } = useTranslation("pending");
  const where = origin.channel
    ? t(
        origin.conversationKind === "direct"
          ? "item.startedIn.direct"
          : "item.startedIn.group",
        { channel: origin.channel, name: origin.conversation || "" },
      )
    : t("item.startedIn.chat");
  return (
    <div className="fdy-pending-item-origin flex min-w-0 items-start gap-1.5 border-l-2 border-line-strong pl-2.5">
      <Quote
        aria-hidden="true"
        className="mt-0.5 flex-none text-ink-faint"
        size={12}
      />
      <ClampedText clamp={2} size="xs">
        <span className="text-ink-faint">
          {t("item.startedSaid", {
            where,
            when: clockTime(origin.at, { date: "short" }),
          })}
        </span>{" "}
        <span className="text-ink">{origin.text}</span>
      </ClampedText>
    </div>
  );
}
