import type { IssueContract } from "@foundry/protocol";
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
  return (
    <div className="fdy-contract-summary">
      <section className="fdy-issue-card">
        <div className="fdy-issue-card-heading">
          <h3>任务目标</h3>
          <span>
            {contract.status === "confirmed" ? "已确认" : "待确认草案"} · 第{" "}
            {contract.revision} 版
          </span>
        </div>
        <p>{contract.goal.text || "还需要明确希望达成的结果。"}</p>
      </section>
      <section className="fdy-issue-card">
        <h3>完成标准</h3>
        {!contract.criteria.length ? (
          <p>还没有可观察的完成标准。请在聊天中告诉 Agent 你想解决什么问题。</p>
        ) : null}
        {contract.criteria.map((criterion, index) => (
          <article className="fdy-criterion-summary" key={criterion.id}>
            <h4>
              {index + 1}. {criterion.title}{" "}
              <span>{criterion.required ? "必须满足" : "补充目标"}</span>
            </h4>
            <p>{criterion.statement}</p>
            {compact ? (
              <details>
                <summary>如何验证与判断</summary>
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
                  <strong>如何验证：</strong>
                  {verificationMethod(criterion)}
                </p>
                <p>
                  <strong>判断依据：</strong>
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
          <h3>范围与限制</h3>
          {[
            ["本次包含", contract.inScope],
            ["本次不做", contract.outOfScope],
            ["必须遵守", contract.constraints],
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
          <h3>参考与背景</h3>
          <p>这些是判断方向的参考，不是执行结果的证明。</p>
          <ReferencePreviews
            issueId={contract.issueId}
            media={contract.goal.media}
          />
        </section>
      ) : null}
    </div>
  );
}
