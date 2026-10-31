# DEV-104 设备页“会话运行器待切换”横幅：可直接切换、问号说明、排版

## 问题

本人在设备页（byte-dev）看到“This device's session runner has not switched yet”横幅：

1. 横幅里没有“立即切换”。按钮只在“设置 → Worker”页签里（代码注释写着“The banner says what waits; the action lives in Settings → Worker”），所以看起来像是不能主动切换。
2. 不清楚“先点 Update，之后还有一个 switch 动作”是什么逻辑。
3. 横幅不好看：整块米黄底上堆着两行“标签 + 等宽版本号 + 远在最右的状态词”，再加一句和第一行重复的“This server serves …”，以及一段长说明。

## 逻辑（问号提示里写的内容）

Worker 由两部分组成（`packages/protocol/src/device.ts` 的 `DeviceRunner`）：

- 连接服务（daemon）：负责与服务器通信。点 Update 后立即以新版本重启。
- 会话运行器：负责执行 Agent 回合。为了不打断正在运行的回合，它在这些回合结束后才切换，而且是自动切换，Update 之后本人不需要再操作。新回合最多等到截止时间；过了截止时间，新回合先交给旧运行器，等到没有回合运行时再切换。
- “立即切换”不再等待：它停止正在运行的回合（会话保留），并马上切换。

## 修改（只改 Web）

- `apps/web/src/features/devices/device-worker.tsx`
  - 横幅：标题后加问号；只显示一行版本变化“会话运行器 旧 → 新”（Worker 落后时显示“Worker 旧 → 新”）；下面是状态说明和“立即切换”按钮；正文用 grid 统一 8 px 间距。运行器待切换时不再显示与此无关的“更新命令 / 源码目录”说明。Worker 落后时，横幅以“更新”为主，不显示“立即切换”。
  - 设置 → Worker：标题“Worker”后加问号；两部分的状态改用 Badge（已是最新 = online，有可用更新/等待切换 = brass，更新中/切换中 = slate，失败/无响应 = warn）；“立即切换”保留。
- `device-runner.tsx`：新增 `runnerStateTone`。
- 共享组件：`components/ui/tooltip.tsx` 增加 `variant="hint"`（较宽、常规字重，用于几句说明）和受控的 `open`/`onOpenChange`；新增 `components/ui/help-hint.tsx`（问号按钮：悬停、键盘聚焦时打开，没有悬停的设备上点击/回车也能打开）。样式加在 `00-foundation.css`（`.fdy-tooltip-hint`、`.fdy-help-hint`）和 `68-device-management.css`。
- 文案（en / zh-CN 同步）：新增 `worker.changeTo`、`helpLabel`、`helpConnection`、`helpRunner`、`helpSwitchNow`；`runnerTitle` 改为“会话运行器尚未切换到新版本”；`pastDeadline` 改写得更易读。

## 部署

dev Web 从当前工作树构建（线上已包含 DEV-096–099 未提交的 Web 改动，所以没有用 HEAD 快照，避免把它们回退）。Release 目录 `~/.foundry/server/releases/dev104-runner-banner`。第 1 轮最终 Web `a5da445025b18577`（中间依次发布过 `4a501063…`、`52a35125…`、`36b2dd67…`，均为本项的迭代）；上一个线上版本 `2ecf91c04d8887ee` 的入口文件保存在 `previous-20261030T151020Z`。没有 Server/Worker 改动。

## 自验

- `scripts/check-changed.sh --files <8 个文件>`：prettier、tsc、19 个 web 测试、12 项 audit:ui 全部通过。
- 真实浏览器（Foundry 启动的 headless Chromium，独立上下文）：登录 e2e-alice，打开合成设备 DEV048（`dev_1d7e8a04-…`）。浏览器内只改写 `/api/foundry-data` 与 `/api/devices/<id>` 的 GET 响应，让该设备显示“在线 + 运行器待切换（已过截止时间，2 个回合）”或“Worker 落后”。`GET …/worker/runner` 返回 2 个合成回合，`POST` 在浏览器内被拦截，不会到达服务器。zh-CN 用改写后的 `/api/auth/state` 响应设置，账号设置本身没有改。
  - 待切换（en 与 zh-CN × light/dark × 1280/390）：横幅有“立即切换”，点击后对话框列出 2 个合成回合，点“取消”后没有发出 switch 请求；设置页签里两个 Badge 是“已是最新 / 等待切换”，也有“立即切换”。
  - 问号：悬停打开提示（宽 340 px，不越出视口）；1280 宽时 Tab 聚焦即打开。390 宽时 Tab 会滚动页面，Radix Tooltip 遇到滚动会关闭（库的既有行为），按 Enter 可以打开（已验证）。
  - Worker 落后：横幅显示“Worker 旧 → 新”，不显示“立即切换”。
  - 截图在仓库外 `/tmp/dev104-shots/`；横幅、暗色提示、中文提示三张在 `.foundry/attachments/20261030/dev104-*.png`。
