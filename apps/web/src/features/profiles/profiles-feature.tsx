import type { ToastTone } from "../../components/ui/toast";
import { ToastFeedback } from "../../components/ui/toast";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
  ProviderHealth,
} from "@bd777/foundry-protocol";
import {
  clearProfileCredential,
  createProfile,
  deleteProfile,
  listAgentModels,
  setDeviceProfiles,
  updateProfile,
} from "../../api";
import { Dialog } from "../../components/ui/dialog";
import { Alert } from "../../components/ui/alert";
import { PageSurface } from "../../components/ui/page-surface";
import { SelectMenu } from "../../components/ui/select-menu";
import { isModelConnection } from "../../lib/model-connections";
import { buildSaveProfileInput } from "./profile-draft";
import { ProfileEditor } from "./profile-editor";
import {
  ConnectionDevices,
  connectionSectionClass,
} from "./connection-devices";
import { useModelCatalog } from "./use-model-catalog";
import { useProfilesState } from "./use-profiles-state";
import { readPageQuery, replacePageQuery } from "../../lib/page-query";
import { PageHeader, SectionHeader } from "../../components/ui/page-header";
import { SectionPanel } from "../../components/ui/section-panel";
import { ownedDeviceCandidates } from "../../lib/devices";
import { SubscriptionsSection } from "./subscriptions-section";
import { EnvironmentProviders } from "./device-providers";
import type { NativeRuntime } from "./device-accounts";
import { ProviderFilters, type RuntimeFilter } from "./provider-filters";
import type { ProviderTab } from "../../lib/provider-tabs";
import { EndpointsSection, ProviderTabsControl } from "./provider-sections";
import { ModelNotesSection } from "./model-notes";
import { ExecutionDefaultFields } from "../../components/workspace/execution-default-fields";

export type ProfilesFeatureEvent =
  /** Resolves once the page shows the providers and device assignments. */
  | { type: "profiles.changed" }
  | { type: "notice.requested"; message: string; tone?: ToastTone };

export interface ProfilesFeatureProps {
  /** Every device's reported profile rows: logins, endpoints, environments. */
  agentProfiles?: AgentProfileProjection[];
  busy?: boolean;
  devices?: DeviceProjection[];
  deviceProfiles?: DeviceProfileBinding[];
  onEvent: (event: ProfilesFeatureEvent) => Promise<void> | void;
  profiles: ProfileDefinition[];
  /** Each device's runtimes, to say whether a provider can run there. */
  providerHealth?: ProviderHealth[];
  /** The open tab; the route keeps it (/model-providers/<tab>). */
  tab: ProviderTab;
  onTabChange: (tab: ProviderTab) => void;
}

