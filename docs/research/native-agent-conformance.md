# 让 Claude Code 与 Codex 按原生方式运行

2026-10-30（DEV-101 讨论）。本人原则：尽量遵循 Agent 自身的最佳使用方式，不往系统提示里注入行为引导，不改它的文件系统默认行为；模型厂商按自己 Agent 的原生形态做后训练，原生形态就是效果最好的形态。

## 两个 Agent 的原生方式

| 能力       | Claude Code（含 Agent SDK）                                                                                                                                                                                         | Codex                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 项目规则   | `CLAUDE.md`、`.claude/rules/*.md`（cwd 及各级父目录），`~/.claude/CLAUDE.md`；可用 `@AGENTS.md` 引入                                                                                                                | `AGENTS.md`（各级目录）                                                                                          |
| Skill 位置 | `~/.claude/skills`、项目 `.claude/skills`（到仓库根）、子目录按需、`--add-dir` 目录、插件（`插件名:skill`）；支持 symlink，改动会话内生效                                                                           | 仓库 `.agents/skills`（cwd 到仓库根）、`~/.agents/skills`、`/etc/codex/skills`、内置；支持 symlink，自动检测改动 |
| Skill 呈现 | 启动时只放名称与描述（单条截断 1536 字符），用到才读全文                                                                                                                                                            | 启动时放名称、描述、路径，占上下文 2%（或 8000 字符）以内，用到才读全文                                          |
| 禁用 skill | `skillOverrides: off`、权限规则 `Skill(name)`                                                                                                                                                                       | `[[skills.config]] path=… enabled=false`                                                                         |
| 配置加载   | SDK 不传 `settingSources` 时与 CLI 相同：user、project、local 全部加载；官方说明 `settingSources: []` 用于多租户隔离                                                                                                | 优先级：`-c` / CLI > profile > 受信任项目 `.codex/config.toml` > `~/.codex/config.toml` > `/etc/codex`           |
| 宿主控制   | `--settings`（命令行层，高于 user/project/local）；`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`：嵌入 Claude Code 的宿主设置后，用户 settings 不能改服务端点、凭据和模型；`CLAUDE_CONFIG_DIR`：官方写明可用于多个账号并存 | `-c` 覆盖为最高优先级；`CODEX_HOME` 换配置目录                                                                   |
| 子代理     | Agent/Task 工具                                                                                                                                                                                                     | 子代理（`multi_agent` 功能）                                                                                     |

