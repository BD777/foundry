import type {
  ConnectorDescriptor,
  ConnectorField,
  ConnectorSignInMethod,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import { useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { checkDeviceConnector } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { CopyButton } from "../../components/ui/copy-button";
import { FieldHint, Radio, TextInput } from "../../components/ui/field";
import { Spinner } from "../../components/ui/loading";
import { SelectMenu } from "../../components/ui/select-menu";
import { TerminalBlock } from "../../components/ui/terminal-block";
import { errorText } from "./account-format";
import { localized, signInMethods } from "./connector-text";

/**
 * The first step of signing a device's tool in: which way (when there is
 * more than one) and what that way asks for, all as the connector's
 * descriptor declares it (docs/connectors.md, "登录方式"). A guided way
 * starts the tool's sign-in on the device with the values; a terminal way
 * shows what to run there and checks the result.
 */
export function SignInChooser({
  connector,
  deviceId,
  deviceName,
  online,
  initialMethod,
  initialValues,
  onStart,
  onSignedIn,
}: {
  connector: ConnectorDescriptor;
  deviceId: string;
  deviceName: string;
  online: boolean;
  initialMethod?: string;
  initialValues?: Record<string, string>;
  onStart: (options: Record<string, string>) => void;
  onSignedIn: (state: DeviceConnectorState) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const groupId = useId();
  const methods = signInMethods(connector);
  const [methodId, setMethodId] = useState(
    methods.find((method) => method.id === initialMethod)?.id ??
      methods[0]?.id ??
      "",
  );
  const method = methods.find((entry) => entry.id === methodId) ?? methods[0];
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...defaults(methods),
    ...stripSecrets(methods, initialValues),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!method) return null;
  const fields = (method.fields ?? []).filter((field) => shown(field, values));

  function start(event: FormEvent) {
    event.preventDefault();
    const problems: Record<string, string> = {};
    for (const field of fields) {
      const value = (values[field.id] ?? "").trim();
      if (!value) {
        if (field.required)
          problems[field.id] = t("signInChooser.required", {
            field: localized(field.label, field.labels),
          });
        continue;
      }
      if (field.pattern && !matches(field.pattern, value))
        problems[field.id] = t("signInChooser.invalid", {
          field: localized(field.label, field.labels),
        });
      if (field.type === "url" && !/^https:\/\/\S+$/.test(value))
        problems[field.id] = t("signInChooser.https", {
          field: localized(field.label, field.labels),
        });
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    const options: Record<string, string> = { method: method!.id };
    for (const field of fields) {
      const value = (values[field.id] ?? "").trim();
      if (value) options[field.id] = value;
    }
    onStart(options);
  }

  return (
    <form className="fdy-xacc-sign-in-chooser" onSubmit={start}>
      {methods.length > 1 ? (
        <fieldset className="fdy-xacc-methods">
          <legend>{t("signInChooser.how")}</legend>
          {methods.map((entry) => (
            <label
              className="fdy-xacc-method"
              data-selected={entry.id === method.id || undefined}
              key={entry.id}
            >
              <Radio
                checked={entry.id === method.id}
                name={groupId}
                onChange={() => {
                  setMethodId(entry.id);
                  setErrors({});
                }}
                value={entry.id}
              />
              <span>
                <strong>{localized(entry.label, entry.labels)}</strong>
                {entry.description ? (
                  <small>
                    {localized(entry.description, entry.descriptions)}
                  </small>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : method.description ? (
        <p>{localized(method.description, method.descriptions)}</p>
      ) : null}
      {method.kind === "terminal" ? (
        <TerminalSignIn
          deviceId={deviceId}
          deviceName={deviceName}
          kind={connector.kind}
          method={method}
          online={online}
          onSignedIn={onSignedIn}
        />
      ) : (
        <>
          {fields.length > 0 ? (
            <div className="fdy-xacc-sign-in-fields">
              {fields.map((field) => (
                <SignInField
                  error={errors[field.id]}
                  field={field}
                  key={field.id}
                  onChange={(value) =>
                    setValues((current) => ({ ...current, [field.id]: value }))
                  }
                  value={values[field.id] ?? ""}
                />
              ))}
            </div>
          ) : null}
          {online ? null : (
            <FieldHint tone="warning">
              {t("signInChooser.offline", { device: deviceName })}
            </FieldHint>
          )}
          <span className="fdy-xacc-form-actions">
            <Button
              disabled={!online}
              size="sm"
              type="submit"
              variant="primary"
            >
              {t("signInChooser.start")}
            </Button>
          </span>
        </>
      )}
    </form>
  );
}

function SignInField({
  field,
  value,
  error,
  onChange,
}: {
  field: ConnectorField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const id = useId();
  const hintId = `${id}-hint`;
  const label = localized(field.label, field.labels);
  const help = field.help ? localized(field.help, field.helps) : undefined;
  const described = [help ? hintId : "", error ? `${id}-error` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="fdy-xacc-field">
      <label htmlFor={id}>
        {label}
        {field.required ? null : (
          <small className="fdy-xacc-optional">
            {" · "}
            {t("signInChooser.optional")}
          </small>
        )}
      </label>
      {field.type === "select" ? (
        <SelectMenu
          ariaLabel={label}
          insideDialog
          onChange={onChange}
          options={(field.options ?? []).map((option) => ({
            value: option.value,
            label: localized(option.label, option.labels),
          }))}
          value={value}
        />
      ) : (
        <TextInput
          aria-describedby={described || undefined}
          aria-invalid={error ? true : undefined}
          autoComplete={field.type === "secret" ? "off" : undefined}
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          spellCheck={false}
          tone="boxed"
          type={
            field.type === "secret"
              ? "password"
              : field.type === "url"
                ? "url"
                : "text"
          }
          value={value}
        />
      )}
      {help ? (
        <FieldHint as="small" id={hintId}>
          {help}
        </FieldHint>
      ) : null}
      {error ? (
        <FieldHint as="small" id={`${id}-error`} tone="error">
          {error}
        </FieldHint>
      ) : null}
    </div>
  );
}

/**
 * A terminal way: the commands to run on the device, each with a copy
 * button, and a check that reads the device again.
 */
function TerminalSignIn({
  deviceId,
  deviceName,
  kind,
  method,
  online,
  onSignedIn,
}: {
  deviceId: string;
  deviceName: string;
  kind: string;
  method: ConnectorSignInMethod;
  online: boolean;
  onSignedIn: (state: DeviceConnectorState) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState("");
  async function check() {
    setChecking(true);
    setResult("");
    try {
      const state = await checkDeviceConnector(deviceId, kind);
      if (state.signedIn) onSignedIn(state);
      else setResult(t("signInChooser.notYet", { device: deviceName }));
    } catch (cause) {
      setResult(errorText(cause));
    } finally {
      setChecking(false);
    }
  }
  return (
    <div className="fdy-xacc-terminal-sign-in">
      <p>{t("signInChooser.terminalIntro", { device: deviceName })}</p>
      {(method.commands ?? []).map((command, index) => (
        <span className="fdy-xacc-command" key={command}>
          <TerminalBlock
            lines={[{ id: `c${index}`, prompt: "$", value: command }]}
          />
          <CopyButton
            copiedLabel={t("setupSteps.signIn.copied")}
            label={t("setupSteps.signIn.copy", { command })}
            text={command}
          />
        </span>
      ))}
      {result ? <Alert title={result} tone="info" /> : null}
      <span className="fdy-xacc-form-actions">
        <Button
          aria-busy={checking}
          disabled={!online || checking}
          onClick={() => void check()}
          size="sm"
          variant="primary"
        >
          {checking ? <Spinner /> : null}
          {t("signInChooser.checkAgain")}
        </Button>
      </span>
    </div>
  );
}

function defaults(methods: ConnectorSignInMethod[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const method of methods)
    for (const field of method.fields ?? [])
      if (field.default !== undefined && values[field.id] === undefined)
        values[field.id] = field.default;
  return values;
}

/** Values to start again with: never a secret the person typed before. */
function stripSecrets(
  methods: ConnectorSignInMethod[],
  values: Record<string, string> | undefined,
): Record<string, string> {
  if (!values) return {};
  const secret = new Set(
    methods.flatMap((method) =>
      (method.fields ?? []).filter((f) => f.type === "secret").map((f) => f.id),
    ),
  );
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key]) => key !== "method" && !secret.has(key),
    ),
  );
}

function shown(field: ConnectorField, values: Record<string, string>): boolean {
  return (
    !field.showWhen ||
    field.showWhen.equals.includes(values[field.showWhen.field] ?? "")
  );
}

function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // A pattern this browser cannot read is the device's to check.
    return true;
  }
}
