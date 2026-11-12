import { ChevronRight, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  ProfileDefinition,
  WorkerGroup,
  WorkerGroupInput,
  WorkerGroupMember,
} from "@bd777/foundry-protocol";
import {
  createWorkerGroup,
  deleteWorkerGroup,
  listWorkerGroups,
  updateWorkerGroup,
} from "../../api";
import { Alert } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { FieldHint, TextInput } from "../../components/ui/field";
import { SectionHeader } from "../../components/ui/page-header";
import { SectionPanel } from "../../components/ui/section-panel";
import {
  SelectMenu,
  type SelectMenuOption,
} from "../../components/ui/select-menu";
import { MutedText } from "../../components/ui/text";
import {
  executionSourceMeta,
  executionSources,
  sourceModels,
  type ExecutionSource,
} from "../../components/workspace/execution-sources";
import {
  claudeEffortOptions,
  codexEffortOptions,
} from "../../lib/agent-effort";

interface MemberDraft {
  providerKind: string;
  providerId: string;
  runtime: string;
  model: string;
  effort: string;
  tokensPerMinute: string;
  weight: string;
}

interface GroupDraft {
  id?: string;
  label: string;
  members: MemberDraft[];
}

const sourceKey = (member: {
  providerKind: string;
  providerId: string;
  runtime: string;
}) => `${member.providerKind}\u0000${member.providerId}\u0000${member.runtime}`;

function hasQuota(tokensPerMinute: string | number | undefined) {
  const quota = Number(tokensPerMinute ?? "");
  return Number.isFinite(quota) && quota > 0;
}

function memberFromSource(source?: ExecutionSource): MemberDraft {
  return {
    providerKind: source?.providerKind ?? "",
    providerId: source?.providerId ?? "",
    runtime: source?.runtime ?? "",
    model: source ? (sourceModels(source)[0] ?? "") : "",
    effort: "",
    tokensPerMinute: "",
    weight: "1",
  };
}

function draftFor(
  group: WorkerGroup | undefined,
  first?: ExecutionSource,
): GroupDraft {
  if (!group) return { label: "", members: [memberFromSource(first)] };
  return {
    id: group.id,
    label: group.label,
    members: group.members.map((member) => ({
      providerKind: member.providerKind,
      providerId: member.providerId,
      runtime: member.runtime,
      model: member.model,
      effort: member.effort ?? "",
      tokensPerMinute: member.tokensPerMinute
        ? String(member.tokensPerMinute)
        : "",
      weight: String(member.weight || 1),
    })),
  };
}

function inputFor(draft: GroupDraft): WorkerGroupInput | undefined {
  if (!draft.label.trim() || draft.members.length === 0) return undefined;
  const seen = new Set<string>();
  const members: WorkerGroupMember[] = [];
  for (const member of draft.members) {
    const model = member.model.trim();
    const tokensPerMinute = member.tokensPerMinute.trim()
      ? Number(member.tokensPerMinute)
      : undefined;
    const weight = Number(member.weight || "1");
    const identity = `${sourceKey(member)}\u0000${model}`;
    if (
      !member.providerId ||
      !model ||
      seen.has(identity) ||
      (tokensPerMinute !== undefined &&
        (!Number.isFinite(tokensPerMinute) || tokensPerMinute < 0)) ||
      !Number.isInteger(weight) ||
      weight < 1
    )
      return undefined;
    seen.add(identity);
    members.push({
      providerKind: member.providerKind as WorkerGroupMember["providerKind"],
      providerId: member.providerId,
      runtime: member.runtime as WorkerGroupMember["runtime"],
      model,
      ...(member.effort ? { effort: member.effort } : {}),
      ...(tokensPerMinute ? { tokensPerMinute } : {}),
      weight,
    });
  }
  return { label: draft.label.trim(), members };
}

/**
 * The person's worker groups: named sets of models, each from any provider,
 * that new workers are assigned from. Lists the groups and edits one in place.
 */
