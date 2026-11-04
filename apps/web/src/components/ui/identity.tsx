import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const identityVariants = cva(
  "grid min-w-0 gap-0.5 [&>small]:text-xs [&>small]:leading-normal [&>small]:text-ink-muted [&>span]:text-xs [&>span]:leading-normal [&>span]:text-ink-muted [&>strong]:text-sm [&>strong]:font-semibold [&>strong]:text-ink",
  {
    variants: {
      /** Long values wrap anywhere, or stay on one line with an ellipsis. */
      lines: {
        wrap: "[&>small]:wrap-anywhere [&>span]:wrap-anywhere [&>strong]:wrap-anywhere",
        truncate: "[&>small]:truncate [&>span]:truncate [&>strong]:truncate",
      },
    },
    defaultVariants: { lines: "wrap" },
  },
);

export interface IdentityProps
  extends HTMLAttributes<HTMLElement>, VariantProps<typeof identityVariants> {
  as?: "div" | "span";
}

/**
 * Who or what a row is about: a `<strong>` name, then `<span>`/`<small>` lines
 * of detail in muted type. The element types carry the roles, so the content
 * stays plain.
 */
export function Identity({
  as: Component = "div",
  className,
  lines,
  ...props
}: IdentityProps) {
  return (
    <Component
      className={cn(identityVariants({ lines }), className)}
      {...props}
    />
  );
}
