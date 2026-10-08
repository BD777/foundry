import { useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { KeyRound, Monitor, Network } from "lucide-react";
import type { DevicesFeatureProps } from "./devices-feature";
import type {
  DeviceProjection,
  AgentProfileProjection,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { DeviceAccounts } from "./device-accounts";
import { DeviceConnections } from "./device-connections";
import { DeviceProviders, deviceProviders } from "./device-providers";
import { isModelConnection } from "../../lib/model-connections";

export function DeviceAccess({
  device,
  ownProfiles,
  ...props
}: DevicesFeatureProps & {
  device: DeviceProjection;
  ownProfiles: AgentProfileProjection[];
}) {
  const { t } = useTranslation("devices");
  const [source, setSource] = useState<"accounts" | "connections">("accounts");
  const accountsTab = useRef<HTMLButtonElement>(null);
  const connectionsTab = useRef<HTMLButtonElement>(null);
  const count = props.deviceProfiles.filter(
    (binding) =>
      binding.deviceId === device.id &&
      binding.enabled &&
      props.profiles.some(
        (profile) =>
          profile.id === binding.profileId && isModelConnection(profile),
      ),
  ).length;
  // API providers in the device's own configuration are API connections too;
  // only the usable ones count.
  const deviceCount = deviceProviders(ownProfiles).filter(
    (row) => row.status === "healthy",
  ).length;
  return (
    <section className="fdy-device-access">
      <div className="fdy-access-intro">
        <h2>{t("access.title")}</h2>
        <p>
          <Trans
            ns="devices"
            i18nKey="access.intro"
            values={{ device: device.label }}
            components={{ strong: <strong /> }}
          />
        </p>
      </div>
      <div
        className="fdy-access-tabs"
        role="tablist"
        aria-label={t("access.sources")}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? "accounts"
              : event.key === "End"
                ? "connections"
                : source === "accounts"
                  ? "connections"
                  : "accounts";
          setSource(next);
          (next === "accounts" ? accountsTab : connectionsTab).current?.focus();
        }}
      >
        <Button
          ref={accountsTab}
          tabIndex={source === "accounts" ? 0 : -1}
          role="tab"
          aria-selected={source === "accounts"}
          aria-controls="device-accounts-panel"
          id="device-accounts-tab"
          variant="ghost"
          className="fdy-access-tab"
          onClick={() => setSource("accounts")}
        >
          <Monitor size={18} />
          <span>
            <strong>{t("access.accountsTitle")}</strong>
            <small>{t("access.accountsHint")}</small>
          </span>
        </Button>
        <Button
          ref={connectionsTab}
          tabIndex={source === "connections" ? 0 : -1}
          role="tab"
          aria-selected={source === "connections"}
          aria-controls="device-connections-panel"
          id="device-connections-tab"
          variant="ghost"
          className="fdy-access-tab"
          onClick={() => setSource("connections")}
        >
          <Network size={18} />
          <span>
            <strong>
              <Trans
                ns="devices"
                i18nKey="access.connectionsTitle"
                values={{ total: count + deviceCount }}
                components={{ em: <em /> }}
              />
            </strong>
            <small>{t("access.connectionsHint")}</small>
          </span>
        </Button>
      </div>
      <div
        role="tabpanel"
        id={
          source === "accounts"
            ? "device-accounts-panel"
            : "device-connections-panel"
        }
        aria-labelledby={
          source === "accounts"
            ? "device-accounts-tab"
            : "device-connections-tab"
        }
      >
        {source === "accounts" ? (
          <>
            <p className="fdy-access-explanation">
              <KeyRound size={14} /> {t("access.accountsExplanation")}
            </p>
            <DeviceAccounts
              device={device}
              profiles={ownProfiles}
              health={props.providerHealth.filter(
                (row) => row.deviceId === device.id,
              )}
              legacyProfiles={props.profiles}
              bindings={props.deviceProfiles}
              onRefresh={props.onRefresh}
            />
          </>
        ) : (
          <>
            <DeviceConnections
              device={device}
              profiles={props.profiles}
              bindings={props.deviceProfiles}
              onRefresh={props.onRefresh}
              onManage={props.onManageConnections}
            />
            <DeviceProviders
              device={device}
              profiles={ownProfiles}
              onRefresh={props.onRefresh}
            />
          </>
        )}
      </div>
    </section>
  );
}
