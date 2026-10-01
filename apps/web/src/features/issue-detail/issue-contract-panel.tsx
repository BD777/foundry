import type { Issue } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { Alert } from "../../components/ui/alert";
import { ContractSummary } from "./contract-summary";
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
  const terminal = issue.status === "accepted" || issue.status === "abandoned";
  return (
    <>
      <p className="fdy-issue-tab-intro">{t("contractPanel.intro")}</p>
      {latest ? (
        <ContractSummary contract={controller.draft ?? confirmed ?? latest} />
      ) : (
        <section className="fdy-issue-card">
          <h3>{t("contractPanel.untitled")}</h3>
          <p>{issue.sourceInput}</p>
          <p>{t("contractPanel.legacyNote")}</p>
        </section>
      )}
      {!terminal ? (
        <section className="fdy-issue-card">
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
                void controller
                  .beginAmendment()
                  .then(onDiscuss)
                  .catch(() => {});
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
              onClick={() => void controller.discard().catch(() => {})}
            >
              {t("contractPanel.discard")}
            </Button>
          ) : null}
        </section>
      ) : null}
      <section className="fdy-issue-card">
        <details>
          <summary>{t("contractPanel.sourceInput")}</summary>
          <p>{issue.sourceInput}</p>
        </details>
        {latest ? (
          <details>
            <summary>{t("contractPanel.technical")}</summary>
            <p>{t("contractPanel.technicalNote")}</p>
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
      </section>
      {controller.error ? (
        <Alert tone="warning" title={t("contractPanel.errorTitle")}>
          {controller.error}
        </Alert>
      ) : null}
    </>
  );
}
