import { useId } from "react";
import { useTranslation } from "react-i18next";
import type {
  MessageChannelFollowUps,
  MessageChannelSessionRule,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { CheckLabel } from "../../components/ui/check-label";
import { ChipInput } from "../../components/ui/chip-input";
import { FieldHint, Radio, TextInput } from "../../components/ui/field";
import {
  FieldLabel,
  FormField,
  FormFieldGroup,
} from "../../components/ui/form-field";
import { SelectMenu } from "../../components/ui/select-menu";
import { Switch } from "../../components/ui/switch";
import {
  channelBounds,
  followUpFroms,
  idleChoices,
  type ChannelDraft,
} from "./channel-model";
import { idleLabelParts } from "./channel-session-model";
import { ProblemHint } from "./settings-channel-filter";

type T = ReturnType<typeof useTranslation<"personalAgent">>["t"];

function idleLabel(minutes: number, t: T): string {
  const { unit, count } = idleLabelParts(minutes);
  return t(`settings.channels.editor.idleOptions.${unit}`, { count });
}

/**
 * When a conversation's messages go to a new session: what a session is
 * (a thread or the whole conversation), how long a quiet spell splits it,
 * and the words that start a new one.
 */
export function ChannelSessionFields({
  sessionKey,
  session,
  onSessionKeyChange,
  onSessionChange,
  idleProblem,
  commandsProblem,
}: {
  sessionKey: ChannelDraft["sessionKey"];
  session: MessageChannelSessionRule;
  onSessionKeyChange: (sessionKey: ChannelDraft["sessionKey"]) => void;
  onSessionChange: (session: MessageChannelSessionRule) => void;
  idleProblem?: string;
  commandsProblem?: string;
}) {
  const { t } = useTranslation("personalAgent");
  const ids = useId();
  const choices = idleChoices.includes(session.idleMinutes)
    ? idleChoices
    : [...idleChoices, session.idleMinutes];

  return (
    <>
      <fieldset className="grid min-w-0 gap-2 border-0 p-0">
        <FieldLabel as="span">
          {t("settings.channels.editor.sessionKey")}
        </FieldLabel>
        {(["thread", "conversation"] as const).map((value) => (
          <CheckLabel key={value}>
            <Radio
              checked={sessionKey === value}
              name={`${ids}-session-key`}
              onChange={() => onSessionKeyChange(value)}
              value={value}
            />
            <span>
              <span>{t(`settings.channels.editor.sessionKeys.${value}`)}</span>
              <small>
                {t(`settings.channels.editor.sessionKeyHints.${value}`)}
              </small>
            </span>
          </CheckLabel>
        ))}
      </fieldset>
      <FormFieldGroup className="max-w-sm" data-channel-field="">
        <span>{t("settings.channels.editor.idle")}</span>
        <SelectMenu
          ariaLabel={t("settings.channels.editor.idle")}
          insideDialog
          onChange={(value) =>
            onSessionChange({ ...session, idleMinutes: Number(value) })
          }
          options={choices.map((minutes) => ({
            value: String(minutes),
            label: idleLabel(minutes, t),
          }))}
          value={String(session.idleMinutes)}
        />
        <FieldHint>{t("settings.channels.editor.idleHint")}</FieldHint>
        <ProblemHint>{idleProblem}</ProblemHint>
      </FormFieldGroup>
      <FormFieldGroup data-channel-field="">
        <FieldLabel htmlFor={`${ids}-reset`}>
          {t("settings.channels.editor.resetCommands")}
        </FieldLabel>
        <ChipInput
          aria-describedby={`${ids}-reset-hint`}
          id={`${ids}-reset`}
          invalid={Boolean(commandsProblem)}
          maxItems={channelBounds.resetCommands}
          maxLength={channelBounds.resetCommand}
          onChange={(resetCommands) =>
            onSessionChange({ ...session, resetCommands })
          }
          placeholder={t("settings.channels.editor.resetCommandsPlaceholder")}
          removeLabel={(word) =>
            t("settings.channels.editor.removeResetCommand", { word })
          }
          values={session.resetCommands}
        />
        <ProblemHint>{commandsProblem}</ProblemHint>
        <FieldHint id={`${ids}-reset-hint`}>
          {t("settings.channels.editor.resetCommandsHint")}
        </FieldHint>
      </FormFieldGroup>
    </>
  );
}

/**
 * 续聊: after a message matched, who may continue its thread or quote it
 * without a trigger word, and which words stop it.
 */
export function ChannelFollowUpFields({
  followUps,
  onChange,
  commandsProblem,
}: {
  followUps: MessageChannelFollowUps;
  onChange: (followUps: MessageChannelFollowUps) => void;
  commandsProblem?: string;
}) {
  const { t } = useTranslation("personalAgent");
  const ids = useId();
  return (
    <>
      <label className="flex min-w-0 cursor-pointer items-center gap-2.5 text-sm text-ink">
        <Switch
          checked={followUps.enabled}
          onCheckedChange={(enabled) => onChange({ ...followUps, enabled })}
        />
        <span>{t("settings.channels.editor.followUps")}</span>
      </label>
      <FieldHint>{t("settings.channels.editor.followUpsHint")}</FieldHint>
      {followUps.enabled ? (
        <>
          <fieldset className="grid min-w-0 gap-2 border-0 p-0">
            <FieldLabel as="span">
              {t("settings.channels.editor.followUpsFrom")}
            </FieldLabel>
            {followUpFroms.map((value) => (
              <CheckLabel key={value}>
                <Radio
                  checked={followUps.from === value}
                  name={`${ids}-follow-up-from`}
                  onChange={() => onChange({ ...followUps, from: value })}
                  value={value}
                />
                <span>
                  <span>
                    {t(`settings.channels.editor.followUpFroms.${value}`)}
                  </span>
                  <small>
                    {t(`settings.channels.editor.followUpFromHints.${value}`)}
                  </small>
                </span>
              </CheckLabel>
            ))}
          </fieldset>
          <FormFieldGroup data-channel-field="">
            <FieldLabel htmlFor={`${ids}-end`}>
              {t("settings.channels.editor.endCommands")}
            </FieldLabel>
            <ChipInput
              aria-describedby={`${ids}-end-hint`}
              id={`${ids}-end`}
              invalid={Boolean(commandsProblem)}
              maxItems={channelBounds.endCommands}
              maxLength={channelBounds.endCommand}
              onChange={(endCommands) =>
                onChange({ ...followUps, endCommands })
              }
              placeholder={t("settings.channels.editor.endCommandsPlaceholder")}
              removeLabel={(word) =>
                t("settings.channels.editor.removeEndCommand", { word })
              }
              values={followUps.endCommands}
            />
            <ProblemHint>{commandsProblem}</ProblemHint>
            <FieldHint id={`${ids}-end-hint`}>
              {t("settings.channels.editor.endCommandsHint")}
            </FieldHint>
          </FormFieldGroup>
        </>
      ) : null}
    </>
  );
}

/**
 * How the channel marks its work in the source's conversation: a reaction
 * while the assistant is on a message, and the AI footer of its replies.
 */
export function ChannelHandoverFields({
  ack,
  footer,
  showAck,
  showFooter,
  footerProblem,
  onAckChange,
  onFooterChange,
}: {
  ack: boolean;
  footer: string;
  showAck: boolean;
  showFooter: boolean;
  footerProblem?: string;
  onAckChange: (ack: boolean) => void;
  onFooterChange: (footer: string) => void;
}) {
  const { t } = useTranslation("personalAgent");
  const ids = useId();
  return (
    <>
      {showAck ? (
        <>
          <label className="flex min-w-0 cursor-pointer items-center gap-2.5 text-sm text-ink">
            <Switch checked={ack} onCheckedChange={onAckChange} />
            <span>{t("settings.channels.editor.ack")}</span>
          </label>
          <FieldHint>{t("settings.channels.editor.ackHint")}</FieldHint>
        </>
      ) : null}
      {showFooter ? (
        <FormField data-channel-field="" htmlFor={`${ids}-footer`}>
          <span>{t("settings.channels.editor.footer")}</span>
          <TextInput
            aria-describedby={`${ids}-footer-hint`}
            aria-invalid={Boolean(footerProblem)}
            id={`${ids}-footer`}
            maxLength={channelBounds.footer}
            onChange={(event) => onFooterChange(event.target.value)}
            placeholder={t("settings.channels.editor.footerPlaceholder")}
            tone="boxed"
            value={footer}
          />
          <ProblemHint>{footerProblem}</ProblemHint>
          <FieldHint id={`${ids}-footer-hint`}>
            {t("settings.channels.editor.footerHint")}
          </FieldHint>
        </FormField>
      ) : null}
    </>
  );
}

/**
 * Where a new channel's sessions run: a workspace made for it, or one the
 * person works in on the assistant's computer. Read-only for the sessions.
 */
export function ChannelWorkspaceChoice({
  value,
  choices,
  onChange,
  problem,
}: {
  value: ChannelDraft["workspace"];
  choices: WorkspaceProjection[];
  onChange: (value: ChannelDraft["workspace"]) => void;
  problem?: string;
}) {
  const { t } = useTranslation("personalAgent");
  const ids = useId();
  return (
    <>
      <fieldset
        className="grid min-w-0 gap-2 border-0 p-0"
        data-channel-field=""
      >
        {(["new", "existing"] as const).map((mode) => (
          <CheckLabel key={mode}>
            <Radio
              checked={value.mode === mode}
              disabled={mode === "existing" && choices.length === 0}
              name={`${ids}-workspace`}
              onChange={() =>
                onChange({
                  mode,
                  id: mode === "existing" ? value.id : "",
                })
              }
              value={mode}
            />
            <span>
              <span>
                {t(`settings.channels.editor.workspaceModes.${mode}`)}
              </span>
              {mode === "existing" && choices.length === 0 ? (
                <small>{t("settings.channels.editor.workspaceNone")}</small>
              ) : null}
            </span>
          </CheckLabel>
        ))}
      </fieldset>
      {value.mode === "existing" ? (
        <FormFieldGroup className="max-w-sm" data-channel-field="">
          <span>{t("settings.channels.editor.workspacePick")}</span>
          <SelectMenu
            ariaLabel={t("settings.channels.editor.workspacePick")}
            insideDialog
            onChange={(id) => onChange({ mode: "existing", id })}
            options={choices.map((workspace) => ({
              value: workspace.id,
              label: workspace.name,
              meta: workspace.localPath,
            }))}
            placeholder={t("settings.channels.editor.workspacePickPlaceholder")}
            value={value.id}
          />
          <ProblemHint>{problem}</ProblemHint>
        </FormFieldGroup>
      ) : null}
      <FieldHint className="mt-0">
        {t("settings.channels.editor.workspaceNote")}
      </FieldHint>
    </>
  );
}
