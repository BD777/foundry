# DEV-105 · 回归 Agent 原生用法

状态：三步全部完成，已部署 dev（Server `2a5eb614…`、Worker `0.5.7-dev.180.ge880c37a.local.1793381451`、Web `5c527bfe…`），并已提交合入 main（PR #164，`b42fa748`，2026-10-31；本人授权提交）。Agent 自验与本人委托的真实会话验收通过（见流水）。

## 计划

1. 风险最低的部分（本步）：去掉 Claude 系统提示里重复的 skill 目录；只在 Skill 试用会话里禁用原生子代理；不再把工作状态注入模型。
2. Codex 的 skill 改为原生发现：Foundry 提供的 skill 以 symlink 放进工作区 `.agents/skills/`（写入 `.git/info/exclude`），恢复原生 skill 说明，不再禁用用户自己的 skill。
3. 配置目录与配置来源回归原生：账号与模型用 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 加命令行层设置（Codex 用 `-c`）钉住；默认账号用用户自己的 `~/.claude`、`~/.codex`，其他账号的配置目录以 symlink 链入用户的 skills、agents、规则与 settings；不再由 Foundry 把 AGENTS.md 拼进提示。先复现 10-16 的窗口污染问题，证明新方式挡得住。

## 第一步

- **原生子代理：** 原条件是“会话的 skill 里有草稿或有排除项”，工作区只要有草稿，所有会话就失去 Agent/Task（Codex `multi_agent`）。改为明确的 `skillTrial` 标记，只在带 `skillSelection` 创建的会话上设置。
- **Claude 的 skill 目录：** Claude Code 自己列出插件 `foundry-workspace:*` 里的 skill，Foundry 不再在追加的系统提示里另列 JSON 目录和规则；追加内容只剩设备说明。Codex 仍需要目录（它的原生 skill 说明在第二步之前是关着的），不变。
- **工作状态注入：** Claude 的 UserPromptSubmit / PreToolUse / PostToolUse 不再返回 `additionalContext`，PostCompact 不再补发，回合提示不再带前缀；Codex 压缩后不再 steer、压缩恢复的继续说明不再附带工作状态。hook 只保留观察（哪个工具调用启动了哪个进程、写了哪个文件、定时器、后台任务），见调研文档的 hook 表。
- 测试：`runner-skills`（Claude 无目录；有草稿的普通会话保留子代理，试用会话关闭）、`codex-app-server`（压缩后不注入任何内容）更新；worker 相关 6 个测试文件 73/73、`runner-skills` 14/14 通过。

## 删除 skillSelection（Skill 试用）

本人决定删除（2026-10-31）。它是 DEV-006/007（10-19）加的“Foundry 自己做 Skill 对照实验”：一个会话装草稿、一个不装。实际只用过 5 次（2 次是它自己的回归测试），最后一次 10-27。为了让“不装”的那组不被原生子代理看到磁盘上的 skill，它要求锁定输入、禁止 fork 和导入上下文、关掉原生子代理。Skill Creator 自带的评测（原生子代理分别跑带与不带 skill）就是原生做法。

- Server：删除 `skill_trials.go`、`create_session` 的 `skillSelection`、会话记录里的选择、派发时的试用分支、草稿的 `lastTrial`，以及只为试用存在的草稿跨执行根导出（`export_draft_skill`）。
- Worker：删除试用分支、`skillTrial`、`excludedNames`、草稿导出处理与 transfer 校验；原生子代理在任何会话里都不再被关闭。
- Web：草稿页去掉“试用…”按钮、试用对话框和“上次试用”信息，相关文案与样式。

## 第二步：Codex 原生发现 skill

- `codex-native-skills.ts`：把工作区选中的 skill 以 symlink 放进执行目录的 `.agents/skills/<name>`，指向已验证的快照；用户同名的真实目录保持不动；不再选中的、Foundry 建的链接删除；链接写入仓库自己的 `.git/info/exclude`（按工作区相对仓库根的路径）。草稿本来就在 `.agents/skills`，原生直接发现。
- `codexSessionConfig` 不再设 `skills.include_instructions=false`、不再按路径禁用用户的 skill、不再在 `developer_instructions` 里写目录；只剩设备说明。删除 `prepareCodexSkillIsolation`（启动前用 `skills/list` 找出要禁用的用户 skill）。
- 已知：Codex 把链接到 Claude 插件目录里的 skill 列为 `foundry-workspace:<name>`（链接目标的上层有插件清单），是 Codex 自身行为，未处理。

## 自验（第二步与删除）

