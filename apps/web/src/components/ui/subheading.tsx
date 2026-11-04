import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const subheadingVariants = cva("min-w-0 wrap-anywhere", {
  variants: {
    size: {
      /** The title of a block inside a page or a side column. */
      title: "text-md font-bold text-ink",
      /** A group inside a block. */
      group: "text-sm font-bold text-ink",
      /** A small caption over a list. */
      caption: "text-xs font-semibold text-ink-muted",
    },
  },
  defaultVariants: { size: "title" },
});

export interface SubheadingProps
  extends
    HTMLAttributes<HTMLHeadingElement>,
    VariantProps<typeof subheadingVariants> {
  as?: "h2" | "h3" | "h4";
}

/** A heading inside a page section; the element sets the outline level only. */
export function Subheading({
  as: Component = "h3",
  className,
  size,
  ...props
}: SubheadingProps) {
  return (
    <Component
      className={cn(subheadingVariants({ size }), className)}
      {...props}
    />
  );
}
