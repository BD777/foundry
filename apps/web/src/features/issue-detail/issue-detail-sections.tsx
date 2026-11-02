import { useTranslation } from "react-i18next";
import { ChecklistRow } from "../../components/ui/checklist-row";
import { Panel, SectionLabel } from "../../components/ui/panel";

export interface IssueCriteriaProps {
  criteria: string[];
}

export function IssueCriteria({ criteria }: IssueCriteriaProps) {
  const { t } = useTranslation("issueDetail");
  return (
    <section className="fdy-detail-block">
      <SectionLabel>{t("sections.acceptanceCriteria")}</SectionLabel>
      <Panel className="fdy-criteria-panel">
        {criteria.map((criterion) => (
          <ChecklistRow
            className="fdy-criteria-row"
            key={criterion}
            marker="dot"
            tone="neutral"
          >
            {criterion}
          </ChecklistRow>
        ))}
      </Panel>
    </section>
  );
}
