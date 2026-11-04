import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * tailwind-merge only knows Tailwind's default scales. The shadows, easings
 * and animations that styles/foundation.css adds to the theme are named here,
 * so `shadow-none` after `shadow-card` replaces it instead of both staying and
 * the sheet's order deciding. A `text-*` size still replaces a `leading-*`
 * written before it (tailwind-merge assumes v3 sizes carry a line height), so
 * a component writes its `leading-*` after its `text-*`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: [
        "hairline",
        "btn",
        "card",
        "raised",
        "overlay",
        "floating",
        "drop",
        "sheet",
        "prompt",
        "prompt-focus",
        "prompt-drag",
        "panel-focus",
        "inset-field",
        "field",
        "field-hover",
        "field-focus",
        "selected",
        "issue-selected",
        "approval",
      ],
      ease: ["out-strong", "in-out-strong", "link"],
      animate: [
        "spinner",
        "spin-slow",
        "pulse-dot",
        "skeleton-sweep",
        "page-fade",
        "turn-preview-in",
        "chat-screen-in",
        "sweep",
      ],
    },
  },
});

/** Joins class names; a later Tailwind utility wins over a conflicting earlier one. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
