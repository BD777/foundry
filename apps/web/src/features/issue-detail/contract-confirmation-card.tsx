import type { Issue } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Alert } from "../../components/ui/alert";
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
  const problems = controller.confirmProblems;
  if (!draft?.criteria.length) return null;
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
      {problems?.length ? (
        <Alert tone="warning" title={t("confirmation.blocked")}>
          <ul>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <Button
        className="fdy-contract-confirm-action"
        disabled={
          problems?.length !== 0 ||
          controller.busy ||
          controller.replying ||
          issue.status === "in_progress"
        }
        onClick={() => void controller.confirm(draft)}
      >
        {t("confirmation.confirm")}
      </Button>
    </div>
  );
}
