import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { AppLink } from "./app-link";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { cn } from "../../lib/cn";

const entryClass =
  "grid h-auto w-full grid-cols-[18px_minmax(0,1fr)_14px] items-center justify-start gap-2.5 rounded-sm px-3 py-1.5 text-left text-sm font-semibold text-ink hover:bg-control-ghost-hover focus-visible:outline-0 focus-visible:shadow-[inset_0_0_0_1px_var(--fdy-accent)]";
/** The icon-only entry of a collapsed sidebar: a 40px square on wide screens. */
const collapsedEntryClass =
  "min-[861px]:mx-auto min-[861px]:min-h-10 min-[861px]:w-10 min-[861px]:grid-cols-[18px] min-[861px]:justify-center min-[861px]:p-0";
const hiddenWhenCollapsed = "min-[861px]:hidden";

export interface SidebarContextEntryProps {
  /** The full text announced by assistive technology and the tooltip. */
  ariaLabel: string;
  badge?: ReactNode;
  className?: string;
  collapsed?: boolean;
  detail?: string;
  href?: string;
  icon: LucideIcon;
  label: string;
  onBrowse?: () => void;
  regionLabel: string;
}

/**
 * A sidebar's current context: its name, a detail line and a forward arrow.
 * Forward navigation opens a page where the context can be switched.
 */
export function SidebarContextEntry({
  ariaLabel,
  badge,
  className,
  collapsed = false,
  detail,
  href,
  icon: Icon,
  label,
  onBrowse,
  regionLabel,
}: SidebarContextEntryProps) {
  const content = (
    <>
      <Icon
        aria-hidden="true"
        className="flex-none justify-self-center text-ink-muted"
        size={18}
      />
      <span
        className={cn(
          "fdy-location-entry-rows flex min-w-0 flex-1 flex-col gap-0.5",
          collapsed && hiddenWhenCollapsed,
        )}
      >
        <span className="fdy-location-entry-row flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-md leading-[1.3] font-semibold">
            {label}
          </span>
          {badge}
        </span>
        {detail ? (
          <span className="fdy-location-entry-row fdy-location-entry-device flex min-w-0 items-center gap-2 text-2xs font-normal text-ink-muted">
            <span className="min-w-0 flex-1 truncate text-2xs leading-[1.3] font-normal">
              {detail}
            </span>
          </span>
        ) : null}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "flex-none text-ink-muted",
          collapsed && hiddenWhenCollapsed,
        )}
        size={14}
      />
    </>
  );
  const buttonClassName = cn(entryClass, collapsed && collapsedEntryClass);

  return (
    <section
      aria-label={regionLabel}
      className={cn("fdy-sidebar-context-entry grid min-w-0 gap-px", className)}
      data-collapsed={collapsed}
    >
      <Tooltip content={ariaLabel}>
        {href ? (
          <Button
            asChild
            className={buttonClassName}
            onClick={onBrowse}
            title={ariaLabel}
            variant="ghost"
          >
            <AppLink aria-label={ariaLabel} href={href}>
              {content}
            </AppLink>
          </Button>
        ) : (
          <Button
            aria-label={ariaLabel}
            className={buttonClassName}
            onClick={onBrowse}
            title={ariaLabel}
            variant="ghost"
          >
            {content}
          </Button>
        )}
      </Tooltip>
    </section>
  );
}
