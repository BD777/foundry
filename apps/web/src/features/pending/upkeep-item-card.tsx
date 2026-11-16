import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Brain, FilePenLine } from "lucide-react";
import type { PendingItem } from "../../api";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { FieldHint } from "../../components/ui/field";
import { IconBox } from "../../components/ui/icon-box";
import { navigateAppRoute } from "../../lib/in-app-navigation";

/**
 * One upkeep item's row: its title, a line of why, and the one action that
 * settles it (DEV-256). Project and memory upkeep share this layout.
 */
function UpkeepRow({
  item,
  icon,
  title,
  reason,
  action,
  onAction,
  disabled = false,
}: {
  item: PendingItem;
  icon: ReactNode;
  title: string;
  reason: string;
  action: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  const titleId = useId();
  return (
    <article
      aria-labelledby={titleId}
      className="fdy-pending-item fdy-pending-item-upkeep grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-4 py-3.5 not-first:border-t not-first:border-line-soft max-[640px]:px-3"
      data-source={item.source}
      data-state={item.state}
    >
      <IconBox aria-hidden="true" size="chat" tone="warn">
        {icon}
      </IconBox>
      <div className="grid min-w-0 gap-1.5">
        <p
          className="text-sm leading-[1.45] font-semibold text-ink"
          id={titleId}
        >
          {title}
        </p>
        <FieldHint className="m-0 leading-[1.6]">{reason}</FieldHint>
        <ButtonRow>
          <Button
            disabled={disabled}
            onClick={onAction}
            size="sm"
            variant="secondary"
          >
            {action}
          </Button>
        </ButtonRow>
      </div>
    </article>
  );
}

/**
 * A project's suggested file changes waiting for the person (DEV-256). One
 * item per project: it closes when every suggestion is applied or dismissed
 * on that project's page, so its only action opens the page.
 */
export function UpkeepItemCard({ item }: { item: PendingItem }) {
  const { t } = useTranslation("pending");
  return (
    <UpkeepRow
      action={t("upkeep.open")}
      icon={<FilePenLine size={15} />}
      item={item}
      onAction={() => navigateAppRoute({ view: "workspace" }, item.workspaceId)}
      reason={t("upkeep.reason")}
      title={t("upkeep.title", { project: item.title, count: item.count ?? 0 })}
    />
  );
}

/**
 * An assistant's memory suggestions waiting for the person (DEV-256). One item
 * per assistant, counting its findings in both memory layers; its action opens
 * that assistant's settings at the memory-maintenance section (activity).
 */
export function MemoryUpkeepItemCard({ item }: { item: PendingItem }) {
  const { t } = useTranslation("pending");
  return (
    <UpkeepRow
      action={t("memoryUpkeep.open")}
      disabled={!item.assistantId}
      icon={<Brain size={15} />}
      item={item}
      onAction={() =>
        navigateAppRoute({
          view: "assistantSettings",
          assistantId: item.assistantId ?? "",
          assistantSection: "activity",
        })
      }
      reason={t("memoryUpkeep.reason")}
      title={t("memoryUpkeep.title", {
        assistant: item.title,
        count: item.count ?? 0,
      })}
    />
  );
}
