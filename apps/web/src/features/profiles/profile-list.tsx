import { Plus } from "lucide-react";
import type {
  DeviceProfileBinding,
  ProfileDefinition,
} from "@foundry/protocol";
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
  return (
    <section className="fdy-profile-list">
      <header className="fdy-profile-list-header">
        <span className="fdy-profile-list-title">
          <strong>Connections</strong>
          <em>{profiles.length} saved on this server</em>
        </span>
        <Button disabled={busy} onClick={onCreate} size="sm" variant="primary">
          <Plus size={14} />
          New connection
        </Button>
      </header>
      {profiles.length === 0 ? (
        <EmptyState
          title="Add your first model connection"
          body="Connect an API or gateway here. Official Claude and Codex accounts are managed on each device."
        />
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
                <small>{profile.model || "Runtime default model"}</small>
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
