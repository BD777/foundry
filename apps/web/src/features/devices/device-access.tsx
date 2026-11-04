import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import type { DevicesFeatureProps } from "./devices-feature";
import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import { Button } from "../../components/ui/button";
import { SectionHeader } from "../../components/ui/page-header";
import { SectionPanel } from "../../components/ui/section-panel";
import { InfoRow } from "../../components/ui/info-row";
import { isModelConnection } from "../../lib/model-connections";
import { modelProviderShape } from "../../lib/model-provider-shape";
import { navigateToModelProviders } from "../../lib/in-app-navigation";

/**
 * What this device's chats can run on, read-only: its subscriptions, the
 * server providers assigned to it, endpoints in its own configuration and
 * launch environments. All of them are managed on Model providers, which
 * the link opens filtered to this device.
 */
export function DeviceAccess({
  device,
  ownProfiles,
  ...props
}: DevicesFeatureProps & {
  device: DeviceProjection;
  ownProfiles: AgentProfileProjection[];
}) {
  const { t } = useTranslation("devices");
  const rows = ownProfiles.filter(
    (row) => row.deviceId === device.id && row.origin === "device",
  );
  const subscription = (runtime: "claude" | "codex") => {
    const row = rows.find(
      (entry) =>
        entry.runtime === runtime &&
        modelProviderShape(entry)?.access.kind === "official_login",
    );
    if (row?.status !== "healthy") return t("access.summary.notSignedIn");
    return row.accountLabel
      ? t("access.summary.signedInAs", { account: row.accountLabel })
      : t("access.summary.signedIn");
  };
  const assigned = props.profiles.filter(
    (profile) =>
      isModelConnection(profile) &&
      props.deviceProfiles.some(
        (binding) =>
          binding.deviceId === device.id &&
          binding.profileId === profile.id &&
          binding.enabled,
      ),
  );
  const found = rows.filter(
    (row) =>
      modelProviderShape(row)?.access.kind === "endpoint" &&
      row.status === "healthy" &&
      !row.promotedProfileId,
  );
  const environments = rows.filter(
    (row) => modelProviderShape(row)?.access.kind === "environment",
  );
  const entries: Array<[string, string]> = [
    [t("access.summary.claude"), subscription("claude")],
    [t("access.summary.codex"), subscription("codex")],
    [t("access.summary.server"), names(assigned)],
    [t("access.summary.found"), names(found)],
    [t("access.summary.environments"), names(environments)],
  ];
  function names(list: { label: string }[]): string {
    return list.length
      ? list.map((item) => item.label).join(", ")
      : t("access.summary.none");
  }
  return (
    <section className="grid min-w-0 gap-5.5">
      <SectionHeader
        title={t("access.title")}
        description={t("access.summaryIntro", { device: device.label })}
        actions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => navigateToModelProviders({ deviceId: device.id })}
          >
            {t("access.manage")}
            <ArrowRight size={14} />
          </Button>
        }
      />
      <SectionPanel>
        {entries.map(([label, value]) => (
          <InfoRow
            key={label}
            label={label}
            endClassName="max-w-[60%] text-xs text-ink-muted"
          >
            <span className="truncate" title={value}>
              {value}
            </span>
          </InfoRow>
        ))}
      </SectionPanel>
    </section>
  );
}
