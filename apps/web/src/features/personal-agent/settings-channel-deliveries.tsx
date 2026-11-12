import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import type {
  MessageChannelDelivery,
  MessageChannelDeliveryStatus,
} from "@bd777/foundry-protocol";
import { listMessageChannelDeliveries, releaseMessageChannel } from "../../api";
import { Alert } from "../../components/ui/alert";
import { AppLink } from "../../components/ui/app-link";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { DividedList } from "../../components/ui/divided-list";
import { Skeleton } from "../../components/ui/loading";
import { Switch } from "../../components/ui/switch";
import { ToastFeedback } from "../../components/ui/toast";
import { serverErrorText } from "../../lib/errors";
import { chatHref } from "../../lib/in-app-navigation";
import { clockTime, fullWhen } from "../../lib/time-format";
import { PaMuted } from "./pa-muted";

const statusTone: Record<MessageChannelDeliveryStatus, BadgeProps["tone"]> = {
  held: "warn",
  queued: "slate",
  delivered: "brass",
  done: "online",
  failed: "error",
  dropped: "neutral",
};

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

/**
 * A channel's latest messages, newest first: what came in, what happened to
 * it and what its session did. Unmatched ones are shown on request, so the
 * person can find a conversation's id for a rule.
 */
export function ChannelDeliveries({
  assistantId,
  channelId,
  held,
  homeWorkspaceId,
  onReleased,
}: {
  assistantId?: string;
  channelId: string;
  /** Messages held back by a limit in the last 24 hours. */
  held: number;
  homeWorkspaceId?: string;
  onReleased: () => void;
}) {
  const { t } = useTranslation("personalAgent");
  const [dropped, setDropped] = useState(false);
  const [deliveries, setDeliveries] = useState<MessageChannelDelivery[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState("");
  const [released, setReleased] = useState<number>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listMessageChannelDeliveries(
        assistantId,
        channelId,
        dropped,
      );
      setDeliveries(list.deliveries);
      setError("");
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setLoading(false);
    }
  }, [assistantId, channelId, dropped]);

  useEffect(() => {
    void load();
  }, [load]);

  async function release(): Promise<void> {
    setReleasing(true);
    setReleaseError("");
    try {
      const result = await releaseMessageChannel(assistantId, channelId);
      setReleased(result.released);
      onReleased();
      void load();
    } catch (reason) {
      setReleaseError(serverErrorText(reason));
    } finally {
      setReleasing(false);
    }
  }

  const hasHeld =
    held > 0 || (deliveries ?? []).some((entry) => entry.status === "held");

  return (
    <div className="grid min-w-0 gap-3 rounded-lg bg-inset p-3.5">
      <ButtonRow className="justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-ink">
          <Switch checked={dropped} onCheckedChange={setDropped} />
          <span>{t("settings.channels.deliveries.showDropped")}</span>
        </label>
        <ButtonRow>
          {hasHeld ? (
            <Button
              busy={releasing}
              disabled={releasing}
              onClick={() => void release()}
              size="sm"
              variant="secondary"
            >
              {releasing
                ? t("settings.channels.deliveries.releasing")
                : t("settings.channels.deliveries.release")}
            </Button>
          ) : null}
          <Button
            busy={loading}
            disabled={loading}
            onClick={() => void load()}
            size="sm"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" size={14} />
            {t("settings.channels.deliveries.refresh")}
          </Button>
        </ButtonRow>
      </ButtonRow>
      {released !== undefined ? (
        <ToastFeedback
          title={t("settings.channels.deliveries.released", {
            count: released,
          })}
          tone="success"
        />
      ) : null}
      {releaseError ? (
        <ToastFeedback
          title={t("settings.channels.deliveries.releaseFailed")}
          tone="error"
        >
          {releaseError}
        </ToastFeedback>
      ) : null}
      {error ? (
        <Alert
          size="compact"
          title={t("settings.channels.deliveries.loadFailed")}
          tone="error"
        >
          {error}
        </Alert>
      ) : null}
      {deliveries === undefined ? (
        error ? null : (
          <Skeleton
            className="h-16"
            label={t("settings.channels.deliveries.loading")}
          />
        )
      ) : deliveries.length === 0 ? (
        <PaMuted>{t("settings.channels.deliveries.empty")}</PaMuted>
      ) : (
        <DividedList density="compact">
          {deliveries.map((delivery) => (
            <DeliveryRow
              delivery={delivery}
              homeWorkspaceId={homeWorkspaceId}
              key={delivery.id}
            />
          ))}
        </DividedList>
      )}
    </div>
  );
}

