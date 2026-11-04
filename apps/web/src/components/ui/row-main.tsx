import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** The top line of a row: who it is on the left, its status or menu on the right. */
export function RowMain({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start justify-between gap-3",
        className,
      )}
      {...props}
    />
  );
}
