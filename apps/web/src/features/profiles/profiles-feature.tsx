import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import {
  clearProfileCredential,
  createProfile,
  deleteProfile,
  listAgentModels,
  setDeviceProfiles,
  updateProfile,
} from "../../api";
import { Button } from "../../components/ui/button";
import { PageSurface } from "../../components/ui/page-surface";
import { SelectMenu } from "../../components/ui/select-menu";
import { isModelConnection } from "../../lib/model-connections";
import { buildSaveProfileInput } from "./profile-draft";
import { ProfileEditor } from "./profile-editor";
import { ProfileList } from "./profile-list";
import { ConnectionDevices } from "./connection-devices";
import { useModelCatalog } from "./use-model-catalog";
import { useProfilesState } from "./use-profiles-state";
import { liveDevices } from "../../lib/devices";
import { readPageQuery, replacePageQuery } from "../../lib/page-query";

export type ProfilesFeatureEvent =
  /** Resolves once the page shows the providers and device assignments. */
  { type: "profiles.changed" } | { type: "notice.requested"; message: string };

export interface ProfilesFeatureProps {
  busy?: boolean;
  devices?: DeviceProjection[];
  deviceProfiles?: DeviceProfileBinding[];
  onEvent: (event: ProfilesFeatureEvent) => Promise<void> | void;
  onOpenDevices?: () => void;
  profiles: ProfileDefinition[];
}

export function ProfilesFeature({
  busy = false,
  devices = [],
  deviceProfiles = [],
  onEvent,
  onOpenDevices,
  profiles,
}: ProfilesFeatureProps) {
  const { t } = useTranslation("profiles");
  const connections = profiles.filter(isModelConnection);
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
      void onEvent({ type: "notice.requested", message: t("page.saveFailed") });
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
    open(profileId);
  });
  return (
    <PageSurface variant="profiles">
      <div className="fdy-profile-intro">
        <strong>{t("page.title")}</strong>
        <p>{t("page.intro")}</p>
        <Button
          className="fdy-connections-device-link"
          variant="ghost"
          size="sm"
          onClick={onOpenDevices}
        >
          {t("page.openDeviceAccounts")}
        </Button>
      </div>
      <ProfileList
        busy={busy || saving}
        deviceProfiles={deviceProfiles}
        onCreate={() => open()}
        onSelect={open}
        profiles={connections}
      />
      <Dialog.Root
        open={modalOpen}
        onOpenChange={(open) => {
          if (!saving && !models.busy) {
            if (!open) state.updateDraft({ apiKey: "" });
            setModalOpen(open);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fdy-profile-modal-overlay" />
          <Dialog.Content className="fdy-profile-modal">
            <header className="fdy-profile-modal-header">
              <div>
                <Dialog.Title>
                  {state.isNew
                    ? t("page.newConnection")
                    : t("page.editConnection")}
                </Dialog.Title>
                <Dialog.Description>
                  {t("page.modalDescription")}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button
                  aria-label={t("page.closeEditor")}
                  size="icon"
                  variant="ghost"
                >
                  <X size={17} />
                </Button>
              </Dialog.Close>
            </header>
            {error ? (
              <p className="fdy-profile-modal-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="fdy-connection-editor-scroll">
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
              <section className="fdy-connection-devices">
                <strong>{t("page.catalogDevice")}</strong>
                <p>
                  {catalogDevice
                    ? t("page.catalogDeviceReady")
                    : t("page.catalogDeviceUnavailable")}
                </p>
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
                  devices={liveDevices(devices)}
                  bindings={deviceProfiles}
                  profile={state.selectedProfile}
                  onSave={(deviceId, profileIds) =>
                    request(async () => {
                      await setDeviceProfiles({ deviceId, profileIds });
                      await onEvent({ type: "profiles.changed" });
                    })
                  }
                />
              ) : (
                <p className="fdy-helper-copy">{t("page.saveFirst")}</p>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </PageSurface>
  );
}
