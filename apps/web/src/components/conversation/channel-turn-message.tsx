import type { MessageChannelOrigin } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Disclosure, DisclosureSummary } from "../ui/disclosure";
import { clockTime } from "../../lib/time-format";

/**
 * A message channel turn (DEV-234): the source conversation, who sent its
 * latest message and when, and the batch's texts. The raw facts block the
 * agent received stays behind 「详情」, so it never reads as the person's own
 * message.
 */
export function ChannelTurnMessage({
  origin,
  rawText,
}: {
  origin: MessageChannelOrigin;
  rawText: string;
}) {
  const { t } = useTranslation("conversation");
  const conversation =
    origin.conversation.name ||
    t(`channelTurn.kind.${origin.conversation.kind}`, {
      defaultValue: origin.conversation.kind,
    });
  const last = origin.messages[origin.messages.length - 1];
  const sender = last?.sender.name || last?.sender.id;
  const at = last?.at || origin.at;
  const inThread = Boolean(origin.thread?.id || origin.thread?.isReply);
  const continued = !origin.sessionNew;
  return (
    <div className="grid min-w-0 gap-2 rounded-lg bg-inset px-3.5 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
        <span className="font-semibold text-ink">{origin.source}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 font-medium wrap-anywhere text-ink">
          {conversation}
        </span>
        {sender ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 wrap-anywhere">{sender}</span>
          </>
        ) : null}
        {at ? (
          <time dateTime={at} title={new Date(at).toLocaleString()}>
            {clockTime(at, { date: "short" })}
          </time>
        ) : null}
        {inThread ? (
          <Badge size="xs" tone="slate">
            {t("channelTurn.thread")}
          </Badge>
        ) : null}
        {continued ? (
          <Badge size="xs" tone="neutral">
            {t("channelTurn.continued")}
          </Badge>
        ) : null}
      </div>
      <ol className="m-0 grid list-none gap-2 p-0">
        {origin.messages.map((message, index) => (
          <li className="grid min-w-0 gap-0.5" key={message.id || index}>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-ink-muted">
              <span className="font-medium wrap-anywhere text-ink-2">
                {message.sender.name || message.sender.id}
              </span>
              {message.at ? (
                <time dateTime={message.at}>
                  {clockTime(message.at, { date: "short" })}
                </time>
              ) : null}
            </span>
            <p className="m-0 text-md leading-normal text-ink whitespace-pre-wrap [overflow-wrap:anywhere]">
              {message.text || t("channelTurn.noText")}
            </p>
          </li>
        ))}
      </ol>
      {rawText.trim() ? (
        <Disclosure>
          <DisclosureSummary>{t("channelTurn.details")}</DisclosureSummary>
          <pre className="max-h-72 overflow-auto rounded-md bg-control-ghost-hover p-2 text-xs leading-normal whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
            {rawText}
          </pre>
        </Disclosure>
      ) : null}
    </div>
  );
}
