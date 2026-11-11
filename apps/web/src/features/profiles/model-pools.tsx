import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  ModelPool,
  ModelPoolInput,
  ModelPoolMember,
  ProfileDefinition,
} from "@bd777/foundry-protocol";
import {
  createModelPool,
  deleteModelPool,
  listModelPools,
  updateModelPool,
} from "../../api";
import { i18n } from "../../i18n";
import { runtimeMeta } from "../../components/agent-runtime/runtime-mark";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { ConfirmButton } from "../../components/ui/confirm-button";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint, TextInput } from "../../components/ui/field";
import { SectionHeader } from "../../components/ui/page-header";
import { SelectMenu } from "../../components/ui/select-menu";
import {
  providerModelGroups,
  type ProviderKind,
  type ProviderModelGroup,
} from "../../components/agent-runtime/provider-models";

interface MemberDraft {
  model: string;
  tokensPerMinute: string;
  weight: string;
}

interface PoolDraft {
  id?: string;
  providerKey: string;
  label: string;
  members: MemberDraft[];
}

const emptyMember = (): MemberDraft => ({
  model: "",
  tokensPerMinute: "",
  weight: "1",
});

function memberDraft(pool: ModelPool, provider: ProviderModelGroup): PoolDraft {
  return {
    id: pool.id,
    providerKey: provider.key,
    label: pool.label,
    members: pool.members.map((member) => ({
      model: member.model,
      tokensPerMinute:
        member.tokensPerMinute && member.tokensPerMinute > 0
          ? String(member.tokensPerMinute)
          : "",
      weight: String(member.weight || 1),
    })),
  };
}

function membersInput(members: MemberDraft[]): ModelPoolMember[] {
  return members.map((member) => ({
    model: member.model.trim(),
    tokensPerMinute: member.tokensPerMinute.trim()
      ? Number(member.tokensPerMinute)
      : undefined,
    weight: Number(member.weight || "1"),
  }));
}

function inputFor(
  draft: PoolDraft,
  providers: ProviderModelGroup[],
): ModelPoolInput | undefined {
  const provider = providers.find((item) => item.key === draft.providerKey);
  if (!provider || !draft.label.trim() || draft.members.length === 0)
    return undefined;
  const members = membersInput(draft.members);
  const names = new Set<string>();
  for (const member of members) {
    if (
      !member.model ||
      names.has(member.model) ||
      (member.tokensPerMinute !== undefined &&
        (!Number.isFinite(member.tokensPerMinute) ||
          member.tokensPerMinute < 0)) ||
      !Number.isInteger(member.weight) ||
      (member.weight ?? 0) < 1
    )
      return undefined;
    names.add(member.model);
  }
  return {
    providerKind: provider.kind,
    providerId: provider.models[0]?.providerId ?? "",
    runtime: provider.runtime,
    label: draft.label.trim(),
    members,
  };
}

