import { cva, type VariantProps } from "class-variance-authority";
import { Check, Info } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export const checklistRowVariants = cva("fdy-check-row", {
  variants: {
    marker: {
      check: "fdy-check-row-check",
      dot: "fdy-check-row-dot",
      info: "fdy-check-row-info",
    },
    /** The marker's outline: a rounded square, or a circle. */
    shape: {
      square: null,
      round: "fdy-check-row-round",
    },
    tone: {
      neutral: "fdy-check-row-neutral",
      success: "fdy-check-row-success",
      warning: "fdy-check-row-warning",
    },
  },
  defaultVariants: {
    marker: "dot",
    shape: "square",
    tone: "neutral",
  },
});

export interface ChecklistRowProps
  extends
    HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof checklistRowVariants> {
  children: ReactNode;
}

export function ChecklistRow({
  children,
  className,
  marker,
  shape,
  tone,
  ...props
}: ChecklistRowProps) {
  const Icon = marker === "check" ? Check : marker === "info" ? Info : null;

  return (
    <div
      className={cn(checklistRowVariants({ marker, shape, tone }), className)}
      {...props}
    >
      <span className="fdy-check-row-marker">
        {Icon ? <Icon size={9} /> : null}
      </span>
      <span className="fdy-check-row-body">{children}</span>
    </div>
  );
}
