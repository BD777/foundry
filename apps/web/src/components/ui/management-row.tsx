import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

/** A stack of management rows. */
export function ManagementList({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("grid min-w-0 gap-2", className)} {...props} />;
}

/**
 * One thing being managed: a mark, its name with a few small lines
 * (`ManagementRowCopy`), then its status and actions. A card on the panel
 * surface that wraps its actions under the copy on a narrow screen.
 */
export function ManagementRow({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3.5 rounded-lg bg-panel p-3.75 text-left shadow-card",
        "[&_strong]:text-md [&_strong]:wrap-anywhere",
        "[&_small]:text-xs [&_small]:text-ink-muted [&_small]:wrap-anywhere",
        "max-[700px]:flex-wrap max-[700px]:gap-2.5 max-[700px]:p-3",
        className,
      )}
      {...props}
    />
  );
}

/** The row's name and detail lines: the part that takes the free width. */
export function ManagementRowCopy({
  className,
  ...props
}: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn(
        "grid min-w-0 flex-1 gap-[5px] max-[700px]:basis-[65%]",
        className,
      )}
      {...props}
    />
  );
}
