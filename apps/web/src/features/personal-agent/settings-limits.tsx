import { useTranslation } from "react-i18next";
import type {
  PersonalAgentSettings,
  PersonalAgentUsage,
} from "@bd777/foundry-protocol";
import { FieldHint, TextInput } from "../../components/ui/field";
import { limitCaps, limitKeys, type LimitKey } from "./assistant-model";
import type { ChangeSettings } from "./settings-field";

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
      <p className="fdy-pa-intro">{t("settings.limits.intro")}</p>
      <ul className="fdy-pa-limits">
        {limitKeys.map((key) => {
          const id = `fdy-pa-limit-${key}`;
          const counter = usageOf[key];
          const max = limitCaps[key];
          return (
            <li className="fdy-pa-limit" key={key}>
              <label className="fdy-pa-field-label" htmlFor={id}>
                {t(`settings.limits.labels.${key}`)}
              </label>
              <TextInput
                className="fdy-pa-number"
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
                value={Number.isNaN(draft.limits[key]) ? "" : draft.limits[key]}
              />
              <span className="fdy-pa-limit-meta fdy-pa-muted">
                {usage && counter
                  ? t("settings.limits.now", {
                      value: number.format(usage[counter]),
                    })
                  : null}
                {max !== undefined ? (
                  <span>{t("settings.limits.max", { max })}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <FieldHint>{t("settings.limits.usageNote")}</FieldHint>
    </>
  );
}
