import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

/** A labelled, native progress indicator; an absent value is indeterminate. */
export function ProgressMeter({
  className,
  ...props
}: ComponentPropsWithoutRef<"progress">) {
  return (
    <progress
      {...props}
      className={cn(
        "fdy-progress-meter block h-[5px] w-full appearance-none overflow-hidden rounded-xs border-0 bg-line accent-brand [&::-moz-progress-bar]:rounded-xs [&::-moz-progress-bar]:bg-brand [&::-webkit-progress-bar]:bg-line [&::-webkit-progress-value]:rounded-xs [&::-webkit-progress-value]:bg-brand",
        className,
      )}
    />
  );
}
