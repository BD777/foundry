import { cva } from "class-variance-authority";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Toaster, toast as sonner } from "sonner";
import { Button } from "./button";
import { useFoundryTheme } from "./theme-context";

export type ToastTone = "success" | "info" | "warning" | "error";
/**
 * Which edge of a wide window the stack keeps to: "bottom" (the default),
 * or "top", below the view's header, for a view whose primary controls sit
 * at the bottom (a conversation's composer). Narrow windows always use the
 * top: there the bottom is the composer or the page's next control.
 */
export type ToastPlacement = "top" | "bottom";
export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void | Promise<unknown>;
    disabled?: boolean;
  };
}
type ToastEntry = ToastOptions & { id: string };
type ToastApi = ((options: ToastOptions & { id?: string }) => string) & {
  dismiss: (id: string) => void;
  update: (id: string, patch: Partial<ToastOptions>) => void;
};

/*
 * Feedback toasts on shadcn/ui's Sonner: it stacks, times, pauses on hover and
 * swipes them away, and `ToastProvider` mounts its Toaster. The card is
 * Foundry's (the status tokens), handed to Sonner as a custom toast, so the
 * app API below does not change. The `fdy-toast*` classes are hooks for tests
 * and carry no style.
 */
const visibleToasts = 3;
let sequence = 0;
/** The toasts on screen, oldest first: the app's record of what is live. */
const live = new Map<string, ToastEntry>();

function defaultDuration(entry: ToastEntry) {
  return entry.action || entry.tone === "error" ? 10000 : 5000;
}

function present(entry: ToastEntry) {
  sonner.custom(() => <ToastCard entry={entry} />, {
    id: entry.id,
    duration: entry.duration ?? defaultDuration(entry),
    onAutoClose: () => {
      live.delete(entry.id);
    },
    onDismiss: () => {
      live.delete(entry.id);
    },
  });
}

/** Shared feedback API, also usable by event handlers outside React. */
export const toast: ToastApi = Object.assign(
  (options: ToastOptions & { id?: string }) => {
    const id = options.id ?? `toast-${++sequence}`;
    const entry = { ...options, id };
    live.delete(id);
    live.set(id, entry);
    present(entry);
    while (live.size > visibleToasts) {
      const oldest = live.keys().next().value!;
      live.delete(oldest);
      sonner.dismiss(oldest);
    }
    return id;
  },
  {
    dismiss: (id: string) => {
      if (live.delete(id)) sonner.dismiss(id);
    },
    update: (id: string, patch: Partial<ToastOptions>) => {
      const current = live.get(id);
      if (!current) return;
      const entry = { ...current, ...patch };
      live.set(id, entry);
      present(entry);
    },
  },
);
export function useToast() {
  return toast;
}

const narrowQuery = "(max-width: 860px)";
function subscribeNarrow(notify: () => void) {
  const query = window.matchMedia?.(narrowQuery);
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
}
const isNarrow = () => window.matchMedia?.(narrowQuery).matches ?? false;

const safeTop = "max(8px, env(safe-area-inset-top))";
const safeBottom = "max(16px, env(safe-area-inset-bottom))";
const safeSide = "max(16px, env(safe-area-inset-right))";

/** Sonner's documented hook for the stack's width; its default is 356px. */
const stackWidth = {
  "--width": "min(390px, calc(100vw - 32px))",
} as CSSProperties;

/** Mount once inside the shell so the viewport inherits its theme tokens. */
export function ToastProvider({
  children,
  placement = "bottom",
}: {
  children: ReactNode;
  placement?: ToastPlacement;
}) {
  const { t } = useTranslation("ui");
  const theme = useFoundryTheme();
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false);
  const top = narrow ? safeTop : placement === "top" ? 64 : undefined;
  return (
    <>
      {children}
      <Toaster
        className="fdy-toast-viewport"
        containerAriaLabel={t("toast.viewport")}
        customAriaLabel={t("toast.label")}
        expand
        gap={8}
        mobileOffset={{
          top: safeTop,
          left: 8,
          right: 8,
        }}
        offset={
          top === undefined
            ? { bottom: safeBottom, right: safeSide }
            : { top, right: safeSide }
        }
        position={top === undefined ? "bottom-right" : "top-right"}
        style={stackWidth}
        theme={theme}
        visibleToasts={visibleToasts}
      />
    </>
  );
}

const cardVariants = cva(
  "fdy-toast flex w-(--width) min-w-0 max-h-[30dvh] max-[600px]:w-full items-start gap-2.5 overflow-y-auto rounded-lg border p-3 text-sm leading-normal shadow-drop focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-info-text",
  {
    variants: {
      tone: {
        info: "border-info-border bg-info-surface text-info-text",
        success: "border-success-border bg-success-surface text-success-text",
        warning: "border-warning-border bg-warning-surface text-warning-text",
        error: "border-error-border bg-error-surface text-error-text",
      },
    },
    defaultVariants: { tone: "info" },
  },
);

function ToastCard({ entry }: { entry: ToastEntry }) {
  const { t } = useTranslation("ui");
  const [busy, setBusy] = useState(false);
  const tone = entry.tone ?? "info";
  const Icon =
    tone === "success" ? CircleCheck : tone === "info" ? Info : CircleAlert;
  return (
    <div
      className={cardVariants({ tone })}
      data-tone={tone}
      role={tone === "error" ? "alert" : undefined}
    >
      <Icon className="mt-px flex-none" size={18} aria-hidden="true" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <div className="font-semibold">{entry.title}</div>
        {entry.description ? (
          <div className="mt-[3px] whitespace-pre-wrap">
            {entry.description}
          </div>
        ) : null}
        {entry.action ? (
          <Button
            variant="link"
            size="sm"
            disabled={busy || entry.action.disabled}
            aria-busy={busy}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              Promise.resolve()
                .then(entry.action!.onClick)
                .then(() => toast.dismiss(entry.id))
                .catch(() => {})
                .finally(() => setBusy(false));
            }}
          >
            {entry.action.label}
          </Button>
        ) : null}
      </div>
      <Button
        className="fdy-toast-close -my-1 flex-none"
        variant="ghost"
        size="icon"
        aria-label={t("toast.close")}
        onClick={() => toast.dismiss(entry.id)}
      >
        <X size={16} />
      </Button>
    </div>
  );
}

/** Bridge existing action-result state into the shared floating viewport. */
export function ToastFeedback({
  title,
  children,
  tone = "info",
}: {
  title: string;
  children?: ReactNode;
  tone?: ToastTone;
}) {
  const id = useId();
  const latest = useRef(children);
  latest.current = children;
  const message = typeof children === "string" ? children : undefined;
  useEffect(() => {
    toast({ id, title, description: latest.current, tone });
    return () => {
      if (tone === "error") toast.dismiss(id);
    };
  }, [id, title, tone, message]);
  return null;
}
