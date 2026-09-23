import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

export const actionRowVariants = cva("fdy-action-row", {
  variants: {
    density: {
      compact: "fdy-action-row-compact",
      md: "fdy-action-row-md",
    },
    selected: {
      false: "",
      true: "fdy-action-row-selected",
    },
    variant: {
      side: "fdy-action-row-side",
      table: "fdy-action-row-table",
    },
  },
  defaultVariants: {
    density: "md",
    selected: false,
    variant: "side",
  },
});

export interface ActionRowProps
  extends
    ComponentPropsWithoutRef<"button">,
    VariantProps<typeof actionRowVariants> {
  asChild?: boolean;
}

export function ActionRow({
  asChild = false,
  className,
  density,
  selected,
  type = "button",
  variant,
  ...props
}: ActionRowProps) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      className={cn(
        actionRowVariants({ density, selected, variant }),
        className,
      )}
      {...(!asChild ? { type } : {})}
      {...props}
    />
  );
}
