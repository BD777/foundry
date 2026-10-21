import { liveDevices, isRemovedDevice } from "../../lib/devices";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  PersonalAgentRunPreference,
  PersonalAgentRunTarget,
  PersonalAgentSettings,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { listAgentModels } from "../../api";
import { runtimeMeta } from "../../components/ui/runtime-mark";
import { SelectMenu } from "../../components/ui/select-menu";
import { TextInput } from "../../components/ui/field";
import { Button } from "../../components/ui/button";
import {
  SettingsField,
  SettingsGroup,
  SettingsCheck,
  type ChangeSettings,
} from "./settings-field";

const roles = ["coordinator", "memory", "governance", "executor"] as const;
/** The models one choice offers: its own list, then what its computer reports. */
function useModels(profile: AgentProfileProjection | undefined) {
  const [read, setRead] = useState<{ id: string; models: string[] }>();
  const id = profile
    ? JSON.stringify([
        profile.deviceId,
        profile.id,
        profile.runtime,
        profile.baseUrl,
        profile.model,
        profile.connectionType,
        profile.status,
        profile.accountLabel,
        profile.runtimeGeneration,
      ])
    : "";
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
      { reuse: true, catalogIdentity: id },
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

export function ModelsSection({
  draft,
  change,
  agentProfiles,
  home,
  devices,
  workspaces,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
  agentProfiles: AgentProfileProjection[];
  home: DeviceProjection | undefined;
  devices: DeviceProjection[];
  workspaces: WorkspaceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const defaults: PersonalAgentRunPreference = draft.runDefault ?? {
    profileId: draft.assistantProfileId || "device_default",
    model: draft.assistantModel,
    ...(draft.assistantProfileId && home ? { deviceId: home.id } : {}),
  };
  const updateDefault = (value: PersonalAgentRunPreference) =>
    change({
      runDefault: value,
      assistantProfileId:
        value.profileId === "device_default" ? "" : (value.profileId ?? ""),
      assistantModel: value.model ?? "",
    });
  return (
    <>
      <p className="fdy-pa-intro">{t("settings.models.rolesIntro")}</p>
      <SettingsGroup title={t("settings.models.defaultTitle")}>
        <RunEditor
          title={t("settings.models.defaultTitle")}
          value={defaults}
          onChange={updateDefault}
          profiles={agentProfiles}
          devices={devices}
          homeDeviceId={home?.id}
          workspaces={workspaces}
        />
      </SettingsGroup>
      {roles.map((role) => {
        const override = draft.roleOverrides?.[role];
        const update = (value: PersonalAgentRunPreference | undefined) => {
          const roleOverrides = { ...draft.roleOverrides };
          if (value) roleOverrides[role] = value;
          else delete roleOverrides[role];
          change({ roleOverrides });
        };
        return (
          <SettingsGroup key={role} title={t(`settings.models.roles.${role}`)}>
            <SettingsCheck
              label={t("settings.models.override")}
              checked={Boolean(override)}
              onChange={(enabled) =>
                update(enabled ? { ...defaults } : undefined)
              }
            />
            {override ? (
              <RunEditor
                title={t(`settings.models.roles.${role}`)}
                value={override}
                onChange={update}
                profiles={agentProfiles}
                devices={devices}
                homeDeviceId={role === "coordinator" ? home?.id : undefined}
                workspaces={workspaces}
              />
            ) : (
              <p className="fdy-pa-field-hint">
                {t("settings.models.inherits")}
              </p>
            )}
          </SettingsGroup>
        );
      })}
      <p className="fdy-pa-field-hint">{t("settings.models.applyNext")}</p>
    </>
  );
}

function RunEditor({
  title,
  value,
  onChange,
  profiles,
  devices,
  homeDeviceId,
  workspaces,
}: {
  title: string;
  value: PersonalAgentRunPreference;
  onChange: (value: PersonalAgentRunPreference) => void;
  profiles: AgentProfileProjection[];
  devices: DeviceProjection[];
  homeDeviceId?: string;
  workspaces: WorkspaceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const patch = (next: Partial<PersonalAgentRunPreference>) =>
    onChange({ ...value, ...next });
  return (
    <>
      <SettingsCheck
        checked={!value.disabled}
        label={t("settings.models.enabled")}
        onChange={(enabled) => patch({ disabled: !enabled })}
      />
      <SettingsField
        label={t("settings.models.location")}
        hint={t("settings.models.locationHint")}
      >
        <SelectMenu
          ariaLabel={`${title} ${t("settings.models.location")}`}
          className="fdy-pa-select"
          value={value.deviceId ?? ""}
          options={[
            { value: "", label: t("settings.models.targetLocation") },
            ...(value.deviceId &&
            !liveDevices(devices).some((d) => d.id === value.deviceId)
              ? [
                  {
                    value: value.deviceId,
                    label: `${devices.find((d) => d.id === value.deviceId)?.label ?? value.deviceId} · ${t("settings.devices.unavailable")}`,
                    disabled: true,
                  },
                ]
              : []),
            ...liveDevices(devices).map((d) => ({
              value: d.id,
              label: d.label,
            })),
          ]}
          onChange={(deviceId) =>
            patch({
              deviceId,
              profileId: "device_default",
              runtime: "",
              model: "",
              effort: "",
            })
          }
        />
      </SettingsField>
      <AccountEditor
        title={title}
        value={value}
        profiles={profiles}
        devices={devices}
        defaultDeviceId={homeDeviceId}
        onChange={patch}
      />
      <SettingsField label={t("settings.models.tokenBudget")}>
        <TextInput
          aria-label={`${title} ${t("settings.models.tokenBudget")}`}
          type="number"
          min={1}
          max={10000000}
          value={value.tokenBudget ?? 500000}
          onChange={(e) => patch({ tokenBudget: Number(e.target.value) })}
        />
      </SettingsField>
      <SettingsField label={t("settings.models.timeout")}>
        <TextInput
          aria-label={`${title} ${t("settings.models.timeout")}`}
          type="number"
          min={1}
          max={240}
          value={value.timeoutMinutes ?? 30}
          onChange={(e) => patch({ timeoutMinutes: Number(e.target.value) })}
        />
      </SettingsField>
      <p className="fdy-pa-field-hint">{t("settings.models.fallbackHint")}</p>
      {(value.fallbacks ?? []).map((fallback, index) => {
        const update = (next: PersonalAgentRunTarget) =>
          patch({
            fallbacks: value.fallbacks?.map((item, i) =>
              i === index ? next : item,
            ),
          });
        const target = workspaces.find(
          (ws) => ws.id === fallback.workspaceIds[0],
        );
        return (
          <div key={index} className="fdy-pa-model-fallback">
            <SettingsField
              label={t("settings.models.fallbackWorkspace", {
                index: index + 1,
              })}
            >
              <SelectMenu
                ariaLabel={`${title} ${t("settings.models.fallbackWorkspace", { index: index + 1 })}`}
                value={fallback.workspaceIds[0] ?? ""}
                options={[
                  { value: "", label: t("settings.models.chooseWorkspace") },
                  ...workspaces
                    .filter((ws) => !ws.archivedAt)
                    .map((ws) => ({ value: ws.id, label: ws.name })),
                ]}
                onChange={(workspaceId) =>
                  update({
                    workspaceIds: workspaceId ? [workspaceId] : [],
                    deviceId:
                      workspaces.find((ws) => ws.id === workspaceId)
                        ?.deviceId ?? "",
                    profileId: "",
                    runtime: "",
                  })
                }
              />
            </SettingsField>
            <AccountEditor
              title={`${title} ${t("settings.models.fallback", { index: index + 1 })}`}
              value={fallback}
              profiles={profiles}
              devices={devices}
              defaultDeviceId={target?.deviceId}
              allowDefault={false}
              onChange={(next) =>
                update({
                  ...fallback,
                  ...next,
                  deviceId: target?.deviceId ?? fallback.deviceId,
                })
              }
            />
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                patch({
                  fallbacks: value.fallbacks?.filter((_, i) => i !== index),
                })
              }
            >
              {t("settings.models.removeFallback")}
            </Button>
          </div>
        );
      })}
      <Button
        variant="secondary"
        size="sm"
        disabled={(value.fallbacks?.length ?? 0) >= 3}
        onClick={() =>
          patch({
            fallbacks: [
              ...(value.fallbacks ?? []),
              { deviceId: "", profileId: "", runtime: "", workspaceIds: [] },
            ],
          })
        }
      >
        {t("settings.models.addFallback")}
      </Button>
    </>
  );
}

function AccountEditor({
  title,
  value,
  profiles,
  devices,
  defaultDeviceId,
  onChange,
  allowDefault = true,
}: {
  title: string;
  value: PersonalAgentRunPreference;
  profiles: AgentProfileProjection[];
  devices: DeviceProjection[];
  defaultDeviceId?: string;
  onChange: (value: Partial<PersonalAgentRunPreference>) => void;
  allowDefault?: boolean;
}) {
  const { t } = useTranslation("personalAgent");
  const deviceId = value.deviceId || defaultDeviceId;
  const choices = profiles.filter(
    (profile) =>
      !isRemovedDevice(devices.find((d) => d.id === profile.deviceId)) &&
      (!deviceId || profile.deviceId === deviceId),
  );
  const chosen = choices.find((profile) => profile.id === value.profileId);
  const followsDefault =
    !value.profileId || value.profileId === "device_default";
  const preview =
    chosen ??
    (followsDefault && value.runtime && deviceId
      ? choices.find(
          (p) => p.runtime === value.runtime && p.status === "healthy",
        )
      : undefined);
  const { models, loading } = useModels(preview);
  const key = (profile: AgentProfileProjection) =>
    JSON.stringify([profile.deviceId, profile.id]);
  const accountOptions = [
    {
      value: "",
      label: allowDefault
        ? t("settings.models.serviceDefault")
        : t("settings.models.chooseAccount"),
    },
    ...choices.map((profile) => ({
      value: key(profile),
      label: profile.label,
      meta: `${runtimeMeta(profile.runtime).label} · ${devices.find((d) => d.id === profile.deviceId)?.label ?? profile.deviceId} · ${t(profile.status !== "healthy" ? "settings.models.unavailable" : devices.find((d) => d.id === profile.deviceId)?.status !== "connected" ? "settings.models.deviceOffline" : "settings.models.available")}`,
    })),
  ];
  const missing =
    value.profileId && value.profileId !== "device_default" && !chosen;
  if (missing)
    accountOptions.push({
      value: value.profileId!,
      label: t("settings.models.missingChoice", { name: value.profileId }),
    });
  const modelOptions = [
    { value: "", label: t("settings.models.modelDefault") },
    ...models.map((model) => ({ value: model, label: model })),
  ];
  if (value.model && !models.includes(value.model))
    modelOptions.push({
      value: value.model,
      label: t(
        preview
          ? "settings.models.missingChoice"
          : "settings.models.checkedOnTarget",
        { name: value.model },
      ),
    });
  const efforts =
    (chosen?.runtime ?? value.runtime) === "codex"
      ? ["minimal", "low", "medium", "high", "xhigh"]
      : ["low", "medium", "high", "xhigh", "max"];
  return (
    <>
      <SettingsField
        label={t("settings.models.service")}
        hint={t("settings.models.accountHint")}
      >
        <SelectMenu
          ariaLabel={`${title} ${t("settings.models.service")}`}
          className="fdy-pa-select"
          options={accountOptions}
          value={chosen ? key(chosen) : missing ? value.profileId! : ""}
          onChange={(selected) => {
            const profile = choices.find((choice) => key(choice) === selected);
            onChange(
              profile
                ? {
                    profileId: profile.id,
                    runtime: profile.runtime,
                    deviceId:
                      profile.origin === "server"
                        ? value.deviceId
                        : profile.deviceId,
                    model: "",
                    effort: "",
                  }
                : {
                    profileId: allowDefault ? "device_default" : "",
                    runtime: "",
                    model: "",
                    effort: "",
                  },
            );
          }}
        />
      </SettingsField>
      {followsDefault ? (
        <SettingsField label={t("settings.models.defaultRuntime")}>
          <SelectMenu
            ariaLabel={`${title} ${t("settings.models.defaultRuntime")}`}
            value={value.runtime ?? ""}
            options={[
              { value: "", label: t("settings.models.runtimeDefault") },
              ...(["codex", "claude"] as const).map((runtime) => ({
                value: runtime,
                label: runtimeMeta(runtime).label,
              })),
            ]}
            onChange={(runtime) => onChange({ runtime, model: "", effort: "" })}
          />
        </SettingsField>
      ) : null}
      <SettingsField
        label={t("settings.models.model")}
        hint={
          loading
            ? t("settings.models.loading")
            : followsDefault && preview
              ? t("settings.models.catalogPreview", {
                  account: preview.label,
                  device:
                    devices.find((d) => d.id === preview.deviceId)?.label ??
                    preview.deviceId,
                })
              : undefined
        }
      >
        <SelectMenu
          ariaLabel={`${title} ${t("settings.models.model")}`}
          className="fdy-pa-select"
          disabled={!chosen && !followsDefault}
          options={modelOptions}
          value={value.model ?? ""}
          onChange={(model) => onChange({ model, effort: "" })}
        />
      </SettingsField>
      <SettingsField
        label={t("settings.models.effort")}
        hint={t("settings.models.effortHint")}
      >
        <SelectMenu
          ariaLabel={`${title} ${t("settings.models.effort")}`}
          className="fdy-pa-select"
          disabled={!chosen && !followsDefault}
          options={[
            { value: "", label: t("settings.models.modelDefault") },
            ...efforts.map((effort) => ({ value: effort, label: effort })),
          ]}
          value={value.effort ?? ""}
          onChange={(effort) => onChange({ effort })}
        />
      </SettingsField>
    </>
  );
}
