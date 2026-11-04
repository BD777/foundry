import { cva, type VariantProps } from "class-variance-authority";
import { Check, Info } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * A line of a checklist after Beautiful UI's TaskRows: a small marker (a
 * check, a dot or an info mark) before the text, tinted by tone.
 */
export const checklistRowVariants = cva(
  "flex items-start gap-2.5 text-sm leading-[1.45]",
  {
    variants: {
      tone: {
        neutral: "text-ink",
        success: "text-success-text",
        warning: "text-warning-text",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

const markerVariants = cva(
  "mt-0.5 inline-flex size-[15px] flex-none items-center justify-center border",
  {
    variants: {
      marker: {
        check: "",
        dot: "after:size-[5px] after:rounded-full after:bg-current after:content-['']",
        info: "",
      },
      /** The marker's outline: a rounded square, or a circle. */
      shape: {
        square: "rounded-xs",
        round: "rounded-full",
      },
      tone: {
        neutral: "border-line-strong bg-panel-soft text-ink-faint",
        success: "border-success-border bg-success-surface text-success-text",
        warning: "border-warning-border bg-warning-surface text-warning-text",
      },
    },
    defaultVariants: { marker: "dot", shape: "square", tone: "neutral" },
  },
);

export interface ChecklistRowProps
  extends
    HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof checklistRowVariants>,
    VariantProps<typeof markerVariants> {
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
    <div className={cn(checklistRowVariants({ tone }), className)} {...props}>
      <span className={markerVariants({ marker, shape, tone })}>
        {Icon ? <Icon size={9} /> : null}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
