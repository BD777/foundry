import * as Dialog from "@radix-ui/react-dialog";
import { useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { Button } from "../ui/button";

/** Owns its layout classes; Radix owns focus trapping and dismissal. */
export function WorkspaceDialog({
  title,
  description,
  busy,
  onClose,
  children,
  initialFocus,
  returnFocusTo,
}: {
  title: string;
  description: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  initialFocus?: RefObject<HTMLInputElement | null>;
  returnFocusTo?: HTMLElement | null;
}) {
  const returnFocus = useRef(returnFocusTo ?? document.activeElement);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fdy-location-overlay" />
        <Dialog.Content
          className="fdy-workspace-dialog"
          onOpenAutoFocus={(event) => {
            if (initialFocus?.current) {
              event.preventDefault();
              initialFocus.current.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current instanceof HTMLElement)
              returnFocus.current.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <header className="fdy-location-header">
            <div>
              <Dialog.Title className="fdy-location-title">
                {title}
              </Dialog.Title>
              <Dialog.Description className="fdy-location-description">
                {description}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={`Close ${title}`}
              >
                <X size={18} />
              </Button>
            </Dialog.Close>
          </header>
          <div className="fdy-workspace-dialog-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
