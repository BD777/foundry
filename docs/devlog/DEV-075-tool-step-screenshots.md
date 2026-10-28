# DEV-075 · Agent 实时画面 第一期：每步截图

状态：已实现并部署到 dev（Server、Web、Worker 发布包）；Agent 自验通过；人工验收待确认。代码未提交（按协调要求不做 Git 写操作）。

来源：[DEV-074 调研](DEV-074-agent-live-view-research.md)，用户 2026-10-29 “按建议”批准（备忘 [§7](../research/agent-live-view-20261029.md)）。协调会话 `sess_1793063405185071529`，实施会话 `sess_1793214485759912776`。

## 做了什么

工具**已经返回给模型**的截图不再丢弃，而是挂到对应的工具步骤上。不新增任何采集。

| 层       | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol | `SessionToolFrame`（id、callId、tool、source、path、mimeType、bytes、宽高、capturedAt、inputId）；事件元数据 `toolFrame`；标签 `Tool frame`；`sessionToolFrameLimits`（200 张 / 50 MB）；`SessionToolFrameList`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Worker   | 新增 `tool-frames.ts`。截图来源：Claude 工具结果中的 image 块（Playwright MCP、Foundry `operate_resource` 的 computer_use 等 MCP 工具）；Codex `mcp_tool_call` 结果中的 image 块；Bash / Codex 命令输出里 agent-browser 打印的 `Screenshot saved to <path>`，以及 playwright-cli（或不回传图片的 Playwright MCP）打印的 `[Screenshot of …](<path>)`。只接受魔数确认的 PNG/JPEG/WebP/GIF，单张不超过 8 MB，每个结果最多 4 张。图片复制到 `<workspace>/.foundry/attachments/frames/<session>/`（0600），复用 DEV-051 的图片管线：placeholder / preview / 原图、Server 缓存、预览预推送。事件只带引用，不带 base64。设备端按同一上限清理最旧的文件。**不读取 agent-browser 的画面流或命令日志**（其中带启动参数和代理密码），只读取工具报告的图片文件字节。打码挂载点为 `ToolFrameRedactor`，第一期未启用。 |
| Server   | 帧事件使用状态键 `frame`（最新优先），侧栏状态因此总能拿到最新一帧，列表走同一个部分索引。`GET /api/agent-sessions/{id}/frames` 返回保留的帧和已清理数量；`GET /api/agent-sessions/{id}/frames/{frameId}/image?variant=` 只读该会话记录过、未被清理、且位于该会话 frames 目录内的文件。两条路由都只对会话的查看者开放（工作区 viewer），session token 不能访问（`agentRouteAllowed`）。上限按读取时计算：保留最新、两个上限同时满足的帧，更旧的返回 410。MCP 的会话读取（`sessionInspectEvents`）排除帧事件，所以 Agent 和交接内容里不会出现画面。                                                                                                                                                                                                                                                       |
| Web      | 工具步骤所在的过程组下方显示最新一帧缩略图（16:9，preview 变体），以及“查看画面 · N 张 / View screen · N screenshots”入口。展开过程组后，每个带图的步骤有自己的缩略图。右侧 Context 新增“画面 / Screen”一节，只在有帧时出现。详情面板显示当前帧（LocalImage，可点开看原图）、`第 i / N 张 · 来源 · 时间 · 尺寸`、胶片条（placeholder 变体，ScrollArea 横向滚动）、上一张 / 下一张按钮、“回到最新”、保留上限说明和隐私说明。右侧面板**不会自动打开**。默认跟随最新帧，手动选了旧帧就停止跟随。键盘：← → 切换，Home / End 跳到首末张，Esc 关闭；胶片条用 roving tabindex 和 `aria-pressed`。被清理的帧显示“已按上限清理”（410）。所有图片都通过会话路由读取，不走 `/api/local-files/image`。双语文案。                                                                                                     |

分享：Foundry 目前没有公开的会话分享链接，聊天链接都需要工作区权限。画面不进入 MCP 和交接读取，session token 也读不到画面路由。以后如果增加公开分享，同样要排除 `toolFrame` 事件和 frames 路由。

