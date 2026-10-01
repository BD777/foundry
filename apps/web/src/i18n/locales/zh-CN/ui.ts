import type { ui as en } from "../en/ui";
import type { Translation } from "../../translation";

export const ui: Translation<typeof en> = {
  alert: {
    diagnosticDetails: "诊断详情",
  },
  authorization: {
    openPage: "打开授权页面",
    enterCode: "在授权页面输入代码 <code>{{code}}</code>。",
    resultLabel: "授权码或回调 URL",
    resultPlaceholder: "粘贴授权码或回调 URL",
    complete: "完成授权",
    check: "检查授权",
  },
  errorBoundary: {
    title: "{{label}} 暂时无法显示",
    stillAvailable: "Foundry 的其他区域仍可正常使用。",
    reload: "重新加载页面",
    tryAgain: "重试",
  },
  fileDiff: {
    layout: "差异布局",
    unified: "合并",
    split: "并排",
    calculating: "正在计算此文件的差异…",
    noChanges: "没有文本改动。",
    addedLine: "新增行",
    removedLine: "删除行",
    errors: {
      timedOut: "差异计算超时。请下载归档后在外部比较。",
      display: "无法显示此差异。",
      worker: "无法加载差异计算程序。",
      failed: "无法计算此文件的差异。",
      longLines: "此文件包含超长的行。请下载归档后在外部比较。",
      tooLarge: "此文件太大，无法内联显示差异。请下载归档查看完整内容。",
      timeLimit: "差异计算达到时间上限。请下载归档后在外部比较。",
      tooManyLines: "此差异超过 5,000 行。请下载归档查看全部改动。",
    },
  },
  selectMenu: {
    placeholder: "请选择",
  },
  slashMenu: {
    label: "Skills",
    empty:
      "没有匹配“{{query}}”的 Skill。请在工作区 → Skills 中推广并选择一个。",
  },
};
