import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Inbox,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { PendingItemCard } from "./pending-item-card";
import { openPendingItem } from "./pending-feature";
import { pendingForSession, pendingHeadline } from "./pending-model";
import type { PendingItems } from "./use-pending-items";

/**
 * What the open chat waits for the person on, pinned above its composer:
 * however much other traffic scrolls the transcript, the line stays. It
 * opens into one item at a time, in the compact density of the shared item
 * (its options, reply and "…" menu), with "1 of 3" to step through the rest,
 * so the composer keeps its room. Nothing shows while the chat has no open
 * item.
 */
export function PendingChatBar({
  pending,
  sessionId,
}: {
  pending: PendingItems;
  sessionId: string;
}) {
  const { t } = useTranslation("pending");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const items = useMemo(
    () =>
      pendingForSession(pending.list?.items ?? [], sessionId).filter(
        (item) => item.state === "open",
      ),
    [pending.list, sessionId],
  );
  if (items.length === 0) return null;
  const at = Math.min(index, items.length - 1);
  const current = items[at]!;
  const first = pendingHeadline(items[0]!);
  return (
    <section
      aria-label={t("chat.title")}
      className="mb-1.5 grid min-w-0 gap-0.5 border-b border-line-soft pb-1"
    >
      <div className="flex min-w-0 items-center gap-1">
        <Button
          aria-expanded={open}
          className="min-w-0 flex-1 justify-start gap-2 px-1 text-xs"
          onClick={() => setOpen((value) => !value)}
          size="sm"
          variant="ghost"
        >
          <Inbox
            aria-hidden="true"
            className="flex-none text-brand-dark"
            size={14}
          />
          <strong className="flex-none font-[650] text-ink">
            {t("chat.bar", { count: items.length })}
          </strong>
          {open ? (
            <span className="min-w-0 flex-1" />
          ) : (
            <span className="min-w-0 flex-1 truncate text-left text-ink-muted">
              {first.pathDenied
                ? t("item.permissionDenied", { path: first.pathDenied })
                : first.text}
            </span>
          )}
          {open ? (
            <ChevronUp aria-hidden="true" className="flex-none" size={14} />
          ) : (
            <ChevronDown aria-hidden="true" className="flex-none" size={14} />
          )}
        </Button>
        {open && items.length > 1 ? (
          <div
            aria-label={t("chat.stepper")}
            className="flex flex-none items-center gap-0.5 text-2xs text-ink-muted tabular-nums"
            role="group"
          >
            <Button
              aria-label={t("chat.previous")}
              disabled={at === 0}
              onClick={() => setIndex(at - 1)}
              className="size-7"
              size="icon"
              variant="icon"
            >
              <ChevronLeft aria-hidden="true" size={15} />
            </Button>
            <span aria-live="polite">
              {t("chat.position", { index: at + 1, count: items.length })}
            </span>
            <Button
              aria-label={t("chat.next")}
              disabled={at === items.length - 1}
              onClick={() => setIndex(at + 1)}
              className="size-7"
              size="icon"
              variant="icon"
            >
              <ChevronRight aria-hidden="true" size={15} />
            </Button>
          </div>
        ) : null}
      </div>
      {open ? (
        <div className="max-h-[40vh] min-w-0 overflow-y-auto">
          <PendingItemCard
            density="compact"
            item={current}
            key={current.id}
            onOpenMessage={(target) => {
              setOpen(false);
              openPendingItem(target);
            }}
            pending={pending}
            where="chat"
          />
        </div>
      ) : null}
    </section>
  );
}
