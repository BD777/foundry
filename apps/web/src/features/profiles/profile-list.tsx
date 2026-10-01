import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProfileBinding,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { RuntimeMark, runtimeMeta } from "../../components/ui/runtime-mark";
import { connectionUsage } from "../../lib/model-connections";

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
    <section className="fdy-profile-list">
      <header className="fdy-profile-list-header">
        <span className="fdy-profile-list-title">
          <strong>{t("list.title")}</strong>
          <em>{t("list.saved", { count: profiles.length })}</em>
        </span>
        <Button disabled={busy} onClick={onCreate} size="sm" variant="primary">
          <Plus size={14} />
          {t("list.newConnection")}
        </Button>
      </header>
      {profiles.length === 0 ? (
        <EmptyState title={t("list.emptyTitle")} body={t("list.emptyBody")} />
      ) : (
        <div className="fdy-profile-card-grid">
          {profiles.map((profile) => (
            <Button
              className="fdy-profile-card"
              key={profile.id}
              onClick={() => onSelect(profile.id)}
              variant="ghost"
            >
              <RuntimeMark runtime={profile.runtime} size="lg" />
              <span className="fdy-profile-card-copy">
                <strong>{profile.label}</strong>
                <em>
                  {runtimeMeta(profile.runtime).label} · {profile.baseUrl}
                </em>
                <small>{profile.model || t("list.runtimeDefaultModel")}</small>
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
