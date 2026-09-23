import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState } from "react";
import type {
  AgentModelOption,
  DeviceProfileBinding,
  DeviceProjection,
  ProfileDefinition,
  SaveProfileInput,
} from "@foundry/protocol";
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
      setError(cause instanceof Error ? cause.message : "The request failed.");
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
        <strong>Server API connections</strong>
        <p>
          Reusable API and gateway connections, stored on this server. Assign
          them to the devices that may use them.
        </p>
        <Button
          className="fdy-connections-device-link"
          variant="ghost"
          size="sm"
          onClick={onOpenDevices}
        >
          Use a ChatGPT or Claude subscription? Open device accounts →
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
                  {state.isNew ? "New connection" : "Edit connection"}
                </Dialog.Title>
                <Dialog.Description>
                  Configure an API or gateway. Official logins stay on each
                  device.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button
                  aria-label="Close connection editor"
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
                      throw new Error(
                        "The server did not return the saved connection.",
                      );
                    state.acceptSavedProfile(saved);
                  })
                }
              />
              <section className="fdy-connection-devices">
                <strong>Catalog device</strong>
                <p>
                  {catalogDevice
                    ? "Model discovery runs on this device; it does not change your active workspace."
                    : "The catalog device is unavailable. Select an online device, or enter models and save without discovery."}
                </p>
                {onlineDevices.length ? (
                  <SelectMenu
                    ariaLabel="Catalog device"
                    insideDialog
                    value={catalogDevice?.id ?? ""}
                    options={[
                      ...(!catalogDevice
                        ? [{ value: "", label: "Choose an online device" }]
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
                <p className="fdy-helper-copy">
                  Save this connection first, then assign devices here.
                </p>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </PageSurface>
  );
}
