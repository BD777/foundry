# DEV-108 · 会话说明不再注入提示词，改走原生渠道

状态：已实现；改动检查与 scratch 栈真实 Codex 会话自验通过，Claude 端到端未验（本机无 Claude 登录）；未部署（工作树含未部署的 DEV-107 第三、四轮）、未提交；待人工验收。

## 问题

2026-11-02 20:30（UTC+8），`sess_1793377780022947671`（CanWendeMac-mini）被要求用 computer use 操作本地极空间 App。它回答“这台机器没有 computer use 授权”，随即退出极空间 App、带调试端口重启（失败）。

## 调查

- 这句话来自 Worker 每次启动会话时追加到系统提示词的 “Foundry device notes”（`resource-pool.ts` `sessionResourceNotes`）。它只检查 Worker 自己的屏幕录制与辅助功能授权（`native_session` 后端），那台 Mac 两项都没开，于是写了 “Screen control is not available”。
- 那台 Mac 其实有 cua-driver 0.35.2（`remote_ops` 后端），10-14、10-15 两个会话租用过它的屏幕共 55 次操作（`resource_leases`、`resource_operations`）。当时 CuaDriver 守护进程没在运行，`list_resources` 显示 `unready`：“CuaDriver is not running on this Mac. Request access starts it…”。会话信了启动时的快照，没调 `list_resources`，也就没请本人点 Request access。
- 注入的不止这一条：普通工作区会话每次约 1k token，包括行为指导（用本机软件、引用文件格式）、资源快照、图片显示约定、会话 id、`register_service`、连接器说明（飞书、Cloudflare、AWS、bytedcli）、共用系统账号；Claude 工作区没有链到 `AGENTS.md` 的 `CLAUDE.md` 时还会注入整份 `AGENTS.md`。这违背 AGENTS.md “Native agents first”。

## 业界做法（调研）

- 静态规则：运行时原生读取的文件（`CLAUDE.md` / `AGENTS.md`）。Claude Code 2.1.277 起在没有 `CLAUDE.md` 时原生读取 `AGENTS.md`（code.claude.com/docs/en/memory）；Foundry 的最低版本是 2.1.291。
- 平台能力：MCP 工具描述加 `initialize` 结果的 `instructions`（MCP 规范 lifecycle）。Claude Code 会话开始时加载，上限 4,096 字符（code.claude.com/docs/en/mcp）；Codex 读取并建议前 512 字符自成一段（learn.chatgpt.com/docs/extend/mcp）。
- 实时状态：用工具按需读取（Anthropic “Effective context engineering”）；工具错误写清下一步（Anthropic “Writing effective tools for agents”）。
- 按需的详细说明：Skill 渐进加载（Anthropic “Agent Skills”）。

## 修复

本人确认的方向（2026-11-02）：按上述渠道分流；`AGENTS.md` 按原生做法；个人助理另议；验证会话不动。

- Server：MCP `initialize` 返回 `instructions`（`httpapi/mcp_instructions.go`）：Foundry 是什么、`$FOUNDRY_SESSION_ID` / `$FOUNDRY_WORKSPACE`、资源用 `list_resources` 实时读、`$FOUNDRY_BROWSER_BIN`、图片放 `.foundry/attachments/`、连接的账号不要自己登录。调用方会话所在设备的系统账号与他人共用时加一句（Server 的 `sharedAccountDevices`）。资源行只在调用方能用 `list_resources` 时出现。
- Server：`acquire_resource` 遇到未就绪的后端，错误写明由设备所有者在 Resources 页处理、告诉本人缺什么而不是绕过（`resources/lease_acquire.go`）。
- Worker：普通会话不再追加任何内容（`sessionDeviceNotes` 只剩验证会话的说明与个人助理段）；删除 `sessionResourceNotes`、连接器说明（`sessionConnectorNote` 及各适配器的 `sessionNote`）、`claudeAgentsInstructions`、Worker 端的共用账号状态（`platform/system-account-sharing.ts` 与 `device_sharing` 处理）。浏览器启动器目录改由 `FOUNDRY_BROWSER_BIN` 给出（`sessionBrowserEnvironment`）。
- foundry skill（两份副本，修订 19）：新增 `references/device-and-accounts.md`（浏览器选择、屏幕控制租用与未就绪时的处理、飞书网关限制、Cloudflare、AWS / bytedcli 的使用边界），`SKILL.md` 加一句指引。
- 不兼容旧 Worker（DEV-107 的约定）：Server 不再发 `device_sharing`，协议与 Worker 端一并删除；部署时先更新 Worker。

