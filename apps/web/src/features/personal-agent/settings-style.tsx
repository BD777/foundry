import { useTranslation } from "react-i18next";
import type {
  PersonalAgentSettings,
  PersonalAgentSpeakingStyle,
  PersonalAgentVerbosity,
} from "@bd777/foundry-protocol";
import { TextInput, Textarea } from "../../components/ui/field";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { SelectMenu } from "../../components/ui/select-menu";
import { browserTimezone, extraInstructionsMaxChars } from "./assistant-model";
import {
  SettingsField,
  SettingsGroup,
  type ChangeSettings,
} from "./settings-field";

const speakingStyles: PersonalAgentSpeakingStyle[] = [
  "auto",
  "plain",
  "technical",
];
const verbosities: PersonalAgentVerbosity[] = ["concise", "detailed"];

/** Its name, language, time zone, way of speaking and extra requests. */
export function StyleSection({
  draft,
  change,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
}) {
  const { t } = useTranslation("personalAgent");
  const languages = [
    { value: "", label: t("settings.style.languages.account") },
    { value: "en", label: t("settings.style.languages.en") },
    { value: "zh-CN", label: t("settings.style.languages.zhCN") },
  ];
  if (!languages.some((option) => option.value === draft.language))
    languages.push({ value: draft.language, label: draft.language });
  return (
    <>
      <SettingsGroup>
        <SettingsField htmlFor="fdy-pa-name" label={t("settings.style.name")}>
          <TextInput
            className="fdy-pa-input"
            id="fdy-pa-name"
            maxLength={40}
            onChange={(event) => change({ assistantName: event.target.value })}
            placeholder={t("defaultName")}
            tone="boxed"
            value={draft.assistantName}
          />
        </SettingsField>
        <SettingsField label={t("settings.style.language")}>
          <SelectMenu
            ariaLabel={t("settings.style.language")}
            className="fdy-pa-select"
            onChange={(language) => change({ language })}
            options={languages}
            value={draft.language}
          />
        </SettingsField>
        <SettingsField
          hint={t("settings.style.timezoneHint")}
          htmlFor="fdy-pa-timezone"
          label={t("settings.style.timezone")}
        >
          <TextInput
            className="fdy-pa-input"
            id="fdy-pa-timezone"
            onChange={(event) =>
              change({ timezone: event.target.value.trim() })
            }
            placeholder={t("settings.style.timezonePlaceholder", {
              zone: browserTimezone() || "UTC",
            })}
            tone="boxed"
            value={draft.timezone}
          />
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsField label={t("settings.style.speakingStyle")}>
          <SegmentedControl
            aria-label={t("settings.style.speakingStyle")}
            className="fdy-pa-segments"
            onValueChange={(speakingStyle) => change({ speakingStyle })}
            options={speakingStyles.map((value) => ({
              value,
              label: t(`settings.style.speaking.${value}`),
            }))}
            size="sm"
            value={draft.speakingStyle}
          />
        </SettingsField>
        <SettingsField label={t("settings.style.verbosity")}>
          <SegmentedControl
            aria-label={t("settings.style.verbosity")}
            className="fdy-pa-segments"
            onValueChange={(verbosity) => change({ verbosity })}
            options={verbosities.map((value) => ({
              value,
              label: t(`settings.style.verbosities.${value}`),
            }))}
            size="sm"
            value={draft.verbosity}
          />
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsField
          hint={
            <>
              {t("settings.style.extraHint")}{" "}
              <span
                className="fdy-pa-count"
                data-over={
                  draft.extraInstructions.length > extraInstructionsMaxChars
                    ? "true"
                    : undefined
                }
              >
                {t("settings.style.extraCount", {
                  count: draft.extraInstructions.length,
                })}
              </span>
            </>
          }
          htmlFor="fdy-pa-extra"
          label={t("settings.style.extra")}
        >
          <Textarea
            className="fdy-pa-textarea"
            id="fdy-pa-extra"
            onChange={(event) =>
              change({ extraInstructions: event.target.value })
            }
            resize="vertical"
            rows={5}
            tone="boxed"
            value={draft.extraInstructions}
          />
        </SettingsField>
      </SettingsGroup>
    </>
  );
}
