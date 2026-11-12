import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import type {
  MessageChannelSource,
  MessageChannelTriState,
  MessageChannelView,
  MessageConversationKind,
} from "@bd777/foundry-protocol";
import { createMessageChannel, updateMessageChannel } from "../../api";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { CheckLabel } from "../../components/ui/check-label";
import { Dialog } from "../../components/ui/dialog";
import {
  Checkbox,
  FieldHint,
  Radio,
  TextInput,
  Textarea,
} from "../../components/ui/field";
import {
  FieldLabel,
  FormField,
  FormFieldGroup,
  FormLayout,
} from "../../components/ui/form-field";
import { SelectMenu } from "../../components/ui/select-menu";
import { Switch } from "../../components/ui/switch";
import { ToastFeedback } from "../../components/ui/toast";
import { serverErrorText } from "../../lib/errors";
import {
  blankRule,
  channelBounds,
  channelInput,
  channelLimitKeys,
  channelProblems,
  conversationKinds,
  draftFromChannel,
  newChannelDraft,
  parsePrefixes,
  sourceAccesses,
  triStates,
  type ChannelDraft,
  type ChannelProblem,
  type RuleDraft,
} from "./channel-model";
import {
  PrerequisiteNotice,
  prerequisitesMissing,
} from "./settings-channel-prerequisites";
import { SettingsGroup } from "./settings-field";

type T = ReturnType<typeof useTranslation<"personalAgent">>["t"];

function problemText(problem: ChannelProblem, t: T): string {
  if (problem.kind === "limit")
    return t("settings.channels.editor.problems.limit", {
      label: t(`settings.channels.editor.limits.${problem.key}`),
      min: problem.min,
      max: problem.max,
    });
  if ("rule" in problem)
    return t(`settings.channels.editor.problems.${problem.kind}`, {
      number: problem.rule + 1,
    });
  return t(`settings.channels.editor.problems.${problem.kind}`);
}

/**
 * Creates or edits one message channel. A new channel starts from the
 * three-rule template; once saved, it stays open when its source still
 * needs the person's grant, so the notice can say what is missing.
 */
