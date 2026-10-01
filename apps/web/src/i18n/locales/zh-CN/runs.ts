import type { runs as en } from "../en/runs";
import type { Translation } from "../../translation";

export const runs: Translation<typeof en> = {
  phase: {
    executing: "执行中",
    complete: "已完成",
    failed: "失败",
    queued: "排队中",
    canceled: "已停止",
  },
  status: {
    blocked: "受阻",
    canceled: "已停止",
    completed: "成功",
    failed: "失败",
    queued: "排队中",
    running: "运行中",
  },
  duration: {
    minutes: "{{minutes}} 分 {{seconds}} 秒",
    seconds: "{{seconds}} 秒",
  },
  filter: {
    label: "按运行状态筛选",
    all: "全部",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
  },
  empty: {
    title: "没有运行记录",
    body: "本地 Worker 认领 Issue 后，这里会出现运行记录。",
  },
  table: {
    label: "运行记录表",
    mobileLabel: "运行记录列表",
    run: "运行",
    issue: "Issue",
    runtime: "运行时",
    phase: "阶段",
    duration: "耗时",
    status: "状态",
  },
};
