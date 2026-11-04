import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/*
 * A card: a ring in its shadow, not a border plus a shadow. The border is
 * kept (transparent) on the surface variant so a panel and a flat panel
 * occupy the same box.
 */
export const panelVariants = cva(
  "fdy-panel max-w-full min-w-0 border bg-clip-padding",
  {
    variants: {
      interactive: {
        false: "",
        true: "fdy-panel-interactive transition-shadow duration-150 ease-out-strong hover:shadow-raised",
      },
      radius: {
        md: "fdy-panel-radius-md rounded-lg",
        lg: "fdy-panel-radius-lg rounded-xl",
      },
      variant: {
        flat: "fdy-panel-flat border-line-strong bg-panel shadow-none",
        inset:
          "fdy-panel-inset border-line-soft bg-surface shadow-(--fdy-shadow-inset)",
        soft: "fdy-panel-soft border-line-strong bg-panel-soft shadow-none",
        surface: "fdy-panel-surface border-transparent bg-panel shadow-card",
      },
    },
    defaultVariants: {
      interactive: false,
      radius: "lg",
      variant: "surface",
    },
  },
);

export interface PanelProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof panelVariants> {}

export function Panel({
  className,
  interactive,
  radius,
  variant,
  ...props
}: PanelProps) {
  return (
    <div
      className={cn(panelVariants({ interactive, radius, variant }), className)}
      {...props}
    />
  );
}

/**
 * The heading takes the room; actions keep their size and wrap below it on
 * narrow panels instead of squeezing their labels.
 */
export function PanelHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "fdy-panel-header flex flex-wrap items-start justify-between gap-3.5 [&>:first-child]:min-w-0 [&>:first-child]:flex-[1_1_16rem] [&>button]:flex-none [&_h2]:mt-[3px] [&_h2]:text-xl [&_h2]:leading-[1.15] [&_h2]:font-bold [&_h2]:text-ink [&_p]:mt-1 [&_p]:text-xs [&_p]:leading-normal [&_p]:text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}

export function SectionLabel({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "fdy-section-label flex items-center gap-2 text-2xs leading-none font-semibold text-ink-faint uppercase",
        className,
      )}
      {...props}
    />
  );
}
