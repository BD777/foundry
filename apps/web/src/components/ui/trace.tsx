import { ChevronRight } from "lucide-react";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/*
 * Pieces of an agent's trace rows (thinking, tool steps), after Beautiful UI's
 * ThinkingState and ToolChips: a muted ring that turns while work runs, and
 * the chevron of a disclosure row. A row is a `Button` carrying `group/trace`
 * and `aria-expanded`; the chevron turns with it.
 */

/** A small ring that turns while a step runs; still where motion is reduced. */
export function TraceSpinner({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-3.5 flex-none animate-[spin_0.8s_linear_infinite] rounded-full border-2 border-line-strong border-t-ink-faint motion-reduce:animate-none motion-reduce:border-t-line-strong",
        className,
      )}
      {...props}
    />
  );
}

/** The chevron of a disclosure row: points right, turns down when open. */
export function TraceChevron({
  className,
  size = 15,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn(
        "flex-none text-ink-faint transition-transform duration-150 group-aria-expanded/trace:rotate-90 motion-reduce:transition-none",
        className,
      )}
      size={size}
    />
  );
}
