import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

export const buttonVariants = cva("fdy-button", {
  variants: {
    variant: {
      primary: "fdy-button-primary",
      secondary: "fdy-button-secondary",
      ghost: "fdy-button-ghost",
      nav: "fdy-button-nav",
      icon: "fdy-button-icon",
    },
    size: {
      sm: "fdy-button-sm",
      md: "fdy-button-md",
      lg: "fdy-button-lg",
      icon: "fdy-button-icon-size",
    },
  },
  defaultVariants: {
    variant: "secondary",
    size: "md",
  },
});

export interface ButtonProps
  extends
    ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { asChild = false, className, size, type = "button", variant, ...props },
    ref,
  ) {
    const Comp = asChild ? Slot : "button";

    return (
      <Comp
        className={cn(buttonVariants({ size, variant }), className)}
        ref={ref}
        {...(!asChild ? { type } : {})}
        {...props}
      />
    );
  },
);
