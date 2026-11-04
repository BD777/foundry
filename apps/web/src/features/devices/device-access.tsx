import { FieldHint } from "../../components/ui/field";
import { useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Monitor, Network } from "lucide-react";
import type { DevicesFeatureProps } from "./devices-feature";
import type {
  DeviceProjection,
  AgentProfileProjection,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { SectionHeader } from "../../components/ui/page-header";
import { DeviceAccounts } from "./device-accounts";
import { DeviceConnections } from "./device-connections";
import { DeviceProviders, deviceProviders } from "./device-providers";
import { isModelConnection } from "../../lib/model-connections";

/** Each source is a tab: a soft block, filled when selected, one inset focus ring. */
const accessTabClass =
  "h-auto justify-start gap-3 rounded-lg border-0 bg-panel-soft px-4 py-3.5 text-left active:scale-100 aria-selected:bg-selection aria-selected:text-ink aria-selected:hover:bg-selection focus-visible:outline-0 focus-visible:shadow-[inset_0_0_0_1px_var(--fdy-control-focus)] max-[700px]:items-start max-[700px]:gap-2 max-[700px]:p-3";
const accessTabHintClass =
  "text-xs leading-[1.4] text-ink-muted max-[700px]:text-2xs";

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
  // API providers in the device's own configuration are model providers too;
  // only the usable ones count, and a promoted one already counts as its
  // server copy.
  const deviceCount = deviceProviders(ownProfiles).filter(
    (row) => row.status === "healthy" && !row.promotedProfileId,
  ).length;
  return (
    <section className="grid min-w-0 gap-5.5">
      <SectionHeader
        title={t("access.title")}
        description={
          <Trans
            ns="devices"
            i18nKey="access.intro"
            values={{ device: device.label }}
            components={{ strong: <strong /> }}
          />
        }
      />
      <div
        className="grid grid-cols-2 gap-2 border-b border-line pb-4"
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
          className={accessTabClass}
          onClick={() => setSource("accounts")}
        >
          <Monitor size={18} />
          <span className="grid gap-[5px] whitespace-normal">
            <strong className="text-sm">{t("access.accountsTitle")}</strong>
            <FieldHint as="small" className={accessTabHintClass}>
              {t("access.accountsHint")}
            </FieldHint>
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
          className={accessTabClass}
          onClick={() => setSource("connections")}
        >
          <Network size={18} />
          <span className="grid gap-[5px] whitespace-normal">
            <strong className="text-sm [&_em]:ml-[5px] [&_em]:not-italic">
              <Trans
                ns="devices"
                i18nKey="access.connectionsTitle"
                values={{ total: count + deviceCount }}
                components={{ em: <em /> }}
              />
            </strong>
            <FieldHint as="small" className={accessTabHintClass}>
              {t("access.connectionsHint")}
            </FieldHint>
          </span>
        </Button>
      </div>
      <div
        className="grid min-w-0 gap-7"
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
            <SectionHeader
              title={t("access.accountsTitle")}
              description={t("access.accountsExplanation")}
            />
            <DeviceAccounts
              device={device}
              profiles={ownProfiles}
              health={props.providerHealth.filter(
                (row) => row.deviceId === device.id,
              )}
              legacyProfiles={props.profiles}
              bindings={props.deviceProfiles}
              serverProfiles={props.profiles}
              onRefresh={props.onRefresh}
            />
          </>
        ) : (
          <>
            <DeviceConnections
              device={device}
              profiles={props.profiles}
              bindings={props.deviceProfiles}
              providerHealth={props.providerHealth}
              onRefresh={props.onRefresh}
              onManage={props.onManageConnections}
            />
            <DeviceProviders
              device={device}
              profiles={ownProfiles}
              serverProfiles={props.profiles}
              onRefresh={props.onRefresh}
            />
          </>
        )}
      </div>
    </section>
  );
}
