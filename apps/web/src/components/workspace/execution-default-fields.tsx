import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  ExecutionDefaultsView,
  ModelPool,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import {
  getExecutionDefault,
  listModelPools,
  setExecutionDefault,
  type ExecutionDefaultInput,
} from "../../api";
import { i18n } from "../../i18n";
import { runtimeMeta } from "../agent-runtime/runtime-mark";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { FieldHint } from "../ui/field";
import { SelectMenu, type SelectMenuOption } from "../ui/select-menu";
import {
  claudeEffortOptions,
  codexEffortOptions,
  effortLabel,
} from "../../lib/agent-effort";
import { useProfileModels } from "./agent-default-fields";
import { providerKindOf } from "../agent-runtime/provider-models";

interface ExecutionSource {
  key: string;
  providerKind: string;
  providerId: string;
  runtime: AgentProfileProjection["runtime"];
  label: string;
  profile?: AgentProfileProjection;
  defaultModel: string;
  models: string[];
  devices: number;
}

function executionSources(
  agentProfiles: AgentProfileProjection[],
  profiles: ProfileDefinition[],
): ExecutionSource[] {
  const grouped = new Map<string, ExecutionSource>();
  const add = (
    providerKind: string,
    providerId: string,
    runtime: string,
    label: string,
    defaultModel: string,
    models: string[],
    profile?: AgentProfileProjection,
  ) => {
    const key = `${providerKind}\u0000${providerId}\u0000${runtime}`;
    const found = grouped.get(key);
    if (found) {
      found.devices += profile ? 1 : 0;
      found.profile ??= profile;
      found.models = [...new Set([...found.models, ...models])];
      return;
    }
    grouped.set(key, {
      key,
      providerKind,
      providerId,
      runtime: runtime as AgentProfileProjection["runtime"],
      label,
      profile,
      defaultModel,
      models,
      devices: profile ? 1 : 0,
    });
  };
  for (const profile of profiles)
    add(
      "api",
      profile.id,
      profile.runtime,
      profile.label,
      profile.model ?? "",
      profile.models ?? [],
    );
  for (const profile of agentProfiles) {
    const providerKind = providerKindOf(profile);
    if (!providerKind) continue;
    const key = `${providerKind}\u0000${profile.id}\u0000${profile.runtime}`;
    add(
      providerKind,
      profile.id,
      profile.runtime,
      profile.label,
      profile.model ?? "",
      profile.models ?? [],
      profile,
    );
    const found = grouped.get(key);
    if (found) found.defaultModel ||= profile.model ?? "";
  }
  return [...grouped.values()].sort(
    (a, b) =>
      a.label.localeCompare(b.label) || a.runtime.localeCompare(b.runtime),
  );
}

function executionEmpty(): ExecutionDefaultInput {
  return {
    providerKind: "",
    providerId: "",
    runtime: "",
    model: "",
    modelPoolId: "",
    effort: "",
  };
}

function executionValue(view: ExecutionDefaultsView): ExecutionDefaultInput {
  const value = view.saved ?? view.effective;
  if (!value || value.scope === "none") return executionEmpty();
  return {
    providerKind: value.providerKind ?? "",
    providerId: value.providerId,
    runtime: value.runtime,
    model: value.model ?? "",
    modelPoolId: value.modelPoolId ?? "",
    effort: value.effort ?? "",
  };
}

