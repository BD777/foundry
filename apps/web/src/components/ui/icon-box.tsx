import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export const iconBoxVariants = cva("fdy-icon-box", {
  variants: {
    size: {
      composer: "fdy-icon-box-composer",
      chat: "fdy-icon-box-chat",
      row: "fdy-icon-box-row",
      skill: "fdy-icon-box-skill",
      device: "fdy-icon-box-device",
    },
    tone: {
      brass: "fdy-icon-box-brass",
      dark: "fdy-icon-box-dark",
      device: "fdy-icon-box-device-tone",
      green: "fdy-icon-box-green",
      muted: "fdy-icon-box-muted",
      neutral: "fdy-icon-box-neutral",
      subtle: "fdy-icon-box-subtle",
    },
  },
  defaultVariants: {
    size: "row",
    tone: "neutral",
  },
});

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
