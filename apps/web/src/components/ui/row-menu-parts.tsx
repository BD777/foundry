import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../lib/cn";

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
        <span className="fdy-row-menu-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="fdy-row-menu-copy">
        <span className="fdy-row-menu-label">{children}</span>
        {reason ? <span className="fdy-row-menu-reason">{reason}</span> : null}
      </span>
      {trailing || selected ? (
        <span className="fdy-row-menu-trailing">
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
  className,
  ...props
}: ContextEntryProps) {
  return (
    <ContextMenu.Item
      {...props}
      className={cn("fdy-row-menu-item", className)}
      data-tone={tone}
      data-selected={selected || undefined}
      aria-current={props["aria-current"] ?? (selected ? "true" : undefined)}
    >
      <MenuEntryLabel
        {...{ children, reason, icon, reserveIcon, trailing, selected }}
      />
    </ContextMenu.Item>
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
  className,
  ...props
}: DropdownEntryProps) {
  return (
    <DropdownMenu.Item
      {...props}
      className={cn("fdy-row-menu-item", className)}
      data-tone={tone}
      data-selected={selected || undefined}
      aria-current={props["aria-current"] ?? (selected ? "true" : undefined)}
    >
      <MenuEntryLabel
        {...{ children, reason, icon, reserveIcon, trailing, selected }}
      />
    </DropdownMenu.Item>
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
      className={cn("fdy-row-menu", className)}
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
      className={cn("fdy-row-menu", className)}
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
      className={cn("fdy-row-menu-item", className)}
    >
      <MenuEntryLabel trailing={<ChevronRight size={14} aria-hidden="true" />}>
        {children}
      </MenuEntryLabel>
    </ContextMenu.SubTrigger>
  );
}
export function ContextMenuSeparator() {
  return <ContextMenu.Separator className="fdy-row-menu-separator" />;
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
      className={cn("fdy-row-menu", className)}
    />
  );
}
export function DropdownMenuLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label
      {...props}
      className={cn("fdy-row-menu-heading", className)}
    />
  );
}
