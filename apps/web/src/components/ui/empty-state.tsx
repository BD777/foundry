import type { HTMLAttributes, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const emptyStateVariants = cva(
  "fdy-empty-state rounded-lg border border-dashed border-line-strong bg-surface text-center",
  {
    variants: {
      /** `pane`: the whole of a list's or a detail's pane is empty. */
      size: {
        default: "p-3.5",
        pane: "px-6 py-10",
      },
    },
    defaultVariants: { size: "default" },
  },
);

export interface EmptyStateProps
  extends
    Omit<HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof emptyStateVariants> {
  body: ReactNode;
  title: ReactNode;
}

export function EmptyState({
  body,
  className,
  size,
  title,
  ...props
}: EmptyStateProps) {
  return (
    <div className={cn(emptyStateVariants({ size }), className)} {...props}>
      <strong className="text-xs text-ink-faint">{title}</strong>
      <p className="mt-1 text-2xs leading-[1.4] text-ink-faint">{body}</p>
    </div>
  );
}
