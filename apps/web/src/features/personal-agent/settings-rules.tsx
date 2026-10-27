import { FieldHint } from "../../components/ui/field";
import { useTranslation } from "react-i18next";
import {
  personalAgentActions,
  type PersonalAgentDecision,
  type PersonalAgentPolicyPreset,
  type PersonalAgentSettings,
} from "@bd777/foundry-protocol";
import { SegmentedControl } from "../../components/ui/segmented-control";
import {
  defaultPolicy,
  matchingPreset,
  policyPresets,
  presetPolicy,
} from "./assistant-model";
import {
  SettingsField,
  SettingsGroup,
  type ChangeSettings,
} from "./settings-field";

const decisions: PersonalAgentDecision[] = ["auto", "ask", "deny"];

/** §4's table: what it does on its own, asks about first, or never does. */
export function RulesSection({
  draft,
  change,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
}) {
  const { t } = useTranslation("personalAgent");
  const preset = matchingPreset(draft.policy);
  return (
    <>
      <p className="fdy-pa-intro">{t("settings.rules.intro")}</p>
      <SettingsGroup>
        <SettingsField
          hint={preset ? undefined : t("settings.rules.custom")}
          label={t("settings.rules.presets")}
        >
          <SegmentedControl<string>
            aria-label={t("settings.rules.presets")}
            className="fdy-pa-segments"
            onValueChange={(value) =>
              change({
                policy: presetPolicy(value as PersonalAgentPolicyPreset),
              })
            }
            options={policyPresets.map((value) => ({
              value,
              label: t(`settings.rules.preset.${value}`),
            }))}
            size="sm"
            value={preset ?? ""}
          />
        </SettingsField>
      </SettingsGroup>
      <ul className="fdy-pa-rules">
        {personalAgentActions.map((action) => (
          <li className="fdy-pa-rule" key={action}>
            <span className="fdy-pa-rule-label" id={`fdy-pa-rule-${action}`}>
              {t(`settings.rules.actions.${action}`)}
              {action === "archive_session" ? (
                <FieldHint as="small">
                  {t("settings.rules.archiveSessionHint")}
                </FieldHint>
              ) : null}
            </span>
            <SegmentedControl
              aria-label={t(`settings.rules.actions.${action}`)}
              className="fdy-pa-segments"
              onValueChange={(decision) =>
                change({ policy: { ...draft.policy, [action]: decision } })
              }
              options={decisions.map((value) => ({
                value,
                label: t(`settings.rules.decision.${value}`),
              }))}
              size="sm"
              value={draft.policy[action] ?? defaultPolicy[action] ?? "ask"}
            />
          </li>
        ))}
      </ul>
      <div className="fdy-pa-never">
        <strong>{t("settings.rules.neverTitle")}</strong>
        <p>{t("settings.rules.neverBody")}</p>
      </div>
    </>
  );
}
