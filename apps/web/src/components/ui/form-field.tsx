import type {
  ComponentPropsWithoutRef,
  HTMLAttributes,
  LabelHTMLAttributes,
} from "react";
import { cn } from "../../lib/cn";

const fieldClass =
  "grid min-w-0 gap-1.5 [&>label]:text-xs [&>label]:font-semibold [&>label]:text-ink-muted [&>small]:text-xs [&>small]:leading-normal [&>span]:text-xs [&>span]:font-semibold [&>span]:text-ink-muted";

/** A control under its caption (`<span>` or `<label>`) and optional `<small>` hint. */
export function FormField({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn(fieldClass, className)} {...props} />;
}

/** The same field where the control is not labelled by wrapping (a `<div>` group). */
export function FormFieldGroup({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(fieldClass, className)} {...props} />;
}

/** A caption for a control; a `<label>` unless it only names a group. */
export function FieldLabel({
  as: Component = "label",
  className,
  ...props
}: LabelHTMLAttributes<HTMLElement> & { as?: "label" | "span" }) {
  return (
    <Component
      className={cn("text-xs font-semibold text-ink", className)}
      {...props}
    />
  );
}

/** The parts of a form stacked with a steady gap. */
export function FormLayout({
  as: Component = "div",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: "div" | "form";
} & Pick<ComponentPropsWithoutRef<"form">, "onSubmit" | "noValidate">) {
  return (
    <Component className={cn("grid min-w-0 gap-3.5", className)} {...props} />
  );
}
