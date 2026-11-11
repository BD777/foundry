import { useTranslation } from "react-i18next";
import type {
  PersonalAgentSettings,
  PersonalAgentUsage,
} from "@bd777/foundry-protocol";
import { FieldHint, TextInput } from "../../components/ui/field";
import { limitCaps, limitKeys, type LimitKey } from "./assistant-model";
import type { ChangeSettings } from "./settings-field";
import { PaMuted } from "./pa-muted";
import { DividedList } from "../../components/ui/divided-list";
import { FieldLabel, FormFieldGroup } from "../../components/ui/form-field";

/** The counter each limit applies to; the stuck time has none. */
const usageOf: Partial<Record<LimitKey, keyof PersonalAgentUsage>> = {
  concurrentSessions: "activeSessions",
  dailySessions: "sessionsToday",
  dailyWorkspaces: "workspacesToday",
  weeklyWorkspaces: "workspacesThisWeek",
  hourlyTurns: "turnsThisHour",
  dailyDigestSessions: "digestSessionsToday",
  monthlyTokenBudget: "tokensThisMonth",
};

/** §9's limits, each within its hard cap, beside what is used now. */
export function LimitsSection({
  draft,
  change,
  usage,
}: {
  draft: PersonalAgentSettings;
  change: ChangeSettings;
  usage: PersonalAgentUsage | undefined;
}) {
  const { t, i18n } = useTranslation("personalAgent");
  const number = new Intl.NumberFormat(i18n.language);
  return (
    <>
      <PaMuted className="max-w-[680px] leading-[1.6]" size="sm">
        {t("settings.limits.intro")}
      </PaMuted>
      <DividedList density="compact">
        {limitKeys.map((key) => {
          const id = `fdy-pa-limit-${key}`;
          const counter = usageOf[key];
          const max = limitCaps[key];
          return (
            <li
              className="grid grid-cols-[minmax(0,24rem)_minmax(0,1fr)] items-start gap-x-5 gap-y-1.5 max-[860px]:grid-cols-[minmax(0,1fr)]"
              key={key}
            >
              <FormFieldGroup>
                <FieldLabel htmlFor={id}>
                  {t(`settings.limits.labels.${key}`)}
                </FieldLabel>
                <TextInput
                  className="w-full"
                  id={id}
                  inputMode="numeric"
                  max={max}
                  min={key === "monthlyTokenBudget" ? 0 : 1}
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
              </FormFieldGroup>
              <PaMuted as="span" className="flex flex-wrap gap-x-2.5 gap-y-0.5">
                {usage && counter
                  ? t("settings.limits.now", {
                      value: number.format(usage[counter]),
                    })
                  : null}
                {max !== undefined ? (
                  <span>{t("settings.limits.max", { max })}</span>
                ) : null}
              </PaMuted>
            </li>
          );
        })}
      </DividedList>
      <FieldHint>{t("settings.limits.usageNote")}</FieldHint>
    </>
  );
}
