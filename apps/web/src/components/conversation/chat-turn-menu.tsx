import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { List, Check } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("conversation");
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
            aria-label={t("turns.outline")}
            className="fdy-chat-turn-menu-trigger"
            ref={triggerRef}
            variant="ghost"
          >
            <List size={16} />
            {t("turns.outline")}
            <span>
              {activeIndex + 1} / {anchors.length}
            </span>
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label={t("turns.outline")}
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
              {t("turns.outlineHeading", { count: anchors.length })}
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
