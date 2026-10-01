import type { assets as en } from "../en/assets";
import type { Translation } from "../../translation";

export const assets: Translation<typeof en> = {
  device: {
    section: "设备",
    logs: "日志",
    openLogs: "打开设备日志",
    refresh: "刷新",
    refreshDevice: "刷新设备",
    workersActive_one: "{{count}} 个 Worker 运行中",
    workersActive_other: "{{count}} 个 Worker 运行中",
    noDevice: "没有设备",
    lastConnected: "{{device}} · 最近连接 {{when}}",
    justNow: "刚刚",
    never: "从未",
    online: "在线",
    offline: "离线",
    workdir: "工作目录",
    agents: "Agent",
    agentsConfigured: "已配置 {{configured}}/{{total}}",
    scope: "范围",
    localDevice: "本地设备",
  },
  status: {
    missing: "缺失",
    available: "可用",
    synced: "已同步",
    present: "已存在",
    notReported: "守护进程未上报",
  },
  capacity: {
    title: "执行容量",
    worktreePool: "Worktree 池",
    previewPorts: "预览端口",
    artifactArchive: "产物归档",
  },
  context: {
    title: "上下文",
    workspace: "工作区",
    workspaceMeta: "{{name}} · 配置的基线：{{baseline}}",
    skillsConfig: "Skills 配置",
    skillsMeta_one: "{{count}} 个 Skill · {{path}}",
    skillsMeta_other: "{{count}} 个 Skills · {{path}}",
  },
};
