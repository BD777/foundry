import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentModelOption,
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
  SaveProfileInput,
} from "@bd777/foundry-protocol";
import type { CreateAgentProfileInput } from "../../api-types";
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

export type ProfilesFeatureEvent =
  | { type: "save-profile"; input: SaveProfileInput }
  | { type: "delete-profile"; profileId: string }
  | { type: "clear-credential"; profileId: string }
  | { type: "load-models"; profile: CreateAgentProfileInput }
  | { type: "set-device-profiles"; deviceId: string; profileIds: string[] };
export type ProfilesFeatureResult =
  AgentModelOption[] | ProfileDefinition | undefined;

export interface ProfilesFeatureProps {
  busy?: boolean;
  devices?: DeviceProjection[];
  deviceProfiles?: DeviceProfileBinding[];
  onEvent: (event: ProfilesFeatureEvent) => Promise<ProfilesFeatureResult>;
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
    onLoad: (profile) => onEvent({ type: "load-models", profile }),
    updateDraft: state.updateDraft,
  });
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
                draft={state.draft}
                isNew={state.isNew}
                modelsBusy={models.busy}
                modelsNote={models.note}
                onChange={state.updateDraft}
                onClearCredential={() =>
                  void run(() =>
                    onEvent({
                      type: "clear-credential",
                      profileId: state.selectedProfile!.id,
                    }),
                  )
                }
                onDelete={() =>
                  void run(async () => {
                    await onEvent({
                      type: "delete-profile",
                      profileId: state.selectedProfile!.id,
                    });
                    setModalOpen(false);
                  })
                }
                onLoadModels={
                  catalogDevice ? () => void models.load() : undefined
                }
                onRuntimeChange={state.updateRuntime}
                profile={state.selectedProfile}
                onSave={() =>
                  void run(async () => {
                    if (state.isNew) state.expectCreatedProfile();
                    const saved = await onEvent({
                      type: "save-profile",
                      input: buildSaveProfileInput(state.draft),
                    });
                    if (!saved || !("updatedAtLabel" in saved))
                      throw new Error(t("page.savedMissing"));
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
                    onEvent({
                      type: "set-device-profiles",
                      deviceId,
                      profileIds,
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
