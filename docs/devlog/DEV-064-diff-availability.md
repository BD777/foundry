# DEV-064 Change 面板 “Could not load the diff”：Diff 可用性预先可知

| 环节            | 状态   | 说明                                                                                                                                                                                                                                |
| --------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 问题理解/调研   | 已完成 | 根因在 Web：Git 仓库里“只被回答提到”的文件也按 Change 打开并请求 Diff；真实库只读统计见下文                                                                                                                                         |
| 代码            | 已完成 | Protocol/Worker/Server/Web，文件清单 `.foundry/attachments/20261028/dev064/files.txt`                                                                                                                                               |
| dev Server 部署 | 已完成 | 线上 `dev023-candidate/foundry-server` sha256 `edac08df5a13b9fc`（共享树构建，已含本项字段）；10-28 15:49 SIGHUP 交接，新 pid 2310396 接管，healthz 200                                                                             |
| dev Web 部署    | 已完成 | `b3d2617e4d7a847c`（经 `scripts/deploy-web-dev.sh`，共享树构建）；线上入口 JS 含新文案                                                                                                                                              |
| Worker 更新     | 部分   | 已发布的 `0.5.7-dev.104.g4d184b2.local.1793172116` 已含本项 `session-files.js`（与当前树逐字节一致），无需另打包；dev 服务器设备 的 `runtime/current` 和执行宿主仍是 `.1793154141`（不含本项），切换由 DEV-066 负责，本项未触发更新 |
| Agent 自验      | 已完成 | 单测 + scratch 栈真实 Codex 回合 + 真实浏览器（light/dark × 1280/390，键盘）                                                                                                                                                        |
| 人工验收        | 待确认 | 见“验收步骤”                                                                                                                                                                                                                        |

## 问题

用户截图：聊天侧栏把 `zspread2_20261021_tokyo11_umx_binance_pr…` 按 “Change” 打开，Diff 页签红卡 “Could not load the diff — This file is not one this chat's tools wrote.”，File 页签正常。用户说很多文件都是 Diff 失败、File 正常，要求不能 diff 的文件不要显示 Diff 页签。

## 根因

- 真实会话（只读查库）：文件是 `<workspace>/docs/loops/zspread2_20261021_tokyo11_umx_binance_preparation.md`。Codex 会话 `sess_1792583272196813477` 用写入工具创建了它。用户打开的是另一个聊天 `sess_1792897906152291224`（Claude），这个聊天在 7 个回合里只是用回答提到它，ledger origin 为 `reference`，`inGitRepo: true`。文件在这期间从 10 KB 长到 18 KB，但不是这个聊天的写入工具写的（shell 命令或别的会话写的）。
- Worker 的 diff 读取只接受 `origin: "tool"` 的文件（`readSessionFileDiff`），所以拒绝。这是有意的：Foundry 不把磁盘上的变化算到会话头上。
- Web 不一致：Changes 列表用 `isSessionChange`（`inGitRepo && origin === "tool"`）分组，但详情面板的标题 “Change”、图标和 `ChangeDetail`（Diff/File 切换）只看 `selection.inGitRepo`。从 Files 区或回答里的链接打开一个被提到的仓库文件时，就进了 Change 视图，Diff 必然失败。和 DEV-055 的路径链接无关；DEV-055 只是让这类文件更容易点开。
- 规模（dev 库只读统计，按聊天 × 路径去重）：4,510 个文件条目里，3,439 个会以 Change 视图打开，其中 448 个（13%）是只被提到的文件，Diff 一定失败。最多的是 md 185、json 71、ts 54。没有发现“工具写入在会话 A、最新记录在会话 B 只提到”导致失败的情况，但代码里存在这个隐患，一并修了。

## 决策

采用方案 (b)，加上 (a) 中已有的基线：

