import { useTranslation } from "react-i18next";
import { ArrowUpRight } from "lucide-react";
import type { PersonalAgentItem } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import {
  ContextLinkRow,
  ContextList,
  ContextRowCopy,
} from "../../components/ui/context-card";
import { Subheading } from "../../components/ui/subheading";
import { pendingHref } from "../../lib/in-app-navigation";
import { relativeWhen } from "../../lib/time-format";

/** How many Needs you entries wait on the person for an item, on its list row. */
export function ItemNeedsYouBadge({ item }: { item: PersonalAgentItem }) {
  const { t } = useTranslation("personalAgent");
  const count = item.needsYou?.length ?? 0;
  if (!count) return null;
  return <Badge tone="warn">{t("items.needsYou.count", { count })}</Badge>;
}

/**
 * The Needs you entries stuck on an item, each opening Needs you in a new tab,
 * where it is answered. Nothing when none waits.
 */
export function ItemNeedsYou({ item }: { item: PersonalAgentItem }) {
  const { t } = useTranslation("personalAgent");
  const entries = item.needsYou ?? [];
  if (!entries.length) return null;
  return (
    <section className="grid gap-2">
      <Subheading size="group">
        {t("items.needsYou.count", { count: entries.length })}
      </Subheading>
      <ContextList className="list-none gap-1">
        {entries.map((entry) => (
          <div key={entry.id}>
            <ContextLinkRow
              aria-label={`${entry.title} · ${t("items.needsYou.open")}`}
              href={pendingHref()}
              rel="noopener"
              target="_blank"
              title={entry.title}
            >
              <ContextRowCopy
                detail={relativeWhen(entry.createdAt)}
                title={entry.title}
              />
              <ArrowUpRight
                aria-hidden="true"
                className="flex-none text-ink-faint"
                size={14}
              />
            </ContextLinkRow>
          </div>
        ))}
      </ContextList>
    </section>
  );
}
