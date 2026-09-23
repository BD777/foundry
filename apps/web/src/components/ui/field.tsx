import { cva, type VariantProps } from "class-variance-authority";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import { cn } from "../../lib/cn";

export const fieldVariants = cva("fdy-field", {
  variants: {
    fieldSize: {
      chat: "fdy-field-chat",
      composer: "fdy-field-composer",
    },
    resize: {
      none: "fdy-field-resize-none",
      vertical: "fdy-field-resize-vertical",
    },
    tone: {
      /** Visible input affordance for forms: border, padding, focus ring. */
      boxed: "fdy-field-boxed",
      plain: "fdy-field-plain",
    },
  },
  defaultVariants: {
    fieldSize: "chat",
    resize: "none",
    tone: "plain",
  },
});

export interface TextInputProps
  extends
    ComponentPropsWithoutRef<"input">,
    VariantProps<typeof fieldVariants> {}

export const TextInput = forwardRef<ElementRef<"input">, TextInputProps>(
  ({ className, fieldSize, resize, tone, ...props }, ref) => (
    <input
      className={cn(fieldVariants({ fieldSize, resize, tone }), className)}
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
      className={cn(fieldVariants({ fieldSize, resize, tone }), className)}
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
      className={cn("fdy-checkbox", className)}
      ref={ref}
      type={type}
      {...props}
    />
  ),
);

Checkbox.displayName = "Checkbox";
