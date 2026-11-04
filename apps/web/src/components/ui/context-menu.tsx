import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";
import {
  menuContentClass,
  menuItemClass,
  menuSeparatorClass,
} from "./menu-styles";

/*
 * shadcn/ui's ContextMenu on Radix, looking like Beautiful UI's overlay menu
 * (the same surface as dropdown-menu.tsx).
 */
export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuPortal = ContextMenuPrimitive.Portal;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export function ContextMenuContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        collisionPadding={12}
        {...props}
        className={cn(menuContentClass("context-menu"), className)}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuSubContent({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.SubContent
      collisionPadding={12}
      sideOffset={4}
      {...props}
      className={cn(menuContentClass("context-menu"), className)}
    />
  );
}

export function ContextMenuItem({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      {...props}
      className={cn(menuItemClass, className)}
    />
  );
}

export function ContextMenuSubTrigger({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger>) {
  return (
    <ContextMenuPrimitive.SubTrigger
      {...props}
      className={cn(menuItemClass, className)}
    />
  );
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      {...props}
      className={cn(menuSeparatorClass, className)}
    />
  );
}