1. **只有工具写的文件才是 Change**。被提到的文件一律按 File 打开：标题 “File”，没有 Diff 页签，不请求 diff。不用 Git HEAD 给被提到的文件造基线，理由如下：
   - 范围标签写的是 “All of this chat's edits”，HEAD 差异会把其他会话、编辑器、构建的改动算到这个聊天头上，违背 ledger 的归属原则。截图里的文件正是另一个会话创建的。
   - 读 HEAD 还要在设备上跑 git，范围和成本都扩大。
2. **Diff 可用性在打开之前就已知**。Worker 在回合结束时为 Git 仓库内的工具写入文件上报 `diff` / `totalDiff`，取值 `text | binary | tooLarge | noBaseline`，分别对应本回合和整个会话；判断复用 diff 读取的同一函数 `diffAvailability`。Server `SessionFileRecord` 原样保存，Web 聚合成 `diff`、`turnDiff`。值不是 `text` 时，不显示 Diff/File 切换，直接显示文件，顶部注明原因（“No diff for a binary file”、“No diff: the file is over 1 MB”、“No diff: no copy from before this chat's edits was kept”），新文件再加 “New file” 徽标。
3. **旧设备兼容**：没有上报字段时，文件读取结果是 binary 或非 SVG 图片，就按 binary 处理，不请求文本 diff；其余情况保持原行为（请求 diff，返回 unavailable 时显示说明和 “View file”，不报错）。
4. diff 请求走最近一次用工具写入该文件的会话（`diffSessionId`），而不是最近一次记录它的会话。
5. Git 仓库外的工具写入文件仍在 Files 区按 File 打开（原行为），不额外上报可用性事件。

保留的已有基线：Claude 是 PreToolUse 写前副本；Codex 是回合开始时的 Git 快照；会话新建的文件以空文件为基线（`beforeLabel: empty`，显示 “New file → …”）。

## 改动

- `packages/protocol/src/session.ts`：`SessionFileDiffAvailability`，`SessionFileRecord.diff/totalDiff`
- `packages/worker/src/session-files.ts`：`diffAvailability()`；`reportLineCounts` 上报可用性（仅 Git 内）；`readSessionFileDiff` 复用同一判断；`changeCounts` 只在 `text` 时计数
- `apps/server/internal/store/session_files.go`：`Diff`/`TotalDiff` 字段（+ `session_files_test.go`）
- `apps/web/src/features/chat/chat-context-model.ts`：导出 `isSessionChange`，聚合 `diff`/`turnDiff`/`diffSessionId`
- `apps/web/src/features/chat/chat-detail-panel.tsx`：3 处 `selection.inGitRepo` → `isSessionChange(selection)`（标题、图标、ChangeDetail 分支）
- `apps/web/src/features/chat/chat-detail-change.tsx`：`changeWithoutDiff()`，无 diff 时只显示文件与原因，新文件徽标
- `apps/web/src/features/chat/chat-types.ts`、`i18n/locales/{en,zh-CN}/chat.ts`
- 测试：`packages/worker/test/session-files.test.mjs`、`apps/web/test/chat-change-detail.test.mjs`

## 验证

- Worker `session-files.test.mjs` 26/26：新增“变更在读取前就说明是否有文本 diff”（text/tooLarge/binary/noBaseline，与读取结果一致）和“命令写、回答提到的文件不提供 diff”。
- Web `chat-change-detail.test.mjs` 11/11：被提到的文件无切换、无 diff 请求；设备上报 binary/tooLarge/noBaseline（含单回合）时只显示文件和原因；新 binary 文件显示 New file；旧设备的 binary 文件不请求 diff；text 变更经 `diffSessionId` 读取；模型聚合。
- Server `go test ./internal/store` 通过。
- `scripts/check-changed.sh --files …`：本项文件 prettier/gofmt、protocol、worker tests、go store、audit:ui 通过。失败项都不在本项文件中，属于共享树里其他会话的进行中改动：tsc `src/api/http.ts:120`、web `file-delivery.test.mjs` 下载重试、`session-work-controls.test.mjs`、audit:contract `EnqueueChatMessageInput.steer`。
- 真实设备（scratch 栈 `dev064`，dev 库副本，`FOUNDRY_INTEGRATIONS=off`，Worker 为当前树构建，独立 state root；验后 `down` 已删除）：在合成 Git 工作区 `/tmp/dev064/ws` 运行真实 Codex 会话 `sess_1793161031608628134`：
  - `calc.py` apply_patch 修改：上报 `diff/totalDiff = text`，+5
  - `data/big.log`（1.1 MB）apply_patch 修改：`tooLarge`
  - `data/report.csv` 由 shell 写入、回答提到：`reference`，无 diff 字段
  - `/tmp/dev064/outside/note.md`（仓库外）apply_patch 新建：Files 区，无 diff 字段
