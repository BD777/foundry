import type { Issue } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { isIssueClosed } from "../../lib/issue-meta";
import { ContractSummary } from "./contract-summary";
import { IssueSection } from "./issue-section";
import type { IssueContractController } from "./use-issue-contract";

export function IssueContractPanel({
  issue,
  controller,
  onDiscuss,
}: {
  issue: Issue;
  controller: IssueContractController;
  onDiscuss: () => void;
}) {
  const { t } = useTranslation("issueDetail");
  const { latest, busy, confirmed } = controller;
  const terminal = isIssueClosed(issue);
  return (
    <>
      {latest ? (
        <ContractSummary contract={controller.draft ?? confirmed ?? latest} />
      ) : (
        <IssueSection>
          <h3>{t("contractPanel.untitled")}</h3>
          <p>{issue.sourceInput}</p>
        </IssueSection>
      )}
      {!terminal && latest ? (
        <IssueSection>
          <h3>
            {controller.draft
              ? t("contractPanel.continueTitle")
              : t("contractPanel.amendTitle")}
          </h3>
          <p>
            {controller.draft
              ? t("contractPanel.draftBody")
              : t("contractPanel.amendBody")}
          </p>
          <Button
            variant="secondary"
            disabled={busy || issue.status === "in_progress"}
            onClick={() => {
              if (controller.draft) onDiscuss();
              else
                void controller.beginAmendment(latest).then((done) => {
                  if (done) onDiscuss();
                });
            }}
          >
            {controller.draft
              ? t("view.gotoChat")
              : t("contractPanel.beginAmendment")}
          </Button>
          {controller.draft && confirmed ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void controller.discard()}
            >
              {t("contractPanel.discard")}
            </Button>
          ) : null}
        </IssueSection>
      ) : null}
      <IssueSection>
        <details>
          <summary>{t("contractPanel.sourceInput")}</summary>
          <p>{issue.sourceInput}</p>
        </details>
        {latest ? (
          <details>
            <summary>{t("contractPanel.technical")}</summary>
            <pre>{JSON.stringify(latest, null, 2)}</pre>
            <ul>
              {controller.contracts.map((c) => (
                <li key={c.id}>
                  {t("contractPanel.revisionLine", {
                    revision: c.revision,
                    status: c.status,
                    reason: c.changeReason ?? t("contractPanel.originalGoal"),
                  })}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </IssueSection>
      {controller.error ? (
        <Alert tone="warning" title={t("contractPanel.errorTitle")}>
          {controller.error}
        </Alert>
      ) : null}
    </>
  );
}
