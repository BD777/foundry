import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button, type ButtonProps } from "./button";

/*
 * One look for navigation: the app sidebar and a page's own section list
 * (such as Assistant settings) use the same entries and group headings, so a
 * second column of navigation reads as part of the same system.
 */

/**
 * A navigation entry; `data-state="active"` marks the current one. The rail
 * tone belongs on the app's canvas. The surface tone is a flat selection for
 * a page's own navigation inside a panel.
 */
export const navItemVariants = cva(
  "fdy-nav-item mb-0.5 flex h-auto min-h-[35px] w-full min-w-0 justify-start gap-2.5 rounded-md border-0 px-3 py-[9px] text-md leading-[1.25] text-ink-muted",
  {
    variants: {
      tone: {
        rail: "data-[state=active]:bg-selected data-[state=active]:font-semibold data-[state=active]:text-ink data-[state=active]:shadow-selected data-[state=active]:hover:bg-selected",
        surface:
          "data-[state=active]:bg-selection data-[state=active]:font-semibold data-[state=active]:text-ink data-[state=active]:hover:bg-selection",
      },
    },
    defaultVariants: { tone: "rail" },
  },
);

/** The rail entry's classes, kept for the app shell. */
export const navItemClass = navItemVariants({ tone: "rail" });

/** The label above a group of navigation entries. */
export const navHeadingClass =
  "fdy-nav-heading flex items-center gap-2 px-3 pt-4 pb-2 text-2xs leading-[1.4] font-semibold text-ink-faint uppercase";

export interface NavItemProps
  extends
    Omit<ButtonProps, "variant" | "size">,
    Pick<VariantProps<typeof navItemVariants>, "tone"> {
  /** The entry for the page or section on screen. */
  current?: boolean;
}

/** A navigation entry: a button, or with `asChild` a link it styles. */
export const NavItem = forwardRef<HTMLButtonElement, NavItemProps>(
  function NavItem({ className, current = false, tone, ...props }, ref) {
    return (
      <Button
        aria-current={current ? "page" : undefined}
        className={cn(navItemVariants({ tone }), className)}
        data-state={current ? "active" : "idle"}
        data-tone={tone ?? "rail"}
        ref={ref}
        variant={tone === "surface" ? "navSurface" : "nav"}
        {...props}
      />
    );
  },
);

export interface NavGroupProps {
  label: string;
  children: ReactNode;
  className?: string;
}

/** Navigation entries under a group heading, announced as one section. */
export function NavGroup({ label, children, className }: NavGroupProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn("group/nav-group", className)}
    >
      <h2
        className={cn(navHeadingClass, "group-first/nav-group:pt-0")}
        id={headingId}
      >
        {label}
      </h2>
      {children}
    </section>
  );
}
