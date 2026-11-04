import { useTranslation } from "react-i18next";
import {
  beginNativeSignIn,
  dismissNativeSignIn,
  pollNativeSignIn,
  submitNativeSignInCode,
} from "../../api";
import { Dialog } from "../../components/ui/dialog";
import {
  DeviceSignInFlow,
  type DeviceSignInTransport,
} from "../../components/device-sign-in/device-sign-in-flow";
import { subscriptionName } from "./subscription-text";
import type { NativeRuntime } from "./device-accounts";

export interface NativeSignInTarget {
  deviceId: string;
  deviceName: string;
  runtime: NativeRuntime;
}

/**
 * Signs a device's Claude Code or Codex in to its subscription: the CLI on
 * the device starts its own sign-in and finishes it, so the login and its
 * requests stay on that device; the page only relays the link and the code.
 */
export function NativeSignInDialog({
  target,
  onClose,
  onSignedIn,
}: {
  target?: NativeSignInTarget;
  onClose: () => void;
  onSignedIn: () => void;
}) {
  const { t } = useTranslation("profiles");
  const name = target ? subscriptionName(t, target.runtime) : "";
  return (
    <Dialog
      description={
        target
          ? t("subscriptions.signInDescription", {
              name,
              device: target.deviceName,
            })
          : ""
      }
      layout="compact"
      onClose={onClose}
      open={Boolean(target)}
      title={target ? t("subscriptions.signInTitle", { name }) : ""}
    >
      {target ? (
        <DeviceSignInFlow
          key={`${target.deviceId}:${target.runtime}`}
          deviceName={target.deviceName}
          label={name}
          onSignedIn={onSignedIn}
          transport={nativeTransport(target)}
        />
      ) : null}
    </Dialog>
  );
}

function nativeTransport({
  deviceId,
  runtime,
}: NativeSignInTarget): DeviceSignInTransport {
  return {
    begin: (requestId) => beginNativeSignIn(deviceId, runtime, requestId),
    poll: (operationId) => pollNativeSignIn(deviceId, runtime, operationId),
    dismiss: (operationId) =>
      dismissNativeSignIn(deviceId, runtime, operationId),
    submitCode: (operationId, code) =>
      submitNativeSignInCode(deviceId, runtime, operationId, code),
    // The CLI said it finished; the device's next report shows the account.
    confirmed: (step) => step.status === "complete",
  };
}
