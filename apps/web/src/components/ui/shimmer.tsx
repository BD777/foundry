import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * A shimmering label: the agent is working. After Beautiful UI's Shimmer (MIT,
 * (c) 2026 Shane Levine). Motion stops under prefers-reduced-motion and the
 * label stays readable.
 */
export function Shimmer({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-block bg-[linear-gradient(90deg,var(--ink-2)_35%,var(--ink)_50%,var(--ink-2)_65%)] bg-[length:200%_100%] bg-clip-text text-transparent animate-[shimmer-text_1.8s_linear_infinite] motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-ink-2",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
