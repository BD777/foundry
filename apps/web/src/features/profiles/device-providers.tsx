import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import type {
  AgentProfileProjection,
  DeviceProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { RowMenu } from "../../components/ui/row-menu";
import { RuntimeMark } from "../../components/agent-runtime/runtime-mark";
import { i18n } from "../../i18n";
import { HelpHint } from "../../components/ui/help-hint";
import { DeviceExternalConnections } from "./device-external-connections";
import { PromoteProviderDialog } from "./promote-provider-dialog";
import { LoadingState } from "../../components/ui/loading";
import { SectionHeader } from "../../components/ui/page-header";
import { SectionPanel } from "../../components/ui/section-panel";
import {
  ManagementList,
  ManagementRow,
  ManagementRowCopy,
} from "../../components/ui/management-row";
import { modelProviderShape } from "../../lib/model-provider-shape";

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

function answeredAt(value: string): string {
  return new Date(value).toLocaleString(i18n.language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A device's own endpoint providers: an endpoint whose credential it keeps. */
function discoveredOn(
  profiles: AgentProfileProjection[],
  deviceId: string,
): AgentProfileProjection[] {
  return profiles.filter((row) => {
    if (row.deviceId !== deviceId || row.origin !== "device") return false;
    const shape = modelProviderShape(row);
    return shape?.access.kind === "endpoint";
  });
}

/** A device's providers started inside a launch environment. */
function environmentsOn(
  profiles: AgentProfileProjection[],
  deviceId: string,
): AgentProfileProjection[] {
  return profiles.filter(
    (row) =>
      row.deviceId === deviceId &&
      row.origin === "device" &&
      modelProviderShape(row)?.access.kind === "environment",
  );
}

/**
 * Anthropic- and OpenAI-compatible endpoints in each device's own Claude
 * Code / Codex configuration, each once. Those that answered a turn through
 * their agent's SDK are ready to choose in a chat; one can be promoted to a
 * server provider, and once it is, chats use that copy and the row links to
 * it. Ones still being checked, or not answering, are a line of explanation.
 */
export function DiscoveredProviders({
  devices,
  profiles,
  serverProfiles,
  onRefresh,
}: {
  devices: DeviceProjection[];
  profiles: AgentProfileProjection[];
  serverProfiles: ProfileDefinition[];
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const [promoting, setPromoting] = useState<{
    device: DeviceProjection;
    row: AgentProfileProjection;
  }>();
  const perDevice = devices.map((device) => ({
    device,
    rows: discoveredOn(profiles, device.id),
  }));
  const any = perDevice.some(({ rows }) => rows.length);
  // The server provider a row was promoted into, by its recorded source.
  const promotedTo = (device: DeviceProjection, row: AgentProfileProjection) =>
    serverProfiles.find(
      (profile) =>
        profile.promotedFrom?.deviceId === device.id &&
        profile.promotedFrom.profileId === row.id,
    );
  return (
    <section className="grid min-w-0 gap-4">
      <SectionHeader
        level={3}
        title={t("discovered.title")}
        description={t("discovered.intro")}
      />
      {!any ? (
        <SectionPanel>
          <p className="m-0 text-sm text-ink-muted">{t("discovered.empty")}</p>
        </SectionPanel>
      ) : (
        perDevice.map(({ device, rows }) => {
          if (!rows.length) return null;
          const usable = rows.filter((row) => row.status === "healthy");
          const pending = rows.filter((row) => row.check?.status === "pending");
          const failing = rows.filter(
            (row) =>
              row.status !== "healthy" && row.check?.status !== "pending",
          );
          return (
            <div className="grid min-w-0 gap-2" key={device.id}>
              <strong className="text-sm text-ink">{device.label}</strong>
              {usable.length ? (
                <ManagementList>
                  {usable.map((row) => {
                    const promoted = promotedTo(device, row);
                    const linkedId = promoted?.id ?? row.promotedProfileId;
                    return (
                      <ManagementRow key={row.id}>
                        <RuntimeMark runtime={row.runtime} />
                        <ManagementRowCopy>
                          <strong>{row.label}</strong>
                          <small>
                            {[
                              endpointLabel(row.baseUrl),
                              t("providers.from", { source: row.configLabel }),
                              row.check?.checkedAt
                                ? t("providers.answered", {
                                    time: answeredAt(row.check.checkedAt),
                                  })
                                : undefined,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        </ManagementRowCopy>
                        {linkedId ? (
                          <Badge tone="neutral">
                            {t("discovered.promotedTo", {
                              name: promoted?.label ?? row.label,
                            })}
                          </Badge>
                        ) : (
                          <>
                            <Badge tone="online">{t("providers.ready")}</Badge>
                            <Button
                              size="sm"
                              variant="secondary"
                              aria-label={t("discovered.promoteLabel", {
                                name: row.label,
                                device: device.label,
                              })}
                              onClick={() => setPromoting({ device, row })}
                            >
                              {t("providers.promote")}
                              <ArrowRight size={14} />
                            </Button>
                          </>
                        )}
                        {promoted ? (
                          <RowMenu
                            label={t("providers.actions", { name: row.label })}
                            items={[
                              {
                                key: "promote",
                                label: t("providers.updatePromotion"),
                                onSelect: () => setPromoting({ device, row }),
                              },
                            ]}
                          />
                        ) : null}
                      </ManagementRow>
                    );
                  })}
                </ManagementList>
              ) : null}
              {pending.length ? (
                <LoadingState
                  label={t("providers.checking", {
                    names: pending.map((row) => row.label).join(", "),
                  })}
                />
              ) : null}
              {failing.map((row) => (
                <Alert
                  key={row.id}
                  role="status"
                  size="compact"
                  tone="warning"
                  title={t("providers.notAnswering", {
                    name: row.label,
                    source: row.configLabel,
                    reason: row.check?.message || row.statusDetail || "",
                  })}
                />
              ))}
            </div>
          );
        })
      )}
      {promoting ? (
        <PromoteProviderDialog
          device={promoting.device}
          row={promoting.row}
          promoted={promotedTo(promoting.device, promoting.row)}
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

/**
 * Providers whose agent starts inside an environment a connector gives the
 * device (a gateway's session helper sets its endpoint and credential).
 * Their state, check and defaults are here (the defaults the same as a
 * login's, kept by the device apart from what the connector re-lists);
 * signing in, joining and leaving
 * belong to the connector, on Connectors.
 */
export function EnvironmentProviders({
  devices,
  profiles,
  onRefresh,
}: {
  devices: DeviceProjection[];
  profiles: AgentProfileProjection[];
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("profiles");
  const perDevice = devices
    .map((device) => ({ device, rows: environmentsOn(profiles, device.id) }))
    .filter(({ rows }) => rows.length);
  return (
    <section className="grid min-w-0 gap-4">
      <SectionHeader
        title={t("environments.title")}
        description={t("environments.intro")}
        help={
          <HelpHint label={t("environments.helpLabel")}>
            {t("environments.help")}
          </HelpHint>
        }
      />
      {!perDevice.length ? (
        <SectionPanel>
          <p className="m-0 text-sm text-ink-muted">
            {t("environments.empty")}
          </p>
        </SectionPanel>
      ) : null}
      {perDevice.map(({ device, rows }) => (
        <div className="grid min-w-0 gap-2" key={device.id}>
          <strong className="text-sm text-ink">{device.label}</strong>
          <DeviceExternalConnections
            device={device}
            rows={rows}
            onRefresh={onRefresh}
          />
        </div>
      ))}
    </section>
  );
}
