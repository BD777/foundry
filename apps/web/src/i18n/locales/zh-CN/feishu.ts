import type { feishu as en } from "../en/feishu";
import type { Translation } from "../../translation";

export const feishu: Translation<typeof en> = {
  readOnlyTitle: "只读权限",
  notices: {
    loadFailed: "获取飞书机器人配置失败：{{error}}",
    appIdRequired: "请输入飞书应用的 App ID。",
    saved: "飞书应用凭据已保存，正在建立长连接…",
    saveFailed: "保存失败：{{error}}",
    codeIssued: "配对码 {{code}} 已生成，请在飞书群内发送。",
    codeFailed: "生成配对码失败：{{error}}",
    unbindConfirm: "确定要解除当前飞书群与工作区的绑定吗？",
    unbound: "已解除飞书群关联。",
    unbindFailed: "解除绑定失败：{{error}}",
    commandCopied: "配对指令已复制到剪贴板。",
    commandText: "指令内容：{{command}}",
  },
  credentials: {
    title: "飞书机器人应用配置",
    intro:
      "配置当前工作区专属的飞书自建应用，服务将通过 WebSocket 长连接接收群话题与消息。",
    status: {
      connected: "长连接在线",
      connecting: "正在连接",
      error: "连接异常",
      notConfigured: "未配置",
    },
    appId: "App ID（应用唯一标识）",
    appIdPlaceholder: "例如：cli_a1b2c3d4e5f6g7h8",
    appSecret: "App Secret（应用凭据密钥）",
    appSecretSaved: "••••••••••••••••（已保存，如需修改请输入新密钥）",
    appSecretPlaceholder: "请输入 App Secret",
    showGuide: "飞书开放平台配置指引",
    hideGuide: "收起自建应用指引",
    saving: "正在连接…",
    save: "保存并连接",
    guideTitle: "飞书机器人自建指引",
    openPlatform: "飞书开放平台",
    guide: {
      step1:
        "在开放平台创建自建应用，并在「添加应用能力」中启用<b>「机器人」</b>；",
      step2:
        "在「事件与回调」配置中，事件订阅方式选择<b>「长连接模式（WebSocket）」</b>；",
      step3:
        "在事件列表中添加 <code>im.message.receive_v1</code>（接收消息）事件；",
      step4:
        "在「权限管理」中申请开通 <code>im:message</code>（获取和发送单聊/群聊消息）与 <code>im:chat</code> 权限；<b>如需在话题内直接跟帖追问（无需再次 @ 机器人）</b>，建议额外开通 <code>im:message.group_msg</code>（获取群组中所有消息）权限；",
      step5: "创建并发布应用版本后，将凭据与密钥填入上方输入框完成连接。",
    },
  },
  pairing: {
    title: "飞书群配对",
    intro:
      "将一个飞书群关联至工作区 <b>{{workspace}}</b>。群内的每个话题将独立映射为 Foundry 的 Agent 会话。",
    bound: "已绑定群聊",
    unbound: "未绑定群聊",
    defaultChatName: "飞书群聊",
    chatId: "群 ID：<code>{{id}}</code>",
    unbind: "解除绑定",
    mentionCommand: "@机器人 <需求>",
    pairCommand: "@机器人 /pair <配对码>",
    readyHint:
      "💡 <b>已就绪</b>：在群内发送 <code>{{command}}</code> 将自动开启一个会话，机器人在该话题中流式回复卡片；在话题下的连续跟帖将作为补充指令继续执行。",
    stepsIntro: "只需两步即可完成群聊绑定：",
    step1: "将你的飞书机器人拉入目标飞书群；",
    step2: "在群内艾特机器人并发送配对指令：<code>{{command}}</code>。",
    identityHint:
      "群里的请求将以<b>生成配对码的账号</b>身份执行，并受该账号在此工作区的权限约束（至少需要成员权限）。",
    commandLabel: "群配对指令（10 分钟内有效）",
    copyCommand: "复制指令",
    regenerate: "重新生成配对码",
    generating: "正在生成…",
    generate: "生成群配对码",
  },
};
