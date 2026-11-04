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
import { PaMuted } from "./pa-muted";
import { DividedList } from "../../components/ui/divided-list";

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
      <PaMuted className="max-w-[680px] leading-[1.6]" size="sm">
        {t("settings.rules.intro")}
      </PaMuted>
      <SettingsGroup>
        <SettingsField
          hint={preset ? undefined : t("settings.rules.custom")}
          label={t("settings.rules.presets")}
        >
          <SegmentedControl<string>
            aria-label={t("settings.rules.presets")}
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
      <DividedList density="cozy">
        {personalAgentActions.map((action) => (
          <li
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 max-[860px]:grid-cols-[minmax(0,1fr)]"
            key={action}
          >
            <span
              className="text-sm leading-[1.45] text-ink"
              id={`fdy-pa-rule-${action}`}
            >
              {t(`settings.rules.actions.${action}`)}
              {action === "archive_session" ? (
                <FieldHint as="small">
                  {t("settings.rules.archiveSessionHint")}
                </FieldHint>
              ) : null}
            </span>
            <SegmentedControl
              aria-label={t(`settings.rules.actions.${action}`)}
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
      </DividedList>
      <div className="grid gap-1 rounded-lg bg-panel-soft px-3.5 py-3">
        <strong className="text-sm text-ink">
          {t("settings.rules.neverTitle")}
        </strong>
        <PaMuted className="leading-[1.55]">
          {t("settings.rules.neverBody")}
        </PaMuted>
      </div>
    </>
  );
}
