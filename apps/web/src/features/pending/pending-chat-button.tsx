import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Inbox } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { PendingItemCard } from "./pending-item-card";
import { openPendingItem } from "./pending-feature";
import { pendingForSession } from "./pending-model";
import type { PendingItems } from "./use-pending-items";

/**
 * The open chat's pending items: a labelled count in its header that opens
 * them in a dialog. It shows nothing while the chat has no open item.
 */
export function PendingChatButton({
  pending,
  sessionId,
}: {
  pending: PendingItems;
  sessionId: string;
}) {
  const { t } = useTranslation("pending");
  const [open, setOpen] = useState(false);
  const count = pending.list?.bySession[sessionId] ?? 0;
  const items = useMemo(
    () =>
      pendingForSession(pending.list?.items ?? [], sessionId).filter(
        (item) => item.state === "open",
      ),
    [pending.list, sessionId],
  );
  if (count === 0 && !open) return null;
  return (
    <>
      <Button
        aria-label={t("chat.buttonLabel", { count })}
        className="fdy-pending-chat-button"
        onClick={() => setOpen(true)}
        size="sm"
        variant="ghost"
      >
        <Inbox aria-hidden="true" size={14} />
        {t("chat.button", { count })}
      </Button>
      <Dialog
        description={t("chat.description")}
        onClose={() => setOpen(false)}
        open={open}
        size="wide"
        title={t("chat.title")}
      >
        {items.length === 0 ? (
          <p className="fdy-pending-chat-empty">{t("chat.empty")}</p>
        ) : (
          <div className="fdy-pending-group-items">
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
        )}
      </Dialog>
    </>
  );
}
