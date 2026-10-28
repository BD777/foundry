import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import { openAppHref } from "../../lib/in-app-navigation";

/** A click the browser should handle itself: a new tab, window or download. */
function opensElsewhere(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

/**
 * A real link to one of the app's pages: copying it, a middle or
 * modified click, and "open in new tab" work as for any link, while an
 * ordinary click (or Enter) opens the page in place.
 */
export function AppLink({
  href,
  onClick,
  ...props
}: ComponentPropsWithoutRef<"a"> & { href: string }) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (opensElsewhere(event)) return;
        if (openAppHref(href)) event.preventDefault();
      }}
    />
  );
}
