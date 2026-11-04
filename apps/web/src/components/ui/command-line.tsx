import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** A command to run, with its copy button: the block takes the free width. */
export function CommandLine({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1 [&>:first-child]:min-w-0 [&>:first-child]:flex-auto",
        className,
      )}
      {...props}
    />
  );
}
