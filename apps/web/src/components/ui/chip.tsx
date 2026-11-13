import { X } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

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

/**
 * A chip the person can take away: its text, then a small remove button.
 * `mono` keeps the token look for typed values; names read in the UI font.
 */
export function RemovableChip({
  children,
  mono = true,
  onRemove,
  removeLabel,
  title,
}: {
  children: ReactNode;
  mono?: boolean;
  onRemove: () => void;
  removeLabel: string;
  title?: string;
}) {
  return (
    <span
      className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-md bg-(--fdy-chip-surface) py-px ps-1.5 pe-px align-middle text-2xs leading-tight text-(--fdy-chip-ink)"
      title={title}
    >
      <span className={cn("min-w-0 truncate", mono && "font-mono")}>
        {children}
      </span>
      <Button
        aria-label={removeLabel}
        onClick={onRemove}
        size="iconXs"
        variant="icon"
      >
        <X aria-hidden="true" size={12} />
      </Button>
    </span>
  );
}
