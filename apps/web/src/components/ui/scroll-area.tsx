import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentPropsWithoutRef, Ref } from "react";
import { cn } from "../../lib/cn";

export interface ScrollAreaProps extends ComponentPropsWithoutRef<
  typeof ScrollAreaPrimitive.Root
> {
  viewportRef?: Ref<HTMLDivElement>;
  /** Class of the scrolling viewport, for its padding or overflow policy. */
  viewportClassName?: string;
  /**
   * How the content box lays out. Radix sizes it as a table so the content
   * can grow wider than the viewport ("table", the default). "block" keeps it
   * at the viewport's width, so rows wrap or truncate instead; "columns"
   * fills the viewport's height and turns into "block" on narrow screens.
   */
  contentLayout?: "table" | "block" | "columns";
}

export function ScrollArea({
  children,
  className,
  contentLayout = "table",
  viewportClassName,
  viewportRef,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      className={cn("fdy-scroll-root", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn("fdy-scroll-viewport", viewportClassName)}
        data-content-layout={
          contentLayout === "table" ? undefined : contentLayout
        }
        ref={viewportRef}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        className="fdy-scrollbar"
        orientation="vertical"
      >
        <ScrollAreaPrimitive.Thumb className="fdy-scroll-thumb" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar
        className="fdy-scrollbar fdy-scrollbar-horizontal"
        orientation="horizontal"
      >
        <ScrollAreaPrimitive.Thumb className="fdy-scroll-thumb" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner className="fdy-scroll-corner" />
    </ScrollAreaPrimitive.Root>
  );
}
