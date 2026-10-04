import type { devices as en } from "../en/devices";
import type { Translation } from "../../translation";

export const devices: Translation<typeof en> = {
  list: {
    title: "设备",
    intro: "选择一台设备，浏览它的工作区、管理 Agent 登录，或配置执行。",
    add: "添加设备",
    workspaceCount_one: "{{count}} 个工作区",
    workspaceCount_other: "{{count}} 个工作区",
    view: "查看 →",
    sharedWithYou: "与你共享",
    actionsFor: "{{device}} 的操作",
    removeFromFoundry: "从 Foundry 移除…",
    emptyTitle: "还没有连接设备",
    emptyBody:
      "点击“添加设备”，把一个 Foundry Worker 与这台服务器配对。配对后它会出现在这里，并列出已注册的工作区。",
  },
  status: {
    online: "在线",
    offline: "离线",
  },
  detail: {
    notFoundTitle: "找不到设备",
    notFoundBody: "这台设备已不再注册。你当前的工作区没有变化。",
    backToDevices: "返回设备列表",
    allDevices: "全部设备",
    ownedNote: "设备设置 · 查看这台设备不会切换你的工作区。",
    sharedNote: "共享设备 · 查看这台设备不会切换你的工作区。",
    offline:
      "这台设备已离线。已保存的工作区和历史仍可查看；登录和执行需要设备重新连接。",
    sections: "设备分区",
    sectionWorkspaces: "工作区",
    sectionResources: "资源",
    sectionAgents: "模型与账号",
    sectionSkills: "Skills",
    sectionSettings: "设置",
    sharedTitle: "与你共享",
    sharedBody:
      "你通过工作区访问这台设备。模型、账号、Skills 和设置由配对它的账号管理。",
  },
  settings: {
    title: "执行设置",
    intro: "{{device}} 上的所有工作区共用这些设置。",
    maxTasks: "最大并发任务数",
    runtimeCache: "活跃运行时缓存（分钟）",
    runtimeCacheLabel: "运行时缓存分钟数",
    saved: "设置已保存。",
    saveFailed: "无法保存设置。",
    save: "保存设置",
    removeTitle: "移除设备",
    removeBody:
      "从这台 Foundry 服务器注销 {{device}}。它的工作区会从可用列表中移除；对话、Issue 和运行历史都会保留。机器上的任何内容都不会被删除。",
  },
  add: {
    dialogTitle: "添加或修复设备",
    dialogIntro: "用一条命令配对新机器，或检查、更新已设置好的设备。",
    title: "添加新设备",
    intro:
      "在要执行工作的机器上打开终端，运行一条命令（macOS 或 Linux，需 Node.js 20 或更高版本）。它会安装 Worker、与你的账号配对，并在登录时自动启动。",
    tokenNote:
      "令牌只能使用一次，将于 {{time}} 过期。第一个工作区是 ~/Foundry；加上 <code>{{flag}}</code> 可以选择其他位置，之后也可以在设备的“工作区”中添加更多。",
    mirrorNote:
      "如果 npm 使用的私有镜像无法访问，在命令后加上 <code>{{flag}}</code>。",
    repairTitle: "检查或修复已设置好的设备",
    repairIntro:
      "在那台机器上运行。第一条命令不下载任何东西，只做检查；第二条更新 Worker 并重启。",
    repairLegacy:
      "用更早版本设置的设备，先运行一次 <code>{{update}}</code> 就会有这条命令。",
    copyCommand: "复制命令",
    newToken: "重新生成令牌",
    creating: "正在创建…",
    create: "生成配对命令",
    failedTitle: "无法创建配对令牌",
  },
  removal: {
    title: "要从 Foundry 移除这台设备吗？",
    description:
      "这会在这台 Foundry 服务器上注销该设备。移除后无法从列表中撤销，但机器本身的任何内容都不会被删除。",
    failed: "无法移除这台设备。",
    notFound: "这台设备已不再注册。请刷新列表。",
    workspaces_one:
      "这台设备上的 {{count}} 个工作区将从设备和工作区列表中移除。对话、Issue 和运行历史会保留，并在设备标记为已移除的地方继续显示。",
    workspaces_other:
      "这台设备上的 {{count}} 个工作区将从设备和工作区列表中移除。对话、Issue 和运行历史会保留，并在设备标记为已移除的地方继续显示。",
    localKept:
      "本地文件夹和仓库、Claude/Codex 登录、机器上保存的服务商密钥，以及 Worker 设置都不会被删除。",
    connectionsKept:
      "服务器 API 连接及其加密保存的密钥对其他设备仍然可用；只撤销这台设备的访问权限。",
    online:
      "Worker 当前在线。它会立即断开且不会重连，必须在这台机器上重新设置才能恢复。",
    offline:
      "设备当前离线。如果它再次联系这台服务器，会被拒绝；要恢复，请在那台机器上重新设置。",
    blocked:
      "你当前的工作位置在这台设备上。请先切换到另一台设备上的工作区，再移除它。",
    removing: "正在移除…",
    remove: "移除设备",
  },
  access: {
    title: "这台设备如何连接 AI",
    intro:
      "开始对话时选择一个账号或 API 连接。两者都在 <strong>{{device}}</strong> 上运行。",
    sources: "AI 访问来源",
    accountsTitle: "官方账号",
    accountsHint: "需在这台设备上单独登录",
    connectionsTitle: "服务器 API 连接 <em>{{total}}</em>",
    connectionsHint: "共享配置 · 按设备显式授权",
    accountsExplanation:
      "使用你的 ChatGPT 或 Claude 订阅。凭据保存在这台设备上，不需要服务器连接。",
  },
  resources: {
    title: "资源",
    intro:
      "{{device}} 上可供会话使用的软件，由它的 Worker 在连接时检测。Foundry 从不安装资源。",
    kinds: {
      browser: "浏览器",
      computer_use: "屏幕控制",
    },
    detected: "已重新检测资源。",
    settingsOpen:
      "{{device}} 上已打开系统设置（{{panes}}）。请在那里打开 Foundry Worker 的权限，然后点击“重新检测”。",
    promptsShown:
      "{{device}} 已弹出权限请求。请在那里允许，然后点击“重新检测”。",
    granted: "已获得访问权限。",
    unreachable: "无法连接到设备。",
    detecting: "正在检测…",
    detectAgain: "重新检测",
    emptyTitle: "没有上报的资源",
    emptyOnline: "Worker 在这台设备上没有找到浏览器或屏幕控制。",
    emptyOffline: "设备还没有上报资源；Worker 连接后会显示在这里。",
    listLabel: "设备资源",
    available: "可用",
    unavailable: "不可用",
    screenAccess:
      "要让会话截取和控制这台 Mac，请在“录屏与系统录音”和“辅助功能”中允许运行 Foundry Worker 的程序。权限请求和系统设置会在 {{device}} 上打开。",
    screenAccessGrantTo:
      "要让会话截取和控制这台 Mac，请在“录屏与系统录音”和“辅助功能”中允许运行 Foundry Worker 的程序（<code>{{grantTo}}</code>）。权限请求和系统设置会在 {{device}} 上打开。",
    asking: "正在请求设备…",
    openSettings: "打开系统设置…",
  },
};
