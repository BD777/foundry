import { useTranslation } from "react-i18next";
import type { PendingItem } from "../../api";
import { AppLink } from "../../components/ui/app-link";
import { itemHref } from "../../lib/in-app-navigation";

/**
 * The open item an entry is stuck on, as a link to that item on a line of its
 * own above the entry's facts, so a long item title never splits them.
 * Nothing when its session works on none.
 */
export function PendingItemRef({ item }: { item: PendingItem }) {
  const { t } = useTranslation("pending");
  if (!item.itemId) return null;
  return (
    <p className="min-w-0 truncate text-2xs leading-[1.4]">
      <AppLink
        className="font-medium text-ink underline underline-offset-2 hover:text-brand"
        href={itemHref(item.itemId)}
        title={item.itemText}
      >
        {t("item.itemRef", { text: item.itemText || item.itemId })}
      </AppLink>
    </p>
  );
}
