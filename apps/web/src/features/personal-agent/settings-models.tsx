import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  PersonalAgentDelegateModel,
  PersonalAgentSettings,
} from "@bd777/foundry-protocol";
import { listAgentModels } from "../../api";
import { runtimeMeta } from "../../components/ui/runtime-mark";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { SelectMenu } from "../../components/ui/select-menu";
import {
  SettingsField,
  SettingsGroup,
  type ChangeSettings,
} from "./settings-field";

const delegates: PersonalAgentDelegateModel[] = [
  "device_default",
  "same_as_assistant",
];

/** The models one choice offers: its own list, then what its computer reports. */
function useModels(profile: AgentProfileProjection | undefined) {
  const [read, setRead] = useState<{ id: string; models: string[] }>();
  const id = profile?.id ?? "";
  useEffect(() => {
    if (!profile) return;
    let current = true;
    void listAgentModels(
      {
        id: profile.id,
        deviceId: profile.deviceId,
        runtime: profile.runtime,
        label: profile.label,
        configScope: profile.configScope,
        connectionType: profile.connectionType,
        model: profile.model,
        baseUrl: profile.baseUrl,
      },
      { reuse: true },
    ).then(
      (models) => {
        if (current) setRead({ id, models: models.map((model) => model.id) });
      },
      () => {
        if (current) setRead({ id, models: [] });
      },
    );
    return () => {
      current = false;
    };
  }, [id]);
  const known = [
    ...(profile?.model ? [profile.model] : []),
    ...(profile?.models ?? []),
    ...(read?.id === id ? read.models : []),
  ];
  return {
    models: [...new Set(known)],
    loading: Boolean(profile) && read?.id !== id,
  };
}

/** What the assistant runs on, and what the work it hands off uses. */
export function ModelsSection({
  draft,
  change,
  agentProfiles,
  home,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
  agentProfiles: AgentProfileProjection[];
  home: DeviceProjection | undefined;
}) {
  const { t } = useTranslation("personalAgent");
  const choices = agentProfiles.filter(
    (profile) => profile.deviceId === home?.id,
  );
  const chosen = choices.find(
    (profile) => profile.id === draft.assistantProfileId,
  );
  const { models, loading } = useModels(chosen);
  const modelOptions = [
    { value: "", label: t("settings.models.modelDefault") },
    ...models.map((model) => ({ value: model, label: model })),
  ];
  if (draft.assistantModel && !models.includes(draft.assistantModel))
    modelOptions.push({
      value: draft.assistantModel,
      label: draft.assistantModel,
    });
  return (
    <>
      <p className="fdy-pa-intro">{t("settings.models.intro")}</p>
      <SettingsGroup>
        <SettingsField
          hint={
            choices.length
              ? undefined
              : t("settings.models.none", { device: home?.label ?? "" })
          }
          label={t("settings.models.service")}
        >
          <SelectMenu
            ariaLabel={t("settings.models.service")}
            className="fdy-pa-select"
            onChange={(assistantProfileId) =>
              change({ assistantProfileId, assistantModel: "" })
            }
            options={[
              { value: "", label: t("settings.models.serviceDefault") },
              ...choices.map((profile) => ({
                value: profile.id,
                label: profile.label,
                meta: runtimeMeta(profile.runtime).label,
              })),
            ]}
            value={draft.assistantProfileId}
          />
        </SettingsField>
        <SettingsField
          hint={loading ? t("settings.models.loading") : undefined}
          label={t("settings.models.model")}
        >
          <SelectMenu
            ariaLabel={t("settings.models.model")}
            className="fdy-pa-select"
            disabled={!chosen}
            onChange={(assistantModel) => change({ assistantModel })}
            options={modelOptions}
            value={draft.assistantModel}
          />
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsField label={t("settings.models.delegate")}>
          <SegmentedControl
            aria-label={t("settings.models.delegate")}
            className="fdy-pa-segments"
            onValueChange={(delegateModel) => change({ delegateModel })}
            options={delegates.map((value) => ({
              value,
              label: t(`settings.models.delegates.${value}`),
            }))}
            size="sm"
            value={draft.delegateModel}
          />
        </SettingsField>
      </SettingsGroup>
    </>
  );
}
