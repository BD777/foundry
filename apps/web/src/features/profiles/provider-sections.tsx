import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { SectionHeader } from "../../components/ui/page-header";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { providerTabs, type ProviderTab } from "../../lib/provider-tabs";
import { DiscoveredProviders } from "./device-providers";
import { ProfileList } from "./profile-list";

/** One tab per kind of model provider (/model-providers/<tab>). */
export function ProviderTabsControl({
  tab,
  onTabChange,
}: {
  tab: ProviderTab;
  onTabChange: (tab: ProviderTab) => void;
}) {
  const { t } = useTranslation("profiles");
  return (
    <SegmentedControl
      aria-label={t("page.tabs")}
      onValueChange={onTabChange}
      options={providerTabs.map((value) => ({
        value,
        label: t(`${value}.title`),
      }))}
      tone="navigation"
      value={tab}
    />
  );
}

/** The API endpoints tab: the server's providers, then the devices' own. */
export function EndpointsSection({
  busy,
  connections,
  deviceProfiles,
  devices,
  onCreate,
  onSelect,
  onRefresh,
  profiles,
  serverProfiles,
}: {
  busy: boolean;
  connections: ProfileDefinition[];
  deviceProfiles: DeviceProfileBinding[];
  devices: DeviceProjection[];
  onCreate: () => void;
  onSelect: (profileId: string) => void;
  onRefresh: () => Promise<void>;
  profiles: AgentProfileProjection[];
  serverProfiles: ProfileDefinition[];
}) {
  const { t } = useTranslation("profiles");
  return (
    <section className="grid min-w-0 gap-6">
      <SectionHeader
        title={t("endpoints.title")}
        description={t("endpoints.intro")}
      />
      <ProfileList
        agentProfiles={profiles}
        busy={busy}
        deviceProfiles={deviceProfiles}
        onCreate={onCreate}
        onSelect={onSelect}
        profiles={connections}
      />
      <DiscoveredProviders
        devices={devices}
        profiles={profiles}
        serverProfiles={serverProfiles}
        onRefresh={onRefresh}
      />
    </section>
  );
}
