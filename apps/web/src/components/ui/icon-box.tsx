import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export const iconBoxVariants = cva(
  "fdy-icon-box inline-flex flex-none items-center justify-center leading-none [&_svg]:flex-none [&_svg]:[stroke-width:1.8]",
  {
    variants: {
      size: {
        composer: "fdy-icon-box-composer size-6 rounded-sm",
        chat: "fdy-icon-box-chat size-[26px] rounded-sm",
        row: "fdy-icon-box-row size-[30px] rounded-md",
        skill:
          "fdy-icon-box-skill size-[34px] rounded-md [&_svg]:[stroke-width:1.7]",
        device: "fdy-icon-box-device size-[42px] rounded-lg",
      },
      tone: {
        brass: "fdy-icon-box-brass bg-accent-soft text-brand-dark",
        dark: "fdy-icon-box-dark bg-ink text-2xs leading-none font-bold text-surface",
        device:
          "fdy-icon-box-device-tone bg-control-ghost-hover text-ink-muted",
        green: "fdy-icon-box-green bg-green-tint text-success-text",
        error: "fdy-icon-box-error bg-red-tint text-(--fdy-error-text)",
        warn: "fdy-icon-box-warn bg-orange-tint text-(--fdy-warning-text)",
        muted: "fdy-icon-box-muted bg-control-ghost-hover text-ink-muted",
        neutral: "fdy-icon-box-neutral bg-control-ghost-hover text-ink-faint",
        subtle: "fdy-icon-box-subtle bg-canvas text-ink-faint",
      },
    },
    defaultVariants: {
      size: "row",
      tone: "neutral",
    },
  },
);

export interface IconBoxProps
  extends
    HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof iconBoxVariants> {
  children: ReactNode;
}

export function IconBox({
  children,
  className,
  size,
  tone,
  ...props
}: IconBoxProps) {
  return (
    <span className={cn(iconBoxVariants({ size, tone }), className)} {...props}>
      {children}
    </span>
  );
}
