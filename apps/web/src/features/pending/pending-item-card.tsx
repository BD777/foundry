import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  CornerDownLeft,
  Hand,
  Hourglass,
  KeyRound,
  MessageCircleQuestion,
  MessagesSquare,
  PackageX,
  RotateCcw,
  ScrollText,
  X,
} from "lucide-react";
import type { PendingItem } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { FieldHint, Textarea } from "../../components/ui/field";
import { IconBox } from "../../components/ui/icon-box";
import { RowMenu, type RowMenuItem } from "../../components/ui/row-menu";
import { cn } from "../../lib/cn";
import { relativeWhen } from "../../lib/time-format";
import { navigateToConnectorGrant } from "../../lib/in-app-navigation";
import {
  pendingFailure,
  pendingHeadline,
  pendingOptionLabel,
  pendingOrigin,
  pendingPersonal,
  pendingGitHubScopes,
  pendingPrimary,
  pendingResolved,
  pendingScopeUpdate,
  type PendingFailure,
} from "./pending-model";
import type { PendingItems } from "./use-pending-items";

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
} as const;

/** Details longer than this many characters start collapsed. */
const collapseAfter = 240;

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
  pending: Pick<PendingItems, "changeState" | "reply">;
  density?: "comfortable" | "compact";
  where?: "page" | "chat";
  /** Shown, not acted on: an item the person's assistant handles. */
  readOnly?: boolean;
  /** Name the assistant, chat or project the item came from. */
  showOrigin?: boolean;
}) {
  const { t } = useTranslation("pending");
  const titleId = useId();
  const hintId = useId();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [shown, setShown] = useState<"" | "context" | "error">("");
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"" | "send" | "state">("");
  const [sendingOption, setSendingOption] = useState("");
  const [error, setError] = useState("");
  const resolved = pendingResolved(item);
  const own = pendingPersonal(item);
  const failure = pendingFailure(item);
  const known = failure && failure.kind !== "other";
  const primary = pendingPrimary(item);
  const grantScopes = pendingGitHubScopes(item);
  const headline = own
    ? {
        text: item.title,
        showExcerpt:
          item.source === "bundle_update" || item.source === "message_channel",
      }
    : pendingHeadline(item);
  const title = pendingScopeUpdate(item)
    ? t("item.accountScopes", {
        title: item.title,
        version: item.context ?? "",
        count: item.excerpt.split(" ").filter(Boolean).length,
      })
    : item.source === "bundle_update"
      ? t(
          item.rule === "failed"
            ? "item.bundleFailed"
            : "item.bundleRolledBack",
          { title: item.title },
        )
      : item.source === "account"
        ? t("item.accountReauth", { title: item.title })
        : item.source === "connector"
          ? t("item.connectorExpired", { title: item.title })
          : known
            ? t(`failure.${failure.kind}.title`)
            : headline.pathDenied
              ? t("item.permissionDenied", { path: headline.pathDenied })
              : headline.text;
  const origin = pendingOrigin(
    item,
    t("page.untitled"),
    t("page.personal"),
    t("page.defaultAssistant"),
  );
  const hint = known ? failureHint(failure, t) : "";
  // What the assistant said when the item came to the person (§h); an item
  // it made from its own words already shows them as its title.
  const handed =
    item.handler !== "assistant" && item.handedReason
      ? item.handedReason === "assistant"
        ? item.rule === "handed_over"
          ? ""
          : (item.note ?? "")
        : t(`item.handed.${item.handedReason}`)
      : "";
  // A classified failure says what to do; its raw error waits in the menu.
  const detail = known ? "" : headline.showExcerpt ? item.excerpt : "";
  const long = detail.length > collapseAfter || detail.split("\n").length > 3;
  const canReply =
    !resolved &&
    !readOnly &&
    Boolean(item.sessionId || (item.issueId && item.eventId));
  const when = resolved
    ? t("item.resolved", {
        state: t(`state.${item.state}`),
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
  const send = async (text: string, option = "") => {
    if (!text.trim() || busy) return;
    setBusy("send");
    setSendingOption(option);
    setError("");
    try {
      await pending.reply(item, text);
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
      setSendingOption("");
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

  const openLabel =
    item.source === "bundle_update"
      ? t("item.openSkillLibrary")
      : item.source === "message_channel"
        ? t("item.openMessageChannels")
        : own
          ? t("item.openConnectors")
          : item.issueId
            ? t("page.openIssue")
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
  else if (!readOnly)
    menu.push({
      key: "done",
      label: t("item.done"),
      icon: <Check aria-hidden="true" size={15} />,
      onSelect: () => void change("done"),
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
          return (
            <Button
              className="h-auto min-h-[27px] py-1 text-left whitespace-normal"
              aria-label={
                recommended
                  ? t("item.useRecommended", { option: label })
                  : t("item.useOption", { option: label })
              }
              data-busy={sendingOption === option ? "true" : undefined}
              disabled={Boolean(busy)}
              key={option}
              onClick={() => void send(label, option)}
              size="sm"
              variant={recommended ? "primary" : "secondary"}
            >
              <span>{label}</span>
              {recommended ? (
                <span className="fdy-pending-item-recommended flex-none font-normal whitespace-nowrap opacity-80">
                  · {t("item.recommended")}
                </span>
              ) : null}
            </Button>
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
  else if (primary === "grant")
    action = (
      <Button
        onClick={() =>
          navigateToConnectorGrant("github", item.deviceId!, grantScopes)
        }
        size="sm"
      >
        {grantScopes.length
          ? t("item.grantGitHubScopes", { scopes: grantScopes.join(", ") })
          : t("item.openGitHubPermissions")}
        <ArrowRight aria-hidden="true" size={14} />
      </Button>
    );
  else if (primary === "open")
    action = (
      <Button onClick={() => onOpenMessage(item)} size="sm">
        {primaryOpenLabel}
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
  const notNeeded =
    !resolved && !readOnly ? (
      <Button
        disabled={Boolean(busy)}
        onClick={() => void change("dismissed")}
        size="sm"
        variant="ghost"
      >
        <X aria-hidden="true" size={14} />
        {t("item.notNeeded")}
      </Button>
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
        <strong
          className={cn(
            "fdy-pending-item-title min-w-0 leading-[1.45] font-semibold wrap-anywhere",
            compact ? "text-xs" : "text-sm",
            resolved ? "text-ink-muted" : "text-ink",
          )}
          id={titleId}
        >
          {title}
        </strong>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-2xs leading-[1.4] text-ink-faint">
          {showOrigin ? (
            <>
              <span className="text-ink">
                {t(`item.origin.${origin.kind}`, { name: origin.name })}
              </span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span className="text-ink-muted">{t(`source.${item.source}`)}</span>
          <span aria-hidden="true">·</span>
          <time
            className="tabular-nums"
            dateTime={resolved ? item.resolvedAt : item.createdAt}
            title={resolved ? item.resolvedAt : item.createdAt}
          >
            {when}
          </time>
          {item.occurrences > 1 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{t("item.occurrences", { count: item.occurrences })}</span>
            </>
          ) : null}
        </p>
        {hint ? (
          <p className="fdy-pending-item-fix text-xs leading-[1.5] text-ink-muted">
            {hint}
          </p>
        ) : null}
        {handed && item.handedReason === "assistant_timeout" ? (
          <p className="fdy-pending-item-reason min-w-0 text-xs leading-[1.5] text-ink-muted wrap-anywhere">
            {handed}
          </p>
        ) : handed ? (
          <p className="fdy-pending-item-handed min-w-0 text-xs leading-[1.5] text-ink wrap-anywhere">
            <span className="font-semibold">{t("item.fromAssistant")}</span>{" "}
            {handed}
          </p>
        ) : null}
        {detail ? (
          <div className="grid justify-items-start gap-0.5">
            <p
              className={cn(
                "fdy-pending-item-excerpt min-w-0 text-xs leading-[1.5] whitespace-pre-wrap text-ink-muted wrap-anywhere",
                long && !expanded && "line-clamp-3",
              )}
            >
              {detail}
            </p>
            {long ? (
              <Button
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
                size="inline"
                variant="link"
              >
                {expanded ? t("item.showLess") : t("item.showMore")}
              </Button>
            ) : null}
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
          <div className="mt-1 grid gap-1.5">
            <Textarea
              aria-describedby={hintId}
              aria-label={t("item.replyLabel", { title })}
              disabled={busy === "send"}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void send(draft);
                } else if (event.key === "Escape" && !busy) {
                  event.preventDefault();
                  setReplying(false);
                }
              }}
              ref={replyRef}
              resize="vertical"
              rows={compact ? 2 : 3}
              tone="boxed"
              value={draft}
            />
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <FieldHint id={hintId}>
                {item.source === "issue_question"
                  ? t("item.issueReplyHint")
                  : t("item.replyHint")}
              </FieldHint>
              <ButtonRow className="ml-auto gap-1 max-[640px]:ml-0">
                <Button
                  disabled={busy === "send"}
                  onClick={() => setReplying(false)}
                  size="sm"
                  variant="ghost"
                >
                  {t("item.cancel")}
                </Button>
                <Button
                  data-busy={busy === "send" ? "true" : undefined}
                  disabled={!draft.trim() || Boolean(busy)}
                  onClick={() => void send(draft)}
                  size="sm"
                >
                  <CornerDownLeft aria-hidden="true" size={14} />
                  {busy === "send" ? t("item.sending") : t("item.send")}
                </Button>
              </ButtonRow>
            </div>
          </div>
        ) : null}
        {error ? <Alert size="compact" title={error} tone="error" /> : null}
        {action || secondaryReply || notNeeded ? (
          <div
            className={cn(
              "flex min-w-0 flex-wrap items-center gap-1.5",
              compact ? "mt-1" : "mt-1.5",
            )}
          >
            {action}
            {secondaryReply}
            {notNeeded}
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
