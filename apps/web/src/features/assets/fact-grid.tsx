import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface FactGridItem {
  label: ReactNode;
  mono?: boolean;
  value: ReactNode;
}

export const factGridVariants = cva(
  "grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-px overflow-hidden rounded-md border border-line bg-line",
  {
    variants: {
      density: {
        compact: "mt-[11px]",
        md: "mt-[15px]",
      },
      /** "device": three columns and tighter cells on narrow screens. */
      layout: {
        auto: null,
        device: "max-[860px]:mt-3 max-[860px]:grid-cols-3",
      },
    },
    defaultVariants: {
      density: "md",
      layout: "auto",
    },
  },
);

const cellVariants = cva("min-w-0 bg-panel", {
  variants: {
    density: {
      compact: "px-[11px] py-[9px]",
      md: "px-[13px] py-2.5",
    },
    layout: {
      auto: null,
      device: "max-[860px]:px-[9px] max-[860px]:py-2",
    },
  },
  defaultVariants: { density: "md", layout: "auto" },
});

const labelVariants = cva(
  "mb-[5px] block text-2xs leading-none font-semibold text-ink-faint uppercase",
  {
    variants: {
      layout: {
        auto: null,
        device: "max-[860px]:mb-1",
      },
    },
    defaultVariants: { layout: "auto" },
  },
);

const valueVariants = cva("block min-w-0 font-semibold text-ink", {
  variants: {
    layout: {
      auto: "overflow-hidden text-sm leading-[1.3] text-ellipsis whitespace-nowrap",
      device:
        "overflow-hidden text-sm leading-[1.3] text-ellipsis whitespace-nowrap max-[860px]:text-xs max-[860px]:leading-[1.2]",
    },
    mono: {
      false: null,
      true: "font-mono text-xs leading-[1.3]",
    },
  },
  defaultVariants: { layout: "auto", mono: false },
  compoundVariants: [
    {
      layout: "device",
      mono: true,
      className:
        "[overflow-wrap:anywhere] whitespace-normal max-[860px]:text-2xs max-[860px]:leading-[1.2] max-[860px]:whitespace-nowrap max-[860px]:[overflow-wrap:normal]",
    },
  ],
});

export interface FactGridProps
  extends
    HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof factGridVariants> {
  items: FactGridItem[];
}

export function FactGrid({
  className,
  density,
  items,
  layout,
  ...props
}: FactGridProps) {
  return (
    <div
      className={cn(factGridVariants({ density, layout }), className)}
      {...props}
    >
      {items.map((item, index) => (
        <div className={cellVariants({ density, layout })} key={index}>
          <span className={labelVariants({ layout })}>{item.label}</span>
          <strong className={cn(valueVariants({ layout, mono: !!item.mono }))}>
            {item.value}
          </strong>
        </div>
      ))}
    </div>
  );
}
