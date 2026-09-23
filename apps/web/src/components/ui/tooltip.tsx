import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export function Tooltip({
  children,
  content,
}: {
  children: ReactNode;
  content: ReactNode;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={240}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="fdy-tooltip" sideOffset={7}>
            {content}
            <TooltipPrimitive.Arrow className="fdy-tooltip-arrow" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
