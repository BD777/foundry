import type { DetailsHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** A native disclosure: a quiet summary line that opens a stack of detail. */
export function Disclosure({
  className,
  ...props
}: DetailsHTMLAttributes<HTMLDetailsElement>) {
  return (
    <details
      className={cn("grid min-w-0 gap-2 text-xs text-ink-muted", className)}
      {...props}
    />
  );
}

export function DisclosureSummary({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <summary
      className={cn(
        "-ml-1 w-fit cursor-pointer rounded-xs px-1 py-0.5 text-ink hover:bg-control-ghost-hover focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-brand",
        className,
      )}
      {...props}
    />
  );
}
