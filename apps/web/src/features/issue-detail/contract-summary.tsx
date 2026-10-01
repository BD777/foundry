import type { IssueContract } from "@bd777/foundry-protocol";
import { useTranslation } from "react-i18next";
import { ReferencePreviews } from "./evidence-preview";
import { evidenceRequirementText, verificationMethod } from "./issue-language";

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
    <div className="fdy-contract-summary">
      <section className="fdy-issue-card">
        <div className="fdy-issue-card-heading">
          <h3>{t("contract.goal")}</h3>
          <span>
            {contract.status === "confirmed"
              ? t("contract.confirmed")
              : t("contract.draft")}{" "}
            · {t("contract.revision", { revision: contract.revision })}
          </span>
        </div>
        <p>{contract.goal.text || t("contract.goalMissing")}</p>
      </section>
      <section className="fdy-issue-card">
        <h3>{t("contract.criteria")}</h3>
        {!contract.criteria.length ? <p>{t("contract.noCriteria")}</p> : null}
        {contract.criteria.map((criterion, index) => (
          <article className="fdy-criterion-summary" key={criterion.id}>
            <h4>
              {index + 1}. {criterion.title}{" "}
              <span>
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
          </article>
        ))}
      </section>
      {contract.inScope.length +
        contract.outOfScope.length +
        contract.constraints.length >
      0 ? (
        <section className="fdy-issue-card">
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
        </section>
      ) : null}
      {!compact && contract.goal.media.length ? (
        <section className="fdy-issue-card">
          <h3>{t("contract.references")}</h3>
          <p>{t("contract.referencesNote")}</p>
          <ReferencePreviews
            issueId={contract.issueId}
            media={contract.goal.media}
          />
        </section>
      ) : null}
    </div>
  );
}
