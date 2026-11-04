import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export interface DiffStatProps extends HTMLAttributes<HTMLSpanElement> {
  added: number;
  removed: number;
}

/** What a change adds and removes, as `+13 −41` in mono type. */
export function DiffStat({
  added,
  className,
  removed,
  ...props
}: DiffStatProps) {
  return (
    <span
      className={cn(
        "fdy-diff-stat inline-flex flex-none items-baseline gap-1.5 font-mono text-2xs leading-[1.6] whitespace-nowrap tabular-nums",
        className,
      )}
      {...props}
    >
      <span className="text-success-text" data-sign="added">
        +{added}
      </span>
      <span className="text-error-text" data-sign="removed">
        {"−"}
        {removed}
      </span>
    </span>
  );
}