export function WorkerGroupsSection({
  profiles,
  servers,
  onNotice,
}: {
  profiles: AgentProfileProjection[];
  servers: ProfileDefinition[];
  onNotice?: (message: string, tone?: "success" | "error") => void;
}) {
  const { t } = useTranslation("profiles");
  const sources = useMemo(
    () => executionSources(profiles, servers),
    [profiles, servers],
  );
  const [groups, setGroups] = useState<WorkerGroup[]>();
  const [draft, setDraft] = useState<GroupDraft>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const input = draft ? inputFor(draft) : undefined;
  const byQuota =
    draft?.members.some((member) => hasQuota(member.tokensPerMinute)) ?? false;

  useEffect(() => {
    let active = true;
    listWorkerGroups().then(
      (result) => {
        if (active) setGroups(Array.isArray(result) ? result : []);
      },
      (reason: unknown) => {
        if (!active) return;
        setGroups([]);
        setError(
          reason instanceof Error
            ? reason.message
            : t("workerGroups.loadFailed"),
        );
      },
    );
    return () => {
      active = false;
    };
  }, [t]);

  function updateMember(index: number, patch: Partial<MemberDraft>) {
    setDraft(
      (current) =>
        current && {
          ...current,
          members: current.members.map((member, at) =>
            at === index ? { ...member, ...patch } : member,
          ),
        },
    );
  }

  async function save() {
    if (!draft || !input) return;
    setSaving(true);
    setError("");
    try {
      const saved = draft.id
        ? await updateWorkerGroup(draft.id, input)
        : await createWorkerGroup(input);
      setGroups((current = []) =>
        current.some((group) => group.id === saved.id)
          ? current.map((group) => (group.id === saved.id ? saved : group))
          : [...current, saved],
      );
      setDraft(undefined);
      onNotice?.(t("workerGroups.saved", { name: saved.label }), "success");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("workerGroups.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function remove(group: WorkerGroup) {
    setSaving(true);
    setError("");
    try {
      await deleteWorkerGroup(group.id);
      setGroups((current = []) =>
        current.filter((item) => item.id !== group.id),
      );
      setDraft(undefined);
      onNotice?.(t("workerGroups.deleted", { name: group.label }), "success");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("workerGroups.deleteFailed"),
      );
    } finally {
      setSaving(false);
    }
  }

  const providerOptions = (member: MemberDraft): SelectMenuOption[] => {
    const options: SelectMenuOption[] = sources.map((source) => ({
      value: source.key,
      label: source.label,
      meta: executionSourceMeta(source),
    }));
    if (member.providerId && !sources.some((s) => s.key === sourceKey(member)))
      options.push({
        value: sourceKey(member),
        label: t("workerGroups.missingProvider", { name: member.providerId }),
        disabled: true,
      });
    return options;
  };
  const modelOptions = (member: MemberDraft): SelectMenuOption[] => {
    const source = sources.find((item) => item.key === sourceKey(member));
    return [...new Set([...(source ? sourceModels(source) : []), member.model])]
      .filter(Boolean)
      .map((model) => ({ value: model, label: model }));
  };
  const effortOptions = (member: MemberDraft): SelectMenuOption[] => [
    { value: "", label: t("workerGroups.runtimeDefault") },
    ...(member.runtime === "claude"
      ? claudeEffortOptions()
      : member.runtime === "codex"
        ? codexEffortOptions()
        : []),
  ];

  return (
    <SectionPanel aria-label={t("workerGroups.title")} id="worker-groups">
      <SectionHeader
        level={3}
        title={t("workerGroups.title")}
        description={t("workerGroups.intro")}
        actions={
          draft ? null : (
            <Button
              onClick={() => {
                setError("");
                setDraft(draftFor(undefined, sources[0]));
              }}
              size="sm"
              variant="secondary"
            >
              <Plus aria-hidden size={14} />
              {t("workerGroups.new")}
            </Button>
          )
        }
      />
      <FieldHint>{t("workerGroups.pairingHint")}</FieldHint>
      {error ? <Alert tone="error" size="compact" title={error} /> : null}
      {draft ? (
        <div className="grid min-w-0 gap-4">
          <label className="grid min-w-0 gap-1.5">
            <span className="text-xs font-semibold">
              {t("workerGroups.name")}
            </span>
            <TextInput
              aria-label={t("workerGroups.name")}
              onChange={(event) => {
                const label = event.currentTarget.value;
                setDraft((current) => current && { ...current, label });
              }}
              placeholder={t("workerGroups.namePlaceholder")}
              tone="boxed"
              value={draft.label}
            />
          </label>
          <div className="grid min-w-0 gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold">
                {t("workerGroups.members")}
              </span>
              <Button
                onClick={() =>
                  setDraft(
                    (current) =>
                      current && {
                        ...current,
                        members: [
                          ...current.members,
                          memberFromSource(sources[0]),
                        ],
                      },
                  )
                }
                size="sm"
                variant="ghost"
              >
                <Plus aria-hidden size={14} />
                {t("workerGroups.addMember")}
              </Button>
            </div>
            <ul className="@container/members grid min-w-0 gap-3">
              {draft.members.map((member, index) => (
                <li
                  className="grid min-w-0 grid-cols-2 items-end gap-2 border-t @[480px]/members:grid-cols-6 @[900px]/members:grid-cols-[minmax(0,1.5fr)_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.6fr)_auto] border-line-soft pt-3"
                  key={index}
                >
                  <label className="grid min-w-0 gap-1 col-span-2 @[480px]/members:col-span-3 @[900px]/members:col-span-1">
                    <span className="text-2xs text-ink-muted">
                      {t("workerGroups.provider")}
                    </span>
                    <SelectMenu
                      ariaLabel={t("workerGroups.providerLabel", {
                        index: index + 1,
                      })}
                      className="w-full max-w-full"
                      options={providerOptions(member)}
                      placeholder={t("workerGroups.providerPlaceholder")}
                      value={sourceKey(member)}
                      onChange={(key) => {
                        const source = sources.find((item) => item.key === key);
                        if (source)
                          updateMember(index, {
                            ...memberFromSource(source),
                            tokensPerMinute: member.tokensPerMinute,
                            weight: member.weight,
                          });
                      }}
                    />
                  </label>
                  <label className="grid min-w-0 gap-1 col-span-2 @[480px]/members:col-span-3 @[900px]/members:col-span-1">
                    <span className="text-2xs text-ink-muted">
                      {t("workerGroups.model")}
                    </span>
                    <SelectMenu
                      ariaLabel={t("workerGroups.modelLabel", {
                        index: index + 1,
                      })}
                      className="w-full max-w-full"
                      disabled={!member.providerId}
                      options={modelOptions(member)}
                      placeholder={t("workerGroups.modelPlaceholder")}
                      value={member.model}
                      onChange={(model) => updateMember(index, { model })}
                    />
                  </label>
                  <label className="grid min-w-0 gap-1 @[480px]/members:col-span-2 @[900px]/members:col-span-1">
                    <span className="text-2xs text-ink-muted">
                      {t("workerGroups.effort")}
                    </span>
                    <SelectMenu
                      ariaLabel={t("workerGroups.effortLabel", {
                        index: index + 1,
                      })}
                      className="w-full max-w-full"
                      disabled={!member.providerId}
                      options={effortOptions(member)}
                      value={member.effort}
                      onChange={(effort) => updateMember(index, { effort })}
                    />
                  </label>
                  <label className="grid min-w-0 gap-1 @[480px]/members:col-span-2 @[900px]/members:col-span-1">
                    <span className="text-2xs text-ink-muted">
                      {t("workerGroups.tpm")}
                    </span>
                    <TextInput
                      aria-label={t("workerGroups.tpmLabel", {
                        index: index + 1,
                      })}
                      inputMode="numeric"
                      min="0"
                      onChange={(event) =>
                        updateMember(index, {
                          tokensPerMinute: event.currentTarget.value,
                        })
                      }
                      placeholder={t("workerGroups.tpmPlaceholder")}
                      tone="boxed"
                      type="number"
                      value={member.tokensPerMinute}
                    />
                  </label>
                  <label className="grid min-w-0 gap-1 @[900px]/members:col-span-1">
                    <span className="text-2xs text-ink-muted">
                      {t("workerGroups.weight")}
                    </span>
                    <TextInput
                      aria-describedby={
                        byQuota ? "worker-group-mode-hint" : undefined
                      }
                      aria-label={t("workerGroups.weightLabel", {
                        index: index + 1,
                      })}
                      disabled={byQuota}
                      inputMode="numeric"
                      min="1"
                      onChange={(event) =>
                        updateMember(index, {
                          weight: event.currentTarget.value,
                        })
                      }
                      tone="boxed"
                      type="number"
                      value={member.weight}
                    />
                  </label>
                  <Button
                    aria-label={t("workerGroups.removeMember", {
                      index: index + 1,
                    })}
                    className="justify-self-end @[900px]/members:col-span-1"
                    disabled={draft.members.length === 1}
                    onClick={() =>
                      setDraft(
                        (current) =>
                          current && {
                            ...current,
                            members: current.members.filter(
                              (_, at) => at !== index,
                            ),
                          },
                      )
                    }
                    size="sm"
                    variant="ghost"
                  >
                    <X aria-hidden size={14} />
                  </Button>
                  {byQuota && !hasQuota(member.tokensPerMinute) ? (
                    <FieldHint
                      className="col-span-2 mt-0 @[480px]/members:col-span-6"
                      role="status"
                      tone="warning"
                    >
                      {t("workerGroups.memberWithoutQuota")}
                    </FieldHint>
                  ) : null}
                </li>
              ))}
            </ul>
            <FieldHint id="worker-group-mode-hint">
              {t(
                byQuota
                  ? "workerGroups.memberHintByQuota"
                  : "workerGroups.memberHintByWeight",
              )}
            </FieldHint>
          </div>
          <div className="flex items-center justify-end gap-2">
            {draft.id ? (
              <ConfirmButton
                className="mr-auto"
                confirmLabel={t("workerGroups.deleteConfirm")}
                disabled={saving}
                onConfirm={() => {
                  const group = groups?.find((item) => item.id === draft.id);
                  if (group) void remove(group);
                }}
                size="sm"
                variant="ghost"
              >
                <Trash2 aria-hidden size={14} />
                {t("workerGroups.delete")}
              </ConfirmButton>
            ) : null}
            <Button
              disabled={saving}
              onClick={() => setDraft(undefined)}
              size="sm"
              variant="secondary"
            >
              {t("workerGroups.cancel")}
            </Button>
            <Button
              busy={saving}
              disabled={!input}
              onClick={() => void save()}
              size="sm"
              variant="primary"
            >
              {t("workerGroups.save")}
            </Button>
          </div>
        </div>
      ) : groups?.length ? (
        <ul className="grid min-w-0 gap-1">
          {groups.map((group) => (
            <li className="min-w-0" key={group.id}>
              <Button
                aria-label={t("workerGroups.edit", { name: group.label })}
                className="w-full justify-between"
                onClick={() => {
                  setError("");
                  setDraft(draftFor(group));
                }}
                size="sm"
                variant="ghost"
              >
                <span className="min-w-0 truncate font-semibold">
                  {group.label}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-ink-muted">
                  <Badge dot={false} size="xs" tone="neutral">
                    {t(
                      group.members.some((member) =>
                        hasQuota(member.tokensPerMinute),
                      )
                        ? "workerGroups.modeByQuota"
                        : "workerGroups.modeByWeight",
                    )}
                  </Badge>
                  <span className="truncate">
                    {t("workerGroups.memberCount", {
                      count: group.members.length,
                    })}
                  </span>
                  <ChevronRight aria-hidden size={14} />
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : groups ? (
        <MutedText>{t("workerGroups.empty")}</MutedText>
      ) : null}
    </SectionPanel>
  );
}
