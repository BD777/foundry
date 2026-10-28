# Agent 浏览器 / 电脑操作的实时画面：调研与决策备忘

日期：2026-10-29 · 事项：[DEV-074](../devlog/DEV-074-agent-live-view-research.md) · 性质：调研与决策，不含产品代码

问题（用户 2026-10-29）：Agent 用浏览器或操作电脑时，Foundry 聊天页上看不到它在操作什么。能否像 Codex 桌面 App 那样显示当前画面？放在聊天里、右侧面板展开成一栏，还是浮窗？

> “CodeDesk APP” 按上下文判断是 OpenAI Codex 桌面 App（2026-04 内置浏览器，现并入 ChatGPT 桌面 App），待用户确认。

## 1. 结论与建议

**建议：做，分三期；先做“每步截图”，第二期再做 agent-browser 的只读实时画面；桌面级实时流和接管暂不做。**

| 期              | 内容                                                                                                                                                                                                                  | 价值                                                           | 估算                                                    | 主要风险                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| P1 每步截图     | 把工具**已经产生**的截图（Playwright MCP、Foundry `operate_resource` 的 computer_use、agent-browser / playwright-cli 存到文件的截图）挂到对应工具步骤上：步骤行内缩略图 + 右侧面板“画面”详情（最新画面 + 步骤胶片条） | 不新增采集、不新增隐私面（模型本来就看过这些图）；弱链路下可用 | 4–6 人日（Worker 2 · Server 1 · Web 2–3，含浏览器矩阵） | 覆盖率：agent-browser / playwright-cli 多用文本快照而非截图，很多步骤没有图       |
| P2 只读实时画面 | 有人在看时，Worker 订阅本会话 agent-browser 自带的画面流（CDP screencast），限速转发给 Server → Web，只转画面帧；无人看即停                                                                                           | 真正的“看它在操作”                                             | 7–10 人日                                               | 带宽（约 10 KB/s 的设备）；会话与浏览器的归属；原始流里带命令参数和凭据（已实测） |
| P3 桌面 / 接管  | computer_use 窗口级连续画面、用户接管与交还                                                                                                                                                                           | 登录、验证码、支付等人机协作                                   | ≥3 周，单独立项                                         | 隐私（整屏）、输入抢占（见 DEV-028）、macOS 授权                                  |

为什么 P1 先行：

- 行业里**每家都有逐步截图/回放**，实时流是锦上添花（Manus、Devin、ChatGPT agent 都以“步骤 + 截图时间线”作为回看主体）。
- Foundry 的设备链路有慢到约 10 KB/s 的（DEV-051 实测）。一帧 1280×720 JPEG 实测约 10 KB（见 §3.1），慢链路上“实时”最多每 1–2 秒一帧，效果与“每步一张”接近，而 P1 不占额外带宽。
- P1 的数据模型（帧 = 会话 + 工具调用 + 文件引用 + 尺寸 + 来源）正是 P2/P3 复用的骨架，不是一次性代码。

需要用户决定的事项见 §6。

## 2. 行业调研

