import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  DeviceProjection,
  PersonalAgentRunPreference,
  PersonalAgentRunTarget,
  PersonalAgentSettings,
  PersonalAgentWhenUnavailable,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { i18n } from "../../i18n";
import { useProfileModels } from "../../components/workspace/agent-default-fields";
import {
  claudeEffortOptions,
  codexEffortOptions,
} from "../../lib/agent-effort";
import { navigateAppRoute } from "../../lib/in-app-navigation";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { runtimeMeta } from "../../components/agent-runtime/runtime-mark";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../components/ui/select-menu";
import { FieldHint, TextInput } from "../../components/ui/field";
import { Button } from "../../components/ui/button";
import {
  SettingsField,
  SettingsGroup,
  SettingsCheck,
  type ChangeSettings,
} from "./settings-field";

const advancedRoles = ["memory", "governance"] as const;
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
  const ownOverride = draft.roleOverrides?.coordinator;
  const assistant: PersonalAgentRunPreference = ownOverride ??
    draft.runDefault ?? {
      profileId: draft.assistantProfileId || "device_default",
      model: draft.assistantModel,
    };
  // The assistant runs on its home computer; its choice carries no
  // computer, so work that follows it runs on each project's computer.
  const updateAssistant = (value: PersonalAgentRunPreference) => {
    const next = { ...value, deviceId: undefined };
    const assistantProfileId =
      next.profileId === "device_default" ? "" : (next.profileId ?? "");
    if (ownOverride)
      change({
        roleOverrides: { ...draft.roleOverrides, coordinator: next },
      });
    else
      change({
        runDefault: next,
        assistantProfileId,
        assistantModel: next.model ?? "",
      });
  };
  return (
    <>
      <SettingsGroup title={t("settings.models.assistantTitle")}>
        <FieldHint>
          {t("settings.models.assistantIntro", {
            device: home?.label ?? t("settings.models.homeComputer"),
          })}
        </FieldHint>
        <ChoiceFields
          title={t("settings.models.assistantTitle")}
          value={assistant}
          onChange={(patch) => updateAssistant({ ...assistant, ...patch })}
          sources={homeSources(agentProfiles, home?.id)}
          defaultLabel={t("settings.models.homeDefault")}
        />
      </SettingsGroup>
      <HelperChoice
        draft={draft}
        change={change}
        agentProfiles={agentProfiles}
        devices={devices}
      />
      <p className="m-0 flex flex-wrap items-center gap-x-2 text-xs leading-[1.6] text-ink-muted">
        <span>{t("settings.models.chatUnaffected")}</span>
        <Button
          variant="link"
          size="sm"
          onClick={() => navigateAppRoute({ view: "profiles" })}
        >
          {t("settings.models.manageProviders")}
          <ChevronRight size={14} aria-hidden />
        </Button>
      </p>
      <Disclosure>
        <DisclosureSummary>
          {t("settings.models.advancedTitle")}
        </DisclosureSummary>
        <div className="grid gap-4 pt-2">
          <FieldHint>{t("settings.models.advancedIntro")}</FieldHint>
          {advancedRoles.map((role) => {
            const override = draft.roleOverrides?.[role];
            const update = (value: PersonalAgentRunPreference | undefined) => {
              const roleOverrides = { ...draft.roleOverrides };
              if (value) roleOverrides[role] = value;
              else delete roleOverrides[role];
              change({ roleOverrides });
            };
            return (
              <SettingsGroup
                key={role}
                title={t(`settings.models.roles.${role}`)}
              >
                <SettingsCheck
                  label={t("settings.models.override")}
                  checked={Boolean(override)}
                  onChange={(enabled) =>
                    update(
                      enabled
                        ? { ...assistant, deviceId: undefined }
                        : undefined,
                    )
                  }
                />
                {override ? (
                  <RunEditor
                    title={t(`settings.models.roles.${role}`)}
                    value={override}
                    onChange={update}
                    profiles={agentProfiles}
                    devices={devices}
                    workspaces={workspaces}
                  />
                ) : (
                  <FieldHint>{t("settings.models.inherits")}</FieldHint>
                )}
              </SettingsGroup>
            );
          })}
        </div>
      </Disclosure>
      <FieldHint>{t("settings.models.applyNext")}</FieldHint>
    </>
  );
}

/** How the work the assistant hands off chooses its model. */
type HelperMode = "same" | "each" | "chosen";

function helperModeOf(draft: PersonalAgentSettings): HelperMode {
  const helper = draft.roleOverrides?.executor;
  if (helper)
    return (!helper.profileId || helper.profileId === "device_default") &&
      !helper.model &&
      !helper.runtime
      ? "each"
      : "chosen";
  return draft.runDefault || draft.delegateModel === "same_as_assistant"
    ? "same"
    : "each";
}

