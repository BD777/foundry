import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  MessageChannelPeers,
  MessageChannelSource,
  MessageChannelView,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import {
  createMessageChannel,
  listMessageChannelPeers,
  updateMessageChannel,
} from "../../api";
import { Button } from "../../components/ui/button";
import { CheckLabel } from "../../components/ui/check-label";
import { Dialog } from "../../components/ui/dialog";
import { FieldHint, Radio, TextInput } from "../../components/ui/field";
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
  capabilitiesOf,
  channelBounds,
  channelInput,
  channelLimitKeys,
  channelProblems,
  draftFromChannel,
  filterRules,
  newChannelDraft,
  peerNames,
  problemText,
  sourceAccesses,
  sourceOf,
  type ChannelDraft,
  type ChannelProblem,
  type PlaceId,
} from "./channel-model";
import { channelWorkspaceChoices } from "./channel-session-model";
import { ChannelFilterEditor, ProblemHint } from "./settings-channel-filter";
import {
  PrerequisiteNotice,
  prerequisitesMissing,
} from "./settings-channel-prerequisites";
import {
  ChannelSessionFields,
  ChannelWorkspaceChoice,
} from "./settings-channel-session";
import { ChannelRuleTrial } from "./settings-channel-trial";
import { SettingsGroup } from "./settings-field";

/**
 * Creates or edits one message channel: trigger words and the places they
 * apply in, custom rules under Advanced, a try-out on a made-up message and
 * on recent real ones, when its sessions start fresh and, on create, its
 * workspace. Once saved, it stays open when its source still needs the
 * person's grant, so the notice can say what is missing.
 */
