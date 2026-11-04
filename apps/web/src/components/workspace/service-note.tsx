import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** A muted line of small print in a workspace's services and tunnels. */
export function ServiceNote({
  as: Component = "p",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "p" | "span" }) {
  return (
    <Component
      className={cn(
        "m-0 text-xs leading-[1.6] text-ink-muted wrap-anywhere",
        className,
      )}
      {...props}
    />
  );
}
