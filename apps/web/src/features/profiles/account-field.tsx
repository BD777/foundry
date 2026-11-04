import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

const accountFieldClass =
  "grid min-w-0 content-start gap-1.5 [&>span]:text-2xs [&>span]:font-semibold [&>span]:text-ink-muted";

/**
 * A labelled field of an account's panel: the caption span above its control
 * and hints, spaced by a grid.
 */
export function AccountField({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return <div className={cn(accountFieldClass, className)} {...props} />;
}

/** The same field as a `label`, where the caption names the control it wraps. */
export function AccountFieldLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<"label">) {
  return <label className={cn(accountFieldClass, className)} {...props} />;
}