- 真实浏览器（headless Chromium，light/dark × 1280/390，行与链接都用键盘 Enter 打开），4 种组合结果一致：
  - calc.py：标题 Change，有切换，渲染 diff，1 次 diff 请求；键盘在 Diff/File 间切换正常
  - big.log：标题 Change，无切换，显示 “No diff: the file is over 1 MB” 和文件，0 次请求
  - report.csv（Files 区和回答内链接两种入口）、note.md：标题 File，无切换，0 次请求，无红卡

  截图在 `.foundry/attachments/20261028/dev064/shots/`。

- 二进制文件的工具写入：Codex apply_patch 无法写二进制，真实回合未覆盖，由 Worker 单测和 Web 旧设备回退单测覆盖。

## 限制

- 已有的事件（升级前的回合）没有 `diff` 字段，tooLarge/noBaseline 仍要先请求再显示说明（不是红卡）。被提到的文件这一主要问题与 Worker 版本无关，Web 已修复。
- 切换 Diff→File 时工具栏会重新挂载，键盘焦点回到页面（之前就是这样）。DEV-065 复用该面板时可以让 `SessionFileView` 接收主体内容，保持同一棵树。
- 部署说明：Server 和 Web 在本项部署前已经被别的会话用同一共享树构建上线（sha 和 build id 一致），所以本项的 SIGHUP 和 Web 发布实际是同版本替换。`foundry-server.pre-dev064` 和当前版本相同；要撤掉本项需回退到 `foundry-server.pre-dev057`，但那会同时撤掉 DEV-057。

## 验收步骤

1. 在 dev 打开截图中的聊天（`sess_1792897906152291224`），从 Files 区或回答里的链接打开 `docs/loops/zspread2_20261021_tokyo11_umx_binance_preparation.md`。预期：标题为 “File”，没有 Diff/File 切换，没有红卡，直接显示文件，可下载。
2. 在任一聊天让 agent 用编辑工具修改仓库内的文本文件，从 Changes 打开。预期：标题 “Change”，Diff/File 切换存在，Diff 正常显示。
3. 设备升级到 `.1793172116` 或更新版本后，让 agent 编辑一个超过 1 MB 的仓库文件，或一个二进制文件。预期：Changes 中打开时没有切换，顶部写 “No diff: the file is over 1 MB” 或 “No diff for a binary file”，下方是文件。
4. 浅色/深色、窄屏（390 px）下重复 1–2，Tab/Enter 可操作行与切换。

## 时间线

| 时间（北京）      | 变化/证据                                                                                                     | 剩余                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 2026-10-28 ~12:00 | 定位根因，只读统计 448/3,439；实现 Protocol/Worker/Server/Web 与测试                                          | —                                                |
| 2026-10-28 12:20  | scratch 栈真实 Codex 回合 + 浏览器矩阵；回合因 provider 会话额度中断                                          | —                                                |
| 2026-10-28 15:51  | 续做：浏览器矩阵全部通过，scratch 已删除；Server SIGHUP（同版本）、Web `b3d2617e4d7a847c` 已上线，devlog 完成 | 人工验收；dev 服务器设备 执行宿主切换（DEV-066） |
