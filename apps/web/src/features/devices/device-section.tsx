import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

/**
 * One section of a device page: its `SectionHeader` over the section's own
 * content, spaced by a grid.
 */
export function DeviceSection({
  className,
  ...props
}: ComponentPropsWithoutRef<"section">) {
  return (
    <section
      className={cn("grid min-w-0 gap-4 py-1 max-[700px]:p-0", className)}
      {...props}
    />
  );
}

/** A section's row of actions and the note that follows them. */
export const deviceActionsClass =
  "mt-1 flex flex-wrap items-center gap-x-3 gap-y-2";