| 产品                                    | 位置与形态                                                                                                                    | 实时 / 回放                                                                                           | 接管                                                               | 隐私做法                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex 桌面 App（in-app browser） | 聊天旁的浏览器标签页；**split view**（聊天与标签并排）或 **full view**；`⌘⇧B` 切换。模式：预览、批注（Annotate）、Browser use | 是真实可交互的浏览器页面，用户看到的就是 Agent 操作的那页；截图 API 基于 CDP `Page.captureScreenshot` | 同一浏览器，用户可直接操作；文档未描述显式接管按钮                 | 独立浏览器 profile；按站点设置浏览/下载/上传权限；敏感动作前确认。曾有截图超时后回退到整屏截图、未经同意的报告 |
| Claude Code 桌面 App（Browser pane）    | 右侧 Browser 面板（标签式），可开 dev server、HTML/PDF/视频；`⌘⇧B`                                                            | 面板即实时画面；Claude 改完自动截图、查 DOM 自验（autoVerify）                                        | 用户可直接在面板里操作                                             | 干净 profile，无用户登录态；管理员可限制外部导航                                                               |
| Cursor（Browser tool）                  | 浏览器为独立窗口或编辑器内嵌面板；**截图作为步骤显示在聊天里**                                                                | 面板实时；聊天内逐步截图                                                                              | 用户可在面板里操作                                                 | 每个 workspace 独立 cookie/存储；元素选择只响应用户点击                                                        |
| ChatGPT agent / Operator                | 聊天里展开的“虚拟浏览器”视图                                                                                                  | 实时画面 + 截图留在对话历史                                                                           | **Take over browser**，交还后继续                                  | **接管期间不截图**；删除对话即删除截图；建议清除远程浏览器数据                                                 |
| Manus                                   | 第三栏 “Manus's Computer”：Browser / Terminal / Editor 视图切换                                                               | 实时 + **Replay**（按步骤回放时间线）                                                                 | 可介入、可接管（验证码、付费墙）                                   | 云端沙箱机器                                                                                                   |
| Devin                                   | 会话工具页签：Shell / IDE / Browser（Desktop 页签）                                                                           | 实时 + **Timelapse** 时间线回放；测试录像自动放大到点击处                                             | 交互浏览器、Use Devin's Machine；先暂停 Devin 再接管，避免冲突     | 云端机器                                                                                                       |
| Perplexity Comet                        | 自身就是浏览器；被控标签有**蓝色描边**；后台任务显示小窗口，可点开查看                                                        | 实时                                                                                                  | 任务结束把标签交还给用户                                           | 与浏览器交互前先询问                                                                                           |
| Browserbase                             | 托管浏览器的 **Live View URL**，iframe 嵌入；每个标签一个 URL                                                                 | 实时，可交互                                                                                          | iframe 可交互即接管；断开时 postMessage `browserbase-disconnected` | URL 视为敏感，不进公共日志                                                                                     |
| Browser Use Cloud                       | `liveUrl` iframe；`readOnly=true` 或外包 `inert` + `pointer-events:none` 实现只读                                             | 实时 + 可选 MP4 录像                                                                                  | 交互 iframe 让人登录/批准后交还                                    | **URL 即凭据**                                                                                                 |
| Anthropic computer-use demo             | 单页：左聊天、右 noVNC 桌面（8080 合并页 / 6080 noVNC / 5900 VNC）                                                            | VNC 实时整屏                                                                                          | VNC 即可操作                                                       | Docker 沙箱，单会话                                                                                            |
| agent-browser（本平台已装）             | 每个会话自带 WebSocket 画面流 + `dashboard`（本地 4848 端口的 Next.js 查看页）                                                | JPEG 帧 + 命令活动流；`record` 录像                                                                   | 流接受鼠标/键盘输入                                                | 本地端口无鉴权（见 §3.1）                                                                                      |

归纳出的 UX 模式：

1. **逐步截图（inline thumbnails）**：Cursor、ChatGPT agent。成本最低，回看友好。
2. **侧栏“电脑”面板**：Manus、Devin、Codex/Claude 桌面 App。实时画面跟随当前活动工具，聊天与画面并排。
3. **画中画 / 小窗**：Comet 后台任务小窗。适合“不想切走但想瞄一眼”。
4. **回放时间线**：Manus Replay、Devin Timelapse、Browser Use 录像。
5. **接管与交还**：ChatGPT agent、Devin、Browserbase/Browser Use 的交互 iframe；接管期间暂停 Agent、**不截图**。
6. **隐私**：独立 profile、站点权限、接管不截图、URL 视为凭据、删除对话即删截图。

## 3. Foundry 现状与技术方案

### 3.1 已核对的事实

数据流：Agent CLI（Claude Code / Codex）在执行宿主运行 → Worker（`packages/worker`）把 SDK 消息转成会话事件 → 可靠事件流经 daemon 的 WebSocket 到 Server → Web 订阅会话事件。图片走单独的按需读取：`GET /api/local-files/image` → Server 向设备读 64 KiB 分块（DEV-051：交互优先、≤40 KiB 预览、缓存、失败重试）。