- 没有新建会话或业务对象，没有发消息，也没有运行模型。

## 限制

- 窄屏时版本号较长，“旧 → 新”会换成三行。
- 设置 → Worker 页签里段落间距偏大，这是改动前就有的样式，本项没有动。

## 人工验收步骤

1. 打开 byte-dev 的设备页。运行器还在等待切换时，横幅应为：标题“会话运行器尚未切换到新版本”加问号；一行“会话运行器 旧版本 → 新版本”；一句状态说明；“立即切换”按钮。
2. 悬停问号，应看到三段说明（连接服务 / 会话运行器 / 立即切换）。
3. 点“立即切换”，对话框列出将被停止的回合；“取消”保持等待，确认后才切换。
4. 设置 → Worker：两部分的状态显示为 Badge，问号和“立即切换”都在。

## 第 2 轮：点了 Update 还一直有 Update 按钮

本人反馈：点了好几次 Update，横幅里一直有 “Update Worker”，看不出现在是什么状态。

调查（只读）：

- byte-dev 上的 `~/.foundry/logs/self-update.log`：23:00 那次已经把 `.158` 更新到 `.168`；23:40 的两次点击都是 “`.168` is installed; … Reinstalled … and restarted the worker”，也就是同一版本重装一遍并重启连接服务，没有任何变化。
- `~/.foundry/execution-host`：运行器仍是 `.158`（identity 的 entry 指向 `runtime/0.5.7-dev.158…`），claims 里有 2 个 active 回合，来自 `sess_1793352998673599080`（“核查近期Session合入状态与遗留问题”）和它的子会话 `sess_1793374788025915157`。这个编排会话不断开新回合，过了截止时间后新回合又都交给旧运行器，所以旧运行器一直“有回合在跑”。
- 为什么会出现按钮：`canStart` 原来在 `!release`（页面没读到服务器提供的 Worker 版本）时也会提供更新。`useWorkerRelease` 失败后不重试，本人页面那次读取正好失败（当时其他会话在部署 Server）。在浏览器里让 `/api/worker/release` 返回 502，可以复现截图中同样的 “Update Worker + Switch now”。服务器那边，对已经是目标版本的设备，更新记录会被立刻丢掉（`workerUpdates.active` 中 `workerVersion == update.Version`），所以点击后页面上什么都不显示。

修复（Web）：

- `lib/worker-commands.ts`：`useWorkerRelease` 读取失败后按 2 s、5 s、15 s、30 s 重试，之后每 60 s 一次，成功后清除 `error`。
- `device-worker.tsx`：`canStart = running || (selfUpdating && (behind || failed || stalled || release?.source === "npm"))`。不知道服务器版本时不再“盲目”提供更新；失败或卡住的更新仍可重试。设置 → Worker 显示 “正在读取服务器提供的 Worker 版本…” 或 “无法读取…，正在重试”（en/zh-CN）。
- 测试：`devices-feature.test.mjs` 新增一条（release 返回 502、Worker 已是最新、运行器待切换：没有 “Update Worker”，横幅和设置里各有一个 “Switch now”，有问号）。

部署与自验：Web `3507049250dc28ad` 已部署。`check-changed.sh`（10 个文件）全部通过。真实浏览器中，合成设备声明可自我更新：release 一直 502 时没有 Update 按钮，显示 “Reading…”；release 只失败一次时也没有 Update 按钮，重试后显示 “This server serves …168”。“Switch now” 在横幅和设置里都有。

需要本人决定（未改）：过了截止时间后，新回合交给旧运行器。如果编排会话不断开新回合，旧运行器可能一直等不到“没有回合在跑”的时刻。可选方案：截止后改为让新回合继续等新运行器；或者超过某个上限后提示本人立即切换。

## 时间线

- 2026-10-30 23:00–23:30：问题分析、实现、部署 Web `a5da445025b18577`、Agent 自验通过；待人工验收；未提交。
- 2026-10-30 23:40–00:00：第 2 轮。只读查看 byte-dev 的更新日志与执行宿主状态；修复页面没读到 release 时也提供 Update；部署 Web `3507049250dc28ad`；Agent 自验通过；待人工验收；未提交。