/** Equivalent model ids grouped under their provider, with editable quota weights. */
export function ModelPoolsSection({
  profiles,
  agentProfiles,
  kinds,
  runtimes,
  onNotice,
}: {
  profiles: ProfileDefinition[];
  agentProfiles: AgentProfileProjection[];
  kinds: readonly ProviderKind[];
  runtimes: readonly string[];
  onNotice?: (message: string, tone?: "success" | "error") => void;
}) {
  const { t } = useTranslation("profiles");
  const providers = useMemo(
    () => providerModelGroups(profiles, agentProfiles, kinds, runtimes),
    [profiles, agentProfiles, kinds, runtimes],
  );
  const [pools, setPools] = useState<ModelPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<PoolDraft>();

  useEffect(() => {
    let active = true;
    listModelPools().then(
      (result) => {
        if (!active) return;
        setPools(Array.isArray(result) ? result : []);
        setLoading(false);
      },
      (reason) => {
        if (!active) return;
        setError(
          reason instanceof Error
            ? reason.message
            : i18n.t("modelPools.loadFailed", { ns: "profiles" }),
        );
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const visibleProviders = providers.filter(
    (provider) =>
      pools.some(
        (pool) =>
          pool.providerKind === provider.kind &&
          pool.providerId === provider.models[0]?.providerId &&
          pool.runtime === provider.runtime,
      ) || provider.models.length > 0,
  );
  const input = draft ? inputFor(draft, visibleProviders) : undefined;

  function start(provider?: ProviderModelGroup) {
    const selected = provider ?? visibleProviders[0];
    if (!selected) return;
    setError("");
    setDraft({
      providerKey: selected.key,
      label: "",
      members: [
        {
          ...emptyMember(),
          model: selected.models[0]?.model ?? "",
        },
      ],
    });
  }

  async function save() {
    if (!draft || !input) return;
    setSaving(true);
    setError("");
    try {
      const saved = draft.id
        ? await updateModelPool(draft.id, input)
        : await createModelPool(input);
      setPools((current) => {
        const index = current.findIndex((pool) => pool.id === saved.id);
        if (index < 0) return [...current, saved];
        return current.map((pool) => (pool.id === saved.id ? saved : pool));
      });
      setDraft(undefined);
      onNotice?.(t("modelPools.saved", { label: saved.label }), "success");
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : t("modelPools.saveFailed");
      setError(message);
      onNotice?.(message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove(pool: ModelPool) {
    setSaving(true);
    setError("");
    try {
      await deleteModelPool(pool.id);
      setPools((current) => current.filter((item) => item.id !== pool.id));
      onNotice?.(t("modelPools.deleted", { label: pool.label }), "success");
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : t("modelPools.deleteFailed");
      setError(message);
      onNotice?.(message, "error");
    } finally {
      setSaving(false);
    }
  }

  function updateMember(index: number, patch: Partial<MemberDraft>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            members: current.members.map((member, memberIndex) =>
              memberIndex === index ? { ...member, ...patch } : member,
            ),
          }
        : current,
    );
  }

  return (
    <section className="grid min-w-0 gap-3 border-t border-line pt-4">
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <span className="min-w-0 flex-1">
          <SectionHeader
            level={3}
            title={t("modelPools.title")}
            description={t("modelPools.intro")}
          />
        </span>
        <Button
          disabled={!visibleProviders.length || loading}
          onClick={() => start()}
          size="sm"
          variant="secondary"
        >
          <Plus size={14} />
          {t("modelPools.add")}
        </Button>
      </div>
      {error && !draft ? (
        <Alert tone="error" size="compact" title={error} />
      ) : null}
      {visibleProviders.length ? (
        <div className="grid min-w-0">
          {visibleProviders.map((provider) => {
            const providerPools = pools.filter(
              (pool) =>
                pool.providerKind === provider.kind &&
                pool.providerId === provider.models[0]?.providerId &&
                pool.runtime === provider.runtime,
            );
            return (
              <div
                className="grid min-w-0 gap-2 border-b border-line-soft py-2.5"
                key={provider.key}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <strong className="min-w-0 truncate text-sm">
                    {provider.label}
                  </strong>
                  <small className="text-2xs text-ink-muted">
                    {t(`modelNotes.kinds.${provider.kind}`)} ·{" "}
                    {runtimeMeta(provider.runtime).label}
                  </small>
                  <Button
                    className="ml-auto"
                    onClick={() => start(provider)}
                    size="sm"
                    variant="ghost"
                  >
                    <Plus size={14} />
                    {t("modelPools.addUnderProvider")}
                  </Button>
                </div>
                {providerPools.length ? (
                  <ul className="grid min-w-0 gap-1 pl-3">
                    {providerPools.map((pool) => (
                      <li
                        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-line-soft py-2"
                        key={pool.id}
                      >
                        <Button
                          className="grid min-w-0 gap-0.5 p-0 text-left"
                          onClick={() => setDraft(memberDraft(pool, provider))}
                          size="inline"
                          variant="bare"
                        >
                          <span className="min-w-0 truncate text-xs font-semibold">
                            {pool.label}
                          </span>
                          <span className="min-w-0 truncate font-mono text-2xs text-ink-muted">
                            {pool.members
                              .map((member) => member.model)
                              .join(" · ")}
                          </span>
                        </Button>
                        <ConfirmButton
                          confirmLabel={t("modelPools.deleteConfirm")}
                          disabled={saving}
                          onConfirm={() => void remove(pool)}
                          size="sm"
                          variant="ghost"
                        >
                          <Trash2 size={14} />
                          <span className="sr-only">
                            {t("modelPools.deleteLabel", {
                              label: pool.label,
                            })}
                          </span>
                        </ConfirmButton>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <FieldHint className="m-0 pl-3">
                    {t("modelPools.noneUnderProvider")}
                  </FieldHint>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <FieldHint>
          {loading ? t("modelPools.loading") : t("modelPools.none")}
        </FieldHint>
      )}

      <Dialog
        busy={saving}
        description={t("modelPools.dialogDescription")}
        layout="compact"
        onClose={() => setDraft(undefined)}
        open={Boolean(draft)}
        size="default"
        title={draft?.id ? t("modelPools.editTitle") : t("modelPools.addTitle")}
      >
        {draft ? (
          <div className="grid min-w-0 gap-4">
            {error ? <Alert tone="error" title={error} /> : null}
            <label className="grid min-w-0 gap-1.5">
              <span className="text-xs font-semibold">
                {t("modelPools.provider")}
              </span>
              <SelectMenu
                ariaLabel={t("modelPools.provider")}
                options={visibleProviders.map((provider) => ({
                  value: provider.key,
                  label: provider.label,
                  meta: `${runtimeMeta(provider.runtime).label} · ${t(
                    `modelNotes.kinds.${provider.kind}`,
                  )}`,
                }))}
                value={draft.providerKey}
                onChange={(providerKey) =>
                  setDraft((current) =>
                    current ? { ...current, providerKey } : current,
                  )
                }
              />
            </label>
            <label className="grid min-w-0 gap-1.5">
              <span className="text-xs font-semibold">
                {t("modelPools.name")}
              </span>
              <TextInput
                aria-label={t("modelPools.name")}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? { ...current, label: event.currentTarget.value }
                      : current,
                  )
                }
                placeholder={t("modelPools.namePlaceholder")}
                tone="boxed"
                value={draft.label}
              />
            </label>
            <div className="grid min-w-0 gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold">
                  {t("modelPools.members")}
                </span>
                <Button
                  onClick={() =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            members: [...current.members, emptyMember()],
                          }
                        : current,
                    )
                  }
                  size="sm"
                  variant="ghost"
                >
                  <Plus size={14} />
                  {t("modelPools.addMember")}
                </Button>
              </div>
              <ul className="grid min-w-0 gap-2">
                {draft.members.map((member, index) => (
                  <li
                    className="grid min-w-0 grid-cols-[minmax(0,1.4fr)_minmax(90px,.7fr)_minmax(72px,.5fr)_auto] items-end gap-2 border-t border-line-soft pt-2 max-[640px]:grid-cols-[minmax(0,1fr)_auto]"
                    key={index}
                  >
                    <label className="grid min-w-0 gap-1">
                      <span className="text-2xs text-ink-muted">
                        {t("modelPools.model")}
                      </span>
                      <TextInput
                        aria-label={t("modelPools.modelLabel", {
                          index: index + 1,
                        })}
                        onChange={(event) =>
                          updateMember(index, {
                            model: event.currentTarget.value,
                          })
                        }
                        tone="boxed"
                        value={member.model}
                      />
                    </label>
                    <label className="grid min-w-0 gap-1">
                      <span className="text-2xs text-ink-muted">
                        {t("modelPools.tpm")}
                      </span>
                      <TextInput
                        aria-label={t("modelPools.tpmLabel", {
                          index: index + 1,
                        })}
                        inputMode="numeric"
                        min="0"
                        onChange={(event) =>
                          updateMember(index, {
                            tokensPerMinute: event.currentTarget.value,
                          })
                        }
                        placeholder={t("modelPools.tpmPlaceholder")}
                        tone="boxed"
                        type="number"
                        value={member.tokensPerMinute}
                      />
                    </label>
                    <label className="grid min-w-0 gap-1">
                      <span className="text-2xs text-ink-muted">
                        {t("modelPools.weight")}
                      </span>
                      <TextInput
                        aria-label={t("modelPools.weightLabel", {
                          index: index + 1,
                        })}
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
                      aria-label={t("modelPools.removeMember", {
                        index: index + 1,
                      })}
                      disabled={draft.members.length === 1}
                      onClick={() =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                members: current.members.filter(
                                  (_, memberIndex) => memberIndex !== index,
                                ),
                              }
                            : current,
                        )
                      }
                      size="sm"
                      variant="ghost"
                    >
                      <X size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
              <FieldHint>{t("modelPools.memberHint")}</FieldHint>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                disabled={saving}
                onClick={() => setDraft(undefined)}
                size="sm"
                variant="secondary"
              >
                {t("modelPools.cancel")}
              </Button>
              <Button
                busy={saving}
                disabled={!input}
                onClick={() => void save()}
                size="sm"
                variant="primary"
              >
                {t("modelPools.save")}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