## 检查

- Worker：`test/tool-frames.test.mjs` 8/8 通过。覆盖 MCP image 块、computer_use 来源、agent-browser / playwright-cli 路径（带 ANSI 色码，相对路径）、非图片文件不复制（伪装成 `.png` 的密钥文本）、Codex MCP 与命令输出、保留规则、设备端写满 205 张后只剩 200 个文件。
- Server：`store` 的保留规则（数量、字节、跨大帧截断，以及按生产上限计算 300 KiB × 260 张时保留 170 张）；`httpapi` 的 `TestSessionFramesAreForTheSessionViewersOnly`：非成员的列表和图片请求都是 404 且不打扰设备，viewer 能读；写入 202 帧后保留 200 张、清理 2 张，被清理的帧返回 410；未知帧 404；kept 帧按记录的路径转发 `attachment_read`（preview 变体）；状态事件只带最新帧；MCP 读取不含帧。另有 `TestSessionTokensCannotReadFrames` 和 `TestSessionFramePathStaysInTheSessionsFrames`。
- Web：`test/tool-frames.test.mjs` 4/4 通过：帧并入工具步骤、不单独成行；Context 最新帧；面板默认跟随，Home / → / End 切换，tabindex 与 `aria-pressed` 正确，提示已清理数量；只请求会话路由；中文渲染。DEV-076 的两个 Web 测试（7/7、4/4）在同一次部署前通过。
- `scripts/check-changed.sh --files …`（42 个文件）：Web tsc、66 个 Web 测试文件、Worker 构建与 18 个测试文件、protocol 构建、sqlitestore 与 httpapi/store 全量 Go 测试、11 项 UI 审计均通过。首轮 prettier、gofmt、contract（缺少 Go 结构体）、modules（未登记 `tool-frames`）不通过，修正后单独复跑全部通过。

## 部署与更新

- Server：从共享工作树构建（DEV-076 确认：除本项文件外与线上 `45bf4423…` 一致）。sha256 `bacef1e6…`，2026-10-29 04:24 SIGHUP 交接，新进程接管，旧进程 917 ms 后退出，`/healthz` 200。回滚副本 `foundry-server.pre-dev075`。
- Web：与 DEV-076 约定，从共享工作树发布，一次部署同时包含两项。`49ffe22bb1da6bbe` → `4cc41e774de7bf54`（打开最新帧时继续跟随、Esc 关闭）→ `8d54a6ed0632c60e`（面板纵向间距、去掉图片外层的重复边框）。旧 index/version 保存在发布目录 `previous-*`。
- Worker：`0.5.7-dev.126.g4cf538f.local.1793219656`，从共享工作树打包（= DEV-072 + DEV-076 已发布的 `.1793218601` + 本项），包内已核对含 `tool-frames.js`。旧包已备份。dev 服务器设备经独立 systemd user unit 运行 `foundry-worker update` 完成安全自更新（`.1793218601 → .1793219656`）：daemon 已加载新版本；忙碌的执行宿主仍是 `.104`，未强停，空闲切换后才会开始采集该设备上会话的画面。没有改动其他设备。

## 端到端（真实 dev）

