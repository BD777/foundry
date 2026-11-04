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
      className={cn(
        "fdy-spinner flex-none animate-spinner motion-reduce:animate-none",
        className,
      )}
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
      className={cn(
        "fdy-loading-state flex min-w-0 items-center gap-2 text-sm leading-[1.45] text-ink-muted",
        layout === "block" && "justify-center px-3 py-6",
        className,
      )}
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
      className={cn(
        "fdy-skeleton grid py-1",
        variant === "rows" ? "gap-2" : "gap-2.5",
        className,
      )}
      data-variant={variant}
      role="status"
    >
      <span className="fdy-skeleton-label sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <span
          aria-hidden="true"
          className={cn(
            "fdy-skeleton-bar block animate-skeleton-sweep bg-line bg-[linear-gradient(90deg,transparent_0%,color-mix(in_srgb,var(--fdy-paper-raised)_70%,transparent)_50%,transparent_100%)] bg-size-[200%_100%] motion-reduce:animate-none",
            variant === "rows"
              ? "w-full h-[30px] rounded-md"
              : "rounded-full h-2.5 nth-[3n+2]:w-[92%] nth-[3n]:w-[74%] nth-[3n+1]:w-[58%]",
          )}
          key={index}
        />
      ))}
    </div>
  );
}