function HelperChoice({
  draft,
  change,
  agentProfiles,
  devices,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
  agentProfiles: AgentProfileProjection[];
  devices: DeviceProjection[];
}) {
  const { t } = useTranslation("personalAgent");
  const saved = helperModeOf(draft);
  // "Choose one" stays shown while its source is still to be picked.
  const [picking, setPicking] = useState(false);
  const mode: HelperMode = picking ? "chosen" : saved;
  const helper = draft.roleOverrides?.executor;
  // Budgets and fallbacks set under the old role editor carry over.
  const keep: PersonalAgentRunPreference = {
    ...(helper?.tokenBudget ? { tokenBudget: helper.tokenBudget } : {}),
    ...(helper?.timeoutMinutes
      ? { timeoutMinutes: helper.timeoutMinutes }
      : {}),
    ...(helper?.fallbacks?.length ? { fallbacks: helper.fallbacks } : {}),
  };
  const setHelper = (value: PersonalAgentRunPreference | undefined) => {
    const roleOverrides = { ...draft.roleOverrides };
    if (value) roleOverrides.executor = value;
    else delete roleOverrides.executor;
    return roleOverrides;
  };
  const setMode = (next: HelperMode) => {
    setPicking(next === "chosen" && saved !== "chosen");
    if (next === saved) return;
    if (next === "same")
      change({
        roleOverrides: setHelper(undefined),
        delegateModel: "same_as_assistant",
      });
    else if (next === "each")
      change({
        roleOverrides: setHelper({ ...keep, profileId: "device_default" }),
        delegateModel: "device_default",
      });
  };
  const value: PersonalAgentRunPreference =
    mode === "chosen" && helper ? helper : { profileId: "" };
  const sources = everySource(agentProfiles, devices);
  return (
    <SettingsGroup title={t("settings.models.helpersTitle")}>
      <FieldHint>{t("settings.models.helpersIntro")}</FieldHint>
      <SettingsField label={t("settings.models.helperMode")}>
        <SegmentedControl
          aria-label={t("settings.models.helperMode")}
          value={mode}
          onValueChange={setMode}
          options={(["same", "each", "chosen"] as const).map((option) => ({
            value: option,
            label: t(`settings.models.helperModes.${option}`),
          }))}
        />
      </SettingsField>
      {mode === "chosen" ? (
        <>
          <ChoiceFields
            title={t("settings.models.helpersTitle")}
            value={value}
            sources={sources}
            chooseLabel={t("settings.models.chooseSource")}
            onChange={(patch) => {
              const next = {
                ...keep,
                ...value,
                ...patch,
                deviceId: undefined,
              };
              if (next.profileId) {
                setPicking(false);
                change({ roleOverrides: setHelper(next) });
              }
            }}
          />
          <SettingsField
            label={t("settings.models.whenUnavailable")}
            hint={t("settings.models.whenUnavailableHint")}
          >
            <SelectMenu
              ariaLabel={t("settings.models.whenUnavailable")}
              className="max-w-full min-w-55"
              disabled={!helper || saved !== "chosen"}
              value={helper?.whenUnavailable || "wait"}
              options={(["wait", "device_default"] as const).map((option) => ({
                value: option,
                label: t(`settings.models.whenUnavailableOptions.${option}`),
              }))}
              onChange={(whenUnavailable) =>
                helper &&
                change({
                  roleOverrides: setHelper({
                    ...helper,
                    whenUnavailable:
                      whenUnavailable as PersonalAgentWhenUnavailable,
                  }),
                })
              }
            />
          </SettingsField>
        </>
      ) : (
        <FieldHint>
          {t(
            mode === "same"
              ? "settings.models.helperSameHint"
              : "settings.models.helperEachHint",
          )}
        </FieldHint>
      )}
    </SettingsGroup>
  );
}

/** One model source as the pickers offer it. */
interface Source {
  id: string;
  label: string;
  runtime: AgentProfileProjection["runtime"];
  /** The profile whose model list the model select shows. */
  catalog: AgentProfileProjection;
  meta: string;
  disabled?: boolean;
}

/** The home computer's sources: its sign-ins and the APIs assigned to it. */
function homeSources(
  profiles: AgentProfileProjection[],
  homeId: string | undefined,
): Source[] {
  return profiles
    .filter((profile) => !homeId || profile.deviceId === homeId)
    .map((profile) => ({
      id: profile.id,
      label: profile.label,
      runtime: profile.runtime,
      catalog: profile,
      meta: `${runtimeMeta(profile.runtime).label} · ${i18n.t(
        profile.status === "healthy"
          ? "personalAgent:settings.models.available"
          : "personalAgent:settings.models.unavailable",
      )}`,
    }));
}

/**
 * Sources across the person's computers, one per id: a sign-in has the same
 * id on every computer and a server API is assigned to several, so a helper
 * choice is resolved on each project's own computer.
 */
