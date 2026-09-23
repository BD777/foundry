import type { Issue } from "@foundry/protocol";
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
  const draft = controller.draft;
  if (!draft || !draft.criteria.some((c) => c.required)) return null;
  return (
    <div
      className="fdy-contract-confirmation"
      data-contract-revision={draft.revision}
    >
      <h3>请核对这版完成标准</h3>
      <p>
        下面是实际保存的第 {draft.revision}{" "}
        版。确认后才会开始实现；要调整，直接在下方聊天。
      </p>
      {draft.changeReason ? (
        <details>
          <summary>本次整理依据</summary>
          <p>{draft.changeReason}</p>
        </details>
      ) : null}
      <ContractSummary contract={draft} compact />
      <Button
        disabled={controller.busy || issue.status === "in_progress"}
        onClick={() => void controller.confirm(draft).catch(() => {})}
      >
        确认标准并开始
      </Button>
    </div>
  );
}
