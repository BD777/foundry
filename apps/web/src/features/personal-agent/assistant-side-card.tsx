import { useTranslation } from "react-i18next";
import { ChevronRight, Inbox } from "lucide-react";
import type { PersonalAgentNeedsYouItem } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import {
  ContextLinkRow,
  ContextList,
  ContextRow,
  ContextRowCopy,
  ContextRowIcon,
  ContextSection,
} from "../../components/ui/context-card";
import { pendingHref } from "../../lib/in-app-navigation";

/** The titles the entry lists under its count: the newest three. */
const LISTED_TITLES = 3;

/**
 * 「等你处理」: the count the Needs you page shows, as a link to it in a new
 * tab so the assistant's conversation stays (DEV-254), then the newest
 * titles; each opens its item where it was found. Nothing at zero: the
 * sidebar entry already says it.
 */
export function NeedsYouSection({
  count,
  items = [],
  onOpenItem,
}: {
  count: number;
  items?: PersonalAgentNeedsYouItem[];
  onOpenItem: (itemId: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  if (count <= 0) return null;
  return (
    <ContextSection aria-label={t("home.needsYou.label")}>
      <ContextLinkRow
        href={pendingHref()}
        rel="noopener"
        target="_blank"
        title={t("home.needsYou.open")}
      >
        <ContextRowIcon tone="brass">
          <Inbox aria-hidden="true" size={15} />
        </ContextRowIcon>
        <ContextRowCopy title={t("home.needsYou.title")} />
        <Badge dot={false} size="xs" tone="neutral">
          {count}
        </Badge>
        <ChevronRight
          aria-hidden="true"
          className="flex-none text-ink-faint"
          size={14}
        />
      </ContextLinkRow>
      {items.length ? (
        <ContextList className="mt-2 gap-0.5">
          {items.slice(0, LISTED_TITLES).map((item) => (
            <ContextRow
              key={item.id}
              onClick={() => onOpenItem(item.id)}
              title={item.title}
            >
              <ContextRowCopy title={item.title} />
              <ChevronRight
                aria-hidden="true"
                className="flex-none text-ink-faint"
                size={14}
              />
            </ContextRow>
          ))}
        </ContextList>
      ) : null}
    </ContextSection>
  );
}
