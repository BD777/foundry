import type { sharing as en } from "../en/sharing";
import type { Translation } from "../../translation";

export const sharing: Translation<typeof en> = {
  updateFailed: "无法更新共享设置",
  thisDevice: "这个工作区所在的设备",
  itsOwner: "设备所有者",
  add: {
    title: "添加成员",
    body: "输入对方 Foundry 账号的准确用户名。",
    username: "要添加的用户名",
    usernamePlaceholder: "用户名",
    role: "新成员的角色",
    submit: "添加",
    submitting: "正在添加…",
    invite: "邀请新用户",
  },
  runsCode: {
    title: "这个角色可以运行代码",
    body: "{{role}}可以在这个工作区内发起对话和 Issue，它们会以 {{owner}} 的系统账号在 {{device}} 上运行命令。只需要查看的人请选择查看者。",
  },
  inviteLink: {
    body: "新账号的邀请链接，加入后角色为{{role}} · 只显示一次，7 天后失效",
    label: "邀请链接",
    copy: "复制链接",
  },
  people: {
    title: "有权访问的人",
    manageHint: "所有者管理谁可以查看和运行这个工作区。",
    readOnlyHint: "只有所有者可以更改访问权限。",
  },
  member: {
    you: "{{name}}（你）",
    deviceOwner: "设备所有者",
    disabled: "已停用",
    roleFor: "{{name}} 的角色",
    leave: "退出",
    leaveConfirm: "确定永久退出？",
    remove: "移除",
    removeConfirm: "确定移除访问权限？",
  },
  roleDetails: {
    viewer: "查看 Issue、对话、证据和文件",
    member: "还可以对话、创建并运行自己的 Issue",
    maintainer: "还可以接受工作成果，管理 Skills 和飞书",
    owner: "还可以管理成员、重命名和移除工作区",
  },
};
