import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * A monospace token chip for values such as a tool name, a path or an id.
 * After Beautiful UI's Chip (MIT, (c) 2026 Shane Levine); the surface and ink
 * are Foundry's chip tokens.
 */
export function Chip({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <code
      className={cn(
        "inline-block max-w-full min-w-0 truncate rounded-md bg-(--fdy-chip-surface) px-1.5 py-[3px] align-middle font-mono text-2xs leading-tight text-(--fdy-chip-ink)",
        className,
      )}
      {...props}
    >
      {children}
    </code>
  );
}
