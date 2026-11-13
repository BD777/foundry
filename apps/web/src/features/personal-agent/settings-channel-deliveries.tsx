import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, RefreshCw, RotateCcw } from "lucide-react";
import type {
  MessageChannelDelivery,
  MessageChannelDeliveryStatus,
  MessageEnvelope,
} from "@bd777/foundry-protocol";
import {
  listMessageChannelDeliveries,
  releaseMessageChannel,
  startMessageChannelNewSession,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { AppLink } from "../../components/ui/app-link";
import { Badge, type BadgeProps } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { DividedList } from "../../components/ui/divided-list";
import { Skeleton } from "../../components/ui/loading";
import { Switch } from "../../components/ui/switch";
import { ToastFeedback } from "../../components/ui/toast";
import { Tooltip } from "../../components/ui/tooltip";
import { serverErrorText } from "../../lib/errors";
import { chatHref } from "../../lib/in-app-navigation";
import { clockTime, fullWhen } from "../../lib/time-format";
import { groupDeliveries, type DeliveryGroup } from "./channel-session-model";
import { PaMuted } from "./pa-muted";

type T = ReturnType<typeof useTranslation<"personalAgent">>["t"];

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

function conversationLabel(envelope: MessageEnvelope, t: T): string {
  const kind = t(
    `settings.channels.editor.kind.${envelope.conversation.kind}`,
    { defaultValue: envelope.conversation.kind },
  );
  return envelope.conversation.name || `${kind} · ${envelope.conversation.id}`;
}

/**
 * A channel's latest messages, grouped by the session they went to, newest
 * first: what came in, what happened to it, what its session did, and why
 * the session started. Unmatched ones are shown on request, so the person
 * can find a conversation's id for a rule.
 */
export function ChannelDeliveries({
  assistantId,
  channelId,
  held,
  workspaceId,
  onNotice,
  onReleased,
}: {
  assistantId?: string;
  channelId: string;
  /** Messages held back by a limit in the last 24 hours. */
  held: number;
  /** Where the channel's sessions run, to open them there. */
  workspaceId?: string;
  onNotice: (message: string) => void;
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
  const [renewing, setRenewing] = useState<string>();
  const [renewError, setRenewError] = useState("");

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

  async function startFresh(sessionKey: string, name: string): Promise<void> {
    setRenewing(sessionKey);
    setRenewError("");
    try {
      await startMessageChannelNewSession(assistantId, channelId, sessionKey);
      onNotice(t("settings.channels.deliveries.newSessionDone", { name }));
    } catch (reason) {
      setRenewError(serverErrorText(reason));
    } finally {
      setRenewing(undefined);
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
      {renewError ? (
        <ToastFeedback
          title={t("settings.channels.deliveries.newSessionFailed")}
          tone="error"
        >
          {renewError}
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
        <DividedList density="cozy">
          {groupDeliveries(deliveries).map((group) => (
            <SessionGroup
              group={group}
              key={group.key}
              onStartFresh={(sessionKey, name) =>
                void startFresh(sessionKey, name)
              }
              renewing={renewing}
              workspaceId={workspaceId}
            />
          ))}
        </DividedList>
      )}
    </div>
  );
}

/**
 * One session's messages under a line saying where they came from, whether
 * the session started here and why, a link to it and, on a conversation's
 * newest session, the choice to start fresh with its next message. A
 * message outside any session stands alone.
 */
function SessionGroup({
  group,
  renewing,
  workspaceId,
  onStartFresh,
}: {
  group: DeliveryGroup;
  renewing?: string;
  workspaceId?: string;
  onStartFresh: (sessionKey: string, name: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const newest = group.deliveries[0]!;
  if (!group.sessionKey && !group.sessionId)
    return <DeliveryRow delivery={newest} showConversation />;
  const name = conversationLabel(newest.envelope, t);
  const start = group.started
    ? group.newReason
      ? t("settings.channels.deliveries.sessionNew", {
          reason: t(
            `settings.channels.deliveries.newReasons.${group.newReason}`,
          ),
        })
      : t("settings.channels.deliveries.sessionNewPlain")
    : t("settings.channels.deliveries.sessionContinued");
  const sessionKey = group.sessionKey;
  return (
    <li className="grid min-w-0 gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="min-w-0 font-medium wrap-anywhere text-ink">
          {name}
        </span>
        <span className="text-ink-muted">{start}</span>
        {group.sessionId ? (
          <Button asChild className="text-xs" size="inline" variant="link">
            <AppLink href={chatHref(group.sessionId, workspaceId)}>
              {t("settings.channels.deliveries.openSession")}
              <ArrowUpRight aria-hidden="true" size={13} />
            </AppLink>
          </Button>
        ) : null}
        {group.latest && sessionKey ? (
          <Tooltip
            content={t("settings.channels.deliveries.newSessionHint")}
            variant="hint"
          >
            <Button
              busy={renewing === sessionKey}
              className="ms-auto"
              disabled={renewing !== undefined}
              onClick={() => onStartFresh(sessionKey, name)}
              size="sm"
              variant="ghost"
            >
              <RotateCcw aria-hidden="true" size={14} />
              {t("settings.channels.deliveries.newSession")}
            </Button>
          </Tooltip>
        ) : null}
      </div>
      <ul className="grid min-w-0 list-none gap-2.5 border-s border-line-soft p-0 ps-3">
        {group.deliveries.map((delivery) => (
          <DeliveryRow delivery={delivery} key={delivery.id} />
        ))}
      </ul>
    </li>
  );
}

function DeliveryRow({
  delivery,
  showConversation = false,
}: {
  delivery: MessageChannelDelivery;
  /** A message outside a session group names its conversation itself. */
  showConversation?: boolean;
}) {
  const { t } = useTranslation("personalAgent");
  const { envelope } = delivery;
  const kind = t(
    `settings.channels.editor.kind.${envelope.conversation.kind}`,
    {
      defaultValue: envelope.conversation.kind,
    },
  );
  const conversation = conversationLabel(envelope, t);
  const reason =
    delivery.reason && delivery.reason !== delivery.status
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

  return (
    <li className="grid min-w-0 gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <time className="text-ink-muted" dateTime={at} title={fullWhen(at)}>
          {clockTime(at, { date: "short" })}
        </time>
        {showConversation ? (
          <span className="min-w-0 font-medium wrap-anywhere text-ink">
            {conversation}
          </span>
        ) : null}
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
    </li>
  );
}
