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
import { SectionHeader } from "../../components/ui/page-header";
import { Panel } from "../../components/ui/panel";
import {
  RuntimeMark,
  runtimeMeta,
} from "../../components/agent-runtime/runtime-mark";

const detectedReasonClass =
  "col-span-full text-2xs leading-[1.45] font-[550] text-ink-muted";

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
      <SectionHeader
        title={t("detected.title")}
        description={t("detected.intro")}
        actions={
          <Badge tone="neutral">
            {t("detected.found", { count: detectedProfiles.length })}
          </Badge>
        }
      />

      <div className="mt-3.25 grid gap-2">
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
              <div
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 rounded-lg bg-panel-soft p-3 max-[860px]:grid-cols-[minmax(0,1fr)] max-[860px]:items-start"
                key={profile.id}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <RuntimeMark
                    className="size-6.5 flex-none"
                    runtime={profile.runtime}
                  />
                  <span className="min-w-0">
                    <strong className="block min-w-0 truncate text-md leading-[1.2] font-bold text-ink">
                      {profile.label}
                    </strong>
                    <em className="mt-[3px] block min-w-0 truncate font-mono text-2xs leading-[1.25] font-medium text-ink-faint not-italic">
                      {runtimeMeta(profile.runtime).label} ·{" "}
                      {connectionTypeLabel(profile.connectionType)} ·{" "}
                      {authModeLabel(profile.authMode)}
                    </em>
                    <small className="mt-[3px] block min-w-0 truncate text-2xs leading-[1.25] font-[550] text-ink-muted">
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
                  <p className={detectedReasonClass}>
                    <Badge tone="slate">{t("detected.promoted")}</Badge>{" "}
                    {t("detected.promotedBody")}
                  </p>
                ) : blockReason ? (
                  <p className={detectedReasonClass}>{blockReason}</p>
                ) : (
                  <div className="col-span-full flex items-start justify-between gap-3 border-t border-dashed border-line-soft pt-2.5 max-[860px]:flex-col">
                    <span className="min-w-0 text-2xs leading-[1.45] font-semibold text-ink-muted">
                      {profile.serverCredential
                        ? t("detected.serverHasCredential")
                        : t("detected.keySealed")}
                    </span>
                    <Button
                      className="flex-none"
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
