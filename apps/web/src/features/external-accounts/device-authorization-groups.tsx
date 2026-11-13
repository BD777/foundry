import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { connectorName, localized } from "./connector-text";
import { takeConnectorGrant } from "../../lib/in-app-navigation";
import type {
  ConnectorDescriptor,
  DeviceConnectorDevice,
  DeviceConnectorState,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  DeviceSignInDialog,
  type DeviceSignInTarget,
} from "./device-sign-in-dialog";
import { relativeWhen } from "./account-format";
import { ButtonRow } from "../../components/ui/button-row";
import { DividedList } from "../../components/ui/divided-list";
import { Identity } from "../../components/ui/identity";
import { MutedText } from "../../components/ui/text";
import { ScopeChangeNote } from "./authorization-scope-picker";

/**
 * Each row is a credential group, not a business-specific UI implementation.
 * Checking them again is the device row's Check again, which reads them all.
 */
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
  // A link that asked to grant scopes here (a Pending item, DEV-136) opens
  // the group listing them with those scopes preselected; once, on mount.
  useEffect(() => {
    if (!device.online) return;
    const scopes = takeConnectorGrant(device.deviceId);
    const group = connector.authorizationGroups?.find((g) =>
      scopes?.every((id) => g.scopes?.some((scope) => scope.id === id)),
    );
    if (!scopes || !group) return;
    const auth = state?.authorizations?.find(
      (a) => a.id === group.id && a.revision === group.revision,
    );
    setTarget({
      deviceId: device.deviceId,
      deviceName: device.name,
      kind: connector.kind,
      label: localized(group.label, group.labels),
      group,
      grantedScopes: auth?.grantedScopes,
      lastChange: auth?.lastChange,
      preselect: scopes,
      authorization: { id: group.id, revision: group.revision },
    });
  }, [device.online]);
  if (!connector.authorizationGroups?.length) return null;
  const available = device.online;
  return (
    <>
      <MutedText>
        {t("authorization.separate", { name: connectorName(connector) })}
      </MutedText>
      <DividedList>
        {connector.authorizationGroups.map((group) => {
          const auth = state?.authorizations?.find(
            (a) => a.id === group.id && a.revision === group.revision,
          );
          const label =
            group.labels?.[i18n.resolvedLanguage ?? i18n.language] ??
            group.label;
          const status = auth?.status ?? "unknown";
          const blocked = disabled || !!target || !available;
          return (
            <li
              className="fdy-xacc-binding-row flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2"
              key={group.id}
            >
              <Identity className="flex-1 basis-72">
                <strong>{label}</strong>
                <small>
                  {!device.online
                    ? t("deviceHeld.offlineUnknown")
                    : auth?.reason
                      ? t(`authorization.reason.${auth.reason}`)
                      : t("authorization.localOnly")}
                </small>
                {group.scopes?.length && auth?.grantedScopes ? (
                  <small>
                    {t("authorization.grantedCount", {
                      count: auth.grantedScopes.length,
                      total: group.scopes.length,
                    })}
                  </small>
                ) : null}
                {auth?.lastChange ? (
                  <ScopeChangeNote change={auth.lastChange} />
                ) : null}
                {auth ? (
                  <small>
                    {t("authorization.checked", {
                      when: relativeWhen(auth.checkedAt),
                    })}
                  </small>
                ) : null}
              </Identity>
              <ButtonRow className="ml-auto max-w-full flex-none">
                <Badge tone={status === "ready" ? "online" : "warn"}>
                  {t(`authorization.status.${status}`)}
                </Badge>
                {(status !== "ready" || group.scopes?.length) &&
                status !== "unavailable" ? (
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
                        group,
                        grantedScopes: auth?.grantedScopes,
                        lastChange: auth?.lastChange,
                        authorization: {
                          id: group.id,
                          revision: group.revision,
                        },
                      })
                    }
                  >
                    {auth?.reason === "bootstrap_available"
                      ? t("authorization.prepare")
                      : group.scopes?.length
                        ? t(
                            auth?.grantedScopes?.length
                              ? "authorization.changePermissions"
                              : "authorization.choosePermissions",
                          )
                        : t("authorization.authorize")}
                  </Button>
                ) : null}
              </ButtonRow>
            </li>
          );
        })}
      </DividedList>
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
