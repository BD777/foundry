import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../lib/cn";
import {
  ContextMenuItem,
  ContextMenuSeparator as Separator,
} from "./context-menu";
import { DropdownMenuItem, DropdownMenuLabel as Label } from "./dropdown-menu";
import { menuContentClass, menuItemClass } from "./menu-styles";

export interface MenuEntryContent {
  children: ReactNode;
  reason?: ReactNode;
  icon?: ReactNode;
  reserveIcon?: boolean;
  trailing?: ReactNode;
  selected?: boolean;
  tone?: "default" | "danger";
}
function MenuEntryLabel({
  children,
  reason,
  icon,
  reserveIcon,
  trailing,
  selected,
}: MenuEntryContent) {
  return (
    <>
      {icon || reserveIcon ? (
        <span
          className="inline-flex w-4 flex-none items-center justify-center"
          aria-hidden="true"
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block [overflow-wrap:anywhere]">{children}</span>
        {reason ? (
          <span className="mt-[3px] block text-xs font-normal text-ink-muted">
            {reason}
          </span>
        ) : null}
      </span>
      {trailing || selected ? (
        <span className="inline-flex flex-none text-ink-muted">
          {trailing || <Check size={14} aria-hidden="true" />}
        </span>
      ) : null}
    </>
  );
}
type ContextEntryProps = Omit<
  ComponentPropsWithoutRef<typeof ContextMenu.Item>,
  "asChild" | "children"
> &
  MenuEntryContent;
export function ContextMenuEntry({
  children,
  reason,
  icon,
  reserveIcon,
  trailing,
  selected,
  tone = "default",
  ...props
}: ContextEntryProps) {
  return (
    <ContextMenuItem
      {...props}
      data-tone={tone}
      data-selected={selected || undefined}
      aria-current={props["aria-current"] ?? (selected ? "true" : undefined)}
    >
      <MenuEntryLabel
        {...{ children, reason, icon, reserveIcon, trailing, selected }}
      />
    </ContextMenuItem>
  );
}
type DropdownEntryProps = Omit<
  ComponentPropsWithoutRef<typeof DropdownMenu.Item>,
  "asChild" | "children"
> &
  MenuEntryContent;
export function DropdownMenuEntry({
  children,
  reason,
  icon,
  reserveIcon,
  trailing,
  selected,
  tone = "default",
  ...props
}: DropdownEntryProps) {
  return (
    <DropdownMenuItem
      {...props}
      data-tone={tone}
      data-selected={selected || undefined}
      aria-current={props["aria-current"] ?? (selected ? "true" : undefined)}
    >
      <MenuEntryLabel
        {...{ children, reason, icon, reserveIcon, trailing, selected }}
      />
    </DropdownMenuItem>
  );
}
export function ContextMenuSurface({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenu.Content>) {
  return (
    <ContextMenu.Content
      collisionPadding={12}
      {...props}
      className={cn(menuContentClass("context-menu"), className)}
    />
  );
}
export function ContextSubSurface({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenu.SubContent>) {
  return (
    <ContextMenu.SubContent
      collisionPadding={12}
      sideOffset={4}
      {...props}
      className={cn(menuContentClass("context-menu"), className)}
    />
  );
}
export function ContextSubTrigger({
  children,
  disabled,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof ContextMenu.SubTrigger>, "asChild">) {
  return (
    <ContextMenu.SubTrigger
      disabled={disabled}
      {...props}
      className={cn(menuItemClass, className)}
    >
      <MenuEntryLabel trailing={<ChevronRight size={14} aria-hidden="true" />}>
        {children}
      </MenuEntryLabel>
    </ContextMenu.SubTrigger>
  );
}
export function ContextMenuSeparator() {
  return <Separator />;
}
/**
 * A dropdown's content shown as a panel instead of action rows (the
 * composer's model and access settings): Radix menu focus and dismissal,
 * with the caller's own layout and styling.
 */
export function DropdownMenuPanel(
  props: ComponentPropsWithoutRef<typeof DropdownMenu.Content>,
) {
  return <DropdownMenu.Content {...props} />;
}
export function DropdownMenuSurface({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Content
      collisionPadding={12}
      sideOffset={6}
      {...props}
      className={cn(menuContentClass("dropdown-menu"), className)}
    />
  );
}
export function DropdownMenuLabel(
  props: ComponentPropsWithoutRef<typeof DropdownMenu.Label>,
) {
  return <Label {...props} />;
}
