import type {
  FormHTMLAttributes,
  HTMLAttributes,
  LabelHTMLAttributes,
} from "react";
import { cn } from "../../lib/cn";

/** The form of a workspace dialog: one column of blocks. */
export function WorkspaceForm({
  className,
  ...props
}: FormHTMLAttributes<HTMLFormElement>) {
  return (
    <form className={cn("grid min-w-0 gap-3 text-sm", className)} {...props} />
  );
}

/** A labelled control of a workspace dialog's form. */
export function WorkspaceField({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn("grid min-w-0 gap-3 text-sm", className)} {...props} />
  );
}

/** The dialog's actions, at the end of its form. */
export function WorkspaceFormActions({
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <footer
      className={cn(
        "mt-3 flex flex-wrap items-center justify-end gap-2",
        className,
      )}
      {...props}
    />
  );
}

/** A line of explanation under a workspace dialog's title or field. */
export function LocationDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "mt-1.5 mb-0 text-xs leading-[1.65] text-ink-muted",
        className,
      )}
      {...props}
    />
  );
}
