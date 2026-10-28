import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * The loading primitives: a Spinner beside whatever names the work, a
 * LoadingState for an action, dialog or small section that waits ("spinner
 * + a short label"), and a Skeleton standing in for content that is not
 * there yet. A pending submit is a busy Button (`busy`). Show one of them
 * per wait: never the same loading text twice in a view.
 */

/** A turning ring. Decorative: what it waits for is named beside it. */
export function Spinner({
  className,
  size = 14,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn("fdy-spinner", className)}
      size={size}
    />
  );
}

/** A spinner and a short label, announced politely as a busy status. */
export function LoadingState({
  className,
  label,
  layout = "inline",
}: {
  className?: string;
  label: ReactNode;
  /** "block" centres it in the area it fills (a dialog body, a panel). */
  layout?: "inline" | "block";
}) {
  return (
    <div
      aria-busy="true"
      className={cn("fdy-loading-state", className)}
      data-layout={layout}
      role="status"
    >
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

/**
 * Placeholder bars in the shape of the content to come: lines of text or
 * rows of a list. `label` names what loads, for assistive technology only.
 */
export function Skeleton({
  className,
  label,
  rows = 3,
  variant = "lines",
}: {
  className?: string;
  label: string;
  rows?: number;
  variant?: "lines" | "rows";
}) {
  return (
    <div
      aria-busy="true"
      className={cn("fdy-skeleton", className)}
      data-variant={variant}
      role="status"
    >
      <span className="fdy-skeleton-label">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <span aria-hidden="true" className="fdy-skeleton-bar" key={index} />
      ))}
    </div>
  );
}
