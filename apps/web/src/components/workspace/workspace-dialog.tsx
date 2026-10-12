import * as Dialog from "@radix-ui/react-dialog";
import { useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";

/**
 * Owns its layout classes; Radix owns focus trapping and dismissal. "wide"
 * fits reading long text, such as a skill's SKILL.md.
 */
export function WorkspaceDialog({
  title,
  description,
  size = "default",
  busy,
  onClose,
  children,
  initialFocus,
  returnFocusTo,
}: {
  title: string;
  description: string;
  size?: "default" | "wide";
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  initialFocus?: RefObject<HTMLInputElement | null>;
  returnFocusTo?: HTMLElement | null;
}) {
  const { t } = useTranslation("workspaces");
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
          className={cn(
            "fdy-workspace-dialog",
            size === "wide" && "fdy-workspace-dialog-wide",
          )}
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
                aria-label={t("details.closeLabel", { title })}
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
