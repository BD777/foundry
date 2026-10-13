import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";

export type DialogLayout = "sectioned" | "compact";
export type DialogSize = "default" | "wide" | "large";

/**
 * A modal with a title, a description, a close button and an optional
 * footer. Radix owns focus trapping and dismissal; `busy` blocks every way of
 * closing. Closing returns focus to `returnFocusTo`, or else to the element
 * focused as the dialog opened (dialogs here are opened by plain buttons or
 * menu items, never a Dialog.Trigger, so Radix knows no trigger).
 *
 * "sectioned" divides the header from a padded, scrolling body. "compact" is
 * one padded surface for pickers and confirmations, with actions in `footer`.
 * "wide" fits long text such as a SKILL.md; "large" a side-by-side diff.
 */
export function Dialog({
  title,
  description,
  open = true,
  onClose,
  layout = "sectioned",
  size = "default",
  busy,
  initialFocus,
  returnFocusTo,
  footer,
  children,
}: {
  title: string;
  description: string;
  /** Visibility, for a dialog that stays mounted while closed. */
  open?: boolean;
  /** Asked to close: Escape, outside click or the close button. */
  onClose: () => void;
  layout?: DialogLayout;
  size?: DialogSize;
  busy?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  /** Where focus goes on close when the opener itself goes away (a menu item). */
  returnFocusTo?: HTMLElement | null;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation("ui");
  const opener = useRef<HTMLElement | null>(null);
  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className="fdy-dialog-overlay"
          data-layout={layout}
        />
        <RadixDialog.Content
          className="fdy-dialog"
          data-layout={layout}
          data-size={size}
          onOpenAutoFocus={(event) => {
            opener.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
            if (initialFocus?.current) {
              event.preventDefault();
              initialFocus.current.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocusTo ?? opener.current;
            opener.current = null;
            if (!target) return;
            event.preventDefault();
            target.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <header className="fdy-dialog-header">
            <div>
              <RadixDialog.Title className="fdy-dialog-title">
                {title}
              </RadixDialog.Title>
              <RadixDialog.Description className="fdy-dialog-description">
                {description}
              </RadixDialog.Description>
            </div>
            <RadixDialog.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={t("dialog.close", { title })}
              >
                <X size={18} />
              </Button>
            </RadixDialog.Close>
          </header>
          {children != null ? (
            <div className="fdy-dialog-body">{children}</div>
          ) : null}
          {footer ? (
            <footer className="fdy-dialog-footer">{footer}</footer>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
