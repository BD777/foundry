import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface FactGridItem {
  label: ReactNode;
  mono?: boolean;
  value: ReactNode;
}

export const factGridVariants = cva("fdy-fact-grid", {
  variants: {
    density: {
      compact: "fdy-fact-grid-compact",
      md: "fdy-fact-grid-md",
    },
  },
  defaultVariants: {
    density: "md",
  },
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
  ...props
}: FactGridProps) {
  return (
    <div className={cn(factGridVariants({ density }), className)} {...props}>
      {items.map((item, index) => (
        <div className="fdy-fact-grid-cell" key={index}>
          <span>{item.label}</span>
          <strong data-mono={item.mono ? "true" : "false"}>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}
