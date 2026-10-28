import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type {
  AgentProfileProjection,
  ClaudeEffort,
  CodexReasoningEffort,
} from "@bd777/foundry-protocol";
import {
  listAgentModels,
  type AgentDefault,
  type AgentDefaultSource,
  type DefaultAgentAccount,
  type ResolvedAgentDefault,
  type SetAgentDefaultInput,
} from "../../api";
import {
  claudeEffortOptions,
  codexEffortOptions,
  effortLabel,
} from "../../lib/agent-effort";
import { Alert } from "../ui/alert";
import { Badge } from "../ui/badge";
import { runtimeMeta } from "../ui/runtime-mark";
import { SelectMenu, type SelectMenuOption } from "../ui/select-menu";
import "./agent-default-fields.css";

export type AgentDefaultChange = Omit<
  SetAgentDefaultInput,
  "scope" | "routeId"
>;

export interface AgentDefaultFieldsProps {
  /** The accounts of the workspace's device. */
  accounts: DefaultAgentAccount[];
  /** Profiles whose model lists the model select offers. */
  profiles: AgentProfileProjection[];
  deviceId?: string;
  /** What this level sets; undefined inherits every field. */
  value?: AgentDefault;
  /** What a start at this level runs as. */
  effective?: ResolvedAgentDefault;
  /** Leads the effective line ("New chats use"). */
  effectiveLabel: string;
  disabled?: boolean;
  insideDialog?: boolean;
  onChange: (change: AgentDefaultChange) => Promise<void>;
}

/**
 * One level's default agent: account, model and effort selects, each of
 * which may inherit, and the result a new start gets. Shared by the
 * workspace's Agents & execution tab and its Feishu channel.
 */
