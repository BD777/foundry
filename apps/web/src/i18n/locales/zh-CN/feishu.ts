import type { feishu as en } from "../en/feishu";
import type { Translation } from "../../translation";

export const feishu: Translation<typeof en> = {
  notices: {
    loadFailed: "获取飞书机器人失败：{{error}}",
    saved: "机器人现在运行在 {{app}} 上。",
    saveFailed: "更换机器人应用失败：{{error}}",
    removed: "已从此工作区移除机器人。{{app}} 仍保留在连接器中。",
    removeFailed: "移除机器人失败：{{error}}",
    codeIssued: "配对码 {{code}} 已生成，请在飞书会话中发送。",
    codeFailed: "生成配对码失败：{{error}}",
    unbound: "{{chat}} 的消息不再发到这里。",
    unbindFailed: "解除绑定失败：{{error}}",
    nameRefreshed: "会话名称已更新为 {{chat}}。",
    nameUnchanged: "飞书中的会话名称仍是 {{chat}}。",
    nameRefreshFailed: "未能从飞书读取会话名称，仍显示 {{chat}}。{{error}}",
    commandCopied: "配对指令已复制到剪贴板。",
    commandText: "指令内容：{{command}}",
  },
  status: {
    connected: "已连接",
    connecting: "正在连接",
    error: "未连接",
    unconfigured: "未设置",
  },
  app: {
    title: "飞书机器人",
    intro:
      "成员通过机器人在飞书里使用此工作区。机器人运行在连接器中的一个飞书应用上；Foundry 保管该应用的密钥和唯一的长连接。",
    pick: "飞书应用",
    pickPlaceholder: "选择飞书应用",
    noChoices: "你在连接器中还没有飞书应用。先在那里连接一个，再回到这里选择。",
    connect: "去连接器连接应用",
    use: "用这个应用运行机器人",
    switch: "更换应用",
    switchConfirm: "解除 {{count}} 个会话并更换？",
    switchHint:
      "另一个飞书应用是另一个机器人：更换后，与当前机器人配对的会话会被解除。",
    working: "处理中…",
    manage: "在连接器中查看",
    otherOwner: "由其所有者在连接器中管理",
    personal: "个人应用",
    instance: "组织应用",
    optionMeta: "{{whose}} · ID …{{id}}",
    lastEvent: "最近事件 {{when}}",
    noEvent: "服务器启动以来尚无事件",
    remove: "移除机器人",
    removeConfirm: "从此工作区移除机器人？",
    rotateHint:
      "这个密钥以前存放在设备上。请在飞书中重置密钥，然后把新密钥粘贴到连接器。",
    rotateAction: "更新密钥",
    noSecret: "在连接器中粘贴应用密钥",
    secretMissing: "服务器上没有这个应用的密钥，机器人无法连接。",
    setupTitle: "飞书应用需要的配置",
    openPlatform: "飞书开放平台",
    guide: {
      step1:
        "一个启用了<b>「机器人」</b>能力的自建应用（连接器可以替你创建）。",
      step2:
        "在「事件与回调」中选择<b>「长连接模式（WebSocket）」</b>，并添加 <code>im.message.receive_v1</code> 事件。",
      step3:
        "开通 <code>im:message</code> 与 <code>im:chat</code> 权限；开通 <code>im:message.group_msg</code> 后，话题内跟帖无需再 @ 机器人。",
      step4: "发布一个应用版本。",
    },
  },
  chats: {
    title: "会话",
    intro:
      "每个已配对的会话都会把消息发到 <b>{{workspace}}</b>，每个话题成为一个独立的 Agent 会话。",
    count_one: "{{count}} 个会话",
    count_other: "{{count}} 个会话",
    empty: "还没有配对任何会话。",
    needsApp: "先选择机器人使用的应用，再在这里配对会话。",
    group: "群聊",
    direct: "单聊",
    defaultGroupName: "飞书群聊",
    defaultDirectName: "与机器人的单聊",
    unbind: "解除绑定",
    unbindConfirm: "确定解除这个会话？",
    refreshName: "刷新名称",
    shortId: "…{{id}}",
    readyHint:
      "在群里 @ 机器人并写下需求：<code>{{command}}</code>；在单聊中直接发送即可。机器人会在话题中回复，话题内的跟帖会继续这项工作。",
    mentionCommand: "@机器人 <需求>",
  },
  pairing: {
    title: "配对会话",
    step1: "把机器人拉进飞书群，或打开与它的单聊。",
    step2: "在那里发送配对指令（群里需 @ 机器人）：<code>{{command}}</code>。",
    pairCommand: "/pair <配对码>",
    identityHint:
      "会话中的请求将以<b>生成配对码的账号</b>身份执行，并受该账号在此工作区的权限约束（至少需要成员权限）。",
    commandLabel: "配对指令（{{time}} 前有效）",
    copyCommand: "复制指令",
    regenerate: "重新生成配对码",
    generating: "正在生成…",
    generate: "生成配对码",
    pending: "有一个配对码在 {{time}} 前有效；重新生成即可再次查看。",
  },
};
