import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface EmptyStateProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "title"
> {
  body: ReactNode;
  title: ReactNode;
}

export function EmptyState({
  body,
  className,
  title,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "fdy-empty-state rounded-lg border border-dashed border-line-strong bg-surface p-3.5 text-center",
        className,
      )}
      {...props}
    >
      <strong className="text-xs text-ink-faint">{title}</strong>
      <p className="mt-1 text-2xs leading-[1.4] text-ink-faint">{body}</p>
    </div>
  );
}
