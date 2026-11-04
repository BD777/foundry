import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const dividedListVariants = cva(
  "grid min-w-0 list-none divide-y divide-line-soft p-0",
  {
    variants: {
      /** The vertical padding of every item. */
      density: {
        none: "",
        compact: "[&>li]:py-2",
        cozy: "[&>li]:py-2.5",
        roomy: "[&>li]:py-3",
      },
    },
    defaultVariants: { density: "roomy" },
  },
);

export interface DividedListProps
  extends
    HTMLAttributes<HTMLUListElement>,
    VariantProps<typeof dividedListVariants> {}

/** A list whose items are set off from each other by a hairline. */
export function DividedList({
  className,
  density,
  ...props
}: DividedListProps) {
  return (
    <ul
      className={cn(dividedListVariants({ density }), className)}
      {...props}
    />
  );
}
