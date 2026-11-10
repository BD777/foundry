import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CirclePause,
  CircleX,
  Hourglass,
  LoaderCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SessionWork } from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Popover } from "../../components/ui/popover";
import { chatHref, navigateToChat } from "../../lib/in-app-navigation";
import { cn } from "../../lib/cn";
import {
  ContextRow,
  ContextStatus,
  statusToneOf,
} from "./context/chat-context-parts";

export interface WaitingChildSession {
  id: string;
  selected?: boolean;
  status?: string;
  title: string;
  workspaceId?: string;
}

/** The direct child sessions the open chat's existing work inventory reads. */
export function waitingChildSessions(
  items: readonly SessionWork[],
): WaitingChildSession[] {
  const seen = new Set<string>();
  const children: WaitingChildSession[] = [];
  for (const item of items) {
    const id = item.sourceId;
    if (
      item.kind !== "agent" ||
      item.source !== "foundry" ||
      !id ||
      seen.has(id)
    )
      continue;
    seen.add(id);
    children.push({
      id,
      status: item.observation.status,
      title: item.title,
      workspaceId: item.workspaceId,
    });
  }
  return children;
}

const workStatuses = [
  "idle",
  "running",
  "suspended",
  "completed",
  "failed",
  "stopped",
  "unknown",
] as const;

function workStatus(status: string | undefined): (typeof workStatuses)[number] {
  return workStatuses.find((value) => value === status) ?? "unknown";
}

function StatusMark({
  className,
  status,
}: {
  className?: string;
  status: ReturnType<typeof workStatus>;
}) {
  const Icon =
    status === "running"
      ? LoaderCircle
      : status === "completed"
        ? CircleCheck
        : status === "failed"
          ? CircleX
          : status === "suspended" || status === "idle"
            ? CirclePause
            : CircleHelp;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        status === "running" && "animate-spin-slow motion-reduce:animate-none",
        className,
      )}
      size={11}
    />
  );
}

/**
 * The waiting-child state, shared by chat rows and the open chat header. With
 * children, its trigger opens the existing child-session links.
 */
export function WaitingChildrenStatus({
  children = [],
  className,
  compact = false,
  count,
  workspaceId,
}: {
  children?: readonly WaitingChildSession[];
  className?: string;
  /** A list-row mark: icon and count, with the full wording in its label. */
  compact?: boolean;
  count: number;
  workspaceId?: string;
}) {
  const { t } = useTranslation("chat");
  if (count <= 0) return null;
  const label = t("waitingChildren.count", { count });
  const headerLabel = t("waitingChildren.header", { count });
  const badge = (
    <Badge
      className={cn("fdy-waiting-children max-w-48", className)}
      dot={false}
      aria-label={children.length ? undefined : label}
      role={children.length ? undefined : "img"}
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
      {children.length ? (
        <ChevronDown aria-hidden="true" className="flex-none" size={12} />
      ) : null}
    </Badge>
  );
  if (!children.length) return badge;

  return (
    <Popover
      appearance="panel"
      className="w-[min(300px,calc(100vw-24px))]"
      label={t("waitingChildren.open", { count })}
      trigger={
        <Button
          aria-label={label}
          className="h-auto flex-none cursor-pointer rounded-full p-0 hover:opacity-90 active:scale-100"
          size="sm"
          title={label}
          variant="bare"
        >
          {badge}
        </Button>
      }
    >
      <div className="grid gap-2">
        <strong className="text-xs">{t("waitingChildren.title")}</strong>
        <ul className="m-0 grid list-none gap-0.5 p-0">
          {children.map((child) => {
            const status = workStatus(child.status);
            const statusLabel = t(`work.status.${status}`);
            return (
              <li key={child.id}>
                <ContextRow
                  asChild
                  className="fdy-waiting-child-row grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2"
                  selected={child.selected}
                >
                  <a
                    aria-current={child.selected ? "page" : undefined}
                    href={chatHref(child.id, child.workspaceId ?? workspaceId)}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      navigateToChat(
                        child.id,
                        child.workspaceId ?? workspaceId,
                      );
                    }}
                  >
                    <strong className="min-w-0 truncate text-sm leading-[1.3] font-semibold text-ink">
                      {child.title || t("waitingChildren.untitled")}
                    </strong>
                    <ContextStatus tone={statusToneOf(status)}>
                      <StatusMark status={status} />
                      {statusLabel}
                    </ContextStatus>
                    <ChevronRight
                      aria-hidden="true"
                      className="fdy-waiting-child-chevron flex-none text-ink-faint"
                      size={14}
                    />
                  </a>
                </ContextRow>
              </li>
            );
          })}
        </ul>
      </div>
    </Popover>
  );
}
