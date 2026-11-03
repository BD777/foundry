import type { HTMLAttributes, Ref } from "react";
import { cn } from "../../lib/cn";

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
    <div className={cn("fdy-scroll-root", className)} {...props}>
      <div
        className={cn("fdy-scroll-viewport", viewportClassName)}
        data-direction={direction}
        ref={viewportRef}
      >
        {children}
      </div>
    </div>
  );
}
