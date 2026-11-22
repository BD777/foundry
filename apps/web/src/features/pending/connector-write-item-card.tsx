import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, MessagesSquare, X } from "lucide-react";
import type { PendingItem } from "../../api";
import { Button } from "../../components/ui/button";
import { ClampedText } from "../../components/ui/clamped-text";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { IconBox } from "../../components/ui/icon-box";
import { relativeWhen } from "../../lib/time-format";
import { pendingOrigin, pendingResolved } from "./pending-model";
import { PendingItemRef } from "./pending-item-ref";
import type { PendingItems } from "./use-pending-items";

/**
 * One connector write outside what the session was granted (DEV-265): what
 * would be written where, where the request came from, and the person's
 * allow / don't allow. Allowing makes Foundry send the recorded request.
 */
export function ConnectorWriteItemCard({
  item,
  pending,
  showOrigin,
}: {
  item: PendingItem;
  pending: Pick<PendingItems, "decide">;
  showOrigin: boolean;
}) {
  const { t } = useTranslation("pending");
  const titleId = useId();
  const [busy, setBusy] = useState<"" | "decide">("");
  const [error, setError] = useState("");
  const resolved = pendingResolved(item);
  const detail = item.connectorWrite;
  const origin = pendingOrigin(
    item,
    t("page.untitled"),
    t("page.personal"),
    t("page.defaultAssistant"),
  );
  const account = detail?.accountName || detail?.targetType || "";
  // What-you-see-is-what-you-get: the name Foundry resolved when the
  // proposal was made, else the id said to be unknown. Never a bare id.
  const targetName = detail?.targetName?.trim() ?? "";
  let target = targetName;
  if (detail?.targetType === "conversation" || detail?.targetType === "message")
    target =
      targetName ||
      t("item.connectorWrite.unknownConversation", { id: detail.targetId });
  else if (detail?.targetId)
    target =
      targetName ||
      t("item.connectorWrite.unknownTarget", {
        type: detail.targetType,
        id: detail.targetId,
      });
  else if (!targetName) target = t("item.connectorWrite.targetAccount");
  const conversationKind = detail?.conversationKind;
  const kind =
    conversationKind === "self" ||
    conversationKind === "direct" ||
    conversationKind === "group"
      ? t(`item.connectorWrite.originChannelKind.${conversationKind}`)
      : t("item.connectorWrite.originChannelKind.other");
  const from = detail?.channelName
    ? t("item.connectorWrite.originChannel", {
        channel: detail.channelName,
        kind,
      })
    : detail?.fromHelper
      ? t("item.connectorWrite.originHelper")
      : t("item.connectorWrite.originWeb");
  // Message text reads as a sentence; other writes stay a plain write.
  const action = detail?.action ?? (detail?.text ? "message" : "write");
  let request = "";
  let quote = detail?.text ?? "";
  if (action === "message") {
    request = t("item.connectorWrite.message", {
      account,
      target,
      text: quote,
    });
    quote = "";
  } else if (action === "reaction") {
    request = t("item.connectorWrite.reaction", { account, target });
  } else {
    request = detail?.operation
      ? t("item.connectorWrite.operation", {
          account,
          operation: detail.operation,
        })
      : t("item.connectorWrite.write", { account, target });
  }
  const decide = async (allow: boolean) => {
    if (busy) return;
    setBusy("decide");
    setError("");
    try {
      await pending.decide(item, allow);
    } catch (reason) {
      setError(
        t("item.connectorWrite.failed", {
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
      className="fdy-pending-item fdy-pending-item-connector-write grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-4 py-3.5 not-first:border-t not-first:border-line-soft max-[640px]:px-3"
      data-source={item.source}
      data-state={item.state}
    >
      <IconBox
        aria-hidden="true"
        className={resolved ? "opacity-60" : undefined}
        size="chat"
        tone={resolved ? "muted" : "warn"}
      >
        <MessagesSquare size={15} />
      </IconBox>
      <div className="grid min-w-0 gap-1.5">
        <p className="text-sm font-semibold text-ink" id={titleId}>
          {t("item.connectorWrite.title")}
        </p>
        <p className="min-w-0 text-sm leading-[1.45] text-ink">{request}</p>
        {quote ? (
          <p className="min-w-0 whitespace-pre-wrap break-words border-l-2 border-line-soft pl-2 text-sm text-ink">
            {quote}
          </p>
        ) : null}
        {action === "write" && detail?.preview?.length ? (
          <ClampedText
            clamp={4}
            className="fdy-connector-write-preview"
            size="xs"
            tone="muted"
          >
            {detail.preview.join("\n")}
          </ClampedText>
        ) : null}
        {action === "write" && detail?.body ? (
          <Disclosure className="fdy-connector-write-body">
            <DisclosureSummary>
              {t("item.connectorWrite.bodyDetails")}
            </DisclosureSummary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-2xs text-ink-muted">
              {detail.body}
            </pre>
          </Disclosure>
        ) : null}
        <PendingItemRef item={item} />
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-2xs leading-[1.4] text-ink-faint">
          <span className="text-ink-muted">{from}</span>
          <span aria-hidden="true">·</span>
          {showOrigin ? (
            <>
              <span className="text-ink">
                {t(`item.origin.${origin.kind}`, { name: origin.name })}
              </span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <time
            className="tabular-nums"
            dateTime={
              resolved ? item.resolvedAt : (detail?.expiresAt ?? item.createdAt)
            }
            title={
              resolved ? item.resolvedAt : (detail?.expiresAt ?? item.createdAt)
            }
          >
            {resolved
              ? t("item.resolved", {
                  state: t(`state.${item.state}`),
                  when: relativeWhen(item.resolvedAt || item.updatedAt),
                })
              : detail?.expiresAt
                ? t("item.connectorWrite.expires", {
                    when: relativeWhen(detail.expiresAt),
                  })
                : t("item.connectorWrite.requested", {
                    when: relativeWhen(item.createdAt),
                  })}
          </time>
        </p>
        {!resolved ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Button
              data-busy={busy === "decide" ? "true" : undefined}
              disabled={Boolean(busy)}
              onClick={() => void decide(true)}
              size="sm"
            >
              <Check aria-hidden="true" size={14} />
              {t("item.connectorWrite.allow")}
            </Button>
            <Button
              disabled={Boolean(busy)}
              onClick={() => void decide(false)}
              size="sm"
              variant="ghost"
            >
              <X aria-hidden="true" size={14} />
              {t("item.connectorWrite.decline")}
            </Button>
          </div>
        ) : null}
        {error ? (
          <p className="text-xs text-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </article>
  );
}