export function AgentDefaultFields({
  accounts,
  profiles,
  deviceId,
  value,
  effective,
  effectiveLabel,
  disabled = false,
  insideDialog = false,
  onChange,
}: AgentDefaultFieldsProps) {
  const { t } = useTranslation("agents");
  const [saving, setSaving] = useState(false);
  const account = accounts.find(
    (candidate) => candidate.profileId === value?.profileId,
  );
  // A model or effort set without an account is for the inherited one.
  const runtime =
    account?.runtime || value?.runtime || effective?.runtime || "";
  const catalogProfileId = value?.profileId || effective?.profileId;
  const models = useModels(
    profiles.find(
      (profile) =>
        profile.id === catalogProfileId &&
        (!deviceId || profile.deviceId === deviceId),
    ),
  );
  const inherit: SelectMenuOption = {
    value: "",
    label: t("defaultAgent.inherit"),
  };
  const problem = (code?: string) =>
    code ? t(`defaultAgent.problems.${code}`, { defaultValue: code }) : "";

  const accountOptions: SelectMenuOption[] = [
    inherit,
    ...accounts
      .filter((candidate) => candidate.profileId)
      .map((candidate) => ({
        value: candidate.profileId,
        label: candidate.usable
          ? candidate.name
          : t("defaultAgent.unusableOption", {
              name: candidate.name,
              problem: problem(candidate.problem),
            }),
        meta: runtimeMeta(runtimeKind(candidate.runtime)).label,
      })),
  ];
  if (value?.profileId && !account) {
    accountOptions.push({
      value: value.profileId,
      label: t("defaultAgent.unusableOption", {
        name: value.profileId,
        problem: problem("missing"),
      }),
      meta: "",
    });
  }
  const modelIds = [
    ...new Set([...(value?.model ? [value.model] : []), ...models.models]),
  ];
  const modelOptions = [
    inherit,
    ...modelIds.map((model) => ({ value: model, label: model })),
  ];
  const effortOptions = [
    inherit,
    ...(runtime === "claude"
      ? claudeEffortOptions()
      : runtime === "codex"
        ? codexEffortOptions()
        : []),
  ];

  async function change(patch: AgentDefaultChange) {
    const next: AgentDefaultChange = {
      profileId: value?.profileId,
      runtime,
      model: value?.model,
      effort: value?.effort,
      ...patch,
    };
    setSaving(true);
    try {
      await onChange(next);
    } finally {
      setSaving(false);
    }
  }

  const locked = disabled || saving;
  return (
    <div className="fdy-agent-default">
      <div className="fdy-agent-default-fields">
        <label className="fdy-agent-default-field">
          <span className="fdy-agent-default-label">
            {t("defaultAgent.account")}
            {value?.problem ? (
              <Badge tone="warn" title={problem(value.problem)}>
                {t("defaultAgent.unusableBadge")}
              </Badge>
            ) : null}
          </span>
          <SelectMenu
            ariaLabel={t("defaultAgent.account")}
            disabled={locked}
            insideDialog={insideDialog}
            onChange={(profileId) => {
              const next = accounts.find(
                (candidate) => candidate.profileId === profileId,
              );
              // The model and effort were chosen for the account replaced.
              void change({
                profileId: profileId || undefined,
                runtime: next?.runtime ?? effective?.runtime,
                model: undefined,
                effort: undefined,
              });
            }}
            options={accountOptions}
            value={value?.profileId ?? ""}
          />
        </label>
        <label className="fdy-agent-default-field">
          <span className="fdy-agent-default-label">
            {t("defaultAgent.model")}
          </span>
          <SelectMenu
            ariaLabel={t("defaultAgent.model")}
            disabled={locked || !runtime}
            insideDialog={insideDialog}
            onChange={(model) => void change({ model: model || undefined })}
            options={modelOptions}
            placeholder={models.loading ? t("defaultAgent.loading") : undefined}
            value={value?.model ?? ""}
          />
        </label>
        <label className="fdy-agent-default-field">
          <span className="fdy-agent-default-label">
            {t("defaultAgent.effort")}
          </span>
          <SelectMenu
            ariaLabel={t("defaultAgent.effort")}
            disabled={locked || !runtime}
            insideDialog={insideDialog}
            onChange={(effort) => void change({ effort: effort || undefined })}
            options={effortOptions}
            value={value?.effort ?? ""}
          />
        </label>
      </div>
      <p className="fdy-agent-default-effective" aria-live="polite">
        {saving ? (
          t("defaultAgent.saving")
        ) : effective ? (
          <>
            <strong>{effectiveLabel}:</strong>{" "}
            {describeAgentDefault(effective, t)}
          </>
        ) : (
          t("defaultAgent.noAccount")
        )}
      </p>
      {effective?.skipped?.length ? (
        <Alert title={t("defaultAgent.skippedTitle")} tone="warning">
          {effective.skipped.map((skipped) => (
            <span className="fdy-agent-default-skipped" key={skipped.source}>
              {t("defaultAgent.skipped", {
                account: skipped.accountName || skipped.profileId,
                problem: problem(skipped.problem),
                used: effective.accountName,
              })}
            </span>
          ))}
        </Alert>
      ) : null}
    </div>
  );
}

function runtimeKind(runtime: string): "claude" | "codex" {
  return runtime === "claude" ? "claude" : "codex";
}

/** "Codex · Codex Local · gpt-6 · High — workspace default". */
export function describeAgentDefault(
  effective: ResolvedAgentDefault,
  t: TFunction<"agents">,
): string {
  const what = [
    runtimeMeta(runtimeKind(effective.runtime)).label,
    effective.accountName,
    effective.model || t("defaultAgent.accountModel"),
    effective.effort
      ? effortLabel(effective.effort as ClaudeEffort | CodexReasoningEffort)
      : t("defaultAgent.accountEffort"),
  ].join(" · ");
  const sources = [
    ...new Set(
      [effective.accountSource, effective.modelSource, effective.effortSource]
        .filter((source): source is AgentDefaultSource => Boolean(source))
        .map((source) => t(`defaultAgent.sources.${source}`)),
    ),
  ].join(", ");
  return t("defaultAgent.effectiveFrom", { what, source: sources });
}

/** The models a profile offers: its own list, then what its device reports. */
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
  return {
    models: [
      ...new Set([
        ...(profile?.model ? [profile.model] : []),
        ...(profile?.models ?? []),
        ...(read?.id === id ? read.models : []),
      ]),
    ],
    loading: Boolean(profile) && read?.id !== id,
  };
}
