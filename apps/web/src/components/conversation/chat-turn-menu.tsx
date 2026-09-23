import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { List, Check } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import type { ChatTurnAnchor } from "./chat-turn-navigation";

/** Compact navigation shares the rail's anchors and virtualizer jump command. */
export const ChatTurnMenu = memo(function ChatTurnMenu({
  activeIndex,
  anchors,
  onNavigate,
}: {
  activeIndex: number;
  anchors: readonly ChatTurnAnchor[];
  onNavigate: (anchor: ChatTurnAnchor) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // CSS owns the responsive mode. Dismiss a portaled menu when its trigger
  // disappears during resizing; no duplicate width/pointer breakpoints in JS.
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger) return;
    const observer = new ResizeObserver(() => {
      if (trigger.getClientRects().length === 0) setOpen(false);
    });
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [open]);

  return (
    <div className="fdy-chat-turn-toolbar">
      <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label="会话目录"
            className="fdy-chat-turn-menu-trigger"
            ref={triggerRef}
            variant="ghost"
          >
            <List size={16} />
            会话目录
            <span>
              {activeIndex + 1} / {anchors.length}
            </span>
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label="会话目录"
            align="end"
            className="fdy-chat-turn-menu"
            collisionPadding={12}
            sideOffset={6}
            onCloseAutoFocus={(event) => {
              if (!triggerRef.current?.getClientRects().length)
                event.preventDefault();
            }}
          >
            <DropdownMenu.Label className="fdy-chat-turn-menu-label">
              会话目录 · {anchors.length} 个轮次
            </DropdownMenu.Label>
            {anchors.map((anchor, index) => (
              <DropdownMenu.Item
                asChild
                key={anchor.id}
                onSelect={() => onNavigate(anchor)}
                textValue={anchor.query}
              >
                <Button
                  aria-current={index === activeIndex ? "step" : undefined}
                  className="fdy-chat-turn-menu-item"
                  variant="ghost"
                >
                  <span className="fdy-chat-turn-menu-number">{index + 1}</span>
                  <span className="fdy-chat-turn-menu-query">
                    {anchor.query}
                  </span>
                  {index === activeIndex ? <Check size={14} /> : null}
                </Button>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
});