function everySource(
  profiles: AgentProfileProjection[],
  devices: DeviceProjection[],
): Source[] {
  const own = new Set(devices.map((device) => device.id));
  const byId = new Map<string, AgentProfileProjection[]>();
  for (const profile of profiles) {
    if (!own.has(profile.deviceId)) continue;
    byId.set(profile.id, [...(byId.get(profile.id) ?? []), profile]);
  }
  const online = new Set(
    devices
      .filter((device) => device.status === "connected")
      .map((device) => device.id),
  );
  return [...byId.values()].map((found) => {
    const ready = found.filter((profile) => profile.status === "healthy");
    // The model list comes from a computer that can answer now.
    const catalog =
      ready.find((profile) => online.has(profile.deviceId)) ??
      ready[0] ??
      found[0]!;
    return {
      id: catalog.id,
      label: catalog.label,
      runtime: catalog.runtime,
      catalog,
      meta: `${runtimeMeta(catalog.runtime).label} · ${i18n.t(
        "personalAgent:settings.models.onComputers",
        { count: ready.length, total: devices.length },
      )}`,
    };
  });
}

/** A source, its model and the effort: selection only. */
function ChoiceFields({
  title,
  value,
  sources,
  defaultLabel,
  chooseLabel,
  onChange,
}: {
  title: string;
  value: PersonalAgentRunPreference;
  sources: Source[];
  /** Offered first: the computer's own default; omitted, a source is required. */
  defaultLabel?: string;
  chooseLabel?: string;
  onChange: (patch: Partial<PersonalAgentRunPreference>) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const followsDefault =
    !value.profileId || value.profileId === "device_default";
  const chosen = followsDefault
    ? undefined
    : sources.find((source) => source.id === value.profileId);
  // A computer's default with a runtime named lists that runtime's models.
  const catalog =
    chosen ??
    (followsDefault && value.runtime
      ? sources.find((source) => source.runtime === value.runtime)
      : undefined);
  const { models, loading } = useProfileModels(catalog?.catalog);
  const options: SelectMenuOption[] = [
    ...(defaultLabel ? [{ value: "device_default", label: defaultLabel }] : []),
    ...sources.map((source) => ({
      value: source.id,
      label: source.label,
      meta: source.meta,
    })),
  ];
  if (!followsDefault && !chosen)
    options.push({
      value: value.profileId!,
      label: t("settings.models.missingChoice", { name: value.profileId }),
      disabled: true,
    });
  const modelOptions: SelectMenuOption[] = [
    { value: "", label: t("settings.models.modelDefault") },
    ...models.map((model) => ({ value: model, label: model })),
  ];
  if (value.model && !models.includes(value.model))
    modelOptions.push({
      value: value.model,
      label: t("settings.models.missingChoice", { name: value.model }),
    });
  const runtime = catalog?.runtime ?? value.runtime;
  const efforts =
    runtime === "codex"
      ? codexEffortOptions()
      : runtime === "claude"
        ? claudeEffortOptions()
        : [];
  return (
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
      <SettingsField label={t("settings.models.provider")}>
        <SelectMenu
          ariaLabel={`${title} ${t("settings.models.provider")}`}
          className="w-full max-w-full"
          options={options}
          placeholder={chooseLabel}
          value={
            followsDefault
              ? defaultLabel
                ? "device_default"
                : ""
              : (value.profileId ?? "")
          }
          onChange={(profileId) => {
            const source = sources.find((s) => s.id === profileId);
            onChange({
              profileId,
              runtime: source?.runtime ?? "",
              model: "",
              effort: "",
            });
          }}
        />
      </SettingsField>
      <SettingsField
        label={t("settings.models.model")}
        hint={loading ? t("settings.models.loading") : undefined}
      >
        <SelectMenu
          ariaLabel={`${title} ${t("settings.models.model")}`}
          className="w-full max-w-full"
          disabled={!catalog}
          options={modelOptions}
          value={value.model ?? ""}
          onChange={(model) => onChange({ model })}
        />
      </SettingsField>
      <SettingsField label={t("settings.models.effort")}>
        <SelectMenu
          ariaLabel={`${title} ${t("settings.models.effort")}`}
          className="w-full max-w-full"
          disabled={!catalog}
          options={[
            { value: "", label: t("settings.models.modelDefault") },
            ...efforts,
          ]}
          value={value.effort ?? ""}
          onChange={(effort) => onChange({ effort })}
        />
      </SettingsField>
    </div>
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
          className="max-w-full min-w-55"
          value={value.deviceId ?? ""}
          options={[
            { value: "", label: t("settings.models.targetLocation") },
            ...(value.deviceId && !devices.some((d) => d.id === value.deviceId)
              ? [
                  {
                    value: value.deviceId,
                    label: `${value.deviceId} · ${t("settings.devices.unavailable")}`,
                    disabled: true,
                  },
                ]
              : []),
            ...devices.map((d) => ({
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
      <FieldHint>{t("settings.models.fallbackHint")}</FieldHint>
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
          <div key={index}>
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
    (profile) => !deviceId || profile.deviceId === deviceId,
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
  const { models, loading } = useProfileModels(preview);
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
          className="max-w-full min-w-55"
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
          className="max-w-full min-w-55"
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
          className="max-w-full min-w-55"
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
