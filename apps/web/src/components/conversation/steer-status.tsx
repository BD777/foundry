import { Check, CircleStop, MailCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSharedNow } from "../../lib/use-shared-now";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { ToastFeedback } from "../ui/toast";
import type { ConversationSteerState } from "./conversation-types";
import { formatDuration } from "./turn-usage";

/** Under a steered message: a hairline, then one quiet status line. */
const steerStatusClass =
  "mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-line pt-1.5 text-xs leading-[1.45] text-ink-muted tabular-nums";
const steerIconClass = "mt-0.5 flex-none";

/**
 * How long a Claude message waits behind one tool call before the person
 * is offered to stop the call so that Claude reads it now.
 */
export const steerStopOfferMs = 60_000;

/**
 * Under a message steered into a running turn: delivered and what it
 * waits for, then when the agent read it (DEV-089). While Claude waits
 * behind one long tool call, the person may stop that call: the copy says
 * the call is stopped, and the stop asks to confirm. Never automatic.
 */
export function SteerStatus({
  onStop,
  steer,
}: {
  /** Stops the tool call the message waits behind; absent: not offered. */
  onStop?: () => Promise<void>;
  steer: ConversationSteerState;
}) {
  const { t, i18n } = useTranslation("conversation");
  const waiting = steer.state === "waiting";
  const now = useSharedNow(waiting);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);
  const agent = steer.runtime === "codex" ? "Codex" : "Claude";
  if (!waiting) {
    const readAt = steer.readAt ? new Date(steer.readAt) : undefined;
    if (!readAt || Number.isNaN(readAt.getTime())) return null;
    return (
      <p
        className={cn(steerStatusClass, "gap-1.5 text-ink-faint")}
        data-state="read"
      >
        <Check aria-hidden="true" className={steerIconClass} size={13} />
        <span>
          {t("steer.read", {
            agent,
            time: readAt.toLocaleTimeString(i18n.language, { hour12: false }),
          })}
        </span>
      </p>
    );
  }
  const tool = steer.tool;
  const ran = tool
    ? formatDuration(Math.max(0, now - Date.parse(tool.startedAt)))
    : "";
  const elapsed = tool?.limitMs
    ? t("process.elapsedLimit", {
        elapsed: ran,
        limit: formatDuration(tool.limitMs),
      })
    : ran;
  const line = tool
    ? t(
        steer.moreTools
          ? `steer.waitingToolMore.${steer.runtime}`
          : `steer.waitingTool.${steer.runtime}`,
        { agent, tool: tool.name, elapsed, count: steer.moreTools ?? 0 },
      )
    : t(`steer.waitingStep.${steer.runtime}`, { agent });
  const offered =
    onStop &&
    tool &&
    (stopping ||
      confirming ||
      now - Date.parse(steer.deliveredAt) >= steerStopOfferMs);
  const stop = async () => {
    if (!onStop) return;
    setStopping(true);
    setError(undefined);
    try {
      await onStop();
      setConfirming(false);
    } catch (reason) {
      setStopping(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <div className={steerStatusClass} data-state="waiting">
      <p className="flex min-w-0 gap-1.5" role="status">
        <MailCheck aria-hidden="true" className={steerIconClass} size={13} />
        <span>
          {stopping ? t("steer.stopping", { tool: tool?.name }) : line}
        </span>
      </p>
      {offered && tool && !stopping ? (
        confirming ? (
          <div className="grid w-full gap-1.5">
            <p className="text-ink">
              {t("steer.stopConfirm", { agent, tool: tool.name })}
            </p>
            <span className="flex flex-wrap gap-1.5">
              <Button onClick={() => void stop()} size="sm" variant="danger">
                {t("steer.stopConfirmAction", { tool: tool.name })}
              </Button>
              <Button
                onClick={() => setConfirming(false)}
                ref={keepRef}
                size="sm"
                variant="ghost"
              >
                {t("steer.keepWaiting")}
              </Button>
            </span>
          </div>
        ) : (
          <Button
            onClick={() => setConfirming(true)}
            size="sm"
            variant="secondary"
          >
            <CircleStop aria-hidden="true" size={13} />
            {t("steer.stop", { tool: tool.name })}
          </Button>
        )
      ) : null}
      {error ? (
        <ToastFeedback
          tone="error"
          title={t("steer.stopFailed", { tool: tool?.name })}
        >
          {error}
        </ToastFeedback>
      ) : null}
    </div>
  );
}
