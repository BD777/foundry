import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";

export interface RepositoryMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
}

/**
 * A repository card's secondary actions behind one "…" button, so the card's
 * text keeps its width. Stopping to follow is last and asks first, saying
 * what happens to the skills.
 */
export function RepositoryActions({
  label,
  items,
  disabled,
  unfollowCopy,
  onUnfollow,
}: {
  /** The repository as people see it, for the menu's name and the dialog. */
  label: string;
  items: RepositoryMenuItem[];
  disabled: boolean;
  /** What stopping does to this repository's skills. */
  unfollowCopy: string;
  onUnfollow: () => void;
}) {
  const { t } = useTranslation(["skills", "common"]);
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // While an action runs, its items are disabled but the trigger stays
  // focusable: a disabled trigger would drop keyboard focus to the page
  // right after the person chose an action from it.
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label={t("library.repo.actionsFor", { label })}
            className="fdy-skill-repo-menu-trigger"
            ref={trigger}
            size="sm"
            variant="ghost"
          >
            <MoreHorizontal size={17} />
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
                onSelect={item.onSelect}
              >
                {item.icon}
                {item.label}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Item
              className="fdy-workspace-menu-item"
              disabled={disabled}
              onSelect={() => setConfirming(true)}
            >
              {t("library.repo.removeMenu")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Dialog.Root
        open={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fdy-connection-assign-overlay" />
          <Dialog.Content
            className="fdy-connection-assign-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              trigger.current?.focus();
            }}
          >
            <header className="fdy-connection-assign-header">
              <div>
                <Dialog.Title>
                  {t("library.repo.removeTitle", { label })}
                </Dialog.Title>
                <Dialog.Description>{unfollowCopy}</Dialog.Description>
              </div>
            </header>
            <footer className="fdy-connection-assign-actions fdy-skill-dialog-actions">
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                {t("common:actions.cancel")}
              </Button>
              <Button
                onClick={() => {
                  setConfirming(false);
                  onUnfollow();
                }}
                variant="primary"
              >
                {t("library.repo.remove")}
              </Button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
