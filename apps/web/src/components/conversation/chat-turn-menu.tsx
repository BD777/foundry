import {
  DropdownMenuEntry,
  DropdownMenuLabel,
  DropdownMenuSurface,
} from "../ui/row-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { List } from "lucide-react";
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
          <DropdownMenuSurface
            aria-label={t("turns.outline")}
            align="end"
            collisionPadding={12}
            sideOffset={6}
            onCloseAutoFocus={(event) => {
              if (!triggerRef.current?.getClientRects().length)
                event.preventDefault();
            }}
          >
            <DropdownMenuLabel>
              {t("turns.outlineHeading", { count: anchors.length })}
            </DropdownMenuLabel>
            {anchors.map((anchor, index) => (
              <DropdownMenuEntry
                key={anchor.id}
                onSelect={() => onNavigate(anchor)}
                textValue={anchor.query}
                selected={index === activeIndex}
                aria-current={index === activeIndex ? "step" : undefined}
                icon={index + 1}
                reserveIcon
              >
                {anchor.query}
              </DropdownMenuEntry>
            ))}
          </DropdownMenuSurface>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
});
