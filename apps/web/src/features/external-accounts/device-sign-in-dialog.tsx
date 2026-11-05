import { AuthorizationScopePicker } from "./authorization-scope-picker";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectorDescriptor,
  ConnectorAuthorizationGroup,
  ConnectorScopeChange,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import {
  beginDeviceConnectorSignIn,
  pollDeviceConnectorSignIn,
  dismissDeviceConnectorSignIn,
  submitDeviceConnectorSignInCode,
} from "../../api";
import { localized, signInMethods } from "./connector-text";
import { SignInChooser } from "./sign-in-chooser";
import {
  DeviceSignInFlow,
  type DeviceSignInTransport,
} from "../../components/device-sign-in/device-sign-in-flow";
import { Dialog } from "../../components/ui/dialog";

export interface DeviceSignInTarget {
  deviceId: string;
  deviceName: string;
  kind: string;
  label: string;
  /** Its descriptor: the ways to sign in and what each asks for. */
  connector?: ConnectorDescriptor;
  /** False while the device is offline: the dialog says so and waits. */
  online?: boolean;
  authorization?: { id: string; revision: number };
  group?: ConnectorAuthorizationGroup;
  grantedScopes?: string[];
  lastChange?: ConnectorScopeChange;
  /** Scopes a link asked to add, preselected in the picker. */
  preselect?: string[];
}

/**
 * Signs a device's tool in through Foundry: the device starts the tool's
 * own sign-in, the person approves on the page it names (here, or on their
 * phone through the QR code), and the dialog asks the device every few
 * seconds until the tool says it is done. The login stays on the device.
 */
export function DeviceSignInDialog({
  target,
  onClose,
  onSignedIn,
}: {
  target?: DeviceSignInTarget;
  onClose: () => void;
  onSignedIn: (state: DeviceConnectorState | undefined) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  return (
    <Dialog
      description={
        target
          ? t(
              target.authorization
                ? "authorization.dialogDescription"
                : "deviceSignIn.description",
              {
                name: target.label,
                device: target.deviceName,
              },
            )
          : ""
      }
      layout="compact"
      onClose={onClose}
      open={Boolean(target)}
      title={
        target
          ? t(
              target.authorization
                ? "authorization.dialogTitle"
                : "deviceSignIn.title",
              { name: target.label },
            )
          : ""
      }
    >
      {target ? (
        <SignInFlow
          key={`${target.deviceId}:${target.kind}:${target.authorization?.id ?? ""}:${target.authorization?.revision ?? 0}`}
          onSignedIn={onSignedIn}
          target={target}
        />
      ) : null}
    </Dialog>
  );
}

/**
 * The base sign-in first asks how (the connector's methods and their
 * fields), then runs it; an additional authorization, or a connector that
 * declares no methods, starts at once.
 */
function SignInFlow({
  target,
  onSignedIn,
}: {
  target: DeviceSignInTarget;
  onSignedIn: (state: DeviceConnectorState | undefined) => void;
}) {
  const { t } = useTranslation("externalAccounts");
  const methods = signInMethods(target.connector);
  // One way that asks nothing starts at once; the others stay a click away.
  const guided = methods.filter((method) => method.kind === "guided");
  const [started, setStarted] = useState<Record<string, string> | undefined>(
    () =>
      guided.length === 1 && !guided[0]!.fields?.length
        ? { method: guided[0]!.id }
        : undefined,
  );
  const [last, setLast] = useState<Record<string, string>>();
  if (target.group?.scopes?.length) {
    if (!started)
      return (
        <AuthorizationScopePicker
          group={target.group}
          granted={target.grantedScopes}
          lastChange={target.lastChange}
          preselect={target.preselect}
          onStart={setStarted}
        />
      );
    return (
      <DeviceSignIn
        onSignedIn={onSignedIn}
        target={target}
        options={started}
        onBack={() => setStarted(undefined)}
      />
    );
  }
  if (target.authorization || methods.length === 0)
    return <DeviceSignIn onSignedIn={onSignedIn} target={target} />;
  if (!started)
    return (
      <SignInChooser
        connector={target.connector!}
        deviceId={target.deviceId}
        deviceName={target.deviceName}
        initialMethod={last?.method}
        initialValues={last}
        onSignedIn={onSignedIn}
        onStart={(options) => {
          setLast(options);
          setStarted(options);
        }}
        online={target.online !== false}
      />
    );
  const method = methods.find((entry) => entry.id === started.method);
  // A sign-in that lets the person choose scopes (GitHub's) asks before it starts.
  const scopesGroup = target.connector?.authorizationGroups?.find(
    (group) => group.id === method?.scopesGroup && group.scopes?.length,
  );
  if (scopesGroup && started.scopes === undefined)
    return (
      <AuthorizationScopePicker
        group={scopesGroup}
        preselect={target.preselect}
        submitLabel={t("deviceSignIn.signInWithPermissions")}
        onStart={(options) => setStarted({ ...started, ...options })}
      />
    );
  return (
    <DeviceSignIn
      methodLabel={
        method && methods.length > 1
          ? localized(method.label, method.labels)
          : undefined
      }
      onBack={methods.length > 1 ? () => setStarted(undefined) : undefined}
      onSignedIn={onSignedIn}
      options={started}
      target={target}
    />
  );
}

function DeviceSignIn({
  target,
  options,
  methodLabel,
  onBack,
  onSignedIn,
}: {
  target: DeviceSignInTarget;
  /** What the person chose and entered (signInOptions). */
  options?: Record<string, string>;
  methodLabel?: string;
  /** Back to choosing how to sign in. */
  onBack?: () => void;
  onSignedIn: (state: DeviceConnectorState | undefined) => void;
}) {
  const { deviceId, kind, authorization } = target;
  const transport: DeviceSignInTransport = {
    begin: (requestId) =>
      beginDeviceConnectorSignIn(
        deviceId,
        kind,
        requestId,
        authorization,
        options,
      ),
    poll: (operationId) =>
      pollDeviceConnectorSignIn(deviceId, kind, operationId, authorization),
    dismiss: (operationId) =>
      dismissDeviceConnectorSignIn(deviceId, kind, operationId, authorization),
    submitCode: (operationId, code) =>
      submitDeviceConnectorSignInCode(deviceId, kind, operationId, code),
    confirmed: (step) =>
      Boolean(
        (authorization
          ? step.state?.authorizations?.some(
              (a) =>
                a.id === authorization.id &&
                a.revision === authorization.revision &&
                a.status === "ready",
            )
          : step.state?.signedIn) &&
        step.state?.deviceId === deviceId &&
        step.state.kind === kind,
      ),
  };
  return (
    <DeviceSignInFlow
      deviceName={target.deviceName}
      label={target.label}
      methodLabel={methodLabel}
      onBack={onBack}
      onSignedIn={(step) => onSignedIn(step.state)}
      transport={transport}
    />
  );
}
