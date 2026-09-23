import { ArrowUpFromLine } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@foundry/protocol";
import {
  authModeLabel,
  connectionTypeLabel,
  promotionBlockReason,
  providerStatusLabel,
  statusTone,
} from "../../lib/profile-status";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Panel, PanelHeader } from "../../components/ui/panel";
import { RuntimeMark, runtimeMeta } from "../../components/ui/runtime-mark";

export interface DetectedProfilesPanelProps {
  detectedProfiles: AgentProfileProjection[];
  device?: DeviceProjection;
  onPromote: (profileId: string) => void;
  serverProfileCount: number;
}

export function DetectedProfilesPanel({
  detectedProfiles,
  device,
  onPromote,
  serverProfileCount,
}: DetectedProfilesPanelProps) {
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const dataSignature = `${serverProfileCount}|${detectedProfiles
    .map((profile) => `${profile.id}:${profile.serverCredential ? 1 : 0}`)
    .join(",")}`;

  useEffect(() => {
    setPendingIds([]);
  }, [dataSignature]);

  return (
    <Panel radius="md" variant="surface">
      <PanelHeader>
        <div>
          <h2>Daemon-reported profiles</h2>
          <p>
            Profiles the daemon found in local configuration. Remote endpoints
            can be promoted into server profiles usable from any device.
          </p>
        </div>
        <Badge tone="neutral">{detectedProfiles.length} found</Badge>
      </PanelHeader>

      <div className="fdy-daemon-detected-list">
        {detectedProfiles.length === 0 ? (
          <EmptyState
            body="The daemon has not reported any locally configured agent profile."
            title="Nothing detected"
          />
        ) : (
          detectedProfiles.map((profile) => {
            const blockReason = promotionBlockReason(
              profile.connectionType,
              profile.authMode,
            );
            const pending = pendingIds.includes(profile.id);

            return (
              <div className="fdy-daemon-detected-row" key={profile.id}>
                <div className="fdy-daemon-provider-main">
                  <RuntimeMark runtime={profile.runtime} />
                  <span>
                    <strong>{profile.label}</strong>
                    <em>
                      {runtimeMeta(profile.runtime).label} ·{" "}
                      {connectionTypeLabel(profile.connectionType)} ·{" "}
                      {authModeLabel(profile.authMode)}
                    </em>
                    <small>
                      {profile.accountLabel
                        ? `Signed in as ${profile.accountLabel}`
                        : (profile.statusDetail ?? profile.configLabel)}
                    </small>
                  </span>
                </div>
                <Badge tone={statusTone(profile.status)}>
                  {providerStatusLabel(profile.status)}
                </Badge>
                {profile.promotedProfileId ? (
                  <p className="fdy-daemon-detected-reason">
                    <Badge tone="slate">Promoted</Badge> Already a server
                    profile any device can run. Edit it in Profile settings.
                  </p>
                ) : blockReason ? (
                  <p className="fdy-daemon-detected-reason">{blockReason}</p>
                ) : (
                  <div className="fdy-daemon-promote">
                    <span className="fdy-daemon-promote-note">
                      {profile.serverCredential
                        ? "The server already holds this credential. Promoting it needs no key from you."
                        : "The key this machine uses is sealed into the server so any device can run the profile."}
                    </span>
                    <Button
                      disabled={!device?.id || pending}
                      onClick={() => {
                        setPendingIds((current) => [...current, profile.id]);
                        onPromote(profile.id);
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      <ArrowUpFromLine size={13} />
                      {pending ? "Promoting" : "Promote"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}
