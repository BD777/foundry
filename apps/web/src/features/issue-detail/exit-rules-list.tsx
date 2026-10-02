import { useTranslation } from "react-i18next";
import type { ExitRuleResults } from "@bd777/foundry-protocol";
import { ChecklistRow } from "../../components/ui/checklist-row";

/** The numbered exit rules this review was judged by, and which hold. */
export function ExitRulesList({ rules }: { rules: ExitRuleResults }) {
  const { t } = useTranslation("issueDetail");
  return (
    <div className="fdy-exit-rules" aria-label={t("exitRules.label")}>
      <p className="fdy-detail-helper-copy">
        {t("exitRules.version", { version: rules.version })}
      </p>
      {rules.results.map((rule) => (
        <ChecklistRow
          key={rule.ruleId}
          marker={rule.satisfied ? "check" : "dot"}
          tone={rule.satisfied ? "success" : "warning"}
        >
          <strong>{rule.ruleId}</strong> {t(`exitRules.rules.${rule.ruleId}`)}
          {rule.satisfied ? null : (
            <span className="fdy-exit-rule-state">
              {" "}
              · {t("exitRules.notYet")}
            </span>
          )}
        </ChecklistRow>
      ))}
    </div>
  );
}
