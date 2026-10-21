import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * A small floating panel opened by click, Enter or Space and closed by Escape
 * or an outside click: details that a hover tooltip would hide from touch and
 * keyboard users. `trigger` must be a focusable control, such as a Button.
 */
export function Popover({
  children,
  className,
  trigger,
  label,
  openOnHover = false,
}: {
  children: ReactNode;
  className?: string;
  trigger: ReactNode;
  label?: string;
  /** Hover/focus preview, with click/touch pinning and normal dismissal. */
  openOnHover?: boolean;
}) {
  if (openOnHover)
    return (
      <PreviewPopover trigger={trigger} label={label} className={className}>
        {children}
      </PreviewPopover>
    );
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          aria-label={label}
          align="start"
          className={cn("fdy-popover", className)}
          collisionPadding={12}
          sideOffset={6}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** Uses Radix for positioning, dismissal and focus restoration. Preview never
 * steals focus or changes application state; clicking pins the same panel. */
function PreviewPopover({
  trigger,
  children,
  className,
  label,
}: {
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressFocus = useRef(false);
  const wasPinned = useRef(false);
  const clear = () => {
    clearTimeout(timer.current);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (open && pinned) contentRef.current?.focus();
  }, [open, pinned]);
  function change(next: boolean) {
    clear();
    setOpen(next);
    if (!next) setPinned(false);
  }
  function preview() {
    clear();
    if (suppressFocus.current) return;
    wasPinned.current = pinned;
    setOpen(true);
  }
  function leave() {
    clear();
    timer.current = setTimeout(() => {
      if (
        !pinned &&
        !triggerRef.current?.contains(document.activeElement) &&
        !contentRef.current?.contains(document.activeElement)
      )
        setOpen(false);
    }, 180);
  }
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={change}>
      <PopoverPrimitive.Trigger
        asChild
        ref={triggerRef}
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") preview();
        }}
        onPointerLeave={leave}
        onFocus={preview}
        onBlur={leave}
        onClick={(event) => {
          event.preventDefault();
          clear();
          if (open && pinned) {
            change(false);
            return;
          }
          wasPinned.current = true;
          setPinned(true);
          setOpen(true);
          contentRef.current?.focus();
        }}
      >
        {trigger}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={contentRef}
          tabIndex={-1}
          aria-label={label}
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cn("fdy-popover", className)}
          onPointerEnter={clear}
          onPointerLeave={leave}
          onFocus={clear}
          onBlur={leave}
          onOpenAutoFocus={(event) => {
            if (!wasPinned.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            if (!wasPinned.current) {
              event.preventDefault();
              return;
            }
            suppressFocus.current = true;
            queueMicrotask(() => {
              suppressFocus.current = false;
            });
          }}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
