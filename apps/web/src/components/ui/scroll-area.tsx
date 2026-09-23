import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentPropsWithoutRef, Ref } from "react";
import { cn } from "../../lib/cn";

export interface ScrollAreaProps extends ComponentPropsWithoutRef<
  typeof ScrollAreaPrimitive.Root
> {
  viewportRef?: Ref<HTMLDivElement>;
}

export function ScrollArea({
  children,
  className,
  viewportRef,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      className={cn("fdy-scroll-root", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className="fdy-scroll-viewport"
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
