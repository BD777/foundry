import type { ReactNode } from "react";
import type { PersonalAgentSettings } from "@bd777/foundry-protocol";
import { FieldHint, Checkbox } from "../../components/ui/field";
import { FieldLabel } from "../../components/ui/form-field";
import { Subheading } from "../../components/ui/subheading";

/** Applies part of a change to the settings draft. */
export type ChangeSettings = (patch: Partial<PersonalAgentSettings>) => void;

/** A labelled control with an optional hint under it. */
export function SettingsField({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** The control's id when it is a native field; else the label names a group. */
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 justify-items-start gap-1.5">
      {htmlFor ? (
        <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      ) : (
        <FieldLabel as="span">{label}</FieldLabel>
      )}
      {children}
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </div>
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
      {title ? <Subheading size="group">{title}</Subheading> : null}
      {children}
    </div>
  );
}
