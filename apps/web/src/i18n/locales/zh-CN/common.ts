import type { common as en } from "../en/common";
import type { Translation } from "../../translation";

export const common: Translation<typeof en> = {
  actions: {
    save: "保存",
    saving: "正在保存…",
    cancel: "取消",
    copy: "复制",
    copied: "已复制",
    retry: "重试",
    refresh: "刷新",
    close: "关闭",
    pleaseWait: "请稍候…",
  },
  states: {
    loading: "正在加载…",
    saving: "正在保存…",
  },
  roles: {
    admin: "管理员",
    member: "成员",
    viewer: "查看者",
    maintainer: "维护者",
    owner: "所有者",
  },
  roleNouns: {
    admin: "管理员",
    member: "成员",
    viewer: "查看者",
    maintainer: "维护者",
    owner: "所有者",
  },
  access: {
    denied: "你在这个工作区是{{have}}；这项操作需要{{need}}或更高的角色。",
  },
  errors: {
    serverUnreachable: "Foundry 服务器没有响应，请重试。",
  },
  language: {
    label: "语言",
    followBrowser: "跟随浏览器",
    en: "English",
    "zh-CN": "简体中文",
  },
};
