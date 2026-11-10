import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cva } from "class-variance-authority";
import { useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "./button";

export type DialogLayout = "sectioned" | "compact";
export type DialogSize =
  "default" | "wide" | "large" | "editor" | "viewport" | "preview";
export type DialogSide = "center" | "left";

/*
 * shadcn/ui's Dialog on Radix: an overlay and a centred surface or side
 * drawer. Each portal is one stacking context (the layer), so a later, nested
 * dialog covers the whole earlier one whatever its layout; menus still portal
 * above a dialog. The `fdy-dialog*` classes are hooks for tests and carry no
 * style.
 */
const overlayVariants = cva("pointer-events-auto fixed inset-0 z-0 bg-scrim", {
  variants: { layout: { sectioned: "backdrop-blur-xs", compact: "" } },
});

/* The dialog takes focus itself when the focused control inside it goes away
   (e.g. Install once it succeeds); it is a surface, not a control, so it draws
   no focus ring while its controls keep their own. */
const contentVariants = cva(
  `fdy-dialog pointer-events-auto fixed z-1 box-border bg-surface
   shadow-floating focus-visible:outline-none`,
  {
    variants: {
      side: {
        center: "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl",
        left: "inset-y-0 left-0 h-dvh rounded-r-xl",
      },
      layout: {
        /** A divided header above a padded body that scrolls. */
        sectioned:
          "flex min-h-0 w-[min(570px,calc(100vw-32px))] max-h-[calc(100dvh-40px)] flex-col overflow-hidden text-ink",
        /** One padded surface; the body between header and footer scrolls. */
        compact: `grid grid-rows-[auto_minmax(0,1fr)_auto] gap-3.5 p-(--fdy-dialog-padding)
          [--fdy-dialog-padding:20px] w-[min(560px,calc(100vw-32px))] max-h-[min(720px,calc(100vh-32px))]
          max-[560px]:[--fdy-dialog-padding:16px] max-[560px]:w-[calc(100vw-20px)] max-[560px]:max-h-[calc(100vh-20px)]`,
      },
      size: {
        default: "",
        wide: "w-[min(840px,calc(100vw-32px))]",
        /** A near-full-window working surface for wide content such as tables. */
        viewport:
          "h-[min(85vh,calc(100vh-32px))] w-[92vw] max-h-[calc(100vh-32px)]",
        /** A long-form reading surface that still leaves the page visible. */
        preview:
          "h-[min(85vh,calc(100vh-32px))] w-[min(900px,92vw)] max-h-[calc(100vh-32px)]",
        /** A form editor: its height stays put as the fields inside change. */
        editor:
          "h-[min(880px,calc(100vh-32px))] max-h-[calc(100vh-32px)] w-[min(820px,calc(100vw-32px))]",
        large:
          "h-[min(760px,calc(100vh-32px))] max-h-[calc(100vh-32px)] w-[min(960px,calc(100vw-32px))]",
      },
    },
    compoundVariants: [
      {
        layout: "compact",
        size: "wide",
        class: "max-[560px]:w-[calc(100vw-20px)]",
      },
      {
        layout: "compact",
        size: "large",
        class:
          "max-[560px]:w-[min(960px,calc(100vw-32px))] max-[560px]:max-h-[calc(100vh-32px)]",
      },
      {
        side: "left",
        class: "max-h-none w-[min(340px,calc(100vw-32px))]",
      },
    ],
    defaultVariants: {
      layout: "sectioned",
      side: "center",
      size: "default",
    },
  },
);

const headerVariants = cva("flex items-start justify-between", {
  variants: {
    layout: {
      sectioned: "flex-none gap-4 border-b border-line p-6 max-[700px]:p-4.5",
      compact: "gap-3",
    },
  },
});

const titleVariants = cva("fdy-dialog-title m-0 text-xl", {
  variants: {
    layout: {
      sectioned: "leading-[1.4] [overflow-wrap:anywhere]",
      compact: "leading-tight text-ink",
    },
  },
});

const descriptionVariants = cva(
  "fdy-dialog-description text-xs text-ink-muted",
  {
    variants: {
      layout: {
        sectioned: "mt-1.5 leading-[1.65]",
        compact: "mt-1 leading-normal",
      },
    },
  },
);

const bodyVariants = cva("fdy-dialog-body grid min-h-0 overflow-y-auto", {
  variants: {
    layout: {
      sectioned: "gap-4 p-6 max-[700px]:p-4.5",
      // The body is the one scroller: content keeps its natural height (an
      // auto row, stretched when short), so the padding around it stays in
      // the scroll area and the 4px focus ring of an edge field is not cut.
      // Content needs no scroller of its own.
      compact:
        "gap-3.5 overscroll-contain -my-1 mx-[calc(-1*var(--fdy-dialog-padding))] px-(--fdy-dialog-padding) py-1",
    },
  },
});

const footerVariants = cva("flex flex-wrap items-center justify-end gap-2", {
  variants: {
    layout: {
      sectioned: "flex-none px-6 pb-6 max-[700px]:px-4.5 max-[700px]:pb-4.5",
      compact: "",
    },
  },
});

/**
 * A modal with a title, a description, a close button and an optional
 * footer. Radix owns focus trapping and dismissal; `busy` blocks every way of
 * closing. Closing returns focus to `returnFocusTo`, or else to the element
 * focused as the dialog opened (dialogs here are opened by plain buttons or
 * menu items, never a Dialog.Trigger, so Radix knows no trigger).
 *
 * "sectioned" divides the header from a padded, scrolling body. "compact" is
 * one padded surface for pickers and confirmations, with actions in `footer`.
 * "wide" fits long text such as a SKILL.md; "large" a side-by-side diff;
 * "editor" keeps one settled height while a form inside changes, so the
 * window does not re-centre as fields come and go; "viewport" holds a wide
 * table near the full window size without becoming a second app shell;
 * "preview" holds long-form content at a comfortable reading width.
 */
export function Dialog({
  title,
  description,
  open = true,
  onClose,
  layout = "sectioned",
  side = "center",
  size = "default",
  busy,
  bodyClassName,
  contentId,
  initialFocus,
  returnFocusTo,
  footer,
  headerActions,
  children,
}: {
  title: string;
  /** The line under the title; a dialog whose title says it all omits it. */
  description?: string;
  /** Visibility, for a dialog that stays mounted while closed. */
  open?: boolean;
  /** Asked to close: Escape, outside click or the close button. */
  onClose: () => void;
  layout?: DialogLayout;
  /** Center modal or a full-height drawer anchored to one side. */
  side?: DialogSide;
  size?: DialogSize;
  busy?: boolean;
  /** Layout hook for a body that owns its own scroll region. */
  bodyClassName?: string;
  contentId?: string;
  /** Focused on open; a text input's value is also selected. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Where focus goes on close when the opener itself goes away (a menu item). */
  returnFocusTo?: HTMLElement | null;
  footer?: ReactNode;
  /** Extra controls beside the dialog's close button. */
  headerActions?: ReactNode;
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
        <div className="fdy-dialog-layer pointer-events-none fixed inset-0 z-100">
          <RadixDialog.Overlay
            className={overlayVariants({ layout })}
            data-layout={layout}
          />
          <RadixDialog.Content
            {...(description ? {} : { "aria-describedby": undefined })}
            className={cn(contentVariants({ layout, side, size }))}
            data-layout={layout}
            data-side={side}
            data-size={size}
            id={contentId}
            onOpenAutoFocus={(event) => {
              opener.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null;
              const target = initialFocus?.current;
              if (target) {
                event.preventDefault();
                target.focus();
                // A field opened with a value (a rename) starts selected,
                // so typing replaces it.
                if (target instanceof HTMLInputElement) target.select();
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
            <header className={headerVariants({ layout })}>
              <div>
                <RadixDialog.Title className={titleVariants({ layout })}>
                  {title}
                </RadixDialog.Title>
                {description ? (
                  <RadixDialog.Description
                    className={descriptionVariants({ layout })}
                  >
                    {description}
                  </RadixDialog.Description>
                ) : null}
              </div>
              <div className="flex flex-none items-center gap-1">
                {headerActions}
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
              </div>
            </header>
            {children != null ? (
              <div className={cn(bodyVariants({ layout }), bodyClassName)}>
                {children}
              </div>
            ) : null}
            {footer ? (
              <footer className={footerVariants({ layout })}>{footer}</footer>
            ) : null}
          </RadixDialog.Content>
        </div>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
