import * as SwitchPrimitive from "@radix-ui/react-switch";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import { cn } from "../../lib/cn";

/*
 * shadcn/ui's Switch on Radix, drawn with the theme's tokens: a pill track
 * that fills with the brand colour when on, and a raised thumb. The state
 * is the Radix root's own `data-state`; `fdy-switch` is a hook only.
 */
export const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn(
      `fdy-switch inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center rounded-full
       border-0 bg-ink-3/35 p-0.5 transition-colors duration-150
       focus-visible:outline-2 focus-visible:outline-offset-2
       focus-visible:outline-(color:--fdy-accent) data-[state=checked]:bg-brand
       disabled:cursor-not-allowed disabled:opacity-50`,
      className,
    )}
    ref={ref}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 rounded-full bg-surface shadow-hairline transition-transform duration-150 data-[state=checked]:translate-x-3.5" />
  </SwitchPrimitive.Root>
));

Switch.displayName = "Switch";
