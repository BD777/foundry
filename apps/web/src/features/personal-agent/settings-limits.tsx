import { useTranslation } from "react-i18next";
import type { PersonalAgentSettings } from "@bd777/foundry-protocol";
import { TextInput } from "../../components/ui/field";
import type { ChangeSettings } from "./settings-field";
import { PaMuted } from "./pa-muted";
import { DividedList } from "../../components/ui/divided-list";
import { FieldLabel, FormFieldGroup } from "../../components/ui/form-field";

/** §9's one remaining limit: how long a task may go unanswered before it is reported as possibly stuck. A notice, not a cap. */
export function LimitsSection({
  draft,
  change,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
}) {
  const { t } = useTranslation("personalAgent");
  const id = "fdy-pa-limit-stuckAfterMinutes";
  return (
    <>
      <PaMuted className="max-w-[680px] leading-[1.6]" size="sm">
        {t("settings.limits.intro")}
      </PaMuted>
      <DividedList density="compact">
        <li className="grid grid-cols-[minmax(0,24rem)_minmax(0,1fr)] items-start gap-x-5 gap-y-1.5 max-[860px]:grid-cols-[minmax(0,1fr)]">
          <FormFieldGroup>
            <FieldLabel htmlFor={id}>
              {t("settings.limits.labels.stuckAfterMinutes")}
            </FieldLabel>
            <TextInput
              className="w-full"
              id={id}
              inputMode="numeric"
              min={1}
              onChange={(event) =>
                change({
                  limits: {
                    ...draft.limits,
                    stuckAfterMinutes:
                      event.target.value === ""
                        ? Number.NaN
                        : Number(event.target.value),
                  },
                })
              }
              tone="boxed"
              type="number"
              value={
                Number.isNaN(draft.limits.stuckAfterMinutes)
                  ? ""
                  : draft.limits.stuckAfterMinutes
              }
            />
          </FormFieldGroup>
        </li>
      </DividedList>
    </>
  );
}