来源：[Claude Code skills](https://code.claude.com/docs/en/skills)、[Agent SDK：Use Claude Code features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)、[Claude Code settings](https://code.claude.com/docs/en/settings)、[Claude Code env vars](https://code.claude.com/docs/en/env-vars)、[Codex skills](https://learn.chatgpt.com/docs/build-skills)、[Codex config basics](https://developers.openai.com/codex/config-basic.md)。

## 业界做法

- 托管多个 Agent 的工具复用原生配置：Conductor 在 git worktree 里跑真实的 Claude Code / Codex，用户的 MCP、skill、登录照常生效，服务端点通过环境变量设置（[Conductor providers](https://www.conductor.build/docs/guides/providers)、[Conductor MCP](https://www.conductor.build/docs/reference/mcp)）。
- 跨 Agent 共享 skill：skill 只放一份，用 symlink 链进各家的原生目录（[skills-sync](https://github.com/AtAFork/skills-sync)、[share-skill-with-codex](https://github.com/superchaospc/share-skill-with-codex/releases)、[SSW 规则](https://www.ssw.com.au/rules/symlink-agents-to-claude)、[vercel-labs/skills #851](https://github.com/vercel-labs/skills/issues/851)）。
- 规则文件同理：`CLAUDE.md` 内容为 `@AGENTS.md`，或 symlink 到 `AGENTS.md`。

## Foundry 现状（与原生的差异）

来源：`docs/research/runtime-config-isolation.md`（2026-10-16，起因是一台设备的本地模型目录把会话窗口压到 285K）及 `packages/worker/src` 当前代码。

| 项目       | Claude                                                                                                                                        | Codex                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 配置目录   | 独立 `CLAUDE_CONFIG_DIR`（只放账号身份，历史目录链接回原处）：用户 `~/.claude` 的 settings、CLAUDE.md、skills、agents、commands、插件都看不到 | 独立 `CODEX_HOME`，不复制 config.toml；项目 `.codex/config.toml` 设为不受信任                                              |
| 配置来源   | `settingSources: []`：项目 settings、hooks、CLAUDE.md、`.claude/skills`、agents、commands 都不加载；`strictMcpConfig`，只有 Foundry 的 MCP    | `AGENTS.md` 保留                                                                                                           |
| 工作区规则 | Foundry 读 `AGENTS.md`、`CLAUDE.md`、`.claude/CLAUDE.md` 原文，拼进系统提示                                                                   | 原生                                                                                                                       |
| Skill      | 工作区选中的 skill 做成插件 `foundry-workspace:*`（原生机制）；另在系统提示里再列一遍 JSON 目录和约 2.5KB 规则                                | 关掉原生 skill 说明（`include_instructions=false`）、关掉内置、按路径禁用用户自己的 skill；目录写进 developer_instructions |
| 子代理     | 工作区有草稿 skill 或排除项时 `disallowedTools: [Agent, Task]`                                                                                | 同条件下 `multi_agent=false`                                                                                               |
| 其他注入   | 设备说明（约 2KB）；委派说明（已于 DEV-101 删除）；工作状态 hook（DEV-101 改为只在变化时）                                                    | 同左（经 developer_instructions）                                                                                          |

## 建议的方向（原生优先）

1. **配置与账号：** Claude 不再传 `settingSources: []`，用 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 加命令行层设置钉住所选账号与模型；Codex 用 `-c` 覆盖，不隔离 config.toml。默认账号直接用用户自己的 `~/.claude`、`~/.codex`；其他账号按官方多账号方式各用一个配置目录，把用户的 skills、agents、commands、规则、settings 以 symlink 链入，凭据与历史不链。必须先复现 10-16 的窗口污染，证明新方式不再受影响。
2. **Skill：** 不禁用用户自己的 skill，不再在提示里列目录。Foundry 提供的 skill（内置 foundry skill、工作区选中的库 skill、草稿）放到原生能发现的位置：Claude 保留插件方式（原生、带命名空间、不写进仓库），Codex 在工作区 `.agents/skills/` 下建 symlink 并写入 `.git/info/exclude`。工作区要排除某个 skill 时，用各自的原生禁用开关。
3. **子代理：** 不再因草稿或排除项禁用。只有 Skill 试用会话（带 `skillSelection` 创建的）需要干净环境，限制只作用于这类会话。
4. **规则文件：** 不再由 Foundry 把 AGENTS.md 拼进 Claude 的提示；仓库用 `CLAUDE.md` 写 `@AGENTS.md`（或 symlink），这是两家原生都认的做法。
5. **设备说明：** 只留 Agent 自己查不到的事实（附件目录、浏览器启动器），或移入 foundry skill。

## 风险与需要验证的

- 10-16 的问题（本地设置改了模型、窗口或 provider）在原生加载下是否被宿主模式和命令行层完全挡住。
- 用户自己的 hooks、MCP、claude.ai 连接器会在 Foundry 会话里生效：这是原生行为，但第一次会让人意外。
- 一个 OS 账号被多位 Foundry 用户共用时（如本机的 e2e-alice），他们共用这个 OS 用户的原生配置；需要分开就用不同 OS 账号。
- Codex 的 `.agents/skills` symlink 写在工作区目录里（虽然 git 忽略），要确认不影响用户自己的 `.agents/skills`。

## Foundry 给 Agent 挂的 hook（2026-10-30 核对）

Claude 通过 Agent SDK 的回调 hook；Codex 没有 hook，只在压缩后由 Foundry 发一条 steer、压缩恢复时补一段继续说明。

| Hook                                                                                               | 位置                                                                 | 做什么                                                                                                          | 对模型的影响                                                                     | 判断                                                                                                     |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| PreToolUse / PostToolUse（写文件工具）                                                             | `session-files.ts`                                                   | 写之前存一份原文，写之后记下改了哪个文件，供网页“变更”面板显示 diff                                             | 无（返回空）；每次写文件多一次读盘                                               | 保留：Foundry 自己的观察，不改变行为                                                                     |
| PostToolUse、Stop、UserPromptSubmit（定时器）                                                      | `agent-timers.ts`                                                    | 观察 CronCreate/CronDelete 等，把会话的定时器显示在网页上；识别定时器触发的回合                                 | 无                                                                               | 保留                                                                                                     |
| Stop（后台任务）                                                                                   | `agent-background-tasks.ts`                                          | 回合结束时记录还在跑的后台命令与子代理                                                                          | 无                                                                               | 保留                                                                                                     |
| PreToolUse（Bash）、PostToolUse、PostToolUseFailure                                                | `runner/claude-runtime-start.ts`                                     | 记录哪个工具调用启动了哪个进程，归属到会话的持久工作                                                            | 无                                                                               | 保留                                                                                                     |
| UserPromptSubmit / PreToolUse / PostToolUse / PostCompact 的 `additionalContext`，以及回合提示前缀 | `claude-runtime-start.ts`、`session-prompt.ts`；Codex 压缩后的 steer | 把“Foundry persistent work state …”和使用建议（用 list_session_work、优先原生工具、不要用 host cron）注入给模型 | **有**：往模型上下文里加文字，且含行为引导。DEV-101 已改为只在有内容且变化时注入 | 建议删除：原生 Agent 自己知道它的后台任务与定时器；Foundry 独有的持久计划由 `list_session_work` 按需读取 |
