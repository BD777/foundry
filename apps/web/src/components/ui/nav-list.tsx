import { forwardRef, useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button, type ButtonProps } from "./button";

/*
 * One look for navigation: the app sidebar and a page's own section list
 * (such as Assistant settings) use the same entries and group headings, so a
 * second column of navigation reads as part of the same system.
 */

/** A navigation entry; `data-state="active"` marks the current one. */
export const navItemClass = cn(
  "fdy-nav-item mb-0.5 flex h-auto min-h-[35px] w-full min-w-0 justify-start gap-2.5 rounded-md border-0 px-3 py-[9px] text-md leading-[1.25] text-ink-muted",
  "data-[state=active]:bg-selected data-[state=active]:font-semibold data-[state=active]:text-ink data-[state=active]:shadow-selected data-[state=active]:hover:bg-selected",
);

/** The label above a group of navigation entries. */
export const navHeadingClass =
  "fdy-nav-heading flex items-center gap-2 px-3 pt-4 pb-2 text-2xs leading-[1.4] font-semibold text-ink-faint uppercase";

export interface NavItemProps extends Omit<ButtonProps, "variant" | "size"> {
  /** The entry for the page or section on screen. */
  current?: boolean;
}

/** A navigation entry: a button, or with `asChild` a link it styles. */
export const NavItem = forwardRef<HTMLButtonElement, NavItemProps>(
  function NavItem({ className, current = false, ...props }, ref) {
    return (
      <Button
        aria-current={current ? "page" : undefined}
        className={cn(navItemClass, className)}
        data-state={current ? "active" : "idle"}
        ref={ref}
        variant="nav"
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
