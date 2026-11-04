import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * A muted line of small print under a skill's name: evidence, a path.
 * `data-tone="warning"` colours it as a warning.
 */
export function SkillNote({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <small
      className={cn(
        "whitespace-normal text-ink-muted [overflow-wrap:anywhere] data-[tone=warning]:text-warning-text",
        className,
      )}
      {...props}
    />
  );
}
