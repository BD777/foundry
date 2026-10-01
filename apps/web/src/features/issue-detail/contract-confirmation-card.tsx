import type { Issue } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { ContractSummary } from "./contract-summary";
import type { IssueContractController } from "./use-issue-contract";

export function ContractConfirmationCard({
  issue,
  controller,
}: {
  issue: Issue;
  controller: IssueContractController;
}) {
  const { t } = useTranslation("issueDetail");
  const draft = controller.draft;
  if (!draft || !draft.criteria.some((c) => c.required)) return null;
  return (
    <div
      className="fdy-contract-confirmation"
      data-contract-revision={draft.revision}
    >
      <h3>{t("confirmation.title")}</h3>
      <p>{t("confirmation.body", { revision: draft.revision })}</p>
      {draft.changeReason ? (
        <details>
          <summary>{t("confirmation.basis")}</summary>
          <p>{draft.changeReason}</p>
        </details>
      ) : null}
      <ContractSummary contract={draft} compact />
      <Button
        disabled={controller.busy || issue.status === "in_progress"}
        onClick={() => void controller.confirm(draft).catch(() => {})}
      >
        {t("confirmation.confirm")}
      </Button>
    </div>
  );
}
