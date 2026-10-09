import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * A small floating panel opened by click, Enter or Space and closed by Escape
 * or an outside click: details that a hover tooltip would hide from touch and
 * keyboard users. `trigger` must be a focusable control, such as a Button.
 */
export function Popover({
  children,
  className,
  trigger,
}: {
  children: ReactNode;
  className?: string;
  trigger: ReactNode;
}) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          className={cn("fdy-popover", className)}
          collisionPadding={12}
          sideOffset={6}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
