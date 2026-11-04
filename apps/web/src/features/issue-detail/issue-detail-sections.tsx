import { useTranslation } from "react-i18next";
import { ChecklistRow } from "../../components/ui/checklist-row";
import { Panel, SectionLabel } from "../../components/ui/panel";

export interface IssueCriteriaProps {
  criteria: string[];
}

export function IssueCriteria({ criteria }: IssueCriteriaProps) {
  const { t } = useTranslation("issueDetail");
  return (
    <section className="mb-5.5 w-full max-w-[760px] min-w-0">
      <SectionLabel>{t("sections.acceptanceCriteria")}</SectionLabel>
      <Panel className="mt-[9px] overflow-hidden px-4 py-1.5">
        {criteria.map((criterion) => (
          <ChecklistRow
            className="border-t border-line-soft py-[9px]"
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
