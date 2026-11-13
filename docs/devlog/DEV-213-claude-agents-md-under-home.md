# DEV-213 Claude 会话在家目录下的工作区读不到 AGENTS.md

## 结论

回归属实。家目录下只有 `AGENTS.md` 的工作区里，Foundry 启动的 Claude Code 会话**不加载项目 AGENTS.md**。受影响的有本仓库（含 `apps/web/AGENTS.md`）和 `~/Foundry/personal-agent-*` 下的所有助理 home。Codex 不受影响。

- **foundry 仓库：** DEV-195 删掉 `CLAUDE.md → AGENTS.md` symlink 之后开始（工作区 2026-11-12 删除，2026-11-13 00:18 +0800 随 7e2a354c 合入 main）。此后这里的每个 Claude 会话都没有项目规则。
- **助理 home：** 只有 `AGENTS.md`，从没被 Claude 原生加载过。DEV-196/DEV-200 把本人规则和确认过的记忆移进 `AGENTS.md`、去掉每轮注入之后，Claude runtime 的助理就没有这些规则了。
- DEV-209 的只读会话已看到同一现象（“全局 CLAUDE.md 存在时 Claude Code 未自动加载项目 AGENTS.md”）。DEV-195 只核对了版本号和默认值，没有核对实际加载。

## 根因

Claude Code（2.1.311，内置插件 `cc-plugin-agents-md@builtin`）的默认值是 `instructionFiles: "claude-md-or-agents-md"`：工作目录**及各级父目录**有 `CLAUDE.md`、`.claude/CLAUDE.md` 或 `CLAUDE.local.md` 时，就不读 AGENTS.md。唯一的例外是“你的 `~/.claude/CLAUDE.md`”，即**当前配置目录**下的那个（[memory 文档 · When Claude Code reads AGENTS.md / My AGENTS.md isn't loading](https://code.claude.com/docs/en/memory#when-claude-code-reads-agents-md)）。二进制里的判定在 agents-md 插件的 `Et`/`jkr` 中：只要存在一个 kind 为 project/local、文件名属于上述三种、所在目录是 cwd 或其祖先的记忆文件，就视为 CLAUDE.md 项目。

Foundry 用执行配置目录跑 Claude（`runtime-isolation.ts` 的 `isolatedClaudeEnvironment`），`CLAUDE_CONFIG_DIR=~/.foundry/native-runtime/owners/claude/<id>`，再把本人的 `CLAUDE.md`、`rules` 等 symlink 进来。结果本人的 `~/.claude/CLAUDE.md` 对 Claude Code 来说不再是“自己的”，而是 `/home/<user>` 这个祖先目录的 `.claude/CLAUDE.md`，家目录下每个工作区都因此被判为 CLAUDE.md 项目，AGENTS.md 被跳过。内容按文本去重，所以全局规则仍只出现一次，看不出异常。

## 复现（sg-chaos，Claude Code 2.1.311，同一执行配置目录，`--tools ""` 引用测试）

| cwd                                        | 设置                                        | AGENTS.md「Native agents first」首条 | 全局 CLAUDE.md |
| ------------------------------------------ | ------------------------------------------- | ------------------------------------ | -------------- |
| `~/workspace/foundry`                      | Foundry 现状                                | ABSENT                               | 有             |
| `~/workspace/foundry`                      | + `pluginConfigs` `claude-md-and-agents-md` | 原文                                 | 有             |
| `/tmp/…/ctl`（家目录外，同一份 AGENTS.md） | Foundry 现状                                | 原文                                 | 有             |
| `~/Foundry/personal-agent-2`（助理 home）  | Foundry 现状                                | ABSENT（未列出任何项目文件）         | 有             |

Codex 对照（sess_1794561057214905232，foundry 工作区）：原文引用正确，启动指令文件为 `/home/windeng/workspace/foundry/AGENTS.md`。

## 修复

用文档化的设置补足原生行为，不注入提示，也不加回 symlink。Worker 的 `buildClaudeLaunchPlan` 往命令行层设置（`--settings` 文件，文档说明该层会读取 `pluginConfigs`）里加 `nativeInstructionFileSettings(workspacePath, env)`：

- 从工作区往上找 `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md`。如果找到的唯一文件（按 realpath）就是执行配置目录里 `CLAUDE.md` 指向的本人文件，就写 `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles = "claude-md-and-agents-md"`。此时加载结果和原生一样：本人全局 CLAUDE.md 加上项目 AGENTS.md。
- 项目自己（或更上层）有 CLAUDE.md、本人没有全局 CLAUDE.md、工作区不在家目录下、或本人的 settings 已设过 `instructionFiles`/`projectInstructions`（新旧两个插件 id）时，什么都不写，保持 Claude Code 默认。

代码：[session-launch-options.ts](../../packages/worker/src/session/session-launch-options.ts)；测试：[native-instruction-files.test.mjs](../../packages/worker/test/native-instruction-files.test.mjs)。文档：[native-agent-conformance.md](../research/native-agent-conformance.md)。

## 进展

- 2026-11-13：完成复现、根因定位、修复和定向测试。Mac mini 离线，Worker tsc 和 `run-worker-tests.mjs -- native-instruction-files.test.mjs session-launch-options.test.mjs`（14/14）在 sg-chaos 上 `flock /tmp/fdy-heavy.lock` 运行。中途一次 tsc 失败（computed key 是 `string | undefined`），曾让共享树短暂无法构建，已修复。
- 发布：共享树里还有其他会话尚未发布的 Worker 改动，所以没从共享树打包。做法是取线上包 `…local.1794558943`，只换 `dist/session/session-launch-options.js`（与线上编译产物逐行对比，差异正好是本改动），重打成 `0.5.7-dev.357.g8f394c91.local.1794563196`，经 `deploy-dev.sh --prebuilt … --label dev213 --worker` 上线（回滚：`release.json.pre-dev213`）。`deploy-dev.sh`（未跟踪、正在被别的会话修改）自我加锁重执行时参数已被 shift 掉，所以改由 `fdy-lock deploy -- env _FDY_DEPLOY_LOCKED=1 scripts/deploy-dev.sh …` 调用。
- 验证（sg-chaos，新 Worker）：
  - Foundry Claude 会话 sess_1794563540002738716（Limen · default）原文引用 AGENTS.md「Native agents first」首条和全局 CLAUDE.md「设计原则」首条。
  - 助理 home `~/Foundry/personal-agent-2`：已部署包的 `nativeInstructionFileSettings` 返回 `claude-md-and-agents-md`；同一 CLI 原来答 ABSENT，现在原文引用 AGENTS.md 首行。
  - Codex 对照 sess_1794561057214905232 本就正常。
- Worker 已更新 6 台在线设备（sg-chaos、byte-dev、byte-dev-sg、cottoncpp、limen-canada、macbook）。CanWendeMac-mini 离线，上线后需 `update_worker`。
