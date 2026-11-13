import { useId } from "react";
import { useTranslation } from "react-i18next";
import type {
  MessageChannelSessionRule,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { CheckLabel } from "../../components/ui/check-label";
import { ChipInput } from "../../components/ui/chip-input";
import { FieldHint, Radio } from "../../components/ui/field";
import { FieldLabel, FormFieldGroup } from "../../components/ui/form-field";
import { SelectMenu } from "../../components/ui/select-menu";
import { channelBounds, idleChoices, type ChannelDraft } from "./channel-model";
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