| 工具                                                   | 实际返回                                                                                                                                                                                                                                                               | Foundry 目前保留了什么                                                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playwright MCP `browser_take_screenshot`               | MCP image 内容块（base64）给模型，同时可写到 `--output-dir` 文件                                                                                                                                                                                                       | 实时：Claude 的 `tool_use` 只出名称和参数（截断 1600 字符）；结果只用来把步骤标为完成，**图片丢弃**。历史转写（`transcript-adapters/claude.ts`）只取文本 |
| Foundry `operate_resource`（computer_use，cua-driver） | Server 以 MCP image 返回每个动作的截图（单张 ≤2 MB，总 ≤8 MB，最长边 1280），带 `frameId`、宽高、scale                                                                                                                                                                 | 只记录字节数到租约审计，**图片不入会话**                                                                                                                 |
| Codex `mcp_tool_call`                                  | MCP 结果（可含 image 块）                                                                                                                                                                                                                                              | `sdkToolCallDetail` 只生成文字详情                                                                                                                       |
| agent-browser 0.38.2 `screenshot`                      | 写 PNG 文件，stdout 打印 `Screenshot saved to <path>`；实测 1280×720 简单页 10 KB                                                                                                                                                                                      | Bash 输出文本里有路径；没有和步骤关联成图片                                                                                                              |
| agent-browser 画面流                                   | 实测：每个会话**默认**开启 `ws://127.0.0.1:<随机端口>`；有客户端连上才开始 CDP screencast；消息含 `status`、`tabs`、`frame`（`{seq, data: base64 JPEG, metadata}`）和**命令活动**。5 秒、2 次操作收到 6 帧，base64 合计约 80 KB（每帧约 10 KB JPEG）；页面不变时不出帧 | 未使用                                                                                                                                                   |
| playwright-cli 0.1.22                                  | `screenshot` 存文件并打印路径；`video-start`、`tracing-start`、`show` 仪表盘                                                                                                                                                                                           | 未使用。本机实测：默认要 `chrome` 或 `chromium-1247`，而本机只有 Foundry 启动器用的 1246 版，`open` 直接失败——版本漂移，另行处理                         |

**安全发现**：agent-browser 画面流的命令活动消息里原样带了 `launch` 参数，实测包含代理地址与**代理密码**；端口只绑 127.0.0.1 但无鉴权，同一台机器的其他本地账户/进程都能连上看画面、发输入。因此 P2 **只能转发 `frame` 消息**，不得透传原始流，也不得把端口暴露给浏览器。

Claude Agent SDK 的 `PostToolUse` hook（Worker 已在用，见 `runner/claude-runtime-start.ts`）的输入里有 `tool_response`，可以在不改变模型上下文的前提下拿到工具结果里的图片——这是 P1 在 Claude 侧的挂载点；Codex 侧在 `item/completed` 的 `mcpToolCall.result.content` 中取。

### 3.2 方案比较

| 方案                                     | 怎么做                                                                                                                    | 帧率 / 带宽                                                          | 覆盖                                             | 代价                 | 结论                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ | -------------------- | -------------------------------- |
| A. 工具结果截图                          | Worker 从 hook / item 结果里取 image 块，或从 Bash 输出识别截图路径；落盘到会话目录，事件只带引用                         | 每步 0–1 张，只在用户打开时按需拉取（复用 DEV-051 预览）             | MCP 截图、computer_use、显式截图命令             | 低                   | **P1**                           |
| B. CDP screencast（经 agent-browser 流） | Worker 连本会话 agent-browser 的 WS，只取 `frame`                                                                         | 内容变化才出帧；限 ≤1–2 fps、最长边 ≤960、JPEG q≈50 → 每帧约 8–15 KB | agent-browser 会话（本平台主力）                 | 中                   | **P2 首选**                      |
| B′. CDP screencast（直连）               | 对 Foundry 启动器拉起、带 `--remote-debugging-port` 的 Chromium 调 `Page.startScreencast`，用 `screencastFrameAck` 做背压 | 同上                                                                 | Foundry 启动的浏览器、Playwright MCP 的 CDP 模式 | 中；需管理端口与归属 | P2 补充                          |
| C. 定时截图轮询                          | 每 N 秒 `Page.captureScreenshot`                                                                                          | 固定开销，无变化也发                                                 | 同 B                                             | 低但浪费             | 只作 B 不可用时的降级            |
| D. VNC / noVNC / WebRTC 整屏             | 执行宿主开 VNC 或 WebRTC，经 Foundry 隧道给浏览器                                                                         | 视频级，慢链路不可用                                                 | 整个桌面                                         | 高；整屏隐私         | **不做**；P3 也只考虑窗口级截帧  |
| E. 录像 / trace 回放                     | agent-browser `record`、playwright-cli `video-start` / `tracing-start`                                                    | 事后                                                                 | 回合结束后                                       | 低（工具已有）       | 作为 P1 的附件选项，不作实时手段 |

### 3.3 传输与存储（P1/P2 共用）

