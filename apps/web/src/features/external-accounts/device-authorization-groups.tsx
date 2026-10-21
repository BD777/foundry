import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConnectorDescriptor,
  DeviceConnectorDevice,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import { checkDeviceConnector } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  DeviceSignInDialog,
  type DeviceSignInTarget,
} from "./device-sign-in-dialog";
import { errorText, relativeWhen } from "./account-format";

/** Each row is a credential group, not a business-specific UI implementation. */
export function DeviceAuthorizationGroups({
  connector,
  device,
  state,
  disabled,
  onState,
}: {
  connector: ConnectorDescriptor;
  device: DeviceConnectorDevice;
  state?: DeviceConnectorState;
  disabled?: boolean;
  onState: (state: DeviceConnectorState) => void;
}) {
  const { t, i18n } = useTranslation("externalAccounts");
  const [target, setTarget] = useState<DeviceSignInTarget>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!connector.authorizationGroups?.length) return null;
  const available = device.online && device.authorizationSupported;
  return (
    <>
      <p className="fdy-xacc-muted">{t("authorization.separate")}</p>
      {error ? <Alert title={error} tone="error" /> : null}
      <ul className="fdy-xacc-list">
        {connector.authorizationGroups.map((group) => {
          const auth = state?.authorizations?.find(
            (a) => a.id === group.id && a.revision === group.revision,
          );
          const label =
            group.labels?.[i18n.resolvedLanguage ?? i18n.language] ??
            group.label;
          const status = auth?.status ?? "unknown";
          const blocked = disabled || busy || !!target || !available;
          return (
            <li className="fdy-xacc-binding-row" key={group.id}>
              <span className="fdy-xacc-identity">
                <strong>{label}</strong>
                <small>
                  {!device.online
                    ? t("deviceHeld.offlineUnknown")
                    : !device.authorizationSupported
                      ? t("authorization.workerUpgrade")
                      : auth?.reason
                        ? t(`authorization.reason.${auth.reason}`)
                        : t("authorization.localOnly")}
                </small>
                {auth ? (
                  <small>
                    {t("authorization.checked", {
                      when: relativeWhen(auth.checkedAt),
                    })}
                  </small>
                ) : null}
              </span>
              <span className="fdy-xacc-row-buttons">
                <Badge tone={status === "ready" ? "online" : "warn"}>
                  {t(`authorization.status.${status}`)}
                </Badge>
                {status !== "ready" && status !== "unavailable" ? (
                  <Button
                    disabled={blocked}
                    size="sm"
                    variant="primary"
                    onClick={() =>
                      setTarget({
                        deviceId: device.deviceId,
                        deviceName: device.name,
                        kind: connector.kind,
                        label,
                        authorization: {
                          id: group.id,
                          revision: group.revision,
                        },
                      })
                    }
                  >
                    {auth?.reason === "bootstrap_available"
                      ? t("authorization.prepare")
                      : t("authorization.authorize")}
                  </Button>
                ) : null}
                <Button
                  disabled={disabled || busy || !!target || !device.online}
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    void checkDeviceConnector(device.deviceId, connector.kind)
                      .then(onState)
                      .catch((e) => setError(errorText(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  {t("deviceHeld.checkAgain")}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      <DeviceSignInDialog
        target={target}
        onClose={() => setTarget(undefined)}
        onSignedIn={(next) => {
          setTarget(undefined);
          if (next) onState(next);
        }}
      />
    </>
  );
}
