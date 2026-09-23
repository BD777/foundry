import { useEffect } from "react";
import type { NavView } from "./navigation";

export function useViewScrollReset(
  activeView: NavView,
  selectedIssueId: string,
): void {
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          '[data-foundry-sidebar-nav-link="true"][data-state="active"]',
        )
        ?.scrollIntoView({ block: "nearest", inline: "center" });

      window.scrollTo({ left: 0, top: 0 });
      document
        .querySelectorAll<HTMLElement>('[data-foundry-scroll-reset="true"]')
        .forEach((element) => {
          element.scrollTop = 0;
          element.scrollLeft = 0;
        });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeView, selectedIssueId]);
}