/** The orchestrator's worker model, globally or as a workspace override. */
export function ExecutionDefaultFields({
  disabled = false,
  profiles,
  servers = [],
  workspaceId,
  onNotice,
}: {
  disabled?: boolean;
  profiles: AgentProfileProjection[];
  servers?: ProfileDefinition[];
  workspaceId?: string;
  onNotice?: (message: string, tone?: "success" | "error") => void;
}) {
  const { t } = useTranslation("agents");
  const [view, setView] = useState<ExecutionDefaultsView>();
  const [pools, setPools] = useState<ModelPool[]>([]);
  const [draft, setDraft] = useState<ExecutionDefaultInput>(executionEmpty);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const sources = useMemo(
    () => executionSources(profiles, servers),
    [profiles, servers],
  );
  const selected = sources.find(
    (source) =>
      (!draft.providerKind || source.providerKind === draft.providerKind) &&
      source.providerId === draft.providerId &&
      source.runtime === draft.runtime,
  );
  const missing = draft.providerId && !selected;
  const { models, loading } = useProfileModels(selected?.profile);
  const effective = view?.effective;
  const saved = view?.saved;
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify(view ? executionValue(view) : executionEmpty());

  useEffect(() => {
    let active = true;
    setView(undefined);
    setError("");
    getExecutionDefault(workspaceId).then(
      (next) => {
        if (!active) return;
        setView(next);
        setDraft(executionValue(next));
      },
      (reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : i18n.t("executionDefault.loadFailed", { ns: "agents" }),
          );
      },
    );
    listModelPools().then(
      (result) => {
        if (active) setPools(Array.isArray(result) ? result : []);
      },
      () => {
        if (active) setPools([]);
      },
    );
    return () => {
      active = false;
    };
  }, [workspaceId]);

  const providers: SelectMenuOption[] = [
    { value: "", label: t("executionDefault.chooseProvider") },
    ...sources.map((source) => ({
      value: source.key,
      label: source.label,
      meta: [
        runtimeMeta(source.runtime).label,
        source.devices
          ? t("executionDefault.deviceCount", { count: source.devices })
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    })),
  ];
  if (missing)
    providers.push({
      value: selectedKey(draft),
      label: t("executionDefault.missingProvider", {
        name: draft.providerId,
      }),
      disabled: true,
    });

  const modelIds = [
    ...new Set([
      ...(draft.model ? [draft.model] : []),
      ...(selected?.defaultModel ? [selected.defaultModel] : []),
      ...(selected?.models ?? []),
      ...models,
    ]),
  ];
  const selectedPools = pools.filter(
    (pool) =>
      (!selected?.providerKind ||
        pool.providerKind === selected.providerKind) &&
      pool.providerId === selected?.providerId &&
      pool.runtime === selected?.runtime,
  );
  const modelOptions: SelectMenuOption[] = [
    { value: "", label: t("executionDefault.chooseModel") },
    ...selectedPools.map((pool) => ({
      value: `pool:${pool.id}`,
      label: t("executionDefault.poolOption", {
        name: pool.label,
        count: pool.members.length,
      }),
    })),
    ...modelIds.map((model) => ({ value: model, label: model })),
  ];
  if (
    draft.modelPoolId &&
    !selectedPools.some((pool) => pool.id === draft.modelPoolId)
  )
    modelOptions.push({
      value: `pool:${draft.modelPoolId}`,
      label: t("executionDefault.missingPool", {
        name: draft.modelPoolId,
      }),
      disabled: true,
    });
  if (missing && draft.model)
    modelOptions.push({
      value: draft.model,
      label: t("executionDefault.missingModel", { name: draft.model }),
      disabled: true,
    });
  const effortOptions: SelectMenuOption[] = [
    { value: "", label: t("executionDefault.runtimeDefault") },
    ...(draft.runtime === "claude"
      ? claudeEffortOptions()
      : draft.runtime === "codex"
        ? codexEffortOptions()
        : []),
  ];
  const canSave =
    !!draft.providerId &&
    (!!draft.model || !!draft.modelPoolId) &&
    (draft.runtime === "claude" || draft.runtime === "codex");
  const effectiveSource =
    effective?.scope === "workspace"
      ? t("executionDefault.sources.workspace")
      : t("executionDefault.sources.global");
  const effectiveProvider = sources.find(
    (source) =>
      (!effective?.providerKind ||
        source.providerKind === effective.providerKind) &&
      source.providerId === effective?.providerId &&
      source.runtime === effective?.runtime,
  );
  const effectiveProviderLabel = effectiveProvider
    ? effectiveProvider.label
    : t("executionDefault.missingProvider", {
        name: effective?.providerId,
      });

  async function save(next: ExecutionDefaultInput, message: string) {
    setSaving(true);
    setError("");
    try {
      const savedView = await setExecutionDefault(next, workspaceId);
      setView(savedView);
      setDraft(executionValue(savedView));
      onNotice?.(message, "success");
    } catch (reason) {
      const text =
        reason instanceof Error
          ? reason.message
          : t("executionDefault.saveFailed");
      setError(text);
      onNotice?.(text, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid min-w-0 gap-3">
      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
        <label className="grid min-w-0 gap-1.5">
          <span className="text-xs font-semibold">
            {t("executionDefault.provider")}
          </span>
          <SelectMenu
            ariaLabel={t("executionDefault.provider")}
            className="w-full max-w-full"
            disabled={disabled}
            options={providers}
            value={selected ? selected.key : missing ? selectedKey(draft) : ""}
            onChange={(key) => {
              const source = sources.find((candidate) => candidate.key === key);
              setDraft({
                providerKind: source?.providerKind ?? "",
                providerId: source?.providerId ?? "",
                runtime: source?.runtime ?? "",
                model: source?.defaultModel ?? source?.models[0] ?? "",
                modelPoolId: "",
                effort: "",
              });
            }}
          />
        </label>
        <label className="grid min-w-0 gap-1.5">
          <span className="text-xs font-semibold">
            {t("executionDefault.model")}
          </span>
          <SelectMenu
            ariaLabel={t("executionDefault.model")}
            className="w-full max-w-full"
            disabled={disabled || !selected}
            options={modelOptions}
            placeholder={
              loading ? t("executionDefault.loadingModels") : undefined
            }
            value={
              draft.modelPoolId ? `pool:${draft.modelPoolId}` : draft.model
            }
            onChange={(value) =>
              setDraft((current) =>
                value.startsWith("pool:")
                  ? {
                      ...current,
                      model: "",
                      modelPoolId: value.slice("pool:".length),
                    }
                  : { ...current, model: value, modelPoolId: "" },
              )
            }
          />
        </label>
        <label className="grid min-w-0 gap-1.5">
          <span className="text-xs font-semibold">
            {t("executionDefault.effort")}
          </span>
          <SelectMenu
            ariaLabel={t("executionDefault.effort")}
            className="w-full max-w-full"
            disabled={disabled || !selected}
            options={effortOptions}
            value={draft.effort}
            onChange={(effort) =>
              setDraft((current) => ({ ...current, effort }))
            }
          />
        </label>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          busy={saving}
          disabled={disabled || saving || !dirty || !canSave}
          onClick={() =>
            void save(
              draft,
              t(
                workspaceId
                  ? "executionDefault.workspaceSaved"
                  : "executionDefault.globalSaved",
              ),
            )
          }
          size="sm"
          variant="primary"
        >
          {saving
            ? t("executionDefault.saving")
            : workspaceId
              ? t("executionDefault.saveOverride")
              : t("executionDefault.saveGlobal")}
        </Button>
        {saved ? (
          <Button
            disabled={disabled || saving}
            onClick={() =>
              void save(
                executionEmpty(),
                t(
                  workspaceId
                    ? "executionDefault.inheritedSaved"
                    : "executionDefault.globalCleared",
                ),
              )
            }
            size="sm"
            variant="secondary"
          >
            {t(
              workspaceId
                ? "executionDefault.useGlobal"
                : "executionDefault.clearGlobal",
            )}
          </Button>
        ) : null}
        <FieldHint as="span" className="mt-0 min-w-0 flex-1">
          {effective && effective.scope !== "none"
            ? t("executionDefault.effective", {
                source: effectiveSource,
                provider: effectiveProviderLabel,
                model: effective.pool
                  ? t("executionDefault.poolChoice", {
                      name: effective.pool.label,
                      count: effective.pool.members.length,
                    })
                  : effective.model,
                effort: effective.effort
                  ? effortLabel(
                      effective.effort as Parameters<typeof effortLabel>[0],
                    )
                  : t("executionDefault.runtimeDefault"),
              })
            : t("executionDefault.none")}
        </FieldHint>
      </div>
      {error ? <Alert tone="error" size="compact" title={error} /> : null}
    </section>
  );
}

function selectedKey(value: ExecutionDefaultInput): string {
  return `${value.providerKind}\u0000${value.providerId}\u0000${value.runtime}`;
}
