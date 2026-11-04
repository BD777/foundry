import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

export const actionRowVariants = cva(
  "fdy-action-row relative max-w-full min-w-0 cursor-pointer appearance-none border-0 bg-transparent bg-clip-padding text-left [font:inherit] text-inherit transition-[background-color,box-shadow] duration-150 ease-out-strong focus-visible:shadow-[inset_0_0_0_1px_var(--fdy-control-focus),0_0_0_2px_var(--fdy-control-focus-soft)] focus-visible:outline-none",
  {
    variants: {
      density: {
        compact: "fdy-action-row-compact px-2.5 py-[9px]",
        md: "fdy-action-row-md px-[18px] py-[13px]",
      },
      selected: {
        false: "",
        true: "fdy-action-row-selected text-ink",
      },
      variant: {
        side: "fdy-action-row-side mb-[3px] flex h-auto w-full items-center justify-start rounded-lg",
        table:
          "fdy-action-row-table h-auto w-full justify-stretch rounded-none border-t border-line-soft",
      },
    },
    compoundVariants: [
      {
        selected: false,
        variant: "side",
        className: "hover:bg-control-ghost-hover",
      },
      { selected: false, variant: "table", className: "hover:bg-surface" },
      // Selected stays distinguishable from hovered, in both themes: a side
      // row is raised with one ring, a table row a tonal fill.
      {
        selected: true,
        variant: "side",
        className: "bg-selected shadow-selected",
      },
      { selected: true, variant: "table", className: "bg-selection" },
    ],
    defaultVariants: {
      density: "md",
      selected: false,
      variant: "side",
    },
  },
);

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
      aria-current={selected ? "true" : undefined}
      {...props}
    />
  );
}
