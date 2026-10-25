# DEV-041 原生会话完整历史、Codex 工作区指令与插件缓存

2026-10-25 至 10-26，用户反馈：在 Foundry 中继续 cottoncpp 上的会话 `sess_1792942466521638962` 时，提示“本地会话较大，当前仅载入前段记录”，看不到最新内容；用户认为它原本是 Foundry 会话。来源会话：`sess_1792942569342884961`。

## 调查结论

- 会话来源：原生日志 `~/.codex/sessions/2026/10/23/rollout-…-01a166bd-3790-73f2-b54e-96164aaf4129.jsonl` 的首行为 `originator: "Codex Desktop"`、CLI 0.153.4；Foundry 自己启动的 Codex 会话是 `originator: "foundry"`，日志含 `FOUNDRY_SESSION_ID`。数据库 `agent_session_native_ids` 中该原生 id 只有 10-25 15:34 接管时写入的一行；10-23 02:30–07:00 cottoncpp 工作区没有 Foundry 会话，`.foundry/sessions/` 也没有对应目录。因此 10-23 的对话由 Codex Desktop 发起，Foundry 当时只是把它列为原生对话，10-25 用户发消息时才接管。用户接受此结论。
- 只显示开头：Worker 只读原生日志的前 1 MiB 生成对话记录，超出部分加一条“仅载入前段”的提示（`native-chat.ts` / `native-chat-transcript.ts`）。该日志当时 3.15 MB，共 1016 行，前 1 MiB 只有 198 行，止于 10-23 03:18。接管（`adoptNativeChat`）把这份截断的记录一次性复制成会话事件，之后不会再补。缺失部分为 779 行、2.09 MB（10-23 03:18–06:15），包括部署和授权页的几轮对话。模型本身从完整日志恢复，回答不受影响。
- “9 份副本”：之前的统计是误判。`~/.foundry/native-runtime/owners/codex/<id>/sessions` 是指向 `~/.codex/sessions` 的符号链接，递归查找会沿链接重复列出同一文件；12 条路径都指向 inode 3772118，日志本身没有副本。旧 owner 目录只保留两个历史链接，这是有意为之：Codex 的 SQLite 索引按这些路径记录 rollout。真正重复的是 Codex 在每个生成的 CODEX_HOME 下克隆的插件市场 `.tmp/plugins`，每份约 103 MB，cottoncpp 当前 owner 目录 105 MB 中 103 MB 是它。
- 接管过程中的异常：
  1. Codex 会话没有加载工作区 `AGENTS.md`。Foundry 生成的 Codex 配置把工作区设为 `trust_level = "untrusted"`（用于屏蔽项目 `.codex/config.toml`），代码注释认为这不影响 `AGENTS.md`。实测 Codex 0.164 在 untrusted 项目下完全不读项目 `AGENTS.md`：接管后的第一轮写入 “The previously provided AGENTS.md instructions no longer apply”，`world_state.agents_md` 为空。该问题不限于接管：cottoncpp（`01a16950`、`01a16676`）和 foundry 仓库（`01a16e60`）上 Foundry 启动的 Codex 会话都没有加载 `AGENTS.md`，Agent 只能自己 `cat AGENTS.md`。对照探针（无模型调用，provider 指向本机不可达端口）：trusted 时 `agents_md` 为项目文件；untrusted 时为空；`$CODEX_HOME/AGENTS.md` 在 untrusted 下照常加载，60 KB 未截断。
  2. 继续原生对话时总会出现“此原生 Codex Local 会话从这里起改用 Codex Local 继续”，即使配置相同（`profileTransitionNoteForSend` 对原生对话不比较配置）。
  3. 其余事件正常：没有错误或警告事件；输入 id `01a173bf-…` 来自运行中排队的消息，属正常格式。

## 修复

- 原生对话改为“最新部分 + 向前翻页”：
  - Worker 读日志末尾约 1 MiB（按行对齐；单行超过 1 MiB 时整行读入，超过 16 MiB 的行跳过），`ChatThread.transcriptBefore` 记录这部分的起始字节偏移。没有 id 的步骤按日志字节偏移命名，各页命名一致。
  - 新增设备请求 `read_native_history`（能力 `native_history_v1`）：按原生 id 在本设备日志中查找，只返回属于发起工作区（cwd 一致）的对话，返回偏移之前的一页及新偏移。
  - Server：`GET /api/chats/{id}/history?before=` 为未接管的原生对话读取更早的页面（Viewer 权限）。接管时把 `transcriptBefore` 记入 `agent_session_native_ids.history_before`（启动时自动加列）。会话事件分页读到最早的已存事件后，若仍有未导入的历史，`eventsBefore` 继续指向它；下一页从设备读取并以更早的 `created_at` 存为事件（`ImportNativeHistory`，按会话串行、重复页面忽略），直到日志开头。导入后的历史永久保存在会话中。
  - Web：打开原生对话时，滚到顶部或点“加载更早的消息”会从设备读取上一页并拼到前面；已接管的会话沿用原有分页。
- Codex 工作区指令：生成的 Codex home 写入 `AGENTS.md`，内容为工作区根目录的 `AGENTS.override.md` 或 `AGENTS.md`（标注来源，128 KiB 上限与 Claude 一致）；工作区删除该文件时同步删除。项目仍为 untrusted，项目 `.codex/config.toml` 继续屏蔽。
- 插件：生成的 Codex 配置加 `[features] plugins = false`，Codex 不再为每个会话克隆约 100 MB 的插件市场（Foundry 本来就不导入用户插件配置）。实测探针 home 从 103 MB+ 降到 3.7 MB。
- 接管提示：用同一配置继续原生对话时不再显示“改用 … 继续”。

## 验证与部署证据

