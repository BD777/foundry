import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import type {
  AgentProfileProjection,
  DeviceProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { RowMenu } from "../../components/ui/row-menu";
import { RuntimeMark } from "../../components/ui/runtime-mark";
import { i18n } from "../../i18n";
import { navigateToModelProvider } from "../../lib/in-app-navigation";
import { PromoteProviderDialog } from "./promote-provider-dialog";

/** Host and path, which is what tells two providers on one gateway apart. */
function endpointLabel(baseUrl?: string): string {
  if (!baseUrl) return "";
  try {
    const url = new URL(baseUrl);
    return `${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return baseUrl;
  }
}

/** API providers configured on the device itself, not on the server. */
export function deviceProviders(
  profiles: AgentProfileProjection[],
): AgentProfileProjection[] {
  return profiles.filter(
    (row) =>
      row.origin === "device" &&
      (row.connectionType === "openai_compatible" ||
        row.connectionType === "anthropic_compatible"),
  );
}

/**
 * API providers in the device's own Claude Code / Codex configuration, each
 * once. Those that answered a turn through their agent's SDK are ready to
 * choose in a chat, with nothing to set up; ones still being checked, or not
 * answering, are a line of explanation rather than a row. A ready one can be
 * promoted to a Model provider on the server; once it is, chats use that
 * copy and the row links to it.
 */
export function DeviceProviders({
  device,
  profiles,
  serverProfiles,
  onRefresh,
}: {
  device: DeviceProjection;
  profiles: AgentProfileProjection[];
  serverProfiles: ProfileDefinition[];
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const [promoting, setPromoting] = useState<AgentProfileProjection>();
  const rows = deviceProviders(profiles);
  const usable = rows.filter((row) => row.status === "healthy");
  const pending = rows.filter((row) => row.check?.status === "pending");
  const failing = rows.filter(
    (row) => row.status !== "healthy" && row.check?.status !== "pending",
  );
  if (!rows.length) return null;
  // The Model provider this row was promoted into, by its recorded source.
  // Promoting again updates that one; a server profile that only shares the
  // endpoint (promotedProfileId) is linked but not updated.
  const promotedTo = (row: AgentProfileProjection) =>
    serverProfiles.find(
      (profile) =>
        profile.promotedFrom?.deviceId === device.id &&
        profile.promotedFrom.profileId === row.id,
    );
  return (
    <section className="fdy-device-section">
      <header className="fdy-management-heading">
        <div>
          <h2>{t("providers.title")}</h2>
          <p>{t("providers.intro", { device: device.label })}</p>
        </div>
      </header>
      {usable.length ? (
        <div className="fdy-management-list">
          {usable.map((row) => {
            const promoted = promotedTo(row);
            const linkedId = promoted?.id ?? row.promotedProfileId;
            return (
              <div className="fdy-management-row" key={row.id}>
                <RuntimeMark runtime={row.runtime} />
                <span>
                  <strong>{row.label}</strong>
                  <small>
                    {[
                      endpointLabel(row.baseUrl),
                      t("providers.from", { source: row.configLabel }),
                      row.check?.checkedAt
                        ? t("providers.answered", {
                            time: new Date(row.check.checkedAt).toLocaleString(
                              i18n.language,
                              {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              },
                            ),
                          })
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
                {linkedId ? (
                  <Button
                    aria-label={t("providers.openPromoted", {
                      name: promoted?.label ?? row.label,
                    })}
                    onClick={() => navigateToModelProvider(linkedId)}
                    size="sm"
                    variant="ghost"
                  >
                    {t("providers.promoted")}
                    <ArrowRight size={14} />
                  </Button>
                ) : (
                  <Badge tone="online">{t("providers.ready")}</Badge>
                )}
                <RowMenu
                  label={t("providers.actions", { name: row.label })}
                  items={[
                    {
                      key: "promote",
                      label: promoted
                        ? t("providers.updatePromotion")
                        : t("providers.promote"),
                      onSelect: () => setPromoting(row),
                    },
                  ]}
                />
              </div>
            );
          })}
        </div>
      ) : null}
      {pending.length ? (
        <p role="status">
          {t("providers.checking", {
            names: pending.map((row) => row.label).join(", "),
          })}
        </p>
      ) : null}
      {failing.map((row) => (
        <p key={row.id}>
          {t("providers.notAnswering", {
            name: row.label,
            source: row.configLabel,
            reason: row.check?.message || row.statusDetail || "",
          })}
        </p>
      ))}
      {promoting ? (
        <PromoteProviderDialog
          device={device}
          row={promoting}
          promoted={promotedTo(promoting)}
          onClose={() => setPromoting(undefined)}
          onPromoted={async () => {
            await onRefresh();
            setPromoting(undefined);
          }}
        />
      ) : null}
    </section>
  );
}
