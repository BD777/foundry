import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";
import { Spinner } from "./loading";

/*
 * Adapted from Beautiful UI's Button (MIT, (c) 2026 Shane Levine): a pill with
 * a press scale and an inset highlight on filled variants. The variant and
 * size names are Foundry's; the `fdy-button*` classes stay as hooks for tests
 * and for the few places that place a button (they carry no style).
 */
const filledShadow = "shadow-(--fdy-shadow-accent)";

export const buttonVariants = cva(
  `fdy-button relative inline-flex min-w-0 max-w-full items-center justify-center
   gap-2 select-none whitespace-nowrap rounded-full font-medium leading-none
   outline-none transition-[transform,background-color,color,opacity,box-shadow]
   duration-150 ease-out-strong active:scale-[0.96] focus-visible:outline-2
   focus-visible:outline-offset-2 focus-visible:outline-(color:--fdy-accent)
   disabled:pointer-events-none disabled:opacity-50
   aria-disabled:pointer-events-none aria-disabled:opacity-50`,
  {
    variants: {
      variant: {
        primary: `fdy-button-primary bg-brand text-on-brand hover:bg-brand-dark ${filledShadow}`,
        secondary:
          "fdy-button-secondary bg-surface text-ink shadow-btn hover:bg-inset aria-expanded:bg-hover",
        /** A destructive confirmation, such as stopping running work. */
        danger:
          "fdy-button-danger bg-red-tint text-(--fdy-error-text) shadow-[0_0_0_1px_color-mix(in_oklab,var(--red)_30%,transparent)] hover:bg-[color-mix(in_oklab,var(--red)_20%,var(--surface))]",
        ghost: "fdy-button-ghost text-ink hover:bg-hover-2",
        /**
         * No background of its own, hovered or not: a click target filling a
         * row or card whose surface owns hover, so one layer changes color.
         */
        bare: "fdy-button-bare text-inherit",
        nav: "fdy-button-nav text-inherit hover:bg-hover-2",
        icon: "fdy-button-icon text-inherit hover:bg-hover-2",
        /** Reads as a link inside text; acts as a button (opens in-app). */
        link: "fdy-button-link rounded-md text-(--fdy-info-text) hover:underline underline-offset-3",
      },
      size: {
        sm: "fdy-button-sm h-[27px] gap-1.5 px-3 text-xs",
        md: "fdy-button-md px-4 py-2 text-[13px]",
        lg: "fdy-button-lg px-5 py-2.5 text-sm",
        icon: "fdy-button-icon-size size-8 p-0",
        /** Flows with the surrounding text: its font, line height, wrapping. */
        inline:
          "fdy-button-inline inline h-auto gap-[3px] rounded-md px-px align-baseline leading-[inherit] whitespace-normal",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends
    ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * A pending submit: a spinner before the label, `aria-busy`, and no
   * further clicks. Give it the label of the work under way ("Saving…").
   */
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      asChild = false,
      busy = false,
      children,
      className,
      disabled,
      size,
      type = "button",
      variant,
      ...props
    },
    ref,
  ) {
    const Comp = asChild ? Slot : "button";

    return (
      <Comp
        className={cn(buttonVariants({ size, variant }), className)}
        ref={ref}
        {...(!asChild ? { type } : {})}
        {...props}
        aria-busy={busy || props["aria-busy"] || undefined}
        data-busy={busy ? "true" : undefined}
        disabled={busy || disabled}
      >
        {busy && !asChild ? (
          <>
            <Spinner />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
