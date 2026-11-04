import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * A row of a list drawn as its own small surface: "raised" is the card
 * (surface and soft shadow), "ring" the quieter hairline outline. `interactive`
 * rows show hover and, when `selected`, the selection fill; the row itself is
 * the click target, so the fill never moves content.
 */
export const rowCardVariants = cva("min-w-0 rounded-lg", {
  variants: {
    tone: {
      raised: "bg-surface shadow-card",
      ring: "shadow-hairline",
    },
    interactive: {
      false: null,
      true: "cursor-pointer transition-colors duration-120 hover:bg-control-ghost-hover",
    },
    selected: {
      false: null,
      true: "bg-selection hover:bg-selection",
    },
  },
  defaultVariants: {
    tone: "raised",
    interactive: false,
    selected: false,
  },
});

type RowCardElement = "div" | "li" | "label" | "section" | "ul" | "details";

export interface RowCardProps
  extends HTMLAttributes<HTMLElement>, VariantProps<typeof rowCardVariants> {
  as?: RowCardElement;
}

export function RowCard({
  as: Component = "div",
  className,
  interactive,
  selected,
  tone,
  ...props
}: RowCardProps) {
  return (
    <Component
      className={cn(
        rowCardVariants({ interactive, selected, tone }),
        className,
      )}
      {...props}
    />
  );
}
