import { cn } from "../../lib/cn";

/*
 * The look shared by the shadcn DropdownMenu and ContextMenu (menus open from
 * a button or a right click; Radix owns the behaviour), on Beautiful UI's
 * overlay surface. A menu is the one surface that clears an open dialog (z 100).
 */
const base =
  "z-110 overflow-y-auto overscroll-contain rounded-lg bg-surface p-[5px] text-ink shadow-floating";

/** Sized by the room Radix measures for the menu (literal classes: Tailwind reads the source). */
const contentSize = {
  "dropdown-menu": cn(
    "min-w-[min(210px,var(--radix-dropdown-menu-content-available-width,calc(100vw-24px)))]",
    "max-w-[min(360px,calc(100vw-24px),var(--radix-dropdown-menu-content-available-width,calc(100vw-24px)))]",
    "max-h-[min(440px,var(--radix-dropdown-menu-content-available-height,calc(100dvh-24px)))]",
  ),
  "context-menu": cn(
    "min-w-[min(210px,var(--radix-context-menu-content-available-width,calc(100vw-24px)))]",
    "max-w-[min(360px,calc(100vw-24px),var(--radix-context-menu-content-available-width,calc(100vw-24px)))]",
    "max-h-[min(440px,var(--radix-context-menu-content-available-height,calc(100dvh-24px)))]",
  ),
};

export function menuContentClass(kind: keyof typeof contentSize) {
  return cn(base, contentSize[kind]);
}

export const menuItemClass = cn(
  "flex min-h-[34px] cursor-pointer select-none items-center gap-[9px] rounded-sm px-2.5 py-2",
  "text-left text-sm leading-[1.4] text-ink outline-none",
  "not-data-disabled:data-highlighted:bg-control-ghost-hover",
  "not-data-disabled:data-[state=open]:bg-control-ghost-hover",
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info-border",
  "data-selected:bg-accent-soft not-data-disabled:data-[tone=danger]:text-error-text",
  "data-disabled:cursor-default data-disabled:text-ink-faint",
);

export const menuSeparatorClass = "mx-[5px] my-1 h-px bg-line";

export const menuLabelClass = "px-2.5 py-2 text-xs text-ink-muted";
