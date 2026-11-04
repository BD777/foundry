import { useTranslation } from "react-i18next";
import type { ExitRuleResults } from "@bd777/foundry-protocol";
import { ChecklistRow } from "../../components/ui/checklist-row";
import { IssueMetaLine } from "./issue-section";

/** The numbered exit rules this review was judged by, and which hold. */
export function ExitRulesList({ rules }: { rules: ExitRuleResults }) {
  const { t } = useTranslation("issueDetail");
  return (
    <div className="grid gap-1.5" aria-label={t("exitRules.label")}>
      <IssueMetaLine>
        {t("exitRules.version", { version: rules.version })}
      </IssueMetaLine>
      {rules.results.map((rule) => (
        <ChecklistRow
          key={rule.ruleId}
          marker={rule.satisfied ? "check" : "dot"}
          tone={rule.satisfied ? "success" : "warning"}
        >
          <strong>{rule.ruleId}</strong> {t(`exitRules.rules.${rule.ruleId}`)}
          {rule.satisfied ? null : (
            <span className="text-ink-muted"> · {t("exitRules.notYet")}</span>
          )}
        </ChecklistRow>
      ))}
    </div>
  );
}
