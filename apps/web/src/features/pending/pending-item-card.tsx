import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Check,
  CornerDownLeft,
  RotateCcw,
  X,
} from "lucide-react";
import type { PendingItem } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { FieldHint, Textarea } from "../../components/ui/field";
import { relativeWhen } from "../../lib/time-format";
import {
  pendingHeadline,
  pendingOptionLabel,
  pendingResolved,
} from "./pending-model";
import type { PendingItems } from "./use-pending-items";

const sourceTone = {
  question: "brass",
  issue_question: "brass",
  turn_failed: "error",
  needs_hands: "warn",
} as const;

/** Excerpts longer than this many characters start collapsed. */
const collapseAfter = 420;

/**
 * One pending item, in its source's own words, shown once: a headline row
 * (source, what it is, when), the excerpt only when it says more than the
 * headline, then one row with the Agent's options and what the person can
 * do here (reply, open the message, mark it done, dismiss it, or open it
 * again).
 */
export function PendingItemCard({
  item,
  onOpenMessage,
  pending,
}: {
  item: PendingItem;
  /** Opens the transcript at the item's message (or its Issue). */
  onOpenMessage: (item: PendingItem) => void;
  pending: Pick<PendingItems, "changeState" | "reply">;
}) {
  const { t } = useTranslation("pending");
  const titleId = useId();
  const hintId = useId();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "state">("");
  const [error, setError] = useState("");
  const resolved = pendingResolved(item);
  const headline = pendingHeadline(item);
  const long = item.excerpt.length > collapseAfter;
  const canReply =
    !resolved && Boolean(item.sessionId || (item.issueId && item.eventId));
  const when = resolved
    ? t("item.resolved", {
        state: t(`state.${item.state}`),
        when: relativeWhen(item.resolvedAt || item.updatedAt),
      })
    : relativeWhen(item.createdAt);

  const openReply = (text = draft) => {
    setDraft(text);
    setReplying(true);
    setError("");
    window.requestAnimationFrame(() => replyRef.current?.focus());
  };
  const send = async () => {
    if (!draft.trim() || busy) return;
    setBusy("send");
    setError("");
    try {
      await pending.reply(item, draft);
      setDraft("");
      setReplying(false);
    } catch (reason) {
      setError(
        t("item.sendFailed", {
          error: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    } finally {
      setBusy("");
    }
  };
  const change = async (state: "open" | "done" | "dismissed") => {
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

  return (
    <article
      aria-labelledby={titleId}
      className="fdy-pending-item"
      data-state={item.state}
    >
      <header className="fdy-pending-item-head">
        <Badge size="sm" tone={sourceTone[item.source]}>
          {t(`source.${item.source}`)}
        </Badge>
        <strong className="fdy-pending-item-title" id={titleId}>
          {headline.pathDenied
            ? t("item.permissionDenied", { path: headline.pathDenied })
            : headline.text}
        </strong>
        <span className="fdy-pending-item-meta">
          <time
            dateTime={resolved ? item.resolvedAt : item.createdAt}
            title={resolved ? item.resolvedAt : item.createdAt}
          >
            {when}
          </time>
          {item.occurrences > 1 ? (
            <span>{t("item.occurrences", { count: item.occurrences })}</span>
          ) : null}
        </span>
      </header>
      {headline.showExcerpt ? (
        <>
          <blockquote
            className="fdy-pending-item-excerpt"
            data-collapsed={long && !expanded ? "true" : "false"}
          >
            {item.excerpt}
          </blockquote>
          {long ? (
            <Button
              aria-expanded={expanded}
              className="fdy-pending-item-more"
              onClick={() => setExpanded((value) => !value)}
              size="sm"
              variant="ghost"
            >
              {expanded ? t("item.showLess") : t("item.showMore")}
            </Button>
          ) : null}
        </>
      ) : null}
      {item.context && showContext ? (
        <blockquote
          aria-label={t("item.context")}
          className="fdy-pending-item-excerpt"
          data-tone="context"
        >
          {item.context}
        </blockquote>
      ) : null}
      {replying ? (
        <div className="fdy-pending-item-reply">
          <Textarea
            aria-describedby={hintId}
            aria-label={t("item.replyLabel", { title: headline.text })}
            disabled={busy === "send"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void send();
              } else if (event.key === "Escape" && !busy) {
                event.preventDefault();
                setReplying(false);
              }
            }}
            ref={replyRef}
            resize="vertical"
            rows={3}
            tone="boxed"
            value={draft}
          />
          <div className="fdy-pending-item-row">
            <FieldHint id={hintId}>
              {item.source === "issue_question"
                ? t("item.issueReplyHint")
                : t("item.replyHint")}
            </FieldHint>
            <div className="fdy-pending-item-actions">
              <Button
                disabled={busy === "send"}
                onClick={() => setReplying(false)}
                size="sm"
                variant="ghost"
              >
                {t("item.cancel")}
              </Button>
              <Button
                disabled={!draft.trim() || Boolean(busy)}
                onClick={() => void send()}
                size="sm"
              >
                <CornerDownLeft aria-hidden="true" size={14} />
                {busy === "send" ? t("item.sending") : t("item.send")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {error ? <Alert size="compact" title={error} tone="error" /> : null}
      <div className="fdy-pending-item-row">
        {item.options?.length ? (
          <div
            aria-label={t("item.options")}
            className="fdy-pending-item-options"
            role="group"
          >
            {item.options.map((option) => {
              const label = pendingOptionLabel(option);
              return (
                <Button
                  aria-label={t("item.useOption", { option: label })}
                  disabled={!canReply || Boolean(busy)}
                  key={option}
                  onClick={() => openReply(label)}
                  size="sm"
                  variant="secondary"
                >
                  {label}
                  {option === item.recommendation ? (
                    <span className="fdy-pending-item-recommended">
                      {t("item.recommended")}
                    </span>
                  ) : null}
                </Button>
              );
            })}
          </div>
        ) : null}
        <div className="fdy-pending-item-actions">
          {canReply && !replying ? (
            <Button
              disabled={Boolean(busy)}
              onClick={() => openReply()}
              size="sm"
              variant="ghost"
            >
              <CornerDownLeft aria-hidden="true" size={14} />
              {t("item.reply")}
            </Button>
          ) : null}
          {item.context ? (
            <Button
              aria-expanded={showContext}
              onClick={() => setShowContext((value) => !value)}
              size="sm"
              variant="ghost"
            >
              {showContext ? t("item.hideContext") : t("item.showContext")}
            </Button>
          ) : null}
          <Button onClick={() => onOpenMessage(item)} size="sm" variant="ghost">
            {item.issueId ? t("page.openIssue") : t("item.openMessage")}
            <ArrowUpRight aria-hidden="true" size={14} />
          </Button>
          {resolved ? (
            <Button
              disabled={Boolean(busy)}
              onClick={() => void change("open")}
              size="sm"
              variant="ghost"
            >
              <RotateCcw aria-hidden="true" size={14} />
              {t("item.reopen")}
            </Button>
          ) : (
            <>
              <Button
                aria-label={t("item.done")}
                disabled={Boolean(busy)}
                onClick={() => void change("done")}
                size="sm"
                title={t("item.done")}
                variant="ghost"
              >
                <Check aria-hidden="true" size={14} />
                {t("item.doneShort")}
              </Button>
              <Button
                disabled={Boolean(busy)}
                onClick={() => void change("dismissed")}
                size="sm"
                variant="ghost"
              >
                <X aria-hidden="true" size={14} />
                {t("item.dismiss")}
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
