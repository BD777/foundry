import type { Issue } from "@foundry/protocol";
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
  const { latest, busy, confirmed } = controller;
  const terminal = issue.status === "accepted" || issue.status === "abandoned";
  return (
    <>
      <p className="fdy-issue-tab-intro">
        这里保留我们约定的目标和检查方式。需要调整时，请回到主聊天。
      </p>
      {latest ? (
        <ContractSummary contract={controller.draft ?? confirmed ?? latest} />
      ) : (
        <section className="fdy-issue-card">
          <h3>目标尚未整理</h3>
          <p>{issue.sourceInput}</p>
          <p>历史文字不会自动变成已确认标准。</p>
        </section>
      )}
      {!terminal ? (
        <section className="fdy-issue-card">
          <h3>{controller.draft ? "继续讨论" : "需要调整约定？"}</h3>
          <p>
            {controller.draft
              ? "主聊天中的确认卡片与这里来自同一份草案。普通“继续”不会启动实现。"
              : "执行反馈不会改写标准。发起调整会暂停新的执行和验收，等待你重新确认。"}
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
            {controller.draft ? "回到主聊天" : "发起标准调整"}
          </Button>
          {controller.draft && confirmed ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void controller.discard().catch(() => {})}
            >
              撤回调整，保留已确认标准
            </Button>
          ) : null}
        </section>
      ) : null}
      <section className="fdy-issue-card">
        <details>
          <summary>原始输入</summary>
          <p>{issue.sourceInput}</p>
        </details>
        {latest ? (
          <details>
            <summary>技术详情与版本记录</summary>
            <p>内部身份仅用于审计，不需要手动编辑。</p>
            <pre>{JSON.stringify(latest, null, 2)}</pre>
            <ul>
              {controller.contracts.map((c) => (
                <li key={c.id}>
                  第 {c.revision} 版 · {c.status} ·{" "}
                  {c.changeReason ?? "原始目标"}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
      {controller.error ? (
        <Alert tone="warning" title="操作尚未完成">
          {controller.error}
        </Alert>
      ) : null}
    </>
  );
}
