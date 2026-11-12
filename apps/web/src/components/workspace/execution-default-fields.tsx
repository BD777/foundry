import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  ExecutionDefaultsView,
  ProfileDefinition,
  WorkerGroup,
} from "@bd777/foundry-protocol";
import {
  getExecutionDefault,
  listWorkerGroups,
  setExecutionDefault,
  type ExecutionDefaultInput,
  type ExecutionModelChoiceInput,
} from "../../api";
import { i18n } from "../../i18n";
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
import { navigateToWorkerGroups } from "../../lib/in-app-navigation";
import {
  executionSourceMeta,
  executionSources,
  sourceModels,
  type ExecutionSource,
} from "./execution-sources";
import { ModelGuideLink } from "./model-guide-link";

export type ExecutionDefaultValue = Partial<ExecutionModelChoiceInput> & {
  alternatives?: Partial<ExecutionModelChoiceInput>[];
};

type SourceMode = "model" | "group";

interface ChoiceValue {
  choice: ExecutionModelChoiceInput;
  group?: WorkerGroup;
}

interface AlternativeDraft extends ChoiceValue {
  key: string;
  mode: SourceMode;
}

interface ExecutionValue {
  choice: ExecutionModelChoiceInput;
  alternatives: ChoiceValue[];
}

function emptyChoice(): ExecutionModelChoiceInput {
  return {
    providerKind: "",
    providerId: "",
    runtime: "",
    model: "",
    workerGroupId: "",
    effort: "",
  };
}

function emptyExecution(): ExecutionDefaultInput {
  return { ...emptyChoice(), alternatives: [] };
}

export function emptyExecutionModelInput(): ExecutionDefaultInput {
  return emptyExecution();
}

function choiceValue(value?: {
  providerKind?: string;
  providerId?: string;
  runtime?: string;
  model?: string;
  workerGroupId?: string;
  group?: WorkerGroup;
  effort?: string;
}): ChoiceValue {
  return {
    choice: {
      providerKind: value?.providerKind ?? "",
      providerId: value?.providerId ?? "",
      runtime: value?.runtime ?? "",
      model: value?.model ?? "",
      workerGroupId: value?.workerGroupId ?? "",
      effort: value?.effort ?? "",
    },
    group: value?.group,
  };
}

function executionValue(view?: ExecutionDefaultsView): ExecutionValue {
  const value = view?.saved ?? view?.effective;
  if (!value || value.scope === "none")
    return { choice: emptyChoice(), alternatives: [] };
  return {
    choice: choiceValue(value).choice,
    alternatives: (value.alternatives ?? []).map(choiceValue),
  };
}

function executionValueFromInput(
  value?: ExecutionDefaultValue,
): ExecutionValue {
  return {
    choice: choiceValue(value).choice,
    alternatives: (value?.alternatives ?? []).map(choiceValue),
  };
}

function choiceComplete(
  value: ExecutionModelChoiceInput,
  mode: SourceMode,
): boolean {
  return mode === "group"
    ? Boolean(value.workerGroupId)
    : Boolean(
        value.providerId &&
        value.model &&
        (value.runtime === "claude" || value.runtime === "codex"),
      );
}

function choicesComparable(
  choice: ExecutionModelChoiceInput,
  alternatives: ExecutionModelChoiceInput[],
): string {
  return JSON.stringify({ ...choice, alternatives });
}

function choiceFromSource(source?: ExecutionSource): ChoiceValue {
  return choiceValue(
    source
      ? {
          providerKind: source.providerKind,
          providerId: source.providerId,
          runtime: source.runtime,
          model: source.defaultModel || source.models[0] || "",
        }
      : undefined,
  );
}

