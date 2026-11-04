import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

/*
 * The rows of the composer's runtime menus (permissions; model, effort and
 * speed). Their popovers are Radix dropdown panels with Button rows, so these
 * parts only fix the rows' look; focus, dismissal and selection stay the
 * menus' own.
 */

const rowSurface =
  "w-full rounded-xl py-0 text-left leading-normal active:scale-100 hover:bg-control-ghost-hover";

/** The heading line over a menu's rows. */
export function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mx-1 mb-2 flex items-center justify-between gap-4.5 text-md font-[650] text-ink-faint">
      <span>{children}</span>
    </div>
  );
}

/** A group's small-caps title inside the permissions menu. */
export function MenuSection({ children }: { children: ReactNode }) {
  return (
    <div className="mx-2.5 mt-2.75 mb-1 text-2xs font-[760] text-ink-faint uppercase">
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div className="mx-2.5 my-2 h-px bg-line" />;
}

/** One permission choice: icon, name and summary, a check when current. */
export function MenuOption({
  checkIcon,
  icon,
  onClick,
  selected,
  summary,
  title,
  tooltip,
}: {
  checkIcon: ReactNode;
  icon: ReactNode;
  onClick: () => void;
  selected: boolean;
  summary: ReactNode;
  title: ReactNode;
  /** The raw mode value, shown as the text's native tooltip. */
  tooltip?: string;
}) {
  return (
    <Button
      className={cn(
        rowSurface,
        "grid min-h-14 grid-cols-[28px_1fr_22px] items-center gap-3 px-2.5 py-3 data-[selected=true]:bg-control-ghost-hover",
      )}
      data-selected={selected}
      onClick={onClick}
      variant="ghost"
    >
      {icon}
      <span className="grid min-w-0 gap-0.5" title={tooltip}>
        <strong className="text-md font-[750] text-ink">{title}</strong>
        <em className="truncate text-sm leading-[1.35] font-[600] text-ink-faint not-italic">
          {summary}
        </em>
      </span>
      {selected ? checkIcon : null}
    </Button>
  );
}

/** A row of the model-and-effort menu's main column. */
export function MenuRow({
  active = false,
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Button> & { active?: boolean }) {
  return (
    <Button
      className={cn(
        rowSurface,
        "grid min-h-10.5 grid-cols-[1fr_auto_20px] items-center gap-2.5 px-2.75 data-[active=true]:bg-control-ghost-hover [&>svg]:text-ink-faint",
        className,
      )}
      data-active={active}
      variant="ghost"
      {...props}
    >
      {children}
    </Button>
  );
}

export function MenuRowLabel({ children }: { children: ReactNode }) {
  return <strong className="text-md font-[760] text-ink">{children}</strong>;
}

export function MenuRowValue({ children }: { children: ReactNode }) {
  return (
    <span className="max-w-30.5 truncate text-md font-[650] text-ink-faint">
      {children}
    </span>
  );
}

export function SubmenuTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mx-3 mb-2.5 text-lg font-[760] text-ink-faint">
      {children}
    </div>
  );
}

/** One choice of a submenu: its name (and a second line), a check if current. */
export function SubmenuOption({
  checkIcon,
  children,
  onClick,
  selected,
  stacked = false,
}: {
  checkIcon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  selected: boolean;
  /** The name and a summary under it, both inside `children`. */
  stacked?: boolean;
}) {
  return (
    <Button
      className={cn(
        rowSurface,
        "flex items-center justify-between gap-4 px-3",
        stacked ? "min-h-15.5" : "min-h-10",
      )}
      data-selected={selected}
      onClick={onClick}
      variant="ghost"
    >
      <span
        className={cn(
          "min-w-0 text-lg font-[650] text-ink",
          stacked ? "grid gap-0.75 whitespace-normal" : "truncate",
        )}
      >
        {children}
      </span>
      {selected ? checkIcon : null}
    </Button>
  );
}

export function SubmenuStackedName({ children }: { children: ReactNode }) {
  return <strong className="text-lg font-[760]">{children}</strong>;
}

export function SubmenuStackedSummary({ children }: { children: ReactNode }) {
  return (
    <em className="text-md font-[620] text-ink-faint not-italic">{children}</em>
  );
}