function DeliveryRow({
  delivery,
  homeWorkspaceId,
}: {
  delivery: MessageChannelDelivery;
  homeWorkspaceId?: string;
}) {
  const { t } = useTranslation("personalAgent");
  const { envelope } = delivery;
  const kind = t(
    `settings.channels.editor.kind.${envelope.conversation.kind}`,
    {
      defaultValue: envelope.conversation.kind,
    },
  );
  const conversation = envelope.conversation.name
    ? envelope.conversation.name
    : `${kind} · ${envelope.conversation.id}`;
  const reason = delivery.reason
    ? t(`settings.channels.deliveries.reasons.${delivery.reason}`, {
        defaultValue: delivery.reason,
      })
    : "";
  const showReason =
    reason &&
    (delivery.status === "queued" ||
      delivery.status === "failed" ||
      delivery.status === "dropped");
  const text = firstLine(envelope.text);
  const at = envelope.occurredAt || delivery.createdAt;
  const sessionId = delivery.sessionId;

  return (
    <li className="grid min-w-0 gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <time className="text-ink-muted" dateTime={at} title={fullWhen(at)}>
          {clockTime(at, { date: "short" })}
        </time>
        <span className="min-w-0 font-medium wrap-anywhere text-ink">
          {conversation}
        </span>
        {envelope.sender.name &&
        envelope.sender.name !== envelope.conversation.name ? (
          <span className="text-ink-muted">{envelope.sender.name}</span>
        ) : null}
        <Badge size="xs" tone={statusTone[delivery.status] ?? "neutral"}>
          {t(`settings.channels.deliveries.status.${delivery.status}`, {
            defaultValue: delivery.status,
          })}
          {showReason ? ` · ${reason}` : ""}
        </Badge>
      </div>
      {delivery.status === "dropped" ? (
        <PaMuted size="xs">
          {[
            envelope.conversation.name
              ? `${kind} · ${envelope.conversation.id}`
              : "",
            envelope.mentionsMe
              ? t("settings.channels.deliveries.mentionsMe")
              : "",
            envelope.sender.isSelf
              ? t("settings.channels.deliveries.fromSelf")
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </PaMuted>
      ) : (
        <PaMuted className="truncate" size="xs" tone="ink">
          {text || t("settings.channels.deliveries.noText")}
        </PaMuted>
      )}
      {delivery.actions?.length ? (
        <ul className="grid gap-0.5 text-xs text-ink-muted">
          {delivery.actions.map((action) => (
            <li className="wrap-anywhere" key={`${action.at}:${action.kind}`}>
              <span className="font-medium text-ink">
                {t(`settings.channels.deliveries.actions.${action.kind}`, {
                  defaultValue: action.kind,
                })}
              </span>
              {action.summary ? ` · ${action.summary}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {sessionId ? (
        <Button
          asChild
          className="justify-self-start text-xs"
          size="inline"
          variant="link"
        >
          <AppLink href={chatHref(sessionId, homeWorkspaceId)}>
            {t("settings.channels.deliveries.openSession")}
            <ArrowUpRight aria-hidden="true" size={13} />
          </AppLink>
        </Button>
      ) : null}
    </li>
  );
}
