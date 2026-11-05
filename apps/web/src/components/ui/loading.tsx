import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * The loading primitives, one per wait, placed in the region that waits
 * (docs/devlog/DEV-139-loading-states.md):
 *
 * - first load of a list or page: a Skeleton in the list's own box, in the
 *   shape of its rows ("items" for icon-and-title rows);
 * - first load of a dialog body, a panel or a small section: a LoadingState
 *   in that body ("block" centres it);
 * - content already shown and being refreshed or saved: keep the content and
 *   put a labelled Spinner beside the region's title or in its refresh
 *   button; never a row that pushes the content;
 * - a pending submit: a busy Button.
 *
 * Standalone indicators (LoadingState, Skeleton, a labelled Spinner) stay
 * invisible for their first 300 ms while holding their space, so a quick
 * answer never flashes one. The region that waits takes `aria-busy`.
 */

const appear = "animate-loading-appear";

/**
 * A turning ring. Without `label` it is decorative: what it waits for is named
 * beside it (a busy Button, a LoadingState). With `label` it stands alone, by
 * a title or in a row, as a polite status naming the work for assistive
 * technology.
 */
export function Spinner({
  className,
  label,
  size = 14,
}: {
  className?: string;
  label?: string;
  size?: number;
}) {
  const ring = (
    <LoaderCircle
      aria-hidden="true"
      className={cn(
        "fdy-spinner flex-none animate-spinner motion-reduce:animate-none",
        !label && className,
      )}
      size={size}
    />
  );
  if (!label) return ring;
  return (
    <span
      className={cn(
        "fdy-spinner-status inline-flex flex-none text-ink-faint",
        appear,
        className,
      )}
      role="status"
    >
      {ring}
      <span className="sr-only">{label}</span>
    </span>
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
        appear,
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

const bar =
  "fdy-skeleton-bar block animate-skeleton-sweep bg-line-strong bg-[linear-gradient(90deg,transparent_0%,color-mix(in_srgb,var(--fdy-paper-raised)_70%,transparent)_50%,transparent_100%)] bg-size-[200%_100%] motion-reduce:animate-none";

/** Title widths for "items", so the rows do not read as one block. */
const itemWidths = ["w-[72%]", "w-[54%]", "w-[64%]", "w-[46%]"];

/**
 * Placeholder bars in the shape of the content to come: lines of text, rows
 * of a list, or "items" (a mark and a title, the list rows of the sidebar,
 * trees and pickers; padded like those rows). `label` names what loads, for
 * assistive technology only.
 */
export function Skeleton({
  className,
  compact = false,
  label,
  rows = 3,
  variant = "lines",
}: {
  className?: string;
  /** "items" as tree rows: 28 px high with a small mark. */
  compact?: boolean;
  label: string;
  rows?: number;
  variant?: "lines" | "rows" | "items";
}) {
  return (
    <div
      aria-busy="true"
      className={cn(
        "fdy-skeleton grid",
        appear,
        variant === "items" ? !compact && "gap-[3px]" : "py-1",
        variant === "rows" ? "gap-2" : variant === "lines" && "gap-2.5",
        className,
      )}
      data-variant={variant}
      role="status"
    >
      <span className="fdy-skeleton-label sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) =>
        variant === "items" ? (
          <span
            aria-hidden="true"
            className={cn(
              "flex items-center",
              compact
                ? "h-7 gap-1.5 px-3"
                : "min-h-[38px] gap-[9px] px-2.5 py-1.5",
            )}
            key={index}
          >
            <span
              className={cn(
                bar,
                "flex-none",
                compact ? "size-3.5 rounded-xs" : "size-[26px] rounded-sm",
              )}
            />
            <span
              className={cn(
                bar,
                "h-2.5 rounded-full",
                itemWidths[index % itemWidths.length],
              )}
            />
          </span>
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              bar,
              variant === "rows"
                ? "w-full h-[30px] rounded-md"
                : "rounded-full h-2.5 nth-[3n+2]:w-[92%] nth-[3n]:w-[74%] nth-[3n+1]:w-[58%]",
            )}
            key={index}
          />
        ),
      )}
    </div>
  );
}