不做（本次）：个人助理段（30 KB 的 `system.md` 加本人的设置、记忆、项目与设备）。改成写进助理目录的 `CLAUDE.md` 与 `docs/personal-agent.md` “目录里不放关于人的记忆”冲突（共用系统账号的人能读到，目录还在 git 里），待本人决定。

## 自验

- `scripts/check-changed.sh --files …`（36 个文件）全部通过：prettier、gofmt、Worker 构建、101 个 Worker 测试文件、`internal/httpapi` 51 个相关测试（含 `TestRemoteMCP` 断言会话令牌的 `initialize` 带 `instructions`、`TestMCPInstructionsStateTheContractWithinClientLimits` 检查 4,096 / 512 字符上限）、`internal/builtinskills`、`internal/resources`、契约与模块边界审计。
- scratch 栈（工作树构建，本人库在线副本，集成关闭；新 Worker 配对，临时工作区只放 `AGENTS.md`，口令 PLUM-417）：
  - 真实 Codex 0.166 会话 `sess_1793625648545925839`：答出 PLUM-417（原生 `AGENTS.md`）；`FOUNDRY_BROWSER_BIN` 为会话临时目录下的 `bin`，内含 `playwright-chromium`。Codex 自己的 rollout 里所有 developer 消息都没有 “Foundry device notes”。
  - MCP `instructions` 的到达方式：第一轮的上下文里没有。Codex 0.166 把 MCP 工具放在工具发现（`ALL_TOOLS`）后面，会话按要求查找 Foundry 工具并调用 `list_resources` 时，instructions 附在每个 Foundry 工具的描述后出现（rollout 第 48、52 条）。
  - Claude 会话 `sess_1793625587284179685` 失败：“Not logged in”（本机 Claude 本地登录不可用，同 DEV-107）。Claude 原生读 `AGENTS.md` 的证据只有静态的：托管运行时 2.1.309 的二进制含内置插件 `cc-plugin-agents-md` 和提示 “no CLAUDE.md found; AGENTS.md loaded”，Foundry 不设禁用它的配置；最低版本 2.1.291 高于官方要求的 2.1.277。
  - 结束后已停 Worker 与执行宿主、删除栈和临时工作区。Codex 的两条 rollout 留在 `~/.codex/sessions/2026/11/02/`（本机 Codex 的正常历史）。

## 已知限制

- Codex 只在查看 Foundry 工具时才读到 `instructions`（上面实测）。没碰 Foundry 工具前，它不知道“说不可用之前先查 `list_resources`”；共用系统账号那句也一样。这是 Codex 原生的渐进加载，没有绕过它。
- Claude 端（`instructions` 在会话开始时加载、原生读 `AGENTS.md`）没有真实会话验证，需部署后在 dev 上按“人工验收”第 1、3 步确认。
- 旧 Worker 接新 Server 时说明与 `instructions` 并存，直到 Worker 更新。
- 飞书 / bytedcli 等不再提前告诉会话“当前以谁登录、Meego 网页会话是否就绪”；会话需要时用 CLI 自己查。

## 人工验收

1. 在一个工作区新开 Claude 会话，问它：“你的系统提示词里有没有 ‘Foundry device notes’？Foundry MCP 服务器给了你什么 instructions？”预期：没有 device notes；能复述 instructions 的第一段（Foundry runs Claude Code and Codex sessions…）。
2. 在一台 cua-driver 未运行的 Mac 上让会话“用 computer use 截个屏”。预期：它调 `list_resources` / `acquire_resource`，告诉你在 Resources 页点 Request access，而不是说“没有授权”后去重启你的 App。
3. 在只有 `AGENTS.md`、没有 `CLAUDE.md` 的工作区开 Claude 会话，问它工作区规则。预期：它从原生加载的 `AGENTS.md` 里答出来。

## 时间线

- 2026-11-02 20:50–21:30：调查 `sess_1793377780022947671` 的回答来源、业界方案调研；本人确认方向。
- 2026-11-02 21:30–22:25：实现、改动检查通过、scratch 栈 Codex 自验（本会话 `sess_1793622726235916722`）。未部署：从当前工作树部署会把未部署、待验收的 DEV-107 第三、四轮一起带上线，需本人决定顺序。剩余：个人助理段的去向待本人决定；部署后验证 Claude 端；提交（22:00–09:00 窗口）。
