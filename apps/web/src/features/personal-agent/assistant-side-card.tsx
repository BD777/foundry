import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { PersonalAgentNeedsYouItem } from "@bd777/foundry-protocol";
import {
  ContextHeading,
  ContextHeadingAction,
  ContextList,
  ContextRow,
  ContextRowCopy,
  ContextSection,
} from "../../components/ui/context-card";
import { pendingHref } from "../../lib/in-app-navigation";

/** The titles the entry lists under its count: the newest three. */
const LISTED_TITLES = 3;

/**
 * 「等你处理」: the count the Needs you page shows, headed as the items
 * section is, its 「全部」 opening that page in a new tab so the assistant's
 * conversation stays (DEV-254), then the newest titles; each opens its item where it was found. Nothing at zero: the
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