export function ChannelEditor({
  assistantId,
  sources,
  view: initialView,
  onClose,
  onSaved,
}: {
  assistantId?: string;
  sources: MessageChannelSource[];
  view?: MessageChannelView;
  onClose: () => void;
  onSaved: (view: MessageChannelView) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const [view, setView] = useState(initialView);
  const [draft, setDraft] = useState<ChannelDraft>(() =>
    initialView
      ? draftFromChannel(initialView.channel)
      : newChannelDraft(
          {
            direct: t("settings.channels.editor.template.direct"),
            groupMention: t("settings.channels.editor.template.groupMention"),
            selfTest: t("settings.channels.editor.template.selfTest"),
          },
          sources.length === 1 ? sources[0]!.accountId : "",
        ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const ids = useId();
  const problems = channelProblems(draft);
  const change = (patch: Partial<ChannelDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const changeRule = (index: number, next: RuleDraft) =>
    setDraft((current) => ({
      ...current,
      rules: current.rules.map((entry, at) => (at === index ? next : entry)),
    }));

  const sourceOptions = sources.map((source) => ({
    value: source.accountId,
    label: source.label || source.kind,
  }));
  if (
    draft.sourceAccountId &&
    !sourceOptions.some((option) => option.value === draft.sourceAccountId)
  )
    sourceOptions.push({
      value: draft.sourceAccountId,
      label:
        view?.channel.source.label ||
        view?.channel.source.kind ||
        draft.sourceAccountId,
    });

  async function save(): Promise<void> {
    if (problems.length) {
      setAttempted(true);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const input = channelInput(draft, sources, view?.channel);
      const saved = view
        ? await updateMessageChannel(assistantId, view.channel.id, input)
        : await createMessageChannel(assistantId, input);
      onSaved(saved);
      if (prerequisitesMissing(saved.prerequisites)) {
        setView(saved);
        setDraft(draftFromChannel(saved.channel));
        setAttempted(false);
      } else onClose();
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setSaving(false);
    }
  }

  const sourceChanged =
    view !== undefined &&
    view.channel.source.accountId !== draft.sourceAccountId;

  return (
    <Dialog
      busy={saving}
      footer={
        <>
          <Button disabled={saving} onClick={onClose} variant="ghost">
            {view
              ? t("settings.channels.editor.close")
              : t("settings.channels.editor.cancel")}
          </Button>
          <Button
            busy={saving}
            disabled={saving}
            onClick={() => void save()}
            variant="primary"
          >
            {saving
              ? t("settings.channels.editor.saving")
              : view
                ? t("settings.channels.editor.save")
                : t("settings.channels.editor.create")}
          </Button>
        </>
      }
      onClose={onClose}
      size="editor"
      title={
        view
          ? t("settings.channels.editor.editTitle", { name: view.channel.name })
          : t("settings.channels.editor.newTitle")
      }
    >
      <FormLayout
        as="form"
        className="gap-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {view && !sourceChanged ? (
          <PrerequisiteNotice
            accountId={view.channel.source.accountId}
            assistantId={assistantId}
            onGranted={(prerequisites) =>
              setView((current) =>
                current ? { ...current, prerequisites } : current,
              )
            }
            prerequisites={view.prerequisites}
          />
        ) : null}
        <SettingsGroup>
          <FormField htmlFor={`${ids}-name`}>
            <span>{t("settings.channels.editor.name")}</span>
            <TextInput
              id={`${ids}-name`}
              maxLength={channelBounds.name}
              onChange={(event) => change({ name: event.target.value })}
              placeholder={t("settings.channels.editor.namePlaceholder")}
              tone="boxed"
              value={draft.name}
            />
          </FormField>
          <FormFieldGroup>
            <span>{t("settings.channels.editor.source")}</span>
            <SelectMenu
              ariaLabel={t("settings.channels.editor.source")}
              insideDialog
              onChange={(sourceAccountId) => change({ sourceAccountId })}
              options={sourceOptions}
              placeholder={t("settings.channels.editor.sourcePlaceholder")}
              value={draft.sourceAccountId}
            />
          </FormFieldGroup>
        </SettingsGroup>

        <SettingsGroup title={t("settings.channels.editor.rulesTitle")}>
          <FieldHint>{t("settings.channels.editor.rulesHint")}</FieldHint>
          <ol className="grid min-w-0 list-none gap-3 p-0">
            {draft.rules.map((entry, index) => (
              <RuleEditor
                entry={entry}
                index={index}
                key={entry.rule.id}
                onChange={(next) => changeRule(index, next)}
                onRemove={() =>
                  setDraft((current) => ({
                    ...current,
                    rules: current.rules.filter((_, at) => at !== index),
                  }))
                }
              />
            ))}
          </ol>
          <Button
            className="justify-self-start"
            disabled={draft.rules.length >= channelBounds.rules}
            onClick={() =>
              setDraft((current) => ({
                ...current,
                rules: [...current.rules, blankRule()],
              }))
            }
            size="sm"
            variant="secondary"
          >
            <Plus aria-hidden="true" size={14} />
            {t("settings.channels.editor.addRule")}
          </Button>
        </SettingsGroup>

        <SettingsGroup title={t("settings.channels.editor.guide")}>
          <FormField htmlFor={`${ids}-guide`}>
            <Textarea
              aria-describedby={`${ids}-guide-hint`}
              aria-label={t("settings.channels.editor.guide")}
              id={`${ids}-guide`}
              maxLength={channelBounds.guide}
              onChange={(event) => change({ guide: event.target.value })}
              resize="vertical"
              rows={6}
              tone="boxed"
              value={draft.guide}
            />
            <FieldHint id={`${ids}-guide-hint`}>
              {t("settings.channels.editor.guideHint")}
            </FieldHint>
          </FormField>
        </SettingsGroup>

        <SettingsGroup>
          <FormFieldGroup className="max-w-sm">
            <span>{t("settings.channels.editor.sessionKey")}</span>
            <SelectMenu
              ariaLabel={t("settings.channels.editor.sessionKey")}
              insideDialog
              onChange={(value) =>
                change({
                  sessionKey: value === "thread" ? "thread" : "conversation",
                })
              }
              options={(["conversation", "thread"] as const).map((value) => ({
                value,
                label: t(`settings.channels.editor.sessionKeys.${value}`),
              }))}
              value={draft.sessionKey}
            />
          </FormFieldGroup>
          <fieldset className="grid min-w-0 gap-2 border-0 p-0">
            <FieldLabel as="span">
              {t("settings.channels.editor.accessTitle")}
            </FieldLabel>
            {sourceAccesses.map((access) => (
              <CheckLabel key={access}>
                <Radio
                  checked={draft.access === access}
                  name={`${ids}-access`}
                  onChange={() => change({ access })}
                  value={access}
                />
                <span>{t(`settings.channels.editor.access.${access}`)}</span>
              </CheckLabel>
            ))}
          </fieldset>
          <label className="flex min-w-0 cursor-pointer items-center gap-2.5 text-sm text-ink">
            <Switch
              checked={draft.inheritOtherConnectors}
              onCheckedChange={(inheritOtherConnectors) =>
                change({ inheritOtherConnectors })
              }
            />
            <span>{t("settings.channels.editor.inheritOthers")}</span>
          </label>
          <ul className="grid gap-0.5 text-xs text-ink-muted">
            <li>{t("settings.channels.editor.workspaces")}</li>
            <li>{t("settings.channels.editor.identityResources")}</li>
          </ul>
        </SettingsGroup>

        <SettingsGroup title={t("settings.channels.editor.limitsTitle")}>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            {channelLimitKeys.map((key) => (
              <FormField htmlFor={`${ids}-${key}`} key={key}>
                <span>{t(`settings.channels.editor.limits.${key}`)}</span>
                <TextInput
                  id={`${ids}-${key}`}
                  inputMode="numeric"
                  max={channelBounds[key].max}
                  min={channelBounds[key].min}
                  onChange={(event) =>
                    change({
                      limits: {
                        ...draft.limits,
                        [key]:
                          event.target.value === ""
                            ? Number.NaN
                            : Number(event.target.value),
                      },
                    })
                  }
                  tone="boxed"
                  type="number"
                  value={
                    Number.isNaN(draft.limits[key]) ? "" : draft.limits[key]
                  }
                />
              </FormField>
            ))}
          </div>
        </SettingsGroup>

        {attempted && problems.length ? (
          <Alert
            size="compact"
            title={t("settings.channels.editor.problemsTitle")}
            tone="warning"
          >
            <ul className="grid gap-0.5">
              {problems.map((problem) => {
                const text = problemText(problem, t);
                return <li key={text}>{text}</li>;
              })}
            </ul>
          </Alert>
        ) : null}
        {error ? (
          <ToastFeedback
            title={t("settings.channels.editor.saveFailed")}
            tone="error"
          >
            {error}
          </ToastFeedback>
        ) : null}
      </FormLayout>
    </Dialog>
  );
}

function RuleEditor({
  entry,
  index,
  onChange,
  onRemove,
}: {
  entry: RuleDraft;
  index: number;
  onChange: (next: RuleDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("personalAgent");
  const ids = useId();
  const { rule } = entry;
  const setRule = (patch: Partial<RuleDraft["rule"]>) =>
    onChange({ ...entry, rule: { ...rule, ...patch } });
  const toggleKind = (kind: MessageConversationKind, on: boolean) =>
    setRule({
      conversationKinds: on
        ? [...rule.conversationKinds.filter((value) => value !== kind), kind]
        : rule.conversationKinds.filter((value) => value !== kind),
    });
  const missingPrefix =
    rule.enabled && parsePrefixes(entry.prefixes).length === 0;
  const number = index + 1;
  const triOptions = (group: "mentions" | "fromSelfOptions") =>
    triStates.map((value) => ({
      value,
      label: t(`settings.channels.editor.${group}.${value}`),
    }));

  return (
    <li className="grid min-w-0 gap-3 rounded-lg bg-inset p-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <Switch
          aria-label={`${t("settings.channels.editor.rule", { number })} · ${t("settings.channels.editor.ruleEnabled")}`}
          checked={rule.enabled}
          onCheckedChange={(enabled) => setRule({ enabled })}
        />
        <TextInput
          aria-label={`${t("settings.channels.editor.rule", { number })} · ${t("settings.channels.editor.ruleLabel")}`}
          className="flex-1"
          onChange={(event) => setRule({ label: event.target.value })}
          placeholder={t("settings.channels.editor.rule", { number })}
          tone="boxed"
          value={rule.label ?? ""}
        />
        <Button
          aria-label={`${t("settings.channels.editor.rule", { number })} · ${t("settings.channels.editor.removeRule")}`}
          onClick={onRemove}
          size="icon"
          variant="icon"
        >
          <Trash2 aria-hidden="true" size={15} />
        </Button>
      </div>
      <fieldset className="grid min-w-0 gap-1.5 border-0 p-0">
        <FieldLabel as="span">{t("settings.channels.editor.kinds")}</FieldLabel>
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1.5">
          {conversationKinds.map((kind) => (
            <CheckLabel key={kind}>
              <Checkbox
                checked={rule.conversationKinds.includes(kind)}
                onChange={(event) => toggleKind(kind, event.target.checked)}
              />
              <span>{t(`settings.channels.editor.kind.${kind}`)}</span>
            </CheckLabel>
          ))}
        </div>
      </fieldset>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <FormFieldGroup>
          <span>{t("settings.channels.editor.mentionsMe")}</span>
          <SelectMenu
            ariaLabel={`${t("settings.channels.editor.rule", { number })} · ${t("settings.channels.editor.mentionsMe")}`}
            insideDialog
            onChange={(value) =>
              setRule({ mentionsMe: value as MessageChannelTriState })
            }
            options={triOptions("mentions")}
            value={rule.mentionsMe}
          />
        </FormFieldGroup>
        <FormFieldGroup>
          <span>{t("settings.channels.editor.fromSelf")}</span>
          <SelectMenu
            ariaLabel={`${t("settings.channels.editor.rule", { number })} · ${t("settings.channels.editor.fromSelf")}`}
            insideDialog
            onChange={(value) =>
              setRule({ fromSelf: value as MessageChannelTriState })
            }
            options={triOptions("fromSelfOptions")}
            value={rule.fromSelf}
          />
        </FormFieldGroup>
      </div>
      <FormField htmlFor={`${ids}-prefixes`}>
        <span>{t("settings.channels.editor.prefixes")}</span>
        <TextInput
          aria-describedby={`${ids}-prefixes-hint`}
          aria-invalid={missingPrefix || undefined}
          id={`${ids}-prefixes`}
          onChange={(event) =>
            onChange({ ...entry, prefixes: event.target.value })
          }
          placeholder={t("settings.channels.editor.prefixesPlaceholder")}
          tone="boxed"
          value={entry.prefixes}
        />
        <FieldHint
          id={`${ids}-prefixes-hint`}
          tone={missingPrefix ? "warning" : "muted"}
        >
          {missingPrefix
            ? t("settings.channels.editor.prefixRequired")
            : t("settings.channels.editor.prefixesHint")}
        </FieldHint>
      </FormField>
      <FormField htmlFor={`${ids}-conversations`}>
        <span>{t("settings.channels.editor.conversationIds")}</span>
        <Textarea
          aria-describedby={`${ids}-conversations-hint`}
          id={`${ids}-conversations`}
          onChange={(event) =>
            onChange({ ...entry, conversationIds: event.target.value })
          }
          resize="vertical"
          rows={2}
          tone="boxed"
          value={entry.conversationIds}
        />
        <FieldHint id={`${ids}-conversations-hint`}>
          {t("settings.channels.editor.conversationIdsHint")}
        </FieldHint>
      </FormField>
    </li>
  );
}