export function ProfilesFeature({
  agentProfiles = [],
  busy = false,
  devices = [],
  deviceProfiles = [],
  onEvent,
  profiles,
  providerHealth = [],
  tab,
  onTabChange,
}: ProfilesFeatureProps) {
  const { t } = useTranslation("profiles");
  const { t: tAgents } = useTranslation("agents");
  const ownDevices = ownedDeviceCandidates(devices);
  // A link from a device's page opens filtered to it (?device=<id>). The URL
  // is read once; the filter writes it back, never the other way round.
  const [deviceFilter, setDeviceFilter] = useState(() =>
    readPageQuery("device"),
  );
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>("all");
  const shownDevices = deviceFilter
    ? ownDevices.filter((device) => device.id === deviceFilter)
    : ownDevices;
  const runtimes: NativeRuntime[] =
    runtimeFilter === "all" ? ["claude", "codex"] : [runtimeFilter];
  const shownProfiles = agentProfiles.filter((row) =>
    runtimes.includes(row.runtime as NativeRuntime),
  );
  const refresh = () => Promise.resolve(onEvent({ type: "profiles.changed" }));
  const connections = profiles.filter(isModelConnection);
  const shownConnections = connections.filter(
    (profile) =>
      runtimes.includes(profile.runtime as NativeRuntime) &&
      (!deviceFilter ||
        deviceProfiles.some(
          (row) =>
            row.deviceId === deviceFilter &&
            row.profileId === profile.id &&
            row.enabled,
        )),
  );
  const state = useProfilesState(connections);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Catalog reads explicitly select a device; they do not inherit a workspace.
  const [catalogDeviceId, setCatalogDeviceId] = useState("");
  const onlineDevices = devices.filter(
    (device) => device.status === "connected",
  );
  const catalogDevice = catalogDeviceId
    ? onlineDevices.find((device) => device.id === catalogDeviceId)
    : onlineDevices[0];
  const models = useModelCatalog({
    deviceId: catalogDevice?.id,
    draft: state.draft,
    onLoad: (profile, reuse) =>
      request(() => listAgentModels(profile, { reuse })),
    updateDraft: state.updateDraft,
  });
  // A server request the page also hears about when it fails.
  async function request<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (error) {
      void onEvent({
        tone: "error",
        type: "notice.requested",
        message: t("page.saveFailed"),
      });
      throw error;
    }
  }
  // A change is shown once the page has read it, then the page says so.
  function change(
    send: () => Promise<ProfileDefinition>,
    notice: (label: string) => string,
  ): Promise<ProfileDefinition> {
    return request(async () => {
      const profile = await send();
      await onEvent({ type: "profiles.changed" });
      void onEvent({
        type: "notice.requested",
        message: notice(profile.label),
      });
      return profile;
    });
  }
  async function run(action: () => Promise<unknown>) {
    setSaving(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("page.requestFailed"),
      );
    } finally {
      setSaving(false);
    }
  }
  function open(profileId?: string) {
    if (profileId) state.selectProfile(profileId);
    else state.startNewProfile();
    setError("");
    models.reset();
    setModalOpen(true);
  }
  // A link to one provider (?provider=<id>, e.g. from a device's promoted
  // provider) opens its editor once the list has it. The URL is read once.
  const requestedProfile = useRef(readPageQuery("provider"));
  useEffect(() => {
    const profileId = requestedProfile.current;
    if (!profileId || !connections.some((row) => row.id === profileId)) return;
    requestedProfile.current = "";
    replacePageQuery({ provider: "" });
    onTabChange("endpoints");
    open(profileId);
  });
  return (
    <PageSurface variant="profiles">
      <PageHeader title={t("page.title")} description={t("page.intro")} />
      <SectionPanel className="grid min-w-0 gap-3">
        <SectionHeader
          level={3}
          title={tAgents("executionDefault.globalTitle")}
          description={tAgents("executionDefault.globalIntro")}
        />
        <ExecutionDefaultFields
          profiles={agentProfiles}
          servers={connections}
          onNotice={(message, tone) =>
            void onEvent({ type: "notice.requested", message, tone })
          }
        />
      </SectionPanel>
      <ProviderTabsControl tab={tab} onTabChange={onTabChange} />
      <ProviderFilters
        devices={ownDevices}
        deviceId={deviceFilter}
        runtime={runtimeFilter}
        onDeviceChange={(value) => {
          setDeviceFilter(value);
          replacePageQuery({ device: value });
        }}
        onRuntimeChange={setRuntimeFilter}
      />
      {tab === "subscriptions" ? (
        <SubscriptionsSection
          devices={shownDevices}
          runtimes={runtimes}
          profiles={agentProfiles}
          providerHealth={providerHealth}
          bindings={deviceProfiles}
          serverProfiles={profiles}
          onRefresh={refresh}
        />
      ) : tab === "endpoints" ? (
        <EndpointsSection
          busy={busy || saving}
          connections={shownConnections}
          deviceProfiles={deviceProfiles}
          devices={shownDevices}
          onCreate={() => open()}
          onSelect={open}
          onRefresh={refresh}
          profiles={shownProfiles}
          serverProfiles={profiles}
        />
      ) : (
        <EnvironmentProviders
          devices={shownDevices}
          profiles={shownProfiles}
          onRefresh={refresh}
        />
      )}
      <ModelNotesSection
        agentProfiles={shownProfiles}
        kinds={
          tab === "subscriptions"
            ? ["subscription"]
            : tab === "endpoints"
              ? ["api", "discovered"]
              : ["environment"]
        }
        profiles={shownConnections}
        runtimes={runtimes}
      />
      <Dialog
        busy={saving || models.busy}
        description={t("page.modalDescription")}
        layout="compact"
        open={modalOpen}
        size="editor"
        title={state.isNew ? t("page.newConnection") : t("page.editConnection")}
        onClose={() => {
          state.updateDraft({ apiKey: "" });
          setModalOpen(false);
        }}
      >
        <div className="grid gap-4 pt-4.5">
          {error ? <ToastFeedback tone="error" title={error} /> : null}
          <div className="grid content-start gap-5">
            <ProfileEditor
              busy={busy || saving}
              catalogWindows={models.windows}
              draft={state.draft}
              isNew={state.isNew}
              modelsBusy={models.busy}
              modelsNote={models.note}
              onChange={state.updateDraft}
              onClearCredential={() =>
                void run(() =>
                  change(
                    () => clearProfileCredential(state.selectedProfile!.id),
                    (label) => t("page.credentialCleared", { label }),
                  ),
                )
              }
              onDelete={() =>
                void run(async () => {
                  await change(
                    () => deleteProfile(state.selectedProfile!.id),
                    (label) => t("page.profileDeleted", { label }),
                  );
                  setModalOpen(false);
                })
              }
              onLoadModels={
                catalogDevice ? () => void models.load() : undefined
              }
              onReadCatalogWindows={
                catalogDevice ? () => void models.readWindows() : undefined
              }
              onRuntimeChange={state.updateRuntime}
              profile={state.selectedProfile}
              onSave={() =>
                void run(async () => {
                  if (state.isNew) state.expectCreatedProfile();
                  const input = buildSaveProfileInput(state.draft);
                  const saved = await change(
                    () =>
                      input.id
                        ? updateProfile(input.id, input)
                        : createProfile(input),
                    (label) => t("page.profileSaved", { label }),
                  );
                  state.acceptSavedProfile(saved);
                })
              }
            />
            <section className={connectionSectionClass}>
              <SectionHeader
                level={3}
                title={t("page.catalogDevice")}
                description={
                  catalogDevice ? t("page.catalogDeviceReady") : undefined
                }
              />
              {catalogDevice ? null : (
                <Alert
                  size="compact"
                  tone="warning"
                  title={t("page.catalogDeviceUnavailable")}
                />
              )}
              {onlineDevices.length ? (
                <SelectMenu
                  ariaLabel={t("page.catalogDevice")}
                  insideDialog
                  value={catalogDevice?.id ?? ""}
                  options={[
                    ...(!catalogDevice
                      ? [{ value: "", label: t("page.chooseOnlineDevice") }]
                      : []),
                    ...onlineDevices.map((device) => ({
                      value: device.id,
                      label: device.label,
                    })),
                  ]}
                  onChange={setCatalogDeviceId}
                />
              ) : null}
            </section>
            {state.selectedProfile ? (
              <ConnectionDevices
                devices={devices}
                bindings={deviceProfiles}
                agentProfiles={agentProfiles}
                profiles={profiles}
                providerHealth={providerHealth}
                profile={state.selectedProfile}
                onRefresh={refresh}
                onSave={(deviceId, profileIds) =>
                  request(async () => {
                    await setDeviceProfiles({ deviceId, profileIds });
                    await onEvent({ type: "profiles.changed" });
                  })
                }
              />
            ) : (
              <Alert size="compact" title={t("page.saveFirst")} />
            )}
          </div>
        </div>
      </Dialog>
    </PageSurface>
  );
}