- **事件不带图片**：会话事件只带 `{frameId, callId, source, path, width, height, bytes, url?, title?, capturedAt}`；图片按需走 `/api/local-files/image` 与现有缓存/重试。避免把 base64 塞进可靠事件流（DEV-051 已证明大帧会阻塞共享连接）。
- **P2 实时帧走单独的“可丢弃”通道**：不进可靠 outbox、不 ACK 重放；Server 只保留每个会话的最新一帧在内存；发送前检查背压，积压就丢旧帧（latest-wins）。只在 Server 告知“有人在看”时订阅，观看者全部离开 30 s 后停止。复用 DEV-051 的交互优先 / bulk credit，实时帧优先级低于用户点开的文件。
- **自适应**：按测得吞吐调整帧间隔与尺寸；10 KB/s 链路自动退化为约 0.5 fps、640 宽，并在界面上明示“低带宽，画面延迟约 N 秒”。
- **保留**：P1 截图存在执行宿主的会话目录，随会话归档清理；Server 不持久化帧。可设每会话上限（如 200 张 / 50 MB，超出淘汰最旧，保留每回合最后一张）。

### 3.4 安全与隐私

- **谁能看**：与会话本身的可见性一致（能看会话的人才能看画面）；分享/公开链接默认不含画面。
- **何时采集**：P1 只用模型已看到的截图，不新增采集；P2 实时流只在会话视图打开且用户在“画面”里时进行，可在设置里整体关闭。不在未授权的设备、浏览器、窗口上采集；不截取用户自己的日常浏览器（`--auto-connect` 连用户浏览器时默认不流）。
- **接管期间不采集**（P3，沿用 ChatGPT agent 做法）。
- **遮挡**：CDP 帧无法可靠识别屏幕上的秘密。第一版不承诺自动打码；只在明确的密码输入框（`input[type=password]`）获焦时暂停实时流，并在界面上提示“画面可能含敏感信息”。
- **共享设备账户**：同一系统账户的其他人能读执行宿主上的截图文件；文档与界面要写明，不暗示私密。
- **公开仓库**：截图、录像不进 Git；测试证据放在 `.foundry/attachments/`（已忽略）。

## 4. UX 方案

### 4.1 位置

遵循“一处一物”：画面是会话的一个**详情对象**，放进现有右侧 Context → 详情面板体系，不另造浮层。

```
┌ 聊天 ───────────────────────────────┬ Context ────────────────────┐
│ ▸ 用了工具 agent-browser click @e5   │ 画面                         │
│   [▣ 缩略图 160×90]  localhost:5173  │ ┌─────────────────────────┐ │
│ ▸ 用了工具 browser_take_screenshot   │ │  ● 实时 · 1 fps          │ │
│   [▣ 缩略图]                         │ │  (最新一帧，16:9)        │ │
│ Agent 正在操作浏览器 · 查看画面 →    │ └─────────────────────────┘ │
│                                      │ localhost:5173/settings      │
│ [输入框…]                            │ Changes (3) …  Files (5) …   │
└──────────────────────────────────────┴──────────────────────────────┘
```

点击缩略图或“画面”卡片 → 详情面板（与 Change/File 同一个分栏）：

```
┌ 画面 · agent-browser · 会话浏览器 ──────────── [↗] [×] ┐
│ ● 实时   localhost:5173/settings      第 12/12 步       │
│ ┌──────────────────────────────────────────────────┐   │
│ │                 当前帧（等比，不裁切）            │   │
│ └──────────────────────────────────────────────────┘   │
│ [◀] ▣ ▣ ▣ ▣ ▣ ▣ ▣ ▣ ▣ ▣ ▣ ▣ [▶]   步骤胶片条            │
│ 步骤 12：click @e5 “Save” · 16:02:11 · 打开所在步骤 →   │
└─────────────────────────────────────────────────────────┘
```

- **行内**：只有带图的工具步骤显示缩略图（固定 16:9 占位，加载中/失败沿用 `LocalImage` 状态与“重试图片”）。运行中的回合在状态行给一个明确的文字入口“Agent 正在操作浏览器 · 查看画面”。
- **右侧**：Context 卡片新增“画面”一节（有帧才出现），与 Changes、Files、Previews 同级；点进去是详情。
- **不自动展开**右侧面板（避免抢布局）；用户打开后，若停在最新步骤则**跟随**新帧，手动翻到旧步骤后停止跟随，并显示“回到最新”。
- **弹出**（`↗`）：P2 起提供独立窗口路由（如 `/chats/<id>/screen`），浏览器原生窗口即可当“画中画”；不做页面内悬浮窗（390 宽会遮挡输入框，且与 AGENTS.md 的“一处一物”冲突）。

