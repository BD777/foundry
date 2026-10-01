import { ArrowUpFromLine } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@bd777/foundry-protocol";
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
  const { t } = useTranslation("profiles");
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
          <h2>{t("detected.title")}</h2>
          <p>{t("detected.intro")}</p>
        </div>
        <Badge tone="neutral">
          {t("detected.found", { count: detectedProfiles.length })}
        </Badge>
      </PanelHeader>

      <div className="fdy-daemon-detected-list">
        {detectedProfiles.length === 0 ? (
          <EmptyState
            body={t("detected.emptyBody")}
            title={t("detected.emptyTitle")}
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
                        ? t("detected.signedInAs", {
                            account: profile.accountLabel,
                          })
                        : (profile.statusDetail ?? profile.configLabel)}
                    </small>
                  </span>
                </div>
                <Badge tone={statusTone(profile.status)}>
                  {providerStatusLabel(profile.status)}
                </Badge>
                {profile.promotedProfileId ? (
                  <p className="fdy-daemon-detected-reason">
                    <Badge tone="slate">{t("detected.promoted")}</Badge>{" "}
                    {t("detected.promotedBody")}
                  </p>
                ) : blockReason ? (
                  <p className="fdy-daemon-detected-reason">{blockReason}</p>
                ) : (
                  <div className="fdy-daemon-promote">
                    <span className="fdy-daemon-promote-note">
                      {profile.serverCredential
                        ? t("detected.serverHasCredential")
                        : t("detected.keySealed")}
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
                      {pending
                        ? t("detected.promoting")
                        : t("detected.promote")}
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