function ExecutionChoiceFields({
  disabled,
  groups,
  index,
  knownGroup,
  mode,
  onChange,
  onModeChange,
  sources,
  value,
}: {
  disabled: boolean;
  groups: WorkerGroup[];
  index?: number;
  knownGroup?: WorkerGroup;
  mode: SourceMode;
  onChange: (value: ExecutionModelChoiceInput) => void;
  onModeChange: (mode: SourceMode) => void;
  sources: ExecutionSource[];
  value: ExecutionModelChoiceInput;
}) {
  const { t } = useTranslation("agents");
  const selected = sources.find(
    (source) =>
      (!value.providerKind || source.providerKind === value.providerKind) &&
      source.providerId === value.providerId &&
      source.runtime === value.runtime,
  );
  const missing = Boolean(value.providerId && !selected);
  const { models, loading } = useProfileModels(selected?.profile);
  const providers: SelectMenuOption[] = sources.map((source) => ({
    value: source.key,
    label: source.label,
    meta: executionSourceMeta(source),
  }));
  if (missing)
    providers.push({
      value: selectedKey(value),
      label: t("executionDefault.missingProvider", {
        name: value.providerId,
      }),
      disabled: true,
    });

  const modelOptions: SelectMenuOption[] = [
    ...new Set([
      ...(value.model ? [value.model] : []),
      ...(selected ? sourceModels(selected) : []),
      ...models,
    ]),
  ].map((model) => ({ value: model, label: model }));
  if (missing && value.model)
    modelOptions.push({
      value: value.model,
      label: t("executionDefault.missingModel", { name: value.model }),
      disabled: true,
    });

  const groupOptions: SelectMenuOption[] = groups.map((group) => ({
    value: group.id,
    label: group.label,
    meta: t("executionDefault.groupMembers", { count: group.members.length }),
  }));
  const foundGroup = groups.find((group) => group.id === value.workerGroupId);
  if (
    value.workerGroupId &&
    !foundGroup &&
    knownGroup?.id === value.workerGroupId
  )
    groupOptions.push({
      value: knownGroup.id,
      label: knownGroup.label,
      meta: t("executionDefault.groupMembers", {
        count: knownGroup.members.length,
      }),
    });
  else if (
    value.workerGroupId &&
    !foundGroup &&
    knownGroup?.id !== value.workerGroupId
  )
    groupOptions.push({
      value: value.workerGroupId,
      label: t("executionDefault.missingGroup", {
        name: value.workerGroupId,
      }),
      disabled: true,
    });

  const modeOptions: SelectMenuOption[] = [
    { value: "model", label: t("executionDefault.modeModel") },
    { value: "group", label: t("executionDefault.modeGroup") },
  ];
  const effortOptions: SelectMenuOption[] = [
    { value: "", label: t("executionDefault.runtimeDefault") },
    ...(value.runtime === "claude"
      ? claudeEffortOptions()
      : value.runtime === "codex"
        ? codexEffortOptions()
        : []),
  ];
  const field = "grid min-w-0 gap-1.5";
  const fieldLabels: Record<
    "mode" | "group" | "provider" | "model" | "effort",
    string
  > = {
    mode: t("executionDefault.mode"),
    group: t("executionDefault.group"),
    provider: t("executionDefault.provider"),
    model: t("executionDefault.model"),
    effort: t("executionDefault.effort"),
  };
  const label = (name: keyof typeof fieldLabels) =>
    index
      ? t("executionDefault.alternativeField", {
          field: fieldLabels[name],
          index,
        })
      : fieldLabels[name];

  return (
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-3">
      <label className={field}>
        <span className="text-xs font-semibold">
          {t("executionDefault.mode")}
        </span>
        <SelectMenu
          ariaLabel={label("mode")}
          className="w-full max-w-full"
          disabled={disabled}
          options={modeOptions}
          value={mode}
          onChange={(nextMode) => {
            onModeChange(nextMode as SourceMode);
          }}
        />
      </label>
      {mode === "group" ? (
        <label className={field}>
          <span className="text-xs font-semibold">
            {t("executionDefault.group")}
          </span>
          <SelectMenu
            ariaLabel={label("group")}
            className="w-full max-w-full"
            disabled={disabled}
            options={groupOptions}
            placeholder={t("executionDefault.groupPlaceholder")}
            value={value.workerGroupId}
            onChange={(workerGroupId) =>
              onChange({ ...emptyChoice(), workerGroupId })
            }
          />
        </label>
      ) : (
        <>
          <label className={field}>
            <span className="text-xs font-semibold">
              {t("executionDefault.provider")}
            </span>
            <SelectMenu
              ariaLabel={label("provider")}
              className="w-full max-w-full"
              disabled={disabled}
              options={providers}
              placeholder={t("executionDefault.providerPlaceholder")}
              value={
                selected ? selected.key : missing ? selectedKey(value) : ""
              }
              onChange={(key) => {
                const source = sources.find(
                  (candidate) => candidate.key === key,
                );
                onChange(choiceFromSource(source).choice);
              }}
            />
          </label>
          <label className={field}>
            <span className="text-xs font-semibold">
              {t("executionDefault.model")}
            </span>
            <SelectMenu
              ariaLabel={label("model")}
              className="w-full max-w-full"
              disabled={disabled || !selected}
              options={modelOptions}
              placeholder={
                loading
                  ? t("executionDefault.loadingModels")
                  : t("executionDefault.modelPlaceholder")
              }
              value={value.model}
              onChange={(model) => onChange({ ...value, model })}
            />
          </label>
          <label className={field}>
            <span className="text-xs font-semibold">
              {t("executionDefault.effort")}
            </span>
            <SelectMenu
              ariaLabel={label("effort")}
              className="w-full max-w-full"
              disabled={disabled || !selected}
              options={effortOptions}
              value={value.effort}
              onChange={(effort) => onChange({ ...value, effort })}
            />
          </label>
        </>
      )}
    </div>
  );
}

