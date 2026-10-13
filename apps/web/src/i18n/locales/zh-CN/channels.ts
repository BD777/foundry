import type { channels as en } from "../en/channels";
import type { Translation } from "../../translation";

export const channels: Translation<typeof en> = {
  readOnlyTitle: "只读权限",
  web: {
    title: "网页对话",
    detail: "此工作区始终可用。",
    open: "打开对话",
  },
  types: {
    feishu_bot: { title: "飞书机器人" },
  },
};
