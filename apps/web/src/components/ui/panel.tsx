import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const panelVariants = cva("fdy-panel", {
  variants: {
    interactive: {
      false: "",
      true: "fdy-panel-interactive",
    },
    radius: {
      md: "fdy-panel-radius-md",
      lg: "fdy-panel-radius-lg",
    },
    variant: {
      flat: "fdy-panel-flat",
      inset: "fdy-panel-inset",
      soft: "fdy-panel-soft",
      surface: "fdy-panel-surface",
    },
  },
  defaultVariants: {
    interactive: false,
    radius: "lg",
    variant: "surface",
  },
});

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

export function PanelHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("fdy-panel-header", className)} {...props} />;
}

export function SectionLabel({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("fdy-section-label", className)} {...props} />;
}
