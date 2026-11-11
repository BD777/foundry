import type { DeviceConnectorState } from "@bd777/foundry-protocol";
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { updateDeviceConnectorConfiguration } from "../../api";
import { Button } from "../../components/ui/button";
import { ButtonRow } from "../../components/ui/button-row";
import { FieldHint, TextInput } from "../../components/ui/field";
import { FormFieldGroup } from "../../components/ui/form-field";
import { errorText } from "./account-format";

const regionPattern = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** AWS profile defaults are shown here, after sign-in, not asked during it. */
export function DeviceConnectorConfiguration({
  deviceId,
  kind,
  state,
  disabled,
  onState,
  onSaved,
}: {
  deviceId: string;
  kind: string;
  state: DeviceConnectorState;
  disabled?: boolean;
  onState: (state: DeviceConnectorState) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const id = useId();
  const current = state.configuration?.region ?? "us-east-1";
  const [editing, setEditing] = useState(false);
  const [region, setRegion] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function edit() {
    setRegion(current);
    setError("");
    setEditing(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const value = region.trim();
    if (!regionPattern.test(value)) {
      setError(t("deviceHeld.configuration.regionInvalid"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      onState(
        await updateDeviceConnectorConfiguration(deviceId, kind, {
          region: value,
        }),
      );
      setEditing(false);
      onSaved();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!editing)
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-ink-muted">
        <span>{t("deviceHeld.configuration.region", { region: current })}</span>
        <span aria-hidden="true">·</span>
        <Button disabled={disabled} onClick={edit} size="sm" variant="ghost">
          {t("deviceHeld.configuration.change")}
        </Button>
      </div>
    );

  return (
    <form
      className="grid min-w-0 gap-2 rounded-md border border-line bg-panel-soft p-3"
      onSubmit={(event) => void save(event)}
    >
      <FormFieldGroup className="fdy-xacc-field">
        <label htmlFor={id}>{t("deviceHeld.configuration.regionLabel")}</label>
        <TextInput
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          aria-invalid={error ? true : undefined}
          id={id}
          onChange={(event) => setRegion(event.target.value)}
          placeholder={t("deviceHeld.configuration.regionPlaceholder")}
          spellCheck={false}
          tone="boxed"
          value={region}
        />
        <FieldHint as="small" id={`${id}-hint`}>
          {t("deviceHeld.configuration.regionHint")}
        </FieldHint>
        {error ? (
          <FieldHint as="small" id={`${id}-error`} tone="error">
            {error}
          </FieldHint>
        ) : null}
      </FormFieldGroup>
      <ButtonRow>
        <Button busy={busy} disabled={disabled} size="sm" type="submit">
          {t("deviceHeld.configuration.save")}
        </Button>
        <Button
          disabled={busy}
          onClick={() => setEditing(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("deviceHeld.configuration.cancel")}
        </Button>
      </ButtonRow>
    </form>
  );
}
