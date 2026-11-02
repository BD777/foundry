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
};
