import { cva, type VariantProps } from "class-variance-authority";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type HTMLAttributes,
} from "react";
import { cn } from "../../lib/cn";

/*
 * Text fields after shadcn/ui's Input and Textarea, with Beautiful UI's
 * tokens. A field is borderless by default (chat and composer inputs sit on
 * their own surface); `boxed` gives form inputs an edge: the hairline ring
 * every surface uses, stronger on hover and accented on focus.
 */
const fieldStyles = cva(
  "fdy-field block w-full min-w-0 border-0 bg-transparent font-normal text-ink caret-brand outline-0 placeholder:text-ink-faint read-only:cursor-default focus-visible:outline-none disabled:cursor-default disabled:text-ink-faint disabled:opacity-[0.66] aria-disabled:cursor-default aria-disabled:text-ink-faint aria-disabled:opacity-[0.66]",
  {
    variants: {
      fieldSize: {
        chat: "fdy-field-chat px-0.5 pt-1 pb-2.5 text-md leading-normal",
        composer:
          "fdy-field-composer h-11 min-h-11 flex-1 pt-0.5 pb-1.5 text-md leading-normal",
        /** The text box inside a chip input, after its chips. */
        token: "min-w-24 flex-1 px-1 py-0.5 text-xs leading-normal",
      },
      resize: {
        none: "fdy-field-resize-none resize-none",
        vertical: "fdy-field-resize-vertical resize-y",
      },
      tone: {
        /** Visible input affordance for forms: border, padding, focus ring. */
        boxed:
          "fdy-field-boxed rounded-md bg-control px-[11px] py-[7px] text-xs leading-normal shadow-field transition-shadow duration-150 ease-out-strong hover:not-disabled:not-read-only:not-focus:shadow-field-hover focus:shadow-field-focus",
        plain: "fdy-field-plain",
      },
    },
    defaultVariants: {
      fieldSize: "chat",
      resize: "none",
      tone: "plain",
    },
  },
);

/** The field classes, for the few inputs other components render themselves. */
export function fieldVariants(
  options: VariantProps<typeof fieldStyles> & { className?: string } = {},
): string {
  const { className, ...variants } = options;
  return cn(fieldStyles(variants), className);
}

export interface TextInputProps
  extends
    ComponentPropsWithoutRef<"input">,
    VariantProps<typeof fieldVariants> {}

export const TextInput = forwardRef<ElementRef<"input">, TextInputProps>(
  ({ className, fieldSize, resize, tone, ...props }, ref) => (
    <input
      className={fieldVariants({ className, fieldSize, resize, tone })}
      ref={ref}
      {...props}
    />
  ),
);

TextInput.displayName = "TextInput";

export interface FileInputProps extends ComponentPropsWithoutRef<"input"> {}

export const FileInput = forwardRef<ElementRef<"input">, FileInputProps>(
  ({ className, type = "file", ...props }, ref) => (
    <input
      className={cn("fdy-file-input", className)}
      ref={ref}
      type={type}
      {...props}
    />
  ),
);

FileInput.displayName = "FileInput";

export interface TextareaProps
  extends
    ComponentPropsWithoutRef<"textarea">,
    VariantProps<typeof fieldVariants> {}

export const Textarea = forwardRef<ElementRef<"textarea">, TextareaProps>(
  ({ className, fieldSize, resize, tone, ...props }, ref) => (
    <textarea
      className={fieldVariants({ className, fieldSize, resize, tone })}
      ref={ref}
      {...props}
    />
  ),
);

Textarea.displayName = "Textarea";

export interface CheckboxProps extends ComponentPropsWithoutRef<"input"> {}

export const Checkbox = forwardRef<ElementRef<"input">, CheckboxProps>(
  ({ className, type = "checkbox", ...props }, ref) => (
    <input
      className={cn(
        "fdy-checkbox m-0 size-3.5 cursor-pointer accent-brand",
        className,
      )}
      ref={ref}
      type={type}
      {...props}
    />
  ),
);

Checkbox.displayName = "Checkbox";

export interface RadioProps extends ComponentPropsWithoutRef<"input"> {}

/** A native radio: arrow keys move within its `name` group. */
export const Radio = forwardRef<ElementRef<"input">, RadioProps>(
  ({ className, type = "radio", ...props }, ref) => (
    <input
      className={cn(
        "fdy-radio m-0 size-3.5 cursor-pointer accent-brand",
        className,
      )}
      ref={ref}
      type={type}
      {...props}
    />
  ),
);

Radio.displayName = "Radio";

const hintTone = {
  muted: "text-ink-muted",
  info: "text-info-text",
  warning: "text-warning-text",
  error: "text-error-text",
} as const;

/** Shared help/validation text. Link it to a control with id + aria-describedby. */
export function FieldHint({
  as: Component = "p",
  tone = "muted",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: "p" | "span" | "small" | "div";
  tone?: keyof typeof hintTone;
}) {
  return (
    <Component
      className={cn(
        "fdy-field-hint mt-1.5 block min-w-0 text-xs leading-[1.55] font-normal [overflow-wrap:anywhere]",
        hintTone[tone],
        className,
      )}
      data-tone={tone}
      {...props}
    />
  );
}
