import type { LabelHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * A checkbox or radio with its words: the control first, then a text block
 * (a `<span>`, optionally with a `<small>` hint under it).
 */
export function CheckLabel({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "flex min-w-0 cursor-pointer items-start gap-2 text-xs text-ink [&>input]:mt-0.5 [&>input]:flex-none [&>span]:grid [&>span]:min-w-0 [&>span]:gap-0.5 [&_small]:text-xs [&_small]:text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}
