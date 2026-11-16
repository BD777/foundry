import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, CircleHelp, LoaderCircle, Minus } from "lucide-react";
import type { PersonalAgentItem } from "@bd777/foundry-protocol";
import { ContextRowIcon } from "../../components/ui/context-card";
import { Checkbox } from "../../components/ui/field";
import { itemMark } from "./items-model";

/** Who has the item, in the person's words. */
export function ownerLabel(
  owner: PersonalAgentItem["owner"],
  t: TFunction<"personalAgent">,
): string {
  return t(owner === "person" ? "items.card.you" : "items.owner.assistant");
}

/** Where the item started, in names the person knows; never ids. */
export function originLabel(
  item: PersonalAgentItem,
  t: TFunction<"personalAgent">,
): string {
  const origin = item.origin;
  if (!origin) return "";
  if (origin.kind === "channel")
    return origin.requester
      ? t("items.origin.channel", {
          name: origin.name || origin.source || "",
          requester: origin.requester,
        })
      : t("items.origin.channelOnly", {
          name: origin.name || origin.source || "",
        });
  if (origin.kind === "self_chat") return t("items.origin.selfChat");
  return t("items.origin.web");
}

/** A helper's status in words; a status the Web does not know is shown as the server names it. */
export function helperStatusLabel(
  status: string,
  t: TFunction<"personalAgent">,
): string {
  switch (status) {
    case "queued":
      return t("items.helper.status.queued");
    case "running":
      return t("items.helper.status.running");
    case "asking":
      return t("items.helper.status.asking");
    case "done":
      return t("items.helper.status.done");
    case "failed":
      return t("items.helper.status.failed");
    case "cancelled":
      return t("items.helper.status.cancelled");
    default:
      return status;
  }
}

/** An item's status word, for the timeline's status changes. */
export function itemStatusLabel(
  status: string | undefined,
  t: TFunction<"personalAgent">,
): string {
  switch (status) {
    case "open":
      return t("items.status.open");
    case "done":
      return t("items.status.done");
    case "dropped":
      return t("items.status.dropped");
    default:
      return status ?? "";
  }
}

/** The item's state in one word: the derived one while open, its end once closed. */
export function stateLabel(
  item: PersonalAgentItem,
  t: TFunction<"personalAgent">,
): string {
  if (item.status === "done") return t("items.status.done");
  if (item.status === "dropped") return t("items.status.dropped");
  const mark = itemMark(item);
  // Open and not being worked on is to do; 「进行中」 is only for a running helper.
  if (mark.kind === "person") return t("items.status.todo");
  if (mark.state === "asking") return t("items.helper.status.asking");
  if (mark.state === "running")
    return t(
      mark.helper?.status === "queued"
        ? "items.helper.status.queued"
        : "items.helper.status.running",
    );
  return t("items.status.todo");
}

/**
 * The assistant's state for one open item: a question, a spinner, or a quiet
 * dot. Never colour alone: the row's words say the same.
 */
export function AssistantMark({
  state,
}: {
  state: "asking" | "running" | "idle";
}) {
  if (state === "asking")
    return (
      <ContextRowIcon tone="brass">
        <CircleHelp aria-hidden="true" size={15} />
      </ContextRowIcon>
    );
  if (state === "running")
    return (
      <ContextRowIcon tone="neutral">
        <LoaderCircle
          aria-hidden="true"
          className="animate-spin-slow motion-reduce:animate-none"
          size={15}
        />
      </ContextRowIcon>
    );
  return (
    <ContextRowIcon tone="neutral">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-ink-faint" />
    </ContextRowIcon>
  );
}

/** A closed item's mark: done is a tick, dropped a dash. */
export function ClosedMark({ done }: { done: boolean }) {
  return done ? (
    <ContextRowIcon tone="green">
      <Check aria-hidden="true" size={15} />
    </ContextRowIcon>
  ) : (
    <ContextRowIcon tone="muted">
      <Minus aria-hidden="true" size={15} />
    </ContextRowIcon>
  );
}

/**
 * The lead of an item row, the same width on every row: a checkbox for an
 * open item the person owns (tick = done), the assistant's state for one
 * it owns, and a tick or dash once it is closed.
 */
export function ItemLead({
  busy = false,
  item,
  onTick,
}: {
  busy?: boolean;
  item: PersonalAgentItem;
  onTick?: (item: PersonalAgentItem) => void;
}) {
  const { t } = useTranslation("personalAgent");
  let mark;
  if (item.status !== "open")
    mark = <ClosedMark done={item.status === "done"} />;
  else if (itemMark(item).kind === "person")
    mark = (
      <Checkbox
        aria-label={t("items.card.tick", { text: item.text })}
        checked={false}
        disabled={busy || !onTick}
        onChange={() => onTick?.(item)}
      />
    );
  else {
    const assistant = itemMark(item);
    mark = (
      <AssistantMark
        state={assistant.kind === "assistant" ? assistant.state : "idle"}
      />
    );
  }
  return <span className="flex w-7 flex-none justify-center">{mark}</span>;
}
