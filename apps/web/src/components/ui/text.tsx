import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const mutedTextVariants = cva("min-w-0 wrap-anywhere", {
  variants: {
    size: {
      xs: "text-xs leading-[1.6]",
      sm: "text-sm leading-normal",
    },
    tone: {
      muted: "text-ink-muted",
      faint: "text-ink-faint",
      ink: "text-ink",
      warning: "text-warning-text",
      error: "text-error-text",
    },
  },
  defaultVariants: { size: "xs", tone: "muted" },
});

export interface MutedTextProps
  extends HTMLAttributes<HTMLElement>, VariantProps<typeof mutedTextVariants> {
  as?: "p" | "span" | "small" | "div";
}

/** Secondary copy: a line of explanation under a heading, a row or a control. */
export function MutedText({
  as: Component = "p",
  className,
  size,
  tone,
  ...props
}: MutedTextProps) {
  return (
    <Component
      className={cn(mutedTextVariants({ size, tone }), className)}
      {...props}
    />
  );
}
