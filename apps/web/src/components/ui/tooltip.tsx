import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cva } from "class-variance-authority";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * shadcn/ui's Tooltip on Radix, with Beautiful UI's tooltip tokens
 * (`bg-floating`: --tooltip-bg in light, a raised surface in dark).
 */
const hintClass =
  "grid max-w-[min(340px,calc(100vw-24px))] gap-1.5 rounded-sm px-3 py-2.5 text-xs font-normal leading-normal";

const tooltipVariants = cva(
  `z-50 border border-floating-line bg-floating text-floating-ink
   shadow-drop [overflow-wrap:anywhere]`,
  {
    variants: {
      variant: {
        label:
          "max-w-[220px] rounded-sm px-[9px] py-[7px] text-2xs font-semibold leading-[1.35]",
        hint: hintClass,
      },
    },
    defaultVariants: { variant: "label" },
  },
);

export const TooltipProvider = TooltipPrimitive.Provider;

export function TooltipContent({
  className,
  children,
  variant = "label",
  sideOffset = 7,
  ...props
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
  variant?: "label" | "hint";
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        className={cn(tooltipVariants({ variant }), className)}
        collisionPadding={12}
        sideOffset={sideOffset}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-floating" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

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
    <TooltipProvider delayDuration={240}>
      <TooltipPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipContent variant={variant}>{content}</TooltipContent>
      </TooltipPrimitive.Root>
    </TooltipProvider>
  );
}
