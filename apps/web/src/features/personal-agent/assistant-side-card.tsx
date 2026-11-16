import { useTranslation } from "react-i18next";
import { ChevronRight, Inbox } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import {
  ContextLinkRow,
  ContextRowCopy,
  ContextRowIcon,
  ContextSection,
} from "../../components/ui/context-card";
import { pendingHref } from "../../lib/in-app-navigation";

/**
 * 「等你处理」: one row with the count the Needs you page shows, and a link
 * to it, in a new tab so the assistant's conversation stays (DEV-254). The
 * page holds the items; a narrow sidebar only counts them. Nothing at zero:
 * the sidebar entry already says it.
 */
export function NeedsYouSection({ count }: { count: number }) {
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
    </ContextSection>
  );
}