- 环境：e2e-alice（密码只由脚本从仓库外文件读取，cookie 放在 0700 临时目录）；DEV-048 合成设备 Worker 临时用当前工作树构建运行，验证后已停止（含执行宿主）；合成工作区 `ws_d4da0f57-…`，内有一个合成静态页 `dev075/page.html`。
- 会话 [`sess_1793219191813911387`](https://dev.foundryapp.app/chats/sess_1793219191813911387?workspace=ws_d4da0f57-8b07-40e2-b85d-54f813982f19)：Claude（外部连接 profile）用 agent-browser 打开页面，截图、点击、截图、点击、截图。产生 3 帧（source `agent-browser`，1280×577，17–18 KB），分别挂在三个 Bash 步骤上。API：列表 200；placeholder 172 B WebP；preview/原图为 PNG；未知帧 404；e2e-alice 读不是自己可见的会话的帧时 404；未登录 403。
- 浏览器（Playwright + 本机 Chromium，独立 profile）：light / dark × 1280 / 390，以及 1440（Context 栏常驻）。加载时右侧面板没有打开；过程组下有缩略图和“View screen · 3 screenshots”；键盘聚焦该链接按 Enter 打开面板；面板显示 `3 of 3`、“Showing the latest”；Home → `1 of 3`（出现“Back to latest”），→ → `2 of 3`，End → `3 of 3`；Esc 关闭面板；任何宽度都没有横向溢出；1440 时 Context 有“Screen”行，点击可打开面板。全程没有请求 `/api/local-files/image`。证据：`.foundry/attachments/20261029/dev075/`（`browser-matrix.json`、`{light,dark}-{1280,390}-{inline,screen}.png`、`light-1440-*`、`light-1280-screen-older.png`），不入库。
- e2e-alice 账号的界面语言是英文，没有为测试改它；中文由 Web 单测渲染验证。

## 限制

- 覆盖率取决于工具是否截图：agent-browser / playwright-cli 多数步骤用文本快照，只有显式截图的步骤才有画面。实时画面属于第二期。
- 只采集主 Agent 的工具结果，子 Agent（Task）内部工具的截图未采集。
- 截图在执行设备的工作区 `.foundry/attachments/frames/` 下。同一系统账户的其他人能读这些文件，界面上的隐私说明已写明。工作区 viewer 也能用 `/api/local-files/image` 按路径读取，这与会话可见范围相同。
- Server 只按读取时计算上限，不删设备文件；设备端在每次新帧后按同一规则删除。如果事件丢失，两边可能略有差异。
- 降级后的旧 Server 不保留 `toolFrame` 元数据，这些帧不会显示。
- dev 服务器设备的执行宿主仍是旧版本，需空闲切换后生效。用户的其他设备需自行更新 Worker。

## 人工验收

1. 打开 https://dev.foundryapp.app/chats/sess_1793219191813911387?workspace=ws_d4da0f57-8b07-40e2-b85d-54f813982f19 （e2e-alice 的合成工作区；用自己的账号时需要该工作区的权限）。预期：“已完成思考并调用工具”下方有一张缩略图和“查看画面 · 3 张”，右侧面板没有自动打开。
2. 点“查看画面”或缩略图。预期：右侧出现“画面 · agent-browser”，显示第 3 / 3 张（计数 2、背景淡红）、“正在显示最新画面”、3 张胶片和隐私说明。
3. 键盘：Tab 到胶片条，按 Home、→、End，画面依次切换到第 1、2、3 张；选到旧帧时出现“回到最新”；按 Esc 关闭面板。点主图会以原图打开。
4. 切换明暗主题，以及窄屏（约 390 宽）各看一次：无横向滚动，选中的胶片有加粗边框。
5. 在宽屏（≥1361）下，右侧 Context 有“画面”一节，点击后打开同一面板。
6. 用自己的设备（先 `foundry-worker update` 并等执行宿主切换）让 Agent 用 Playwright MCP 或 `agent-browser screenshot` 截图。预期：新步骤带缩略图；不截图的步骤没有缩略图。

## 时间线

| 时间（UTC+8）    | 变化与证据                                                                                                        | 剩余动作                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 2026-10-29 03:00 | 接手：读 DEV-074 备忘与 brief，确定数据模型（帧 = 会话事件 + 状态键 + 会话路由），复用 DEV-051 图片管线。         | —                                            |
| 2026-10-29 04:24 | Server `bacef1e6…` SIGHUP；Web `49ffe22b`（与 DEV-076 合并发布）。合成会话真实产生 3 帧，API 与访问控制检查通过。 | 浏览器矩阵                                   |
| 2026-10-29 04:33 | 浏览器矩阵中发现面板纵向被拉开、打开最新帧时不跟随；修复后 Web `8d54a6ed`，矩阵通过。                             | —                                            |
| 2026-10-29 04:35 | Worker `.1793219656` 发布；dev 服务器设备 daemon 安全自更新并已加载新版本（执行宿主忙，未强停）。                 | 人工验收；执行宿主切换后在真实会话复看一次。 |
