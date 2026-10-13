import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";

export interface RowMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  /** Asks first, saying what happens: for actions that cannot be undone. */
  confirm?: { title: string; body: string; action: string };
}

/**
 * A row's less frequent actions behind one "…" button. An item that cannot
 * be undone opens a dialog that says what it does before it runs.
 */
export function RowMenu({
  label,
  items,
  disabled,
}: {
  /** The row as people see it, for the button's accessible name. */
  label: string;
  items: RowMenuItem[];
  disabled: boolean;
}) {
  const { t } = useTranslation("externalAccounts");
  const [confirming, setConfirming] = useState<RowMenuItem>();
  const trigger = useRef<HTMLButtonElement>(null);
  if (items.length === 0) return null;
  // While an action runs the items are disabled but the trigger stays
  // focusable, so keyboard focus is not dropped to the page.
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label={t("actions.more", { name: label })}
            ref={trigger}
            size="sm"
            variant="ghost"
          >
            <MoreHorizontal size={16} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="fdy-workspace-actions-menu"
            collisionPadding={12}
            sideOffset={6}
          >
            {items.map((item) => (
              <DropdownMenu.Item
                className="fdy-workspace-menu-item"
                disabled={disabled}
                key={item.key}
                onSelect={() =>
                  item.confirm ? setConfirming(item) : item.onSelect()
                }
              >
                {item.confirm ? `${item.label}…` : item.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Dialog.Root
        open={Boolean(confirming)}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fdy-xacc-modal-overlay" />
          <Dialog.Content
            className="fdy-xacc-modal fdy-xacc-confirm"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
          >
            <header className="fdy-xacc-modal-header">
              <div>
                <Dialog.Title>{confirming?.confirm?.title}</Dialog.Title>
                <Dialog.Description>
                  {confirming?.confirm?.body}
                </Dialog.Description>
              </div>
            </header>
            <div className="fdy-xacc-form-actions">
              <Dialog.Close asChild>
                <Button variant="ghost">{t("connect.cancel")}</Button>
              </Dialog.Close>
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
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
