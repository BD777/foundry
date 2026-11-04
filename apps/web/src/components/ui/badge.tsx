import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * A status pill after Beautiful UI's StatusPill (MIT, (c) 2026 Shane Levine):
 * a tinted pill with a leading dot. The text colours are Foundry's status
 * tokens, mixed with ink to keep 4.5:1 on the tint. The `fdy-badge*` classes
 * are hooks for tests and layout; they carry no style.
 */
export const badgeVariants = cva(
  "fdy-badge inline-flex w-max items-center gap-1.5 whitespace-nowrap rounded-full font-medium leading-none",
  {
    variants: {
      size: {
        sm: "fdy-badge-sm h-[22px] px-2.5 text-xs",
        md: "fdy-badge-md h-6 px-3 text-sm",
      },
      tone: {
        neutral: "fdy-badge-neutral bg-inset text-ink-2 shadow-hairline",
        online: "fdy-badge-online bg-green-tint text-(--fdy-success-text)",
        brass: "fdy-badge-brass bg-accent-tint text-(--fdy-accent-dark)",
        warn: "fdy-badge-warn bg-orange-tint text-(--fdy-warning-text)",
        slate: "fdy-badge-slate bg-accent-tint text-(--fdy-info-text)",
        error: "fdy-badge-error bg-red-tint text-(--fdy-error-text)",
      },
    },
    defaultVariants: {
      size: "sm",
      tone: "neutral",
    },
  },
);

const dotTone = {
  neutral: "bg-ink-3",
  online: "bg-green",
  brass: "bg-accent",
  warn: "bg-orange",
  slate: "bg-accent",
  error: "bg-red",
} as const;

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
      {dot ? (
        <span
          className={cn(
            "fdy-badge-dot size-1.5 flex-none rounded-full",
            dotTone[tone ?? "neutral"],
          )}
        />
      ) : null}
      {children}
    </span>
  );
}
