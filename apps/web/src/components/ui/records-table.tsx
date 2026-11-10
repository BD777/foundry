import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * A table of records after Beautiful UI's RecordsTable (MIT, (c) 2026 Shane
 * Levine): a card on a hairline ring that scrolls, hairline cells, tabular
 * numbers, a sticky header row and a row that lights up under the pointer.
 * The toolbar is always visible, out of flow, pinned inside the card at the end
 * of the header row (the header's height, so it centres in it); the last
 * header cell reserves its width, so at rest it covers nothing, and when the
 * table scrolls sideways the header passes under it, which fades in from the
 * header's own surface.
 */

export interface RecordsTableProps {
  children: ReactNode;
  className?: string;
  /** Actions for the whole table, shown above its top edge. */
  toolbar?: ReactNode;
  /** The card scrolls past this height. */
  tall?: boolean;
  /** Names the scroll region and makes it reachable from the keyboard. */
  scrollLabel?: string;
}

export function RecordsTable({
  children,
  className,
  tall = true,
  toolbar,
  scrollLabel,
}: RecordsTableProps) {
  return (
    <div
      className={cn(
        "fdy-records group/records relative block w-full min-w-0 rounded-lg bg-surface shadow-card",
        className,
      )}
      data-toolbar={toolbar ? "true" : undefined}
    >
      <div
        aria-label={scrollLabel}
        className={cn(
          "overflow-auto rounded-lg [scrollbar-color:var(--line-strong)_transparent] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(color:--fdy-accent)",
          tall && "max-h-[300px]",
        )}
        role={scrollLabel ? "group" : undefined}
        tabIndex={scrollLabel ? 0 : undefined}
      >
        <table className="m-0 w-full table-auto border-separate border-spacing-0 text-sm text-ink">
          {children}
        </table>
      </div>
      {toolbar ? (
        <div className="absolute top-0 right-0 z-4 flex h-[calc(2.25rem-1px)] items-center rounded-tr-lg bg-[linear-gradient(to_right,transparent,var(--surface)_20px)] pr-1.5 pl-5">
          {toolbar}
        </div>
      ) : null}
    </div>
  );
}

export function RecordsHead({
  className,
  ...props
}: ComponentPropsWithoutRef<"thead">) {
  return <thead className={cn("bg-transparent", className)} {...props} />;
}

export function RecordsBody({
  className,
  ...props
}: ComponentPropsWithoutRef<"tbody">) {
  return (
    <tbody
      className={cn(
        "[&>tr:hover>td]:bg-inset [&>tr:last-child>td]:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

export function RecordsRow(props: ComponentPropsWithoutRef<"tr">) {
  return <tr {...props} />;
}

const cell =
  "border-r border-b border-line px-3 py-2 text-left align-top tabular-nums [overflow-wrap:break-word] last:border-r-0";

export function RecordsHeaderCell({
  className,
  ...props
}: ComponentPropsWithoutRef<"th">) {
  return (
    <th
      className={cn(
        cell,
        "sticky top-0 z-1 h-9 bg-surface py-0 align-middle text-xs leading-[1.55] font-semibold whitespace-nowrap text-ink-2 group-data-[toolbar=true]/records:last:pr-[104px]",
        className,
      )}
      {...props}
    />
  );
}

export function RecordsCell({
  className,
  ...props
}: ComponentPropsWithoutRef<"td">) {
  return <td className={cn(cell, "leading-[1.55]", className)} {...props} />;
}