### 4.2 状态

| 状态   | 显示                                                                     | 说明                  |
| ------ | ------------------------------------------------------------------------ | --------------------- |
| 实时   | 图标 + “实时 · N fps”                                                    | 仅 P2                 |
| 低带宽 | “画面延迟约 N 秒”                                                        | 自适应退化            |
| 暂停   | “已暂停（输入密码中 / 你在其他标签页）”                                  | 隐私或页面不可见      |
| 已结束 | “浏览器已关闭 · 最后画面 16:05”                                          | 显示最后一帧 + 胶片条 |
| 不可用 | 原因 + 操作：设备离线（重试）、旧版 Worker（更新提示）、此工具不提供画面 | 不用空白框            |

状态一律文字 + 图标，不只靠颜色；实时画面区设 `aria-live="off"`，状态变化用礼貌播报。

### 4.3 键盘、无障碍、窄屏、主题

- 缩略图是 `Button`（有 `aria-label`：“步骤 12 的画面：localhost:5173/settings”）；详情内 `←/→` 切步骤、`Home/End` 到首/末、`Esc` 关闭；焦点在胶片条上有可见焦点环；选中帧用填充 + 勾，不叠描边。
- 390 宽：沿用详情面板现有的 container query 窄屏布局（`20-chat-detail.css`），胶片条横向滚动，画面等比缩放、不出现横向溢出。
- 明暗主题：画面外框用 `--fdy-*` token；画面本身不加滤镜。
- 只用 `components/ui` 现有组件（`Button`、`SegmentedControl` 等），不手画控件。

## 5. 分期计划

### P1 每步截图（4–6 人日）

1. Worker：Claude `PostToolUse` 取 `tool_response` 的 image 块；Codex 取 `mcpToolCall.result` 的 image 块；Bash 输出中识别 `Screenshot saved to …` / playwright-cli 截图路径；Server 侧 `operate_resource` 的图写回调用方会话（或由 Worker 侧 MCP 结果拿到）。统一落盘、出 `tool_frame` 事件（只带引用）。
2. Protocol + Server：事件类型与存储（随会话事件，无新表或一张轻表），图片读取复用 DEV-051 路径与权限。
3. Web：行内缩略图、Context “画面”一节、详情面板（最新帧 + 胶片条 + 键盘）；i18n 双语；浏览器矩阵（light/dark × 1280/390、键盘、离线/失败）。
4. 度量：一周内带图步骤占浏览器类步骤的比例、缩略图打开率、预览加载 p50/p95、每会话截图字节数。

### P2 只读实时画面（7–10 人日）

1. 归属：Foundry 为每个会话设定 `AGENT_BROWSER_SESSION`（或识别 agent-browser 会话名与本会话的对应），Worker 用 `agent-browser stream status --json` 找端口；Foundry 启动器启动的 Chromium 用 CDP 直连（B′）。
2. Worker 只转发 `frame`，节流、缩放、背压丢帧；Server 内存保留最新帧，转发给订阅者；Web 订阅/退订与状态机。
3. 度量：首帧时间、端到端延迟、实际 fps、每会话流量、慢链路设备上的退化表现；对 Server 和 daemon 事件循环的影响。

### P3 桌面 / 接管（单独立项，≥3 周）

computer_use 租约窗口的连续截帧（cua-driver 已有窗口截图）、接管与交还（需暂停 Agent、不采集、交还时告诉 Agent 改了什么）。依赖 DEV-028 的后台输入边界与 macOS 授权，风险高，先不排期。

### 风险

| 风险                                                            | 缓解                                                                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 覆盖率低（Agent 多用文本快照）                               | 先度量；如需要，在 Foundry skill / 会话说明里建议关键步骤截图，或在 agent-browser 每步后由 Worker 补一张低质量截图（需评估对 Agent 的副作用） |
| 慢链路占满共享连接                                              | 实时帧独立、可丢、低优先；默认只在观看时传                                                                                                    |
| 秘密出现在画面                                                  | 只看会话者可见；密码框暂停；明示提示；不承诺自动打码                                                                                          |
| 工具版本漂移（agent-browser 流格式、playwright-cli 浏览器版本） | 协议按能力探测；不支持时显示“此工具不提供画面”                                                                                                |
| 浏览器归属错误（看到别的会话的浏览器）                          | 只连本会话启动或声明的浏览器；无法确定归属就不显示                                                                                            |

