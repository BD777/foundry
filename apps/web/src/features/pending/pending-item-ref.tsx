import { useTranslation } from "react-i18next";
import type { PendingItem } from "../../api";
import { AppLink } from "../../components/ui/app-link";
import { itemHref } from "../../lib/in-app-navigation";

/**
 * The open item an entry is stuck on, as a link to that item, then the
 * separator before the next fact. Nothing when its session works on none.
 */
export function PendingItemRef({ item }: { item: PendingItem }) {
  const { t } = useTranslation("pending");
  if (!item.itemId) return null;
  return (
    <>
      <AppLink
        className="min-w-0 truncate font-medium text-ink underline underline-offset-2 hover:text-brand"
        href={itemHref(item.itemId)}
        title={item.itemText}
      >
        {t("item.itemRef", { text: item.itemText || item.itemId })}
      </AppLink>
      <span aria-hidden="true">·</span>
    </>
  );
}
