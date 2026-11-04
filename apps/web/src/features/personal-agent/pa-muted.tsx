import { cn } from "../../lib/cn";
import { MutedText, type MutedTextProps } from "../../components/ui/text";

/** The assistant pages' secondary copy: muted, with a slightly tighter line. */
export function PaMuted({ className, ...props }: MutedTextProps) {
  return <MutedText className={cn("leading-[1.55]", className)} {...props} />;
}