export function ChannelEditor({
  assistantId,
  sources,
  view: initialView,
  workspaces = [],
  homeDeviceId,
  homeWorkspaceId,
  onClose,
  onSaved,
}: {
  assistantId?: string;
  sources: MessageChannelSource[];
  view?: MessageChannelView;
  /** The person's workspaces, for a new channel's workspace choice. */
  workspaces?: WorkspaceProjection[];
  homeDeviceId?: string;
  homeWorkspaceId?: string;
  onClose: () => void;
  onSaved: (view: MessageChannelView) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const [view, setView] = useState(initialView);
  const [draft, setDraft] = useState<ChannelDraft>(() =>
    initialView
      ? draftFromChannel(initialView.channel, sources)
      : newChannelDraft(sources.length === 1 ? sources[0]!.accountId : ""),
  );
  const [advancedOpen, setAdvancedOpen] = useState(
    () => draft.filter.custom.length > 0,
  );
  const [peers, setPeers] = useState<MessageChannelPeers>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const ids = useId();
  const source = sourceOf(draft.sourceAccountId, sources, view?.channel);
  const capabilities = capabilitiesOf(source);
  const problems = channelProblems(draft, capabilities);
  // Problems of the filter show as they arise; the rest once Save was tried.
  const shown: ChannelProblem[] = problems.filter(
    (problem) =>
      attempted ||
      problem.kind === "noTriggers" ||
      problem.kind === "noPlace" ||
      problem.kind === "customNoTrigger" ||
      problem.kind === "customNoPlace" ||
      problem.kind === "resetCommands",
  );
  const problemOf = (kind: ChannelProblem["kind"]) => {
    const found = shown.find((problem) => problem.kind === kind);
    return found ? problemText(found, t) : undefined;
  };
  const placeLabel = (place: PlaceId) =>
    t(`settings.channels.editor.places.${place}`);
  const change = (patch: Partial<ChannelDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  useEffect(() => {
    let cancelled = false;
    setPeers(undefined);
    if (!draft.sourceAccountId) return;
    listMessageChannelPeers(assistantId, draft.sourceAccountId)
      .then((result) => {
        if (!cancelled) setPeers(result);
      })
      .catch(() => {
        // Without peers the pickers still keep and show saved ids.
        if (!cancelled) setPeers({ conversations: [], senders: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [assistantId, draft.sourceAccountId]);

  useEffect(() => {
    if (!focusRequest) return;
    const form = document.getElementById(`${ids}-form`);
    const hint = form?.querySelector<HTMLElement>("[data-channel-problem]");
    if (!hint) return;
    const field = hint.closest<HTMLElement>("[data-channel-field]") ?? hint;
    field.scrollIntoView({ block: "center", behavior: "smooth" });
    field
      .querySelector<HTMLElement>(
        "input:not([type=hidden]), textarea, button, [tabindex]",
      )
      ?.focus({ preventScroll: true });
  }, [focusRequest, ids]);

  const sourceOptions = sources.map((entry) => ({
    value: entry.accountId,
    label: entry.label || entry.kind,
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
      if (problems[0]!.kind.startsWith("custom")) setAdvancedOpen(true);
      setFocusRequest((value) => value + 1);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const input = channelInput(draft, sources, view?.channel, placeLabel);
      const saved = view
        ? await updateMessageChannel(assistantId, view.channel.id, input)
        : await createMessageChannel(assistantId, input);
      onSaved(saved);
      if (prerequisitesMissing(saved.prerequisites)) {
        setView(saved);
        setDraft(draftFromChannel(saved.channel, sources));
        setAttempted(false);
      } else onClose();
    } catch (reason) {
      setError(serverErrorText(reason));
    } finally {
      setSaving(false);
    }
  }

  const workspaceChoices = channelWorkspaceChoices(
    workspaces,
    homeDeviceId,
    homeWorkspaceId,
  );

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
        id={`${ids}-form`}
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
          <FormField data-channel-field="" htmlFor={`${ids}-name`}>
            <span>{t("settings.channels.editor.name")}</span>
            <TextInput
              id={`${ids}-name`}
              maxLength={channelBounds.name}
              onChange={(event) => change({ name: event.target.value })}
              placeholder={t("settings.channels.editor.namePlaceholder")}
              tone="boxed"
              value={draft.name}
            />
            <ProblemHint>{problemOf("name")}</ProblemHint>
          </FormField>
          <FormFieldGroup data-channel-field="">
            <span>{t("settings.channels.editor.source")}</span>
            <SelectMenu
              ariaLabel={t("settings.channels.editor.source")}
              insideDialog
              onChange={(sourceAccountId) => change({ sourceAccountId })}
              options={sourceOptions}
              placeholder={t("settings.channels.editor.sourcePlaceholder")}
              value={draft.sourceAccountId}
            />
            <ProblemHint>{problemOf("source")}</ProblemHint>
          </FormFieldGroup>
        </SettingsGroup>

        <SettingsGroup>
          <ChannelFilterEditor
            advancedOpen={advancedOpen}
            capabilities={capabilities}
            filter={draft.filter}
            onAdvancedOpenChange={setAdvancedOpen}
            onChange={(filter) => change({ filter })}
            peers={peers}
            problems={shown}
          />
          <ProblemHint>{problemOf("tooManyRules")}</ProblemHint>
        </SettingsGroup>

        <ChannelRuleTrial
          assistantId={assistantId}
          capabilities={capabilities}
          names={peerNames(peers)}
          rules={filterRules(draft.filter, capabilities, placeLabel)}
          sourceAccountId={draft.sourceAccountId}
        />

        <SettingsGroup title={t("settings.channels.editor.sessionTitle")}>
          <ChannelSessionFields
            commandsProblem={problemOf("resetCommands")}
            idleProblem={problemOf("idle")}
            onSessionChange={(session) => change({ session })}
            onSessionKeyChange={(sessionKey) => change({ sessionKey })}
            session={draft.session}
            sessionKey={draft.sessionKey}
          />
        </SettingsGroup>

        {view ? null : (
          <SettingsGroup title={t("settings.channels.editor.workspaceTitle")}>
            <ChannelWorkspaceChoice
              choices={workspaceChoices}
              onChange={(workspace) => change({ workspace })}
              problem={problemOf("workspace")}
              value={draft.workspace}
            />
          </SettingsGroup>
        )}
        <FieldHint className="mt-0">
          {t("settings.channels.editor.instructionsNote")}
        </FieldHint>

        <SettingsGroup>
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
              <FormField
                data-channel-field=""
                htmlFor={`${ids}-${key}`}
                key={key}
              >
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
          {shown
            .filter((problem) => problem.kind === "limit")
            .map((problem) => {
              const text = problemText(problem, t);
              return <ProblemHint key={text}>{text}</ProblemHint>;
            })}
        </SettingsGroup>

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
