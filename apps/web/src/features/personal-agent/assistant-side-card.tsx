import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { PendingItem } from "../../api";
import {
  ContextHeading,
  ContextHeadingAction,
  ContextList,
  ContextRow,
  ContextRowCopy,
  ContextSection,
} from "../../components/ui/context-card";
import { pendingHref } from "../../lib/in-app-navigation";
import { pendingTitle } from "../../lib/pending-display";

/**
 * The requests that need the person, as the sidebar counts them: its count
 * and the open requests it counts, newest first (notices are not among them).
 */
export interface NeedsYouRequests {
  count: number;
  items: readonly PendingItem[];
}

/** The titles the entry lists under its count: the newest three. */
const LISTED_TITLES = 3;

/**
 * 「等你处理」: the count the Needs you page shows, headed as the items
 * section is, its 「全部」 opening that page in a new tab so the assistant's
 * conversation stays (DEV-254), then the newest titles, as the page heads
 * them; each opens its item where it was found. The count and the rows are
 * the sidebar's, so the numbers agree. Nothing at zero: the sidebar entry
 * already says it.
 */
export function NeedsYouSection({
  count,
  items = [],
  onOpenItem,
}: {
  count: number;
  items?: readonly PendingItem[];
  onOpenItem: (itemId: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const { t: tPending } = useTranslation("pending");
  if (count <= 0) return null;
  return (
    <ContextSection aria-label={t("home.needsYou.label")}>
      <ContextHeading
        action={
          <ContextHeadingAction
            href={pendingHref()}
            label={t("home.needsYou.open")}
          >
            {t("items.card.all")}
          </ContextHeadingAction>
        }
        count={count}
      >
        {t("home.needsYou.title")}
      </ContextHeading>
      {items.length ? (
        <ContextList className="gap-0.5">
          {items.slice(0, LISTED_TITLES).map((item) => {
            const title = pendingTitle(item, tPending);
            return (
              <ContextRow
                key={item.id}
                onClick={() => onOpenItem(item.id)}
                title={title}
              >
                <ContextRowCopy title={title} />
                <ChevronRight
                  aria-hidden="true"
                  className="flex-none text-ink-faint"
                  size={14}
                />
              </ContextRow>
            );
          })}
        </ContextList>
      ) : null}
    </ContextSection>
  );
}
