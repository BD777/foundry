import { CircleHelp } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import { Tooltip } from "./tooltip";

/**
 * A "?" beside a heading (it sits in the heading's line without making it
 * taller): its help opens on hover and keyboard focus, and on
 * click or tap where there is no hover.
 */
export function HelpHint({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      variant="hint"
      content={children}
      open={open}
      onOpenChange={setOpen}
    >
      <Button
        variant="icon"
        size="icon"
        className={cn(
          "fdy-help-hint -my-[3px] size-[22px] align-middle text-ink-muted hover:text-ink data-[state=delayed-open]:text-ink data-[state=instant-open]:text-ink",
          className,
        )}
        aria-label={label}
        onClick={() => setOpen(true)}
      >
        <CircleHelp size={15} aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}
