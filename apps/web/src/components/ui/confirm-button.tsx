import { useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "./button";

export interface ConfirmButtonProps extends Omit<ButtonProps, "onClick"> {
  /** Label shown once the action is armed, e.g. "Delete for good?". */
  confirmLabel: string;
  onConfirm: () => void;
  /** Milliseconds before an armed button forgets it was clicked. */
  resetAfterMs?: number;
}

/**
 * A destructive action that takes two clicks. Irreversible work — clearing a
 * sealed credential, deleting a profile — must never happen on a single
 * mis-click, and an inline second click keeps the decision where the action is
 * instead of throwing a browser dialog over the form.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  resetAfterMs = 4000,
  ...props
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!armed) return;
    timer.current = window.setTimeout(() => setArmed(false), resetAfterMs);
    return () => window.clearTimeout(timer.current);
  }, [armed, resetAfterMs]);

  return (
    <Button
      {...props}
      data-armed={armed || undefined}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}
