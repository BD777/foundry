import type { IssueContract } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { HelpHint } from "../../components/ui/help-hint";
import { ReferencePreviews } from "./evidence-preview";
import { evidenceRequirementText, verificationMethod } from "./issue-language";
import { IssueSection, IssueSubsection } from "./issue-section";

/** Shared by the conversation approval card and inspector: one saved version. */
export function ContractSummary({
  contract,
  compact = false,
}: {
  contract: IssueContract;
  compact?: boolean;
}) {
  const { t } = useTranslation("issueDetail");
  return (
    <div className="grid min-w-0 gap-4">
      <IssueSection>
        <div className="flex flex-wrap items-baseline gap-2">
          <h3>{t("contract.goal")}</h3>
          <span className="text-xs text-ink-muted">
            {contract.status === "confirmed"
              ? t("contract.confirmed")
              : t("contract.draft")}{" "}
            · {t("contract.revision", { revision: contract.revision })}
          </span>
        </div>
        <p>{contract.goal.text || t("contract.goalMissing")}</p>
      </IssueSection>
      <IssueSection>
        <h3>{t("contract.criteria")}</h3>
        {!contract.criteria.length ? <p>{t("contract.noCriteria")}</p> : null}
        {contract.criteria.map((criterion, index) => (
          <IssueSubsection divided={index > 0} key={criterion.id}>
            <h4>
              {index + 1}. {criterion.title}{" "}
              <span className="text-xs text-ink-muted">
                {criterion.required
                  ? t("shared.required")
                  : t("shared.optional")}
              </span>
            </h4>
            <p>{criterion.statement}</p>
            {compact ? (
              <details>
                <summary>{t("contract.howVerified")}</summary>
                <p>{verificationMethod(criterion)}</p>
                <p>{criterion.rubric.text}</p>
                <ul>
                  {evidenceRequirementText(criterion).map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
              </details>
            ) : (
              <>
                <p>
                  <strong>{t("contract.howVerify")}</strong>
                  {verificationMethod(criterion)}
                </p>
                <p>
                  <strong>{t("contract.basis")}</strong>
                  {criterion.rubric.text}
                </p>
                <ul>
                  {evidenceRequirementText(criterion).map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
              </>
            )}
            {!compact ? (
              <ReferencePreviews
                issueId={contract.issueId}
                media={criterion.rubric.media}
              />
            ) : null}
          </IssueSubsection>
        ))}
      </IssueSection>
      {contract.inScope.length +
        contract.outOfScope.length +
        contract.constraints.length >
      0 ? (
        <IssueSection>
          <h3>{t("contract.scope")}</h3>
          {[
            [t("contract.inScope"), contract.inScope],
            [t("contract.outOfScope"), contract.outOfScope],
            [t("contract.constraints"), contract.constraints],
          ].map(([label, values]) =>
            (values as string[]).length ? (
              <div key={label as string}>
                <h4>{label}</h4>
                <ul>
                  {(values as string[]).map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </IssueSection>
      ) : null}
      {!compact && contract.goal.media.length ? (
        <IssueSection>
          <h3 className="flex items-center gap-1.5">
            {t("contract.references")}
            <HelpHint label={t("contract.referencesHelp")}>
              {t("contract.referencesNote")}
            </HelpHint>
          </h3>
          <ReferencePreviews
            issueId={contract.issueId}
            media={contract.goal.media}
          />
        </IssueSection>
      ) : null}
    </div>
  );
}