/**
 * The orchestrator's default worker model and alternatives, globally, in a
 * workspace, or as controlled assistant settings.
 */
export function ExecutionDefaultFields({
  value: controlledValue,
  onChange,
  onClear,
  disabled = false,
  profiles,
  servers = [],
  workspaceId,
  onNotice,
}: {
  /** Controlled value: edit it in the surrounding settings form. */
  value?: ExecutionDefaultValue;
  onChange?: (value: ExecutionDefaultInput) => void;
  onClear?: () => void;
  disabled?: boolean;
  profiles: AgentProfileProjection[];
  servers?: ProfileDefinition[];
  workspaceId?: string;
  onNotice?: (message: string, tone?: "success" | "error") => void;
}) {
  const { t } = useTranslation("agents");
  const [view, setView] = useState<ExecutionDefaultsView>();
  const [groups, setGroups] = useState<WorkerGroup[]>([]);
  const [mode, setMode] = useState<SourceMode>("model");
  const [draft, setDraft] = useState<ExecutionModelChoiceInput>(emptyChoice);
  const [alternatives, setAlternatives] = useState<AlternativeDraft[]>([]);
  const [editingInheritedAlternatives, setEditingInheritedAlternatives] =
    useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const alternativeKey = useRef(0);
  const controlled = onChange !== undefined;
  const controlledSnapshot = JSON.stringify(
    executionValueFromInput(controlledValue),
  );
  const sources = useMemo(
    () => executionSources(profiles, servers),
    [profiles, servers],
  );
  const effective = view?.effective;
  const saved = view?.saved;
  const loadedValue = executionValue(view);
  const inheriting = Boolean(view && workspaceId && !saved);
  const alternativesEditable = !inheriting || editingInheritedAlternatives;
  const dirty =
    choicesComparable(
      draft,
      alternatives.map((alternative) => alternative.choice),
    ) !==
    choicesComparable(
      loadedValue.choice,
      loadedValue.alternatives.map((alternative) => alternative.choice),
    );
  const canSave =
    choiceComplete(draft, mode) &&
    alternatives.every((alternative) =>
      choiceComplete(alternative.choice, alternative.mode),
    );

  function makeAlternative(
    alternative: ChoiceValue,
    alternativeMode: SourceMode,
  ): AlternativeDraft {
    return {
      ...alternative,
      key: `execution-alternative-${alternativeKey.current++}`,
      mode: alternativeMode,
    };
  }

  function setLoadedExecution(nextValue: ExecutionValue) {
    setDraft(nextValue.choice);
    setAlternatives(
      nextValue.alternatives.map((alternative) =>
        makeAlternative(
          alternative,
          alternative.choice.workerGroupId ? "group" : "model",
        ),
      ),
    );
    setMode(nextValue.choice.workerGroupId ? "group" : "model");
    setEditingInheritedAlternatives(false);
  }

  function setLoadedValue(next: ExecutionDefaultsView) {
    setView(next);
    setLoadedExecution(executionValue(next));
  }

  function notifyControlled(
    choice: ExecutionModelChoiceInput,
    items: AlternativeDraft[],
  ) {
    onChange?.({
      ...choice,
      alternatives: items.map((alternative) => alternative.choice),
    });
  }

  function updateDraft(next: ExecutionModelChoiceInput) {
    setDraft(next);
    if (controlled) notifyControlled(next, alternatives);
  }

  function replaceAlternative(index: number, next: AlternativeDraft) {
    const items = alternatives.map((item, at) => (at === index ? next : item));
    setAlternatives(items);
    if (controlled) notifyControlled(draft, items);
  }

  function removeAlternative(index: number) {
    const items = alternatives.filter((_, at) => at !== index);
    setAlternatives(items);
    if (controlled) notifyControlled(draft, items);
  }

  function addAlternative() {
    const items = [
      ...alternatives,
      makeAlternative(choiceFromSource(sources[0]), "model"),
    ];
    setAlternatives(items);
    if (controlled) notifyControlled(draft, items);
  }

  useEffect(() => {
    let active = true;
    setError("");
    if (!controlled) {
      setView(undefined);
      getExecutionDefault(workspaceId).then(
        (next) => {
          if (!active) return;
          setLoadedValue(next);
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
    }
    listWorkerGroups().then(
      (result) => {
        if (active) setGroups(Array.isArray(result) ? result : []);
      },
      () => {
        if (active) setGroups([]);
      },
    );
    return () => {
      active = false;
    };
  }, [controlled, workspaceId]);

  useEffect(() => {
    if (!controlled) return;
    setLoadedExecution(executionValueFromInput(controlledValue));
  }, [controlled, controlledSnapshot]);

  const effectiveSource =
    effective?.scope === "assistant"
      ? t("executionDefault.sources.assistant")
      : effective?.scope === "workspace"
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
  const effectiveLabel =
    effective && effective.scope !== "none"
      ? effective.group
        ? t("executionDefault.effectiveGroup", {
            source: effectiveSource,
            name: effective.group.label,
            count: effective.group.members.length,
          })
        : effective.workerGroupId
          ? t("executionDefault.missingGroup", {
              name: effective.workerGroupId,
            })
          : t("executionDefault.effective", {
              source: effectiveSource,
              provider: effectiveProviderLabel,
              model: effective.model,
              effort: effective.effort
                ? effortLabel(
                    effective.effort as Parameters<typeof effortLabel>[0],
                  )
                : t("executionDefault.runtimeDefault"),
            })
      : t("executionDefault.none");
  const effectiveSummary = `${effectiveLabel} · ${t(
    "executionDefault.alternativeCount",
    { count: effective?.alternatives?.length ?? 0 },
  )}`;
  const alternativeSummary = (alternative: ChoiceValue) =>
    alternative.choice.workerGroupId
      ? t("executionDefault.summaryGroup", {
          name: alternative.group?.label ?? alternative.choice.workerGroupId,
        })
      : t("executionDefault.summaryModel", {
          provider:
            sources.find(
              (source) =>
                (!alternative.choice.providerKind ||
                  source.providerKind === alternative.choice.providerKind) &&
                source.providerId === alternative.choice.providerId &&
                source.runtime === alternative.choice.runtime,
            )?.label ??
            t("executionDefault.missingProvider", {
              name: alternative.choice.providerId,
            }),
          model: alternative.choice.model,
          effort: alternative.choice.effort
            ? effortLabel(
                alternative.choice.effort as Parameters<typeof effortLabel>[0],
              )
            : t("executionDefault.runtimeDefault"),
        });

  async function save(next: ExecutionDefaultInput, message: string) {
    setSaving(true);
    setError("");
    try {
      const savedView = await setExecutionDefault(next, workspaceId);
      setLoadedValue(savedView);
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
      <ExecutionChoiceFields
        disabled={disabled}
        groups={groups}
        knownGroup={saved?.group ?? effective?.group}
        mode={mode}
        onChange={updateDraft}
        onModeChange={(nextMode) => {
          setMode(nextMode);
          updateDraft(emptyChoice());
        }}
        sources={sources}
        value={draft}
      />
      <div className="grid min-w-0 gap-2 border-t border-line-soft pt-3">
        <span className="text-sm font-semibold">
          {t("executionDefault.alternativesTitle")}
        </span>
        {inheriting ? (
          <FieldHint className="mt-0">
            {t("executionDefault.alternativesInherited")}
          </FieldHint>
        ) : null}
        {inheriting && !editingInheritedAlternatives ? (
          alternatives.length ? (
            <>
              <ul className="grid min-w-0 gap-2">
                {alternatives.map((alternative) => (
                  <li
                    className="text-sm leading-[1.55] text-ink"
                    key={alternative.key}
                  >
                    {alternativeSummary(alternative)}
                  </li>
                ))}
              </ul>
              <Button
                className="justify-self-start"
                disabled={disabled}
                onClick={() => {
                  setEditingInheritedAlternatives(true);
                  addAlternative();
                }}
                size="sm"
                variant="ghost"
              >
                <Plus aria-hidden size={14} />
                {t("executionDefault.addAlternative")}
              </Button>
            </>
          ) : (
            <>
              <FieldHint className="mt-0">
                {t("executionDefault.alternativesEmpty")}
              </FieldHint>
              <Button
                className="justify-self-start"
                disabled={disabled}
                onClick={() => {
                  setEditingInheritedAlternatives(true);
                  addAlternative();
                }}
                size="sm"
                variant="ghost"
              >
                <Plus aria-hidden size={14} />
                {t("executionDefault.addAlternative")}
              </Button>
            </>
          )
        ) : (
          <>
            <ul className="grid min-w-0 gap-3">
              {alternatives.length ? (
                alternatives.map((alternative, index) => (
                  <li
                    className="grid min-w-0 gap-2 border-t border-line-soft pt-3"
                    key={alternative.key}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="text-2xs font-semibold text-ink-muted">
                        {t("executionDefault.alternativeNumber", {
                          index: index + 1,
                        })}
                      </span>
                      <Button
                        aria-label={t("executionDefault.removeAlternative", {
                          index: index + 1,
                        })}
                        disabled={disabled || !alternativesEditable}
                        onClick={() => removeAlternative(index)}
                        size="sm"
                        variant="ghost"
                      >
                        <Trash2 aria-hidden size={14} />
                      </Button>
                    </div>
                    <ExecutionChoiceFields
                      disabled={disabled || !alternativesEditable}
                      groups={groups}
                      index={index + 1}
                      knownGroup={alternative.group}
                      mode={alternative.mode}
                      onChange={(nextChoice) =>
                        replaceAlternative(index, {
                          ...alternative,
                          choice: nextChoice,
                        })
                      }
                      onModeChange={(nextMode) =>
                        replaceAlternative(index, {
                          ...alternative,
                          mode: nextMode,
                          choice: emptyChoice(),
                        })
                      }
                      sources={sources}
                      value={alternative.choice}
                    />
                  </li>
                ))
              ) : (
                <li>
                  <FieldHint className="mt-0">
                    {t("executionDefault.alternativesEmpty")}
                  </FieldHint>
                </li>
              )}
            </ul>
            <Button
              className="justify-self-start"
              disabled={disabled || !alternativesEditable}
              onClick={addAlternative}
              size="sm"
              variant="ghost"
            >
              <Plus aria-hidden size={14} />
              {t("executionDefault.addAlternative")}
            </Button>
          </>
        )}
      </div>
      {controlled ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            disabled={disabled || !onClear}
            onClick={onClear}
            size="sm"
            variant="secondary"
          >
            {t("executionDefault.useAssistantInherited")}
          </Button>
          <FieldHint as="span" className="mt-0 min-w-0 flex-1">
            {t("executionDefault.assistantControlled")}
          </FieldHint>
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            busy={saving}
            disabled={disabled || saving || !dirty || !canSave}
            onClick={() =>
              void save(
                {
                  ...draft,
                  alternatives: alternatives.map(
                    (alternative) => alternative.choice,
                  ),
                },
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
                  emptyExecution(),
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
            {effectiveSummary}
          </FieldHint>
        </div>
      )}
      <FieldHint>{t("executionDefault.explicitHint")}</FieldHint>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <ModelGuideLink
          {...(mode === "group" ? {} : draft)}
          group={
            mode === "group"
              ? (groups.find((group) => group.id === draft.workerGroupId) ??
                (saved?.group?.id === draft.workerGroupId
                  ? saved.group
                  : effective?.group?.id === draft.workerGroupId
                    ? effective.group
                    : undefined))
              : undefined
          }
        />
        <Button size="sm" variant="link" onClick={navigateToWorkerGroups}>
          {t("executionDefault.manageGroups")}
          <ChevronRight aria-hidden size={13} />
        </Button>
      </div>
      {error ? <Alert tone="error" size="compact" title={error} /> : null}
    </section>
  );
}

function selectedKey(value: ExecutionModelChoiceInput): string {
  return `${value.providerKind}\u0000${value.providerId}\u0000${value.runtime}`;
}
