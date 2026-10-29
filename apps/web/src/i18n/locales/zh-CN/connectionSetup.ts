import type { connectionSetup as en } from "../en/connectionSetup";
import type { Translation } from "../../translation";

export const connectionSetup: Translation<typeof en> = {
  picker: {
    setUp: "设置…",
    viewProgress: "查看进度…",
    finishSignIn: "完成登录…",
    check: "验证…",
    retry: "重试…",
    detail: {
      not_set_up: "这台设备上还没有设置",
      in_progress: "正在这台设备上设置",
      waiting_sign_in: "等待登录",
      unchecked: "已登记，尚未验证",
      check_failed: "验证失败：{{reason}}",
      check_failed_plain: "验证失败",
      setup_failed: "设置失败：{{reason}}",
      setup_failed_plain: "设置失败",
    },
  },
  dialog: {
    title: "在 {{device}} 上设置 {{label}}",
    description: "一条命令即可在该设备上安装并登记，进度会显示在这里。",
    runAs: "请在 {{device}} 上以 {{user}} 账号打开终端运行这条命令。",
    runAsUnknown:
      "请在 {{device}} 上，以其 Foundry Worker 所用的账号打开终端运行这条命令。",
    provenance: "由连接 {{id}} 于 {{time}} 在 {{source}} 上登记。",
    provenanceNoTime: "由连接 {{id}} 在 {{source}} 上登记。",
    commandLabel: "设置命令",
    copy: "复制命令",
    copied: "已复制",
    gatewayLink: "网关说明",
    otherSetups: "其他设备登记了不同的设置命令。",
    showOtherSetups: "查看其他命令",
    otherSetupFrom: "{{device}} · {{time}}",
    noCommand:
      "这个连接没有登记设置命令。请在 {{device}} 上重新运行其网关的安装程序。",
    loadFailed: "无法读取设置状态：{{error}}",
    close: "关闭",
    done: "完成",
    success: "已就绪，并已为本聊天选中。",
    successNotSelected: "已就绪。请在选择器中选中它。",
  },
  remote: {
    run: "替我设置",
    hint: "Foundry 会在 {{device}} 上运行上面这条命令，你只需完成登录。",
    starting: "正在启动…",
    running: "正在 {{device}} 上运行",
    stop: "停止",
    unavailable: {
      offline: "{{device}} 离线，Foundry 无法在上面运行。",
      old_worker: "请更新 {{device}} 的 Foundry Worker，才能从这里设置连接。",
      remote_commands_off:
        "{{device}} 已关闭远程命令，其所有者可在“资源”页开启。",
    },
  },
  steps: {
    runDone: "命令已开始运行",
    check: "验证",
    checkFailed: "验证失败",
    title: "进度",
    run: "等待运行命令",
    installed: "已安装",
    signIn: "等待登录",
    signedIn: "已登录",
    registered: "已登记到 Foundry",
    checked: "验证通过",
    checking: "正在用一轮简短对话验证…",
  },
  signIn: {
    open: "打开登录页面",
    code: "验证码：{{code}}",
    hint: "请在浏览器中确认登录，本面板会自动继续。",
  },
  check: {
    note: "登记后 Foundry 会用一轮简短对话验证（消耗模型额度）。",
    retry: "重新验证",
  },
  failure: {
    setup: "设置失败",
    check: "验证失败",
    exit: "命令以退出码 {{code}} 结束。",
    timedOut: "命令运行 20 分钟后已被停止。",
    cancelled: "命令已停止。",
    retry: "重试",
  },
  stalled: {
    title: "没有收到进度——请查看终端",
    body: "{{device}} 上 20 分钟没有任何变化。请查看运行命令的终端，然后重试。",
  },
  log: {
    show: "查看日志",
    truncated: "较早的输出已丢弃。",
    empty: "暂无输出。",
  },
};
