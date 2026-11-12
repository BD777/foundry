import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { SectionHeader } from "../../components/ui/page-header";
import { AppLink } from "../../components/ui/app-link";
import { NavGroup, NavItem } from "../../components/ui/nav-list";
import { pathForAppRoute } from "../../lib/routes";
import { providerTabGroups, type ProviderTab } from "../../lib/provider-tabs";
import { DiscoveredProviders } from "./device-providers";
import { ProfileList } from "./profile-list";

/** The sections of Model providers (/model-providers/<section>), as a grouped flat menu. */
export function ProviderNav({
  tab,
  onTabChange,
}: {
  tab: ProviderTab;
  onTabChange: (tab: ProviderTab) => void;
}) {
  const { t } = useTranslation("profiles");
  return (
    <nav aria-label={t("page.sectionsLabel")} data-provider-nav>
      {providerTabGroups.map((group) => (
        <NavGroup key={group.id} label={t(`page.groups.${group.id}`)}>
          {group.tabs.map((value) => (
            <NavItem asChild current={value === tab} key={value} tone="surface">
              <AppLink
                href={pathForAppRoute({ view: "profiles", providerTab: value })}
                onClick={() => onTabChange(value)}
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  {t(`page.sections.${value}`)}
                </span>
              </AppLink>
            </NavItem>
          ))}
        </NavGroup>
      ))}
    </nav>
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
