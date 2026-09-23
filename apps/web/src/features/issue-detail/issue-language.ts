import type {
  AcceptanceCriterion,
  CarrierKind,
  CriterionReviewEntry,
  Issue,
  ReviewBlocker,
} from "@foundry/protocol";

const carriers: Record<CarrierKind, string> = {
  text_log: "运行日志",
  image: "截图或图片",
  video: "录屏",
  audio: "音频",
  http_exchange: "实际请求和响应",
  test_report: "测试报告",
  data: "数据",
  document: "交付文稿",
  file: "交付文件",
  other: "实际材料",
};

export function verificationMethod(criterion: AcceptanceCriterion): string {
  if (criterion.evaluationMode === "agent")
    return "由独立 Agent 阅读实际材料，按下面的标准初判；不是实现 Agent 自述完成。";
  return criterion.checker
    ? `用固定程序检查：${criterion.checker.description}`
    : "计划用固定程序检查；检查器尚未准备好，目前还不能得出通过结论。";
}

export function evidenceRequirementText(
  criterion: AcceptanceCriterion,
): string[] {
  return criterion.evidenceRequirements.map(
    (r) =>
      `${r.description}（至少 ${r.minimumCount} 份；${r.acceptedCarriers.map((c) => carriers[c]).join(" / ")}）`,
  );
}

export function issuePhase(issue: Issue) {
  if (issue.status === "accepted")
    return {
      title: "已接受并集成",
      next: "成果已进入 Workspace；可查看当时的验收记录。",
      tab: "evidence" as const,
    };
  if (issue.status === "abandoned")
    return {
      title: "已放弃",
      next: "对话与候选仍保留，不会继续执行或集成。",
      tab: "details" as const,
    };
  if (issue.contractState !== "confirmed")
    return {
      title: issue.currentContractRevision
        ? "标准修改待确认"
        : "正在明确目标与标准",
      next: "在主聊天里回答问题或调整要求；确认前不会开始新的实现。",
      tab: "details" as const,
    };
  if (issue.status === "in_progress")
    return {
      title: "正在执行",
      next: "Agent 正按已确认标准工作；可以在聊天中提供执行反馈。",
      tab: "details" as const,
    };
  if (issue.status === "verifying")
    return {
      title: "等待验收",
      next: "查看实际材料与判断；缺少证据或标准未通过时不能接受。",
      tab: "evidence" as const,
    };
  if (issue.status === "blocked")
    return {
      title: "需要处理阻碍",
      next: issue.blockedReason?.message ?? "查看主对话中的原因，处理后继续。",
      tab: "environment" as const,
    };
  return {
    title: "等待执行",
    next: "标准已确认，正在等待设备和执行容量。",
    tab: "environment" as const,
  };
}

export function isStatusQuestion(text: string): boolean {
  return /^(这里|现在|当前|这个任务|任务)?(是)?什么状态[？?。!！\s]*$|^(现在|目前)?(进度如何|到哪了|在做什么|为什么没开始)[？?。!！\s]*$|^(what(?:'s| is) (?:the |current )?status|status|any update)[?.!\s]*$/i.test(
    text.trim(),
  );
}

export function verdictText(entry: CriterionReviewEntry): string {
  if (entry.freshness === "stale")
    return "需要重新检查：这份结果不再适用于当前版本。";
  if (entry.effectiveVerdict === "not_evaluated")
    return "尚未检查：请先采集材料并开始验证。";
  if (entry.evidenceAvailability !== "available")
    return "依据不可用：恢复原始材料后才能接受。";
  if (entry.freshness === "unknown")
    return "暂不能确认结果是否适用于当前版本。";
  return {
    pass: "检查通过",
    fail: "未达到约定，需要修改",
    inconclusive: "尚不能判断，需要补充材料或澄清发现",
  }[entry.effectiveVerdict];
}

export function verificationErrorText(message: string): string {
  if (/operation is busy/i.test(message))
    return "同一任务的检查发生资源冲突，尚未形成结果。等待当前检查结束后重试。";
  if (/offline/i.test(message))
    return "执行设备暂时离线。恢复连接后再检查，已有材料与记录保留。";
  if (/timeout|timed.out/i.test(message))
    return "检查未在时限内完成。请查看技术记录，确认上一轮结果后再重试。";
  if (/task_outcome_unknown|interrupted/i.test(message))
    return "上一轮检查结果尚未确认。系统会尝试恢复已保存结果，不会自动重复执行。";
  return "检查遇到技术问题，尚未形成可靠结果。展开技术记录查看原因，处理后重新检查。";
}

export function blockerText(blocker: ReviewBlocker): string {
  const labels: Record<ReviewBlocker["code"], string> = {
    contract_unconfirmed: "完成标准尚未确认。请回到主聊天核对草案。",
    contract_amendment_pending: "有待确认的标准修改。确认或撤回后再继续。",
    checker_missing: "固定检查器尚未准备好，不能把实现说明当成通过。",
    verification_pending: "仍有条件等待检查或正在检查，请等待结果。",
    verification_error: "检查没有正常完成。查看原因后重新检查。",
    required_failed: "有必须满足的标准未通过，请在主聊天中要求修复。",
    required_inconclusive: "有必须满足的标准还无法判断，需要补充依据。",
    evidence_missing: "实际材料不足，先采集对应的交付文件或其他约定材料。",
    input_unbound: "尚不能证明验证环境对应当前候选，不能接受。",
    stale: "结果已过期，需要对当前版本重新检查。",
    material_unavailable: "原始材料当前无法读取，恢复设备或材料后再检查。",
    candidate_changed: "候选内容或其可用性已变化，需要核对并重新采集验证。",
    baseline_changed: "Workspace 基线已变化，需要对齐后重新验证和批准。",
  };
  return labels[blocker.code];
}
