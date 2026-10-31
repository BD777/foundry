import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Tooltip({
  children,
  content,
  variant = "label",
  open,
  onOpenChange,
}: {
  children: ReactNode;
  content: ReactNode;
  /** label: a control's short name; hint: a few sentences of help. */
  variant?: "label" | "hint";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={240}>
      <TooltipPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className={cn(
              "fdy-tooltip",
              variant === "hint" && "fdy-tooltip-hint",
            )}
            sideOffset={7}
            collisionPadding={12}
          >
            {content}
            <TooltipPrimitive.Arrow className="fdy-tooltip-arrow" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
