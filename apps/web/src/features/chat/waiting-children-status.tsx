import { Hourglass } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SessionWork } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";

/** The work rows for the direct child sessions this chat waits on. */
export function waitingChildWorkIds(items: readonly SessionWork[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of items) {
    if (
      item.kind !== "agent" ||
      item.source !== "foundry" ||
      !item.sourceId ||
      seen.has(item.id)
    )
      continue;
    seen.add(item.id);
    ids.push(item.id);
  }
  return ids;
}

/**
 * The waiting-child state, shared by chat rows and the open chat header.
 * The open chat's trigger reveals those rows in the context panel.
 */
export function WaitingChildrenStatus({
  className,
  compact = false,
  count,
  onOpen,
}: {
  className?: string;
  /** A list-row mark: icon and count, with the full wording in its label. */
  compact?: boolean;
  count: number;
  onOpen?: () => void;
}) {
  const { t } = useTranslation("chat");
  if (count <= 0) return null;
  const label = t("waitingChildren.count", { count });
  const headerLabel = t("waitingChildren.header", { count });
  const content = (
    <Badge
      aria-hidden={onOpen ? true : undefined}
      aria-label={onOpen ? undefined : label}
      className={cn("fdy-waiting-children max-w-48", className)}
      dot={false}
      role={onOpen ? undefined : "img"}
      size={compact ? "xs" : "sm"}
      title={label}
      tone="slate"
    >
      <Hourglass aria-hidden="true" className="flex-none" size={12} />
      {compact ? (
        <span className="tabular-nums">{count}</span>
      ) : (
        <>
          <span className="fdy-waiting-children-wide min-w-0 truncate max-[600px]:hidden">
            {headerLabel}
          </span>
          <span className="fdy-waiting-children-count hidden tabular-nums max-[600px]:inline">
            {count}
          </span>
        </>
      )}
    </Badge>
  );
  if (!onOpen) return content;

  return (
    <Button
      aria-label={label}
      className="h-auto flex-none cursor-pointer rounded-full p-0 hover:opacity-90 active:scale-100"
      onClick={onOpen}
      size="sm"
      title={label}
      variant="bare"
    >
      {content}
    </Button>
  );
}
