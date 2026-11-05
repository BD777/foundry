import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Inbox } from "lucide-react";
import { Button } from "../../components/ui/button";
import { PendingItemCard } from "./pending-item-card";
import { openPendingItem } from "./pending-feature";
import { pendingForSession, pendingHeadline } from "./pending-model";
import type { PendingItems } from "./use-pending-items";

/**
 * What the open chat waits for the person on, pinned above its composer:
 * however much other traffic scrolls the transcript, the line stays. It
 * opens into the items themselves (reply, mark done, dismiss, open the
 * message). Nothing shows while the chat has no open item.
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
  const items = useMemo(
    () =>
      pendingForSession(pending.list?.items ?? [], sessionId).filter(
        (item) => item.state === "open",
      ),
    [pending.list, sessionId],
  );
  if (items.length === 0) return null;
  const first = pendingHeadline(items[0]!);
  return (
    <section
      aria-label={t("chat.title")}
      className="mb-1.5 grid min-w-0 gap-1 border-b border-line-soft pb-1.5"
    >
      <Button
        aria-expanded={open}
        className="w-full min-w-0 justify-start gap-2 px-1 text-xs"
        onClick={() => setOpen((current) => !current)}
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
        <span className="min-w-0 flex-1 truncate text-left text-ink-muted">
          {first.pathDenied
            ? t("item.permissionDenied", { path: first.pathDenied })
            : first.text}
        </span>
        {open ? (
          <ChevronUp aria-hidden="true" className="flex-none" size={14} />
        ) : (
          <ChevronDown aria-hidden="true" className="flex-none" size={14} />
        )}
      </Button>
      {open ? (
        <div className="grid max-h-[45vh] min-w-0 overflow-y-auto">
          {items.map((item) => (
            <PendingItemCard
              item={item}
              key={item.id}
              onOpenMessage={(target) => {
                setOpen(false);
                openPendingItem(target);
              }}
              pending={pending}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
