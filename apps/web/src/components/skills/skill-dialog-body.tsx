import type { FormHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * The body of a skills dialog: a column of blocks that scrolls on its own
 * and wraps long names and paths. Pass `as="form"` for a dialog whose footer
 * submits it.
 */
export function SkillDialogBody({
  as: Component = "div",
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> &
  FormHTMLAttributes<HTMLFormElement> & { as?: "div" | "form" }) {
  return (
    <Component
      className={cn(
        "grid min-h-0 min-w-0 content-start gap-3 overflow-y-auto text-sm [overflow-wrap:anywhere]",
        className,
      )}
      {...(props as HTMLAttributes<HTMLDivElement> &
        FormHTMLAttributes<HTMLFormElement>)}
    />
  );
}
