import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProfileBinding,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import {
  RuntimeMark,
  runtimeMeta,
} from "../../components/agent-runtime/runtime-mark";
import { ModelGuideTags } from "./model-guide-tag";
import { connectionUsage } from "../../lib/model-connections";
import { codexTransportStatus } from "./codex-transport";
import { SectionHeader } from "../../components/ui/page-header";
import { serverProfileCheck } from "./connection-devices";

/** How many of the devices a provider is assigned to passed or failed its check. */
function checkCounts(
  profile: ProfileDefinition,
  deviceProfiles: DeviceProfileBinding[],
  agentProfiles: AgentProfileProjection[],
): { passed: number; failed: number } {
  const counts = { passed: 0, failed: 0 };
  for (const binding of deviceProfiles) {
    if (!binding.enabled || binding.profileId !== profile.id) continue;
    const status = serverProfileCheck(
      agentProfiles,
      profile.id,
      binding.deviceId,
    )?.status;
    if (status === "passed") counts.passed += 1;
    if (status === "failed") counts.failed += 1;
  }
  return counts;
}

export function ProfileList({
  agentProfiles = [],
  busy,
  deviceProfiles,
  onCreate,
  onSelect,
  profiles,
}: {
  /** Every device's profile rows; a server provider's carry its checks. */
  agentProfiles?: AgentProfileProjection[];
  busy: boolean;
  deviceProfiles: DeviceProfileBinding[];
  onCreate: () => void;
  onSelect: (profileId: string) => void;
  profiles: ProfileDefinition[];
}) {
  const { t } = useTranslation("profiles");
  return (
    <section className="grid min-w-0 gap-4">
      <SectionHeader
        level={3}
        title={t("list.title")}
        description={t("list.saved", { count: profiles.length })}
        actions={
          <Button
            disabled={busy}
            onClick={onCreate}
            size="sm"
            variant="primary"
          >
            <Plus size={14} />
            {t("list.newConnection")}
          </Button>
        }
      />
      {profiles.length === 0 ? (
        <EmptyState title={t("list.emptyTitle")} body={t("list.emptyBody")} />
      ) : (
        <div className="fdy-profile-card-grid grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          {profiles.map((profile) => {
            const checks = checkCounts(profile, deviceProfiles, agentProfiles);
            return (
              <div className="grid min-w-0 gap-1" key={profile.id}>
                <Button
                  className="fdy-profile-card active:scale-100 h-auto min-h-15.5 w-full min-w-0 justify-start gap-3 rounded-xl bg-panel p-3.5 text-left whitespace-normal shadow-card hover:bg-control-hover hover:shadow-raised max-[700px]:flex-wrap"
                  onClick={() => onSelect(profile.id)}
                  variant="ghost"
                >
                  <RuntimeMark runtime={profile.runtime} size="lg" />
                  <span className="grid min-w-0 flex-1 gap-0.75 max-[700px]:basis-[65%] [&>em]:truncate [&>em]:text-2xs [&>em]:text-ink-muted [&>em]:not-italic [&>small]:truncate [&>small]:text-2xs [&>small]:text-ink-faint [&>strong]:truncate [&>strong]:text-sm [&>strong]:font-semibold [&>strong]:text-ink">
                    <strong>{profile.label}</strong>
                    <em>
                      {runtimeMeta(profile.runtime).label} · {profile.baseUrl}
                    </em>
                    <small>
                      {profile.model || t("list.runtimeDefaultModel")}
                    </small>
                    {profile.codexTransport ? (
                      <small>
                        {codexTransportStatus(
                          t,
                          profile.codexTransport,
                          profile.codexTransportLearned,
                          true,
                        )}
                      </small>
                    ) : null}
                    {checks.failed ? (
                      <small>
                        {t("list.checkFailedOn", { count: checks.failed })}
                      </small>
                    ) : checks.passed ? (
                      <small>
                        {t("list.verifiedOn", { count: checks.passed })}
                      </small>
                    ) : null}
                  </span>
                  <Badge tone={profile.hasCredential ? "neutral" : "slate"}>
                    {connectionUsage(profile, deviceProfiles)}
                  </Badge>
                </Button>
                <div className="px-3.5">
                  <ModelGuideTags targets={profileGuideTargets(profile)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The models a saved endpoint offers, as guide lookups. */
function profileGuideTargets(profile: ProfileDefinition) {
  return [
    ...new Set(
      [profile.model ?? "", ...(profile.models ?? [])].filter(Boolean),
    ),
  ]
    .slice(0, 8)
    .map((model) => ({
      providerKind: "api",
      providerId: profile.id,
      runtime: profile.runtime,
      model,
    }));
}
