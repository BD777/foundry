import * as ToastPrimitive from "@radix-ui/react-toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useId, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";

export type ToastTone = "success" | "info" | "warning" | "error";
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
let sequence = 0;
let entries: ToastEntry[] = [];
const listeners = new Set<(entries: ToastEntry[]) => void>();
function publish(next: ToastEntry[]) {
  entries = next;
  listeners.forEach((listener) => listener(next));
}
/** Shared feedback API, also usable by event handlers outside React. */
export const toast: ToastApi = Object.assign(
  (options: ToastOptions & { id?: string }) => {
    const id = options.id ?? `toast-${++sequence}`;
    publish(
      [...entries.filter((item) => item.id !== id), { ...options, id }].slice(
        -3,
      ),
    );
    return id;
  },
  {
    dismiss: (id: string) => publish(entries.filter((item) => item.id !== id)),
    update: (id: string, patch: Partial<ToastOptions>) =>
      publish(
        entries.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      ),
  },
);
export function useToast() {
  return toast;
}

/** Mount once inside the shell so the viewport inherits its theme tokens. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("ui");
  const [items, setItems] = useState(entries);
  useEffect(() => {
    listeners.add(setItems);
    setItems(entries);
    return () => {
      listeners.delete(setItems);
    };
  }, []);
  return (
    <ToastPrimitive.Provider label={t("toast.label")} swipeDirection="right">
      {children}
      {items.map((item) => (
        <ToastItem key={item.id} item={item} />
      ))}
      <ToastPrimitive.Viewport
        className="fdy-toast-viewport"
        label={t("toast.viewport")}
      />
    </ToastPrimitive.Provider>
  );
}
function ToastItem({ item }: { item: ToastEntry }) {
  const { t } = useTranslation("ui");
  const [busy, setBusy] = useState(false);
  const tone = item.tone ?? "info";
  const Icon =
    tone === "success" ? CircleCheck : tone === "info" ? Info : CircleAlert;
  return (
    <ToastPrimitive.Root
      className="fdy-toast"
      data-tone={tone}
      type={tone === "error" ? "foreground" : "background"}
      duration={
        item.duration ??
        (item.action ? Infinity : tone === "error" ? 10000 : 5000)
      }
      onOpenChange={(open) => {
        if (!open) toast.dismiss(item.id);
      }}
    >
      <Icon className="fdy-toast-icon" size={18} aria-hidden="true" />
      <div className="fdy-toast-copy">
        <ToastPrimitive.Title className="fdy-toast-title">
          {item.title}
        </ToastPrimitive.Title>
        {item.description ? (
          <ToastPrimitive.Description className="fdy-toast-description">
            {item.description}
          </ToastPrimitive.Description>
        ) : null}
        {item.action ? (
          <ToastPrimitive.Action asChild altText={item.action.label}>
            <Button
              variant="link"
              size="sm"
              disabled={busy || item.action.disabled}
              aria-busy={busy}
              onClick={(event) => {
                event.preventDefault();
                if (busy) return;
                setBusy(true);
                Promise.resolve()
                  .then(item.action!.onClick)
                  .then(() => toast.dismiss(item.id))
                  .catch(() => {})
                  .finally(() => setBusy(false));
              }}
            >
              {item.action.label}
            </Button>
          </ToastPrimitive.Action>
        ) : null}
      </div>
      <ToastPrimitive.Close asChild>
        <Button
          className="fdy-toast-close"
          variant="ghost"
          size="icon"
          aria-label={t("toast.close")}
        >
          <X size={16} />
        </Button>
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
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
