import type { ReactNode } from "react";
import type { PersonalAgentSettings } from "@bd777/foundry-protocol";
import { FieldHint, Checkbox } from "../../components/ui/field";
import {
  FieldLabel,
  FormField,
  FormFieldGroup,
} from "../../components/ui/form-field";
import { SectionHeader } from "../../components/ui/page-header";
import { cn } from "../../lib/cn";

/** Applies part of a change to the settings draft. */
export type ChangeSettings = (patch: Partial<PersonalAgentSettings>) => void;

/** A labelled control with an optional hint under it. */
export function SettingsField({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** The control's id when it is a native field; else the label names a group. */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const Component = htmlFor ? FormField : FormFieldGroup;
  return (
    <Component className={cn("w-full max-w-sm", className)}>
      <FieldLabel as="span">{label}</FieldLabel>
      {children}
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </Component>
  );
}

/** A checkbox and the sentence it turns on or off. */
export function SettingsCheck({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm leading-[1.45] text-ink">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** A titled group of fields inside a section. */
export function SettingsGroup({
  title,
  children,
}: {
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3.5 border-t border-line pt-4 first:border-t-0 first:pt-0">
      {title ? <SectionHeader level={3} title={title} /> : null}
      {children}
    </div>
  );
}
