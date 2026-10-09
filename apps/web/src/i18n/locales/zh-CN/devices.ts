import type { devices as en } from "../en/devices";
import type { Translation } from "../../translation";

export const devices: Translation<typeof en> = {
  list: {
    title: "设备",
    intro: "选择一台设备，浏览它的工作区、管理 Agent 登录，或配置执行。",
    add: "添加设备",
    refresh: "刷新状态",
    refreshing: "正在刷新…",
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
    workspacesLink_one: "{{count}} 个工作区",
    workspacesLink_other: "{{count}} 个工作区",
    sectionResources: "资源",
    sectionAgents: "模型与账号",
    sectionSkills: "Skills",
    sectionSettings: "设置",
    sectionDiagnostics: "诊断",
    sharedTitle: "与你共享",
    sharedBody:
      "你通过工作区访问这台设备。模型、账号、Skills 和设置由配对它的账号管理。",
  },
  rename: {
    action: "重命名",
    title: "重命名设备",
    description:
      "所有能看到这台设备的人都会看到这个名字。主机名 {{hostname}} 仍会显示在设备详情中。",
    label: "设备名称",
    submit: "保存名称",
    failed: "无法重命名设备。",
  },
  details: {
    missing: "这台设备的 Worker 早于 0.5.7，不会上报系统信息；更新后即可看到。",
    hostname: "主机名",
    system: "系统",
    kernel: "内核",
    cpu: "处理器",
    cpuValue: "{{model}} · {{count}} 核 · {{arch}}",
    memory: "内存",
    user: "用户",
    worker: "Worker",
    node: "Node.js",
  },
  worker: {
    title: "Worker",
    behindTitle: "这台设备的 Worker 落后于服务器",
    running: "运行的 Worker 版本：{{version}}。",
    unknownVersion: "早于 0.5.7",
    serverBuild: "服务器提供的版本：{{version}}。",
    serverNpm: "服务器使用 npm 发布版。",
    runLocal: "在 {{device}} 上运行，更新并重启 Worker：",
    runOnce:
      "在 {{device}} 上运行一次；它会找到与这台服务器配对的 Worker 并更新。之后设备就有自己的更新命令。",
    updateNow: "立即更新",
    updateAgain: "重新更新",
    updateStalledTitle: "更新没有完成",
    updateStalled: "{{time}} 开始的更新没有完成：设备仍在运行旧的 Worker。",
    updateStalledLog:
      "{{time}} 开始的更新没有完成：设备仍在运行旧的 Worker。设备上的日志：{{log}}",
    updating: "正在更新…",
    updateStarted:
      "设备正在更新 Worker，完成后会自动重启；重新连上后这里会显示新版本。",
    updateRunningSince:
      "{{time}} 起正在更新；Worker 会以新版本重启，重新连上后这里会显示新版本。",
    updateSlow:
      "设备还没有以新版本重新连上。可在“设置 → Worker”或设备上的日志中查看。",
    updateFailed: "无法开始更新。",
    updateAll_one: "更新 {{count}} 台设备的 Worker",
    updateAll_other: "更新 {{count}} 台设备的 Worker",
    updateAllStarted_one:
      "正在更新 {{count}} 台设备；Worker 重启并重新连接后会显示新版本。",
    updateAllStarted_other:
      "正在更新 {{count}} 台设备；Worker 重启并重新连接后会显示新版本。",
    updateAllRunning: "Worker 正在更新；列表会持续刷新直到它们重新连接。",
    updateAllManual:
      "以下设备无法在这里更新（离线或 Worker 版本过旧）：{{devices}}。打开设备查看更新命令。",
    updateAllFailure: "{{device}}：{{error}}",
    stateUpdatable: "有可用更新",
    stateManual: "Worker 版本落后",
    stateUpdating: "正在更新 Worker…",
    stateStalled: "更新未完成",
    stateFailed: "更新失败",
    steps: {
      starting: "开始更新",
      checking: "向服务器确认要安装的 Worker",
      downloading: "下载新的 Worker",
      downloadingVersion: "下载 {{version}}",
      installing: "安装",
      installingVersion: "安装 {{version}}",
      restarting: "重启 Worker",
    },
    stepRunning: "正在{{step}}…",
    updateStepSince:
      "正在{{step}}…{{time}} 开始；Worker 会以新版本重启，重新连上后这里会显示新版本。",
    updateWaiting: "等待中：{{detail}}",
    updateFailedTitle: "更新失败",
    updateFailedReason: "原因：{{reason}}",
    failedVanished: "更新进程没有报告结果就退出了。",
    failedNotBack: "更新后 Worker 没有重新连上。",
    updateLastStep: "最后一步：{{step}}。",
    updateExitCode: "退出码 {{code}}。",
    updateLogTail: "更新日志的末尾",
    updateLogTailAt: "更新日志的末尾（设备上的 {{log}}）",
    sourceCheckout: "它从源码目录运行，用 git 更新。",
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
      "令牌只能使用一次，将于 {{time}} 过期。设备连上后默认没有工作区：在“工作区”页面添加你想用的文件夹即可；也可以加上 <code>{{flag}}</code> 现在就注册一个。",
    mirrorNote:
      "如果 npm 使用的私有镜像无法访问，在命令后加上 <code>{{flag}}</code>。",
    repairTitle: "检查或修复已设置好的设备",
    repairIntro:
      "在那台机器上运行。第一条命令不下载任何东西，只做检查；第二条更新 Worker 并重启。",
    repairLegacy:
      "用更早版本设置的设备，先运行一次 <code>{{update}}</code> 就会有这条命令。",
    repairServerBuild:
      "这台服务器提供自己构建的 Worker（{{version}}），上面的更新命令会跟随它。使用 npm 发布版、或用更早版本设置的设备，先运行一次下面的命令切换过来：",
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
    connectionsTitle: "API 连接 <em>{{total}}</em>",
    connectionsHint: "来自服务器，或这台设备自己的配置",
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
  diagnostics: {
    report: {
      heading: "{{device}} 的诊断 · Worker {{version}} · {{at}}",
      connections: "最近的连接：",
      log: "Worker 日志：",
    },
    title: "诊断",
    intro:
      "让这台设备的 worker 自检并给出报告：与服务器的连接、运行状况、Agent，以及日志末尾（已去除敏感信息）。不会发起任何模型请求。",
    run: "运行诊断",
    running: "运行中…",
    runningNote: "worker 正在自检，最多需要一分钟。",
    copy: "复制报告",
    offline: "设备离线，等它重新连上后才能诊断。",
    lastDisconnect: "上次断开：{{line}}",
    noDisconnect: "服务器启动以来没有记录到断开。",
    generated: "Worker {{version}} · {{at}}",
    log_one: "Worker 日志（{{count}} 行，已去除敏感信息）",
    log_other: "Worker 日志（{{count}} 行，已去除敏感信息）",
    status: { ok: "正常", info: "信息", warn: "注意", error: "问题" },
    group: {
      connection: "连接",
      runtime: "Worker",
      agents: "Agent",
      workspaces: "工作区",
      skills: "Skill",
      chats: "本地对话",
    },
    check: {
      server: "能否访问服务器",
      socket: "长连接往返延迟",
      drops: "最近 30 分钟的断开",
      proxy: "代理",
      eventLoop: "Worker 响应情况",
      memory: "内存",
      disk: "磁盘空间",
      workspaces: "已登记的文件夹",
      skills: "Skill 扫描",
      chats: "本地对话同步",
    },
    ms: "{{ms}} 毫秒",
    server: {
      answered: "{{url}} 在 {{ms}} 毫秒内响应（HTTP {{status}}）",
      failed: "{{url}} 没有响应：{{error}}",
      adviceFailed: "这台设备访问不到服务器，请检查它的网络、VPN 或代理。",
      adviceSlow: "从这台设备访问服务器很慢，请检查两者之间的网络。",
    },
    socket: {
      advice:
        "长连接没有及时响应。如果一直掉线，可能是网络或代理在切断空闲连接。",
    },
    drops: {
      none: "没有",
      some_one: "{{count}} 次 · 最近一次：{{last}}",
      some_other: "{{count}} 次 · 最近一次：{{last}}",
      adviceSilent:
        "其中 {{silentServer}} 次是服务器的数据不再到达，worker 才重连。很可能是设备和服务器之间的网络设备或代理切断了连接；可以换个网络试试，或联系网络管理员。",
      advice: "连接反复断开。下次断开后再运行一次诊断，并复制报告。",
    },
    proxy: {
      none: "没有设置代理",
      set: "环境变量设置了代理 {{proxy}}",
      advice:
        "worker 的长连接不走这个代理。如果这个网络只能通过它访问服务器，连接会一直失败。",
    },
    eventLoop: {
      uptime: "已运行 {{uptimeMinutes}} 分钟",
      delay: "延迟 p99 {{p99Ms}} 毫秒，最大 {{maxMs}} 毫秒",
      stalls_one: "{{count}} 次卡顿",
      stalls_other: "{{count}} 次卡顿",
      lastStall: "最近一次卡顿 {{lastStall}}",
      advice:
        "worker 曾经一次卡住好几秒，期间服务器可能会断开它。请复制这份报告分享出来。",
    },
    memory: {
      used: "占用 {{rssMb}} MB",
      advice: "worker 占用内存较多，更新或重启后会释放。",
    },
    disk: {
      free: "{{path}} 剩余 {{freeGb}} GB",
      advice: "请清理这台设备的磁盘空间。",
    },
    agent: {
      notInstalled: "未安装",
      version: "版本 {{version}}",
      outdated: "有可用更新",
      advice: "到这台设备的「模型与账号」页登录或更新。",
    },
    login: {
      verified: "账号已验证",
      local_login: "已在本机登录",
      not_signed_in: "未登录",
      unavailable: "无法获取登录状态",
      error: "读取登录状态失败：{{loginError}}",
    },
    workspaces: {
      allThere: "已登记的文件夹都在",
      missing_one: "{{count}} 个文件夹已不存在：{{paths}}",
      missing_other: "{{count}} 个文件夹已不存在：{{paths}}",
      advice: "可以在下方忘掉它们，这只是 worker 自己的记录。",
    },
    activity: {
      notRun: "worker 启动后还没运行过",
      last: "最近 {{at}}",
      seconds: "{{seconds}} 秒",
      error: "失败：{{error}}",
      skills_one: "{{count}} 个 Skill",
      skills_other: "{{count}} 个 Skill",
      workspaces_one: "{{count}} 个工作区",
      workspaces_other: "{{count}} 个工作区",
    },
    connection: {
      lasted: "持续 {{seconds}} 秒",
      closedBy: {
        worker: "worker 主动重连（收不到服务器数据）",
        server: "服务器关闭了连接",
        network: "被网络切断",
      },
      error: "错误 {{error}}",
      silence: "断开前 {{seconds}} 秒最后一次收到服务器数据",
      blocked: "worker 自身卡住了 {{seconds}} 秒",
    },
    disconnect: {
      server: "服务器：{{reason}}",
      worker: "worker：{{line}}",
    },
    repair: {
      title: "修复",
      intro: "每项都要你确认后才会在这台设备上执行。",
      running: "正在修复…",
      forgetCount_one: "忘掉 {{count}} 个不存在的文件夹",
      forgetCount_other: "忘掉 {{count}} 个不存在的文件夹",
      action: {
        "forget-missing-workspaces": "忘掉不存在的文件夹",
        "clear-skill-scan-cache": "清空 Skill 扫描缓存",
        "recheck-agents": "重新检查 Agent",
      },
      confirm: {
        "forget-missing-workspaces": "确定忘掉已不存在的文件夹？再点一次",
        "clear-skill-scan-cache": "下次从头重新扫描所有 Skill？再点一次",
        "recheck-agents": "重新查找 Claude Code 和 Codex？再点一次",
      },
      done: {
        "forget-missing-workspaces_one": "已忘掉 {{count}} 个不存在的文件夹。",
        "forget-missing-workspaces_other":
          "已忘掉 {{count}} 个不存在的文件夹。",
        "clear-skill-scan-cache": "已清空，下次扫描会重新读取所有 Skill。",
        "recheck-agents": "正在重新查找 Claude Code 和 Codex。",
      },
    },
  },
};
