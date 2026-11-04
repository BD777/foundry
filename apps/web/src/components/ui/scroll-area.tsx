import type { HTMLAttributes, Ref } from "react";
import { cn } from "../../lib/cn";

/**
 * The app's thin scrollbar for a native scroller: put it on any element that
 * scrolls (a ScrollArea's viewport does).
 */
export const scrollbarClassName =
  "[scrollbar-color:var(--fdy-scroll-thumb)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-corner]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-md [&::-webkit-scrollbar-thumb]:border-[3px] [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-(--fdy-scroll-thumb) [&::-webkit-scrollbar-thumb]:bg-clip-content [&::-webkit-scrollbar-thumb:hover]:bg-(--fdy-scroll-thumb-hover)";

const directionClass = {
  vertical: "overflow-x-hidden overflow-y-auto",
  horizontal: "overflow-x-auto overflow-y-hidden",
  both: "overflow-auto",
  none: "overflow-hidden",
} as const;

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  viewportRef?: Ref<HTMLDivElement>;
  /** Class of the scrolling viewport, for its padding. */
  viewportClassName?: string;
  /**
   * Which way the content scrolls; the other axis clips. "vertical" is the
   * default; "none" only clips.
   */
  direction?: "vertical" | "horizontal" | "both" | "none";
}

/**
 * A clipping box around one native scroller, with the app's thin scrollbar.
 * The content is the viewport's own child, so it lays out like any block.
 */
export function ScrollArea({
  children,
  className,
  direction = "vertical",
  viewportClassName,
  viewportRef,
  ...props
}: ScrollAreaProps) {
  return (
    <div
      className={cn("fdy-scroll-root relative overflow-hidden", className)}
      {...props}
    >
      <div
        className={cn(
          "fdy-scroll-viewport size-full rounded-[inherit]",
          scrollbarClassName,
          directionClass[direction],
          viewportClassName,
        )}
        data-direction={direction}
        ref={viewportRef}
      >
        {children}
      </div>
    </div>
  );
}
