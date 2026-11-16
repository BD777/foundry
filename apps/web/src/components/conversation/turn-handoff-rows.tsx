import { CornerDownRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { chatHref } from "../../lib/in-app-navigation";
import { Button } from "../ui/button";
import type { TurnHandoffKind, TurnHandoffView } from "./turn-handoffs";

type Translate = ReturnType<typeof useTranslation<"conversation">>["t"];

/** A failed handoff in words, by the work it tried to hand over. */
function failureLabel(kind: TurnHandoffKind, t: Translate): string {
  switch (kind) {
    case "create_session":
      return t("handoff.createdFailed");
    case "send_message":
      return t("handoff.messagedFailed");
    case "dispatch_item":
      return t("handoff.dispatchedFailed");
  }
}

/** A result status in words; one this build does not know shows nothing. */
function statusLabel(
  status: string | undefined,
  t: Translate,
): string | undefined {
  switch (status) {
    case "queued":
    case "pending":
    case "dispatching":
    case "running":
      return t("handoff.status.running");
    case "completed":
    case "delivered":
      return t("handoff.status.completed");
    case "failed":
      return t("handoff.status.failed");
    case "canceled":
    case "cancelled":
      return t("handoff.status.canceled");
    default:
      return undefined;
  }
}

function deliveryLabel(
  delivery: TurnHandoffView["delivery"],
  t: Translate,
): string | undefined {
  switch (delivery) {
    case "interrupt":
      return t("handoff.delivery.interrupt");
    case "turn_end":
      return t("handoff.delivery.turnEnd");
    default:
      return undefined;
  }
}

/** A session title that opens the conversation in its own tab. */
function SessionLink({
  handoff,
  label,
  t,
}: {
  handoff: TurnHandoffView;
  label: string;
  t: Translate;
}) {
  if (!handoff.sessionId)
    return <span className="font-medium text-ink">{label}</span>;
  return (
    <Button asChild size="inline" variant="link">
      <a
        href={chatHref(handoff.sessionId, handoff.workspaceId)}
        rel="noreferrer"
        target="_blank"
        title={t("handoff.openSession", { title: label })}
      >
        {label}
      </a>
    </Button>
  );
}

function HandoffRow({ handoff }: { handoff: TurnHandoffView }) {
  const { t } = useTranslation("conversation");
  const muted = Boolean(handoff.failed);
  if (muted) {
    return (
      <span className="min-w-0 text-ink-faint [overflow-wrap:anywhere]">
        {failureLabel(handoff.kind, t)}
        {handoff.failure ? (
          <>
            {t("handoff.reasonSeparator")}
            {handoff.failure}
          </>
        ) : null}
      </span>
    );
  }
  if (handoff.kind === "dispatch_item") {
    return (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span>{t("handoff.dispatched")}</span>
        {handoff.workspace ? (
          <span className="text-ink-faint">{handoff.workspace}</span>
        ) : null}
        {handoff.itemTitle ? (
          <>
            <span className="text-ink-faint">{t("handoff.itemSeparator")}</span>
            <SessionLink handoff={handoff} label={handoff.itemTitle} t={t} />
          </>
        ) : null}
      </span>
    );
  }
  const created = handoff.kind === "create_session";
  const title =
    handoff.title ??
    (created ? t("handoff.newSession") : t("handoff.anotherSession"));
  const status = created ? statusLabel(handoff.status, t) : undefined;
  const delivery = deliveryLabel(handoff.delivery, t);
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      <span>{t(created ? "handoff.created" : "handoff.messaged")}</span>
      <SessionLink handoff={handoff} label={title} t={t} />
      {handoff.workspace ? (
        <span className="text-ink-faint">· {handoff.workspace}</span>
      ) : null}
      {delivery ? <span className="text-ink-faint">· {delivery}</span> : null}
      {status ? <span className="text-ink-faint">· {status}</span> : null}
    </span>
  );
}

/**
 * A turn's handoffs, under its answer and outside the collapsed process
 * group: compact rows, one per session or workspace it handed work to
 * (DEV-250). Several handoffs are several rows; none, no row.
 */
export function TurnHandoffRows({
  className,
  handoffs,
}: {
  className?: string;
  handoffs?: TurnHandoffView[];
}) {
  if (!handoffs?.length) return null;
  return (
    <div
      className={cn("mt-2 grid min-w-0 gap-1", className)}
      data-handoff-rows=""
    >
      {handoffs.map((handoff) => (
        <div
          className="flex min-w-0 items-start gap-1.5 text-xs leading-[1.5] text-ink-muted"
          data-handoff-kind={handoff.kind}
          key={handoff.id}
        >
          <CornerDownRight
            aria-hidden="true"
            className="mt-[3px] flex-none text-ink-faint"
            size={12}
          />
          <HandoffRow handoff={handoff} />
        </div>
      ))}
    </div>
  );
}
