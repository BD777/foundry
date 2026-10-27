import type { ReactNode } from "react";
import type { PersonalAgentSettings } from "@bd777/foundry-protocol";
import { FieldHint, Checkbox } from "../../components/ui/field";

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
    <div className="fdy-pa-field">
      {htmlFor ? (
        <label className="fdy-pa-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="fdy-pa-field-label">{label}</span>
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
    <label className="fdy-pa-check">
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
    <div className="fdy-pa-group">
      {title ? <h3 className="fdy-pa-group-title">{title}</h3> : null}
      {children}
    </div>
  );
}