## 6. 需要用户决定

1. **是否按 P1 → P2 推进**，P3 暂不排期？
2. 右侧面板**是否在 Agent 开始操作浏览器时自动展开**？建议不自动展开，只给“查看画面”入口。
3. P2 实时流**默认开还是默认关**（设置里可改）？建议默认开、仅在观看时传；慢链路自动退化。
4. 截图**保留多久**、是否随会话归档删除？建议随会话，单会话 200 张 / 50 MB 上限。
5. **谁能看**：仅会话可见者；分享链接是否包含画面？建议不包含。
6. “CodeDesk APP” 是否指 OpenAI Codex 桌面 App？若指别的产品，补一列对比。

## 7. 来源

- OpenAI Codex 内置浏览器：[Browser 文档](https://learn.chatgpt.com/docs/browser?surface=app)；[issue #19429 截图区域](https://github.com/openai/codex/issues/19429)；[issue #30605 最小化时截图超时](https://github.com/openai/codex/issues/30605)；[社区：截图回退暴露隐私](https://community.openai.com/t/a-codex-screenshot-fallback-exposed-private-browser-content/1383634)
- Claude Code 桌面 App：[Desktop 文档](https://code.claude.com/docs/en/desktop)
- Cursor：[Browser tool 文档](https://cursor.com/docs/agent/tools/browser)；[Release notes](https://cursor.com/docs/release-notes)
- ChatGPT agent / Operator：[ChatGPT agent 帮助](https://help.openai.com/en/articles/11752874-chatgpt-agent)；[Introducing Operator](https://openai.com/index/introducing-operator/)
- Manus：[WorkOS 介绍](https://workos.com/blog/introducing-manus-the-general-ai-agent)；[Cybernews 评测](https://cybernews.com/ai-tools/manus-ai-review/)（第三方）
- Devin：[Session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)；[Testing & recordings](https://docs.devin.ai/work-with-devin/testing-and-recordings)；[Release notes](https://docs.devin.ai/release-notes)
- Perplexity Comet：[DataCamp 指南](https://www.datacamp.com/tutorial/comet-perplexity)；[The New Comet Assistant](https://www.perplexity.ai/hub/blog/the-new-comet-assistant)
- Browserbase：[Session live view](https://docs.browserbase.com/platform/browser/observability/session-live-view)；[Live URLs API](https://docs.browserbase.com/reference/api/session-live-urls)
- Browser Use Cloud：[Live preview & recording](https://docs.browser-use.com/cloud/browser/live-preview)
- Anthropic computer-use demo：[claude-quickstarts/computer-use-demo](https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo)
- agent-browser：[Streaming 文档](https://agent-browser.dev/streaming)；[issue #1613 帧元数据尺寸](https://github.com/vercel-labs/agent-browser/issues/1613)；本机 0.38.2 实测（§3.1）
- Playwright MCP：[microsoft/playwright #42487 截图文件路径](https://github.com/microsoft/playwright/issues/42487)；[RenderScreenshot：工具与返回](https://renderscreenshot.com/blog/playwright-mcp-screenshots)（第三方）
- CDP：[Page domain（startScreencast / screencastFrame / screencastFrameAck）](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
- Foundry 内部：[DEV-051 图片加载](../devlog/DEV-051-chat-images.md)；[DEV-028 macOS 窗口控制](../devlog/DEV-028-macos-app-control.md)；[Resources](../resources.md)

第三方评测仅用于描述 UX 形态，产品行为以官方文档为准；部分产品（ChatGPT agent、Manus）的界面在 2026 年有变化，实施前应再核对。

## 7. 用户决定（2026-10-29）

用户回复“按建议”，即：(a) 先做 P1，再做 P2，P3 暂缓；(b) Agent 开始用浏览器时不自动打开右侧面板，在步骤旁给“查看画面”入口；(c) 实时画面默认开启、只在有人查看时传输；(d) 截图随会话保存，每会话上限 200 张或 50 MB；(e) 分享链接不包含画面；(f) “CodeDesk APP” 指 OpenAI Codex 桌面 App。
