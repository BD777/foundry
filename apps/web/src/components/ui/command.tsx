import { Command as CommandPrimitive } from "cmdk";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import { cn } from "../../lib/cn";

/*
 * After shadcn/ui's Command (cmdk): a keyboard-navigable listbox with an
 * optional filter input. cmdk marks the active item `data-selected`. The
 * surface is Foundry's: a panel on the hairline ring, an item a rounded row
 * that tints when active.
 */
export const Command = forwardRef<
  ElementRef<typeof CommandPrimitive>,
  ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    className={cn(
      "fdy-command flex flex-col rounded-xl bg-panel text-ink",
      className,
    )}
    ref={ref}
    {...props}
  />
));
Command.displayName = "Command";

export const CommandInput = forwardRef<
  ElementRef<typeof CommandPrimitive.Input>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Input
    className={cn(
      "fdy-command-input block w-full min-w-0 border-0 bg-transparent px-2.5 py-2 text-sm text-ink caret-brand outline-none placeholder:text-ink-faint disabled:cursor-default disabled:opacity-50",
      className,
    )}
    ref={ref}
    {...props}
  />
));
CommandInput.displayName = "CommandInput";

export const CommandList = forwardRef<
  ElementRef<typeof CommandPrimitive.List>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    className={cn(
      "fdy-command-list overflow-x-hidden overflow-y-auto overscroll-contain",
      className,
    )}
    ref={ref}
    {...props}
  />
));
CommandList.displayName = "CommandList";

export const CommandEmpty = forwardRef<
  ElementRef<typeof CommandPrimitive.Empty>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty
    className={cn(
      "fdy-command-empty px-2.5 py-2 text-xs leading-normal text-ink-faint",
      className,
    )}
    ref={ref}
    {...props}
  />
));
CommandEmpty.displayName = "CommandEmpty";

export const CommandGroup = forwardRef<
  ElementRef<typeof CommandPrimitive.Group>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    className={cn(
      "fdy-command-group overflow-hidden [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-ink-faint",
      className,
    )}
    ref={ref}
    {...props}
  />
));
CommandGroup.displayName = "CommandGroup";

export const CommandItem = forwardRef<
  ElementRef<typeof CommandPrimitive.Item>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    className={cn(
      "fdy-command-item relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-control-ghost-hover",
      className,
    )}
    ref={ref}
    {...props}
  />
));
CommandItem.displayName = "CommandItem";

export const CommandLoading = forwardRef<
  ElementRef<typeof CommandPrimitive.Loading>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Loading>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Loading
    className={cn("fdy-command-loading", className)}
    ref={ref}
    {...props}
  />
));
CommandLoading.displayName = "CommandLoading";
