import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
} from "@bd777/foundry-protocol";
import { promoteProfile } from "../../api";
import { Badge } from "../../components/ui/badge";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { RuntimeMark } from "../../components/ui/runtime-mark";
import { i18n } from "../../i18n";

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
 * answering, are a line of explanation rather than a row.
 */
export function DeviceProviders({
  device,
  profiles,
  onRefresh,
}: {
  device: DeviceProjection;
  profiles: AgentProfileProjection[];
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const [copying, setCopying] = useState<string>();
  const [error, setError] = useState("");
  const rows = deviceProviders(profiles);
  const usable = rows.filter((row) => row.status === "healthy");
  const pending = rows.filter((row) => row.check?.status === "pending");
  const failing = rows.filter(
    (row) => row.status !== "healthy" && row.check?.status !== "pending",
  );
  if (!rows.length) return null;
  const copy = async (row: AgentProfileProjection) => {
    setCopying(row.id);
    setError("");
    try {
      await promoteProfile({ deviceId: device.id, profileId: row.id });
      await onRefresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("providers.copyFailed"),
      );
    } finally {
      setCopying(undefined);
    }
  };
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
          {usable.map((row) => (
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
              <Badge tone="online">{t("providers.ready")}</Badge>
              {row.promotedProfileId ? (
                <Badge tone="neutral">{t("providers.onServer")}</Badge>
              ) : row.shareable ? (
                <ConfirmButton
                  size="sm"
                  variant="secondary"
                  disabled={
                    copying !== undefined || device.status !== "connected"
                  }
                  confirmLabel={t("providers.copyConfirm")}
                  onConfirm={() => void copy(row)}
                >
                  {copying === row.id
                    ? t("providers.copying")
                    : t("providers.copyToServer")}
                </ConfirmButton>
              ) : null}
            </div>
          ))}
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
      {error ? (
        <p className="fdy-location-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
