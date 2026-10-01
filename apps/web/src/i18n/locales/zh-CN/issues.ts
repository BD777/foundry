import type { issues as en } from "../en/issues";
import type { Translation } from "../../translation";

export const issues: Translation<typeof en> = {
  status: {
    pending: "待处理",
    in_progress: "进行中",
    blocked: "受阻",
    verifying: "验收中",
    accepted: "已接受",
    abandoned: "已放弃",
  },
  blocked: {
    defaultMessage: "请提供继续所需的信息或决定。",
    reason: {
      needs_input: "需要补充信息",
      needs_permission: "需要授权",
      system_error: "系统错误",
    },
    badge: {
      needs_input: "等你回复",
      needs_permission: "需要授权",
      system_error: "需要处理",
    },
  },
  readiness: {
    direction: "需要人来定方向",
    inferring: "正在判断是否可执行…",
    proposal: "需要方案",
    ready: "可以执行",
    split: "需要拆分",
    unsuitable: "不适合自动执行",
    amendmentPending: "标准修改待确认",
    awaitingContract: "等待确认完成标准",
  },
  phase: {
    preparing: "正在准备执行",
  },
  review: {
    needsAttention: "需要处理",
    awaitingReview: "等你验收",
    reviewCandidate: "验收候选",
  },
  template: {
    blocked: "说明继续所需的信息或决定。",
    pending: "记下这个想法，整理目标和完成标准。",
    accepted: "在上次接受的工作区改动之后，描述后续要做的事。",
    in_progress: "创建一个可以在本地开始执行的 Issue。",
    verifying: "创建一个验收标准清楚的 Issue。",
    abandoned: "在放弃的 Issue 之后，描述新的方向。",
  },
  card: {
    open: "打开 {{id}}",
    accepted: "已接受",
    priority: {
      high: "高",
      medium: "中",
      low: "低",
    },
  },
  board: {
    add: "添加“{{status}}”Issue",
    empty: "没有 Issue",
  },
  list: {
    id: "ID",
    issue: "Issue",
    status: "状态",
    runtime: "运行时",
    updated: "更新",
  },
  strip: {
    clean: "{{baseline}} · 无改动",
    counts: "已接受 {{accepted}} · 已解决 {{resolved}}",
    viewLabel: "工作区视图",
  },
  page: {
    viewLabel: "Issue 视图",
    board: "看板",
    list: "列表",
    inputLabel: "新 Issue 输入",
    placeholder: "描述要 Claude 或 Codex 在这个工作区完成的任务…",
    agentLabel: "Issue Agent",
    submit: "提交 Issue",
    opening: "正在打开",
    needsAgent: "先在设置中配置 Agent，才能创建 Issue",
    hint: "先描述目标，进入主对话后可上传参考。确认完成标准后才开始执行。",
  },
  notices: {
    needsRealAgent: "请先在设置中配置一个真实的 Agent。",
    stillSaving: "当前 Issue 还在保存中。",
    describeFirst: "请先描述 Issue。",
    creating: "正在创建 Issue…",
    created: "Issue 已创建 · 等待确认完成标准",
    unreachable: "无法连接本地 API，Issue 没有创建。",
  },
  worker: {
    title: "这台设备的 Worker 需要更新",
    body: "它可以澄清和验收，但还不能执行已确认的 Issue；确认后的 Issue 会一直等待。在这台设备上运行 <code>{{command}}</code> 更新后即可执行。",
  },
  models: {
    providerDefault: "服务商默认",
  },
};
