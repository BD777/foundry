import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
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
import { connectionUsage } from "../../lib/model-connections";
import { codexTransportStatus } from "./codex-transport";
import { SectionHeader } from "../../components/ui/page-header";

export function ProfileList({
  busy,
  deviceProfiles,
  onCreate,
  onSelect,
  profiles,
}: {
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
          {profiles.map((profile) => (
            <Button
              className="fdy-profile-card active:scale-100 h-auto min-h-15.5 w-full min-w-0 justify-start gap-3 rounded-xl bg-panel p-3.5 text-left whitespace-normal shadow-card hover:bg-control-hover hover:shadow-raised max-[700px]:flex-wrap"
              key={profile.id}
              onClick={() => onSelect(profile.id)}
              variant="ghost"
            >
              <RuntimeMark runtime={profile.runtime} size="lg" />
              <span className="grid min-w-0 flex-1 gap-0.75 max-[700px]:basis-[65%] [&>em]:truncate [&>em]:text-2xs [&>em]:text-ink-muted [&>em]:not-italic [&>small]:truncate [&>small]:text-2xs [&>small]:text-ink-faint [&>strong]:truncate [&>strong]:text-sm [&>strong]:font-semibold [&>strong]:text-ink">
                <strong>{profile.label}</strong>
                <em>
                  {runtimeMeta(profile.runtime).label} · {profile.baseUrl}
                </em>
                <small>{profile.model || t("list.runtimeDefaultModel")}</small>
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
              </span>
              <Badge tone={profile.hasCredential ? "neutral" : "slate"}>
                {connectionUsage(profile, deviceProfiles)}
              </Badge>
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
