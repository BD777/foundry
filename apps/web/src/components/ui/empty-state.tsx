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
    <div className={cn("fdy-empty-state", className)} {...props}>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}