- `check-changed`（47 个文件）全部通过：prettier、gofmt、协议、web tsc 与 11 个测试文件、worker 构建与 41 个测试文件、Go（httpapi、store、sqlitestore）、audit:ui、contract、modules。新增 `linkCodexSkills` 测试（链接、保留用户同名目录、清理旧链接、跳过草稿、写 exclude）。
- 真实端到端（e2e-alice 的 DEV-048 合成设备 Worker 临时运行，构建与发布包相同）：Codex 会话 `sess_1793378692723286615` 回答 `SKILLS=imagegen,openai-docs,skill-creator,skill-installer,foundry-workspace:foundry CATALOG=no AGENT=yes`（Codex 自带 skill 不再被关，Foundry 的 skill 经链接原生列出，`.agents/skills/foundry` 为指向快照的链接）；Claude 会话 `sess_1793378692908529838` 回答 `CATALOG=no AGENT=yes`。两条会话已归档，合成 Worker 与执行宿主已停止。
- 本机：本会话占用的执行宿主仍是第一步的版本（`.1793376748`），所以在它上面开的 Codex 会话 `sess_1793378601318769447` 仍是旧行为；执行宿主空闲后切换到新版本。

## 第三步：配置回归原生

**做法**（官方机制，见调研文档）：

- **Claude：** 每个账号仍有自己的配置目录（官方的多账号方式），其中 `settings.json`、`CLAUDE.md`、`rules`、`skills`、`agents`、`commands`、`output-styles`、`plugins` 链接到本人的配置目录（登录账号为其来源目录；外部连接的来源是 Foundry 的凭据目录，改用本人的 `CLAUDE_CONFIG_DIR` 或 `~/.claude`）；凭据与历史不链接。工作区会话不再传 `settingSources: []`、`strictMcpConfig` 和 skill 白名单，Claude Code 照常加载用户、项目、本地设置与 CLAUDE.md、skills、agents、commands、hooks、MCP；不再关自动记忆和 claude.ai 连接器。账号、端点和模型用 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`（设置文件不能改端点、凭据、模型）加命令行层钉住；外部连接的助手程序会清掉这个变量，连接环境组装后由 Foundry 补回。工具类会话（标题等 Foundry 自己的辅助会话）与验证、澄清角色仍不加载本人配置。
- **Claude 的项目规则：** CLAUDE.md、`.claude/CLAUDE.md` 由 Claude Code 原生加载，Foundry 不再读取拼进提示；只有在 CLAUDE.md 既不是 AGENTS.md 的链接、也不导入它（`@AGENTS.md`）时，Foundry 才转交 AGENTS.md（Claude Code 本身不读它）。
- **Codex：** 执行目录的 config.toml 改为本人的 config.toml（解析后保留全部内容），只加两项：`sqlite_home`（原生历史索引）和 `cli_auth_credentials_store = "ephemeral"`（令牌只在内存）；工作区未被本人标记时视为受信任，不再强制 untrusted；`AGENTS.md`、`AGENTS.override.md`、`hooks.json`、`prompts`、`rules`、`skills`、`plugins`、`memories` 链接到本人的 Codex 目录；不再关 memories、plugins；不再把项目 AGENTS.md 复制成执行目录的 AGENTS.md（受信任后 Codex 自己读）。账号与模型由进程级 `-c model_provider`、`-c model_catalog_json`（有窗口时）与线程配置钉住。
- **斜杠命令：** 删除“未在工作区选中的 skill 不能用斜杠调用”的校验：本人自己的命令和 skill 照常可用。

**10-16 问题复现（Codex）：** 临时 HOME 的 `~/.codex/config.toml` 写入假 provider（`127.0.0.1:9`）、外部模型目录、`model_context_window = 285000` 和一个 MCP 服务器，经 Foundry 真实代码生成执行目录，再启动真实 Codex 0.166 app-server 读 `config/read`：生效的 `model_provider` 为 `openai`、`model_catalog_json` 为 Foundry 的（按 872000 窗口生成）、本人的 MCP 服务器保留；线程配置钉住窗口 872000。即当时的问题（本地目录把窗口压到 285K）被挡住，本人的其余配置照常生效。

**真实推理端到端（Claude，e2e-alice 合成设备，外部连接，HOME 指向临时目录）：** `~/.claude/settings.json` 把 `ANTHROPIC_BASE_URL` 设为 `127.0.0.1:9`、模型设为不存在的名字，另放本人 CLAUDE.md 标记、一个 skill 与一个 subagent，项目放 CLAUDE.md 标记。

- 先发现：链接生效后设置文件里的端点劫持了会话（`594 Connection Refused … 127.0.0.1:9`）。用 CLI 加两个本地监听确认 Claude Code 2.1.308 认这个变量（有它时请求走进程环境的端口，没有时走设置文件的端口），问题在外部连接的环境组装把它清掉了，已修复。
- 修复后 `sess_1793380530337298488`：`USER=DEV105-USER-CLAUDE-MD PROJECT=DEV105-PROJECT-CLAUDE-MD SKILL=yes AGENT=yes MODEL=claude-sonnet-5-5`：本人与项目的规则、skill、subagent 原生加载，会话仍走 Foundry 选的连接和模型。
- Codex（本人真实 `~/.codex`）：`sess_1793380568599849116` 正常完成，读到了项目 AGENTS.md（由 Codex 自己读取）。
- 测试会话已归档，临时 HOME、项目标记文件、合成 Worker 与执行宿主已清理。

**本仓库：** `CLAUDE.md` 改为指向 `AGENTS.md` 的链接（Claude Code 原生读取，Foundry 不再重复转交）；AGENTS.md 增加“Native agents first”一节并压缩（11.4KB → 10.3KB，内容未删）。

**残留措辞：** foundry skill（修订 18）、助理提示（`2026-10-30.2`）与 `create_session` 摘要不再提“Skill isolation / locked Skill / permitted”。Server `2a5eb614…`（21:27，回滚副本 `foundry-server.pre-dev105d`）。

**残留逻辑清理（本人要求一致，2026-10-31）：** 普通会话的 Skill 隔离已取消，下列只为它存在的代码一并删除：

- `skill-isolation.ts` 删除：`/name` 改写为 `/foundry-workspace:name` 移到 `skill-materializer.ts`；Issue 判定者的 Skill 清单移到 `evidence-agent.ts`，只剩中性的文件清单（判定者保持原生发现关闭，防止候选结果给判定者埋 Skill，这是角色级的安全边界，不变）。
- 原生会话 receipt（`isolated`、`receiptConflicts`、`other_workspace`）删除：能否续接由原生决定，续接被拒仍走 `resume_refused`（新原生会话并转交对话）；文件夹改名时 Claude 记录本来就会复制到新目录。
- 每轮为隔离目录读取官方 Skill（`claude-turn`/`codex-turn`）与 `ManagedSkillRuntime.officialSkills`、`hostSkillPaths` 删除；`official-skills.ts` 保留，只供输入框 Skill 菜单。
- 工作区有 Skill 时拒绝自定义命令账号（“Custom runtime commands cannot enforce workspace skill isolation”）删除。
- Worker 端的所需程序推断（`skillToolRequirements`）删除：程序名由 Server 得出，设备只回答 `checkPrograms`。
- 手动隔离验收脚本 `verify-native-skill-isolation.mjs`、`verify-skill-preparation.mjs` 删除；`docs/skills.md` 的“隔离”描述改为原生发现。
- 磁盘上旧的 `<state>/skill-isolation/*.json` receipt 不再读取，留着无害。
- 自验：相关 32 个 Worker 测试文件、Worker 全量（1056 个，0 失败）、web tsc 与测试、audit:ui、模块审计通过。Worker `0.5.7-dev.182.gb42fa748.local.1793464150` 发布（上一版 `release.before-dev105e.json`），本机 daemon 已更新。e2e-alice 合成设备以新包运行：Claude 与 Codex 各两轮，第二轮在同一原生会话续接、记得第一轮的词（`OK2 PEBBLE`），无重开；临时加入的自定义命令账号（`echo`）在有 Skill 的工作区照常运行（以前被拒）。测试会话已归档，临时账号已移除，合成 Worker 与执行宿主已停止。

**影响（本人已接受“同一 OS 账号共用原生配置”）：** 本人的 hooks、MCP 服务器、插件、权限规则、自动记忆在 Foundry 会话里同样生效；Codex 对 config.toml 的写入（如信任、提示状态）落在执行目录的副本，不回写本人文件。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 剩余动作    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 2026-10-31 23:00 | 本工作区、最终构建上的真实会话验收（本人委托 Agent 验证）：Claude `sess_1793458797207687285` `AGENT=yes USER_RULES=yes PROJECT=yes OWN_SKILLS=yes CATALOG=no WORKSTATE=no WAIT=no`，15 个 `foundry-workspace:*` skill 原生列出；Codex `sess_1793458799897452010` 列出自带 skill、本人插件 skill 与经 `.agents/skills` 链接的工作区 skill，`AGENTS_MD=yes SUBAGENTS=yes WAIT=no`，链接被 git 忽略；它答的 `CATALOG=yes` 追问后是 Codex 自己的 `## Skills`/Skill roots 段，不是 Foundry 写入。两条会话已归档 | 提交合入    |
| 2026-10-30 23:30 | 调研两家原生用法与业界做法，核对 Foundry 现状与 hook；本人确认方向                                                                                                                                                                                                                                                                                                                                                                                                                                         | 第一步      |
| 2026-10-31 00:10 | 第一步代码与测试完成；check-changed 通过（worker 39 个测试文件、模块审计）                                                                                                                                                                                                                                                                                                                                                                                                                                 | 部署        |
| 2026-10-31 00:45 | 删除 skillSelection；Codex 改为原生发现 skill；Worker `.1793378436`、Web `5c527bfe…` 上线；合成设备端到端通过                                                                                                                                                                                                                                                                                                                                                                                              | Server 部署 |
| 2026-10-31 00:15 | Worker `.1793376748` 发布，本机 daemon 更新。真实会话核对：`sess_1793376798067070873` 在新执行宿主起来前 10 s 启动，仍是旧行为（`AGENT=no POLICY=yes`）；新宿主上的 `sess_1793376876782980883` 为 `AGENT=yes POLICY=no WORK=no`                                                                                                                                                                                                                                                                            | 第二步      |
