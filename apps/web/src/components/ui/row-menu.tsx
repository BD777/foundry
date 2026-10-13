import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useRef, useState, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Dialog } from "./dialog";

export interface RowMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Asks first, saying what happens: for actions that cannot be undone. */
  confirm?: { title: string; body: string; action: string };
}

/**
 * A row's less frequent actions behind one "…" button. An item runs once the
 * menu has closed and focus is back on the button, so a dialog it opens
 * returns focus there. An item with `confirm` first opens a dialog that says
 * what it does.
 *
 * `disabled` disables the items while an action runs; the button stays
 * focusable, so keyboard focus is not dropped to the page right after the
 * person chose an action from it.
 */
export function RowMenu({
  label,
  items,
  disabled = false,
  triggerRef,
}: {
  /** The button's accessible name, e.g. "Actions for <row>". */
  label: string;
  items: RowMenuItem[];
  disabled?: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
}) {
  const { t } = useTranslation("common");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const chosen = useRef<RowMenuItem | undefined>(undefined);
  const [confirming, setConfirming] = useState<RowMenuItem>();
  if (items.length === 0) return null;
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label={label}
            className="fdy-row-menu-trigger"
            ref={(element) => {
              trigger.current = element;
              if (typeof triggerRef === "function") triggerRef(element);
              else if (triggerRef) triggerRef.current = element;
            }}
            size="sm"
            variant="ghost"
          >
            <MoreHorizontal size={17} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="fdy-row-menu"
            collisionPadding={12}
            onCloseAutoFocus={(event) => {
              const item = chosen.current;
              chosen.current = undefined;
              if (!item) return;
              event.preventDefault();
              trigger.current?.focus();
              if (item.confirm) setConfirming(item);
              else item.onSelect();
            }}
            sideOffset={6}
          >
            {items.map((item) => (
              <DropdownMenu.Item
                className="fdy-row-menu-item"
                disabled={disabled}
                key={item.key}
                onSelect={() => {
                  chosen.current = item;
                }}
              >
                {item.icon}
                {item.confirm ? `${item.label}…` : item.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Dialog
        description={confirming?.confirm?.body ?? ""}
        footer={
          <>
            <Button
              onClick={() => setConfirming(undefined)}
              variant="secondary"
            >
              {t("actions.cancel")}
            </Button>
            <Button
              onClick={() => {
                const item = confirming;
                setConfirming(undefined);
                item?.onSelect();
              }}
              variant="primary"
            >
              {confirming?.confirm?.action}
            </Button>
          </>
        }
        layout="compact"
        onClose={() => setConfirming(undefined)}
        open={Boolean(confirming)}
        returnFocusTo={trigger.current}
        title={confirming?.confirm?.title ?? ""}
      />
    </>
  );
}
