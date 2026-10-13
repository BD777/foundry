import { Check, Copy } from "lucide-react";
import { useCopied } from "../../lib/use-copied";
import { Button, type ButtonProps } from "./button";

export interface CopyButtonProps extends Omit<
  ButtonProps,
  "aria-label" | "children" | "onClick"
> {
  text: string;
  label: string;
  /** The accessible label while the copy reads as done. */
  copiedLabel: string;
  /** Show a check while copied; without it only `data-copied` changes. */
  showCheck?: boolean;
}

/** An icon button that copies `text`, reading as copied for 1.2 s. */
export function CopyButton({
  copiedLabel,
  label,
  showCheck = true,
  text,
  ...props
}: CopyButtonProps) {
  const { copied, copy } = useCopied(1200);
  const done = copied();
  return (
    <Button
      aria-label={done ? copiedLabel : label}
      data-copied={done ? "true" : "false"}
      onClick={() => void copy(text)}
      size="icon"
      variant="ghost"
      {...props}
    >
      {done && showCheck ? <Check size={14} /> : <Copy size={14} />}
    </Button>
  );
}
