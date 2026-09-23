import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export const badgeVariants = cva("fdy-badge", {
  variants: {
    size: {
      sm: "fdy-badge-sm",
      md: "fdy-badge-md",
    },
    tone: {
      neutral: "fdy-badge-neutral",
      online: "fdy-badge-online",
      brass: "fdy-badge-brass",
      warn: "fdy-badge-warn",
      slate: "fdy-badge-slate",
      error: "fdy-badge-error",
    },
  },
  defaultVariants: {
    size: "sm",
    tone: "neutral",
  },
});

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  children: ReactNode;
  dot?: boolean;
}

export function Badge({
  children,
  className,
  dot = true,
  size,
  tone,
  ...props
}: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ size, tone }), className)} {...props}>
      {dot ? <span className="fdy-badge-dot" /> : null}
      {children}
    </span>
  );
}
