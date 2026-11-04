import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * The name of a bundle on its row or card: monospace, with the badge and
 * version that follow it on the same wrapping line.
 */
export function BundleTitle({
  as: Component = "span",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "span" | "strong" }) {
  return (
    <Component
      className={cn(
        "flex flex-wrap items-center gap-2 font-mono text-md font-semibold leading-none text-ink",
        className,
      )}
      {...props}
    />
  );
}