证据目录：`.foundry/attachments/20261026/dev041-native-history/`（截图、浏览器脚本、检查日志）。

- `scripts/check-changed.sh` 全部通过（`check-changed.log`；模块边界修正后补跑 `check-changed-after-boundary-fix.log` 与 `audit:modules`）：prettier、gofmt、protocol 构建与测试、Web tsc 与 52 个测试文件、Worker 构建与 20 个测试文件、sqlitestore 19 项、httpapi/store 全包（640 s）、UI/contract/模块审计。新增测试：Worker `native-chat-history.test.mjs`（大日志按页回到开头、各页拼合与整份一致、超长行、跨工作区拒绝）、`runtime-isolation.test.mjs`（AGENTS.md 软链接/override/删除、plugins=false）；Server `native_history_test.go`（两层）；Web `native-chat-history.test.mjs`（拼页去重、同配置不提示）。
- 部署（2026-10-26 00:57–00:59）：
  - 数据库在线备份 `~/.foundry/server/backups/foundry-20261026-pre-dev041.db`（quick_check ok）。旧 binary、index.html、version.json、Worker release.json 备份在 `~/.foundry/server/releases/dev041-native-history/previous`。
  - Server：构建自工作树 `fix/native-history-and-codex-instructions`（基于 `122222b`，未提交），SHA256 `5eb248d9…acb560`；PM2 `foundry-server` 重启后 PID 355020，实际加载的可执行文件哈希一致，`/healthz` ok（startedAt `2026-10-25T16:57:46Z`），公网 200；`agent_session_native_ids.history_before` 已自动加列；cottoncpp、sg-chaos、byte-dev、byte-dev-sg、CanWendeMac-mini 均已重连。
  - Web：`25a57f29637fac69`，公网 `version.json` 一致。
  - Worker：发布 `0.5.7-dev.71.g122222b.local.1792947416`。cottoncpp 无运行中会话、无工作区常驻服务，以独立 systemd 临时单元执行 `foundry-worker update`：`0.5.7-dev.57 → 0.5.7-dev.71`，daemon（00:59:29）与执行宿主（00:59:45）均已加载新版本。
- 修复本会话：删除接管时导入的 64 条前段事件（可由原生日志重建，备份中保留），`history_before` 设为 3091610（10-25 Foundry 接管前的最后字节）。在 cottoncpp 上用已安装的 Worker 从该偏移向前读取：3 页、336 条记录、348 ms 读到日志开头，最后几轮正是此前缺失的授权页相关对话。会话页面向上滚动时由 Server 逐页导入。
- 真实浏览器（Chromium，scratch 栈 `dev041`：live DB 副本、集成关闭、合成工作区 `/tmp/dev041-e2e/ws` 与 2.8 MB 合成 Codex 日志，结束后已拆除并删除合成数据）：
  - 原生对话打开时只显示第 39–59 轮；滚到顶部触发两次 `/history?before=` 请求（1775760、727273），读到第 00 轮并显示“对话开头”（`1-native-latest.png`、`2-native-start.png`）。
  - 发送消息后接管为 `sess_1792948229222943657`，未出现“改用 … 继续”提示；刷新后会话先显示最新部分，向上滚动经 `eventsBefore` 两页导入到第 00 轮（`3-session-start.png`）。该会话的运行因合成日志缺少真实 Codex 元数据而无法续接，属测试数据限制。
  - 深色 390 px：读到开头，“对话大纲 1/61”，无横向溢出（`4-session-dark-narrow.png`）。
  - 同一合成工作区新建 Codex 会话，工作区 `AGENTS.md` 要求回复 `OK-AGENTS-DEV041`，真实 Codex 运行回复 `OK-AGENTS-DEV041`；生成的 Codex home 含 `AGENTS.md`、`plugins = false`，无 `.tmp/plugins`，每个 0.5–2.5 MB（之前约 105 MB）。

## 限制

- 未接管的原生对话的更早页面不在 Server 保存，需要设备在线；接管后的会话每页导入一次后不再依赖设备。
- 设备 Worker 未更新到含 `native_history_v1` 的版本前，向前翻页会提示需要更新 Worker。
- 只加载工作区根目录的 `AGENTS.md`，与 Claude 侧一致；子目录中的嵌套 `AGENTS.md` 不自动加载。
- 已在执行中的 Codex 进程保留旧配置，下一次启动新执行宿主时生效。

## 人工验收

1. 打开 `sess_1792942466521638962`（cottoncpp，「评估 limen 在 AWS 加拿大的高性价比机型」）：先看到 10-25 起的对话；向上滚动或点「加载更早的消息」，依次出现 10-23 的部署、授权页等几轮，直到「对话开头」与第一条“这里是有aws cli吧？…”。不再出现「本地会话较大，当前仅载入前段记录」。
2. 在 cottoncpp 工作区打开任一较大的原生 Codex/Claude 对话（未接管）：先看到最新几轮，向上滚动可一直加载到开头。用相同配置发送消息继续，不出现「改用 … 继续」。
3. 在 cottoncpp 上新建 Codex 会话，问它“你读到的工作区 AGENTS.md 第一节标题是什么”：应能直接答出 `CLAUDE.md` 的内容，无需先执行 `cat AGENTS.md`。

## 2026-10-26 进展

- 调查、代码、自验、dev Server/Web 部署、Worker 发布及 cottoncpp 更新、本会话修复已完成。人工验收待确认。
- 提交：用户 2026-10-26 授权在夜间窗口（22:00–次日 09:00）直接提交并推送 main；以单个提交推送到 main，部署的 binary 与该提交内容一致。
- 未更新：sg-chaos 本机 daemon（运行本调查会话，避免中断）及其他设备，按各自更新生效。
