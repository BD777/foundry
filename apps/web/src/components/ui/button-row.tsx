import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export const buttonRowVariants = cva("flex min-w-0 flex-wrap items-center", {
  variants: {
    align: {
      start: "justify-start",
      end: "justify-end",
      between: "justify-between",
    },
    gap: {
      sm: "gap-1.5",
      md: "gap-2",
      wide: "gap-x-3 gap-y-2",
    },
  },
  defaultVariants: { align: "start", gap: "md" },
});

export interface ButtonRowProps
  extends HTMLAttributes<HTMLElement>, VariantProps<typeof buttonRowVariants> {
  as?: "div" | "span";
}

/** Buttons side by side; they wrap beneath each other when narrow. */
export function ButtonRow({
  align,
  as: Component = "div",
  className,
  gap,
  ...props
}: ButtonRowProps) {
  return (
    <Component
      className={cn(buttonRowVariants({ align, gap }), className)}
      {...props}
    />
  );
}
