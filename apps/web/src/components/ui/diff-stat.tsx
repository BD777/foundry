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
    <span className={cn("fdy-diff-stat", className)} {...props}>
      <span data-sign="added">+{added}</span>
      <span data-sign="removed">
        {"\u2212"}
        {removed}
      </span>
    </span>
  );
}
