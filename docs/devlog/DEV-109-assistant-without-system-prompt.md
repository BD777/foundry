# DEV-109 · 个人助理不再经系统提示词拿指令

状态：已实现；测试与 scratch 栈真实 Codex 会话自验通过；路由评测未能运行（评测脚本在当前代码上起不来，见“已知限制”）；未部署；待人工验收。

## 问题

DEV-108 之后，普通会话已经不往系统提示词里追加内容，只剩个人助理：每次运行把 30 KB 的 `system.md`、本人的额外要求和 L0 快照（关于这个人、项目与电脑索引、规则）追加到系统提示词（Claude `systemPrompt.append`，Codex `developer_instructions`）。本人不希望有系统提示词注入（2026-11-02）。

## 调研与决定

- 原设计（`docs/personal-agent.md` §439，2026-10-15）：记忆放在 Server 而不是助理目录，理由是电脑离线时也能在设置里查看、编辑、真正遗忘；来源由 Server 判定；换电脑不丢。这一条保留。
- 业界做法（code.claude.com/docs/en/memory、learn.chatgpt.com/docs/customization/memories.md、docs.letta.com/guides/agents/memory、support.claude.com/en/articles/11817273、openai.github.io/openai-agents-python/context/）：一小段核心画像常驻上下文，其余按需用工具取（Letta core/archival、ChatGPT 已保存记忆、Claude Code `MEMORY.md` 前 200 行 + 主题文件）；编码 Agent 的角色设定走原生文件（`CLAUDE.md` / `AGENTS.md`）；个人记忆不放进会提交的目录。
- 本人确认的三点（2026-11-02）：角色提示词写进助理目录的 `AGENTS.md`；核心画像与规则随每轮上下文（在用户消息里，不落盘）；项目与设备索引、其余记忆改由工具读。

## 实现

- Server `personalagent/prompt`：`AgentsFile`（按设置填好的提示词 + 本人能打开的页面，不含任何关于这个人的事实），`ExamplesFile`（示例另成文件 `.foundry/assistant-examples.md`，`AGENTS.md` 只留指引，否则合计 32.3 KB 超出 Codex 32 KiB 上限），`Computers`（`list_computers` 的回答）。`TurnContext` 增加本人确认过的记忆（≤ 2,000 字符，其余提示 `read_memory`）、本人的额外要求、各项操作的规则。删除项目索引与电脑索引的常驻输出。`system.md` 中“快照”的说法改为本轮上下文与工具；版本 `2026-11-02.1`。
- `AgentsFileMaxBytes` = 28 KiB，测试用超长名字验证；当前 `agents_full.golden` 28,019 字节。
- 新 MCP 工具（只给 `personal_agent`）：`read_memory`（活跃记忆，最新在前，按文字筛选，每页 ≤ 50）、`list_computers`；`foundry assistant memory|computers` 命令。
- 线协议：`run_session.personalAgentInstructions`（字符串）改为 `personalAgentFiles`（`[{path, content}]`）。Worker `session/personal-agent-files.ts` 只写 `AGENTS.md` 与 `.foundry/*.md`，内容没变不写；文件的修订进入运行时 key，变了就换新运行时去读；`sessionDeviceNotes` 只剩验证会话。不兼容旧 Worker（DEV-107 约定）：旧 Worker 收到新 Server 的助理运行时没有指令。

## 自验

- Go：`internal/personalagent/...`、`internal/httpapi` 中助理相关测试（含新增 `TestAssistantReadsMemoryAndComputersWithTools`、`TestListComputersShowsWhatComputersHave`、`TestAgentsFileHoldsNothingAboutThePerson`、`TestAgentsFileFitsCodexsLimit`）。
- Worker：`personal-agent.test.mjs`（写文件、拒绝目录外路径、无文件的运行保持运行时 key、新内容换 key）、`foundry-cli.test.mjs`、`session-launch-options`、`runner-skills`、`runtime-isolation`。

- scratch 栈真实 Codex 会话（工作树构建，Worker 不在沙箱里、独立 HOME，`CODEX_HOME` 指向本机登录；新建助理“小墨”，三条记忆、额外要求“叫我小邓。回复尽量简短。”、一个项目『家庭记账』）：问“你知道我哪些事？有哪些电脑？导出 Excel 的按钮该放哪个项目（先别动手）”。助理调用 `read_memory`、`list_computers`、`find_workspace`、`get_workspace`，称呼“小邓”，答出三条记忆，说明只有一台 Linux 电脑可用，把导出功能归到『家庭记账』且没有动手。磁盘上助理目录的 `AGENTS.md` 28,031 字节，`.foundry/assistant-examples.md` 3,481 字节，二者不含记忆、额外要求或项目名（唯一命中的“家庭记账”是提示词自带的示例词）。Codex rollout：`AGENTS.md` 作为 Codex 原生的项目说明出现在用户消息开头，developer 消息里没有助理提示词也没有设备说明。验证后栈、Worker、执行宿主与临时目录均已删除。

## 已知限制

- 本轮上下文每轮都带记忆与规则（约 1.5–3 KB），对话越长重复越多；原来在系统提示词里只出现一次。
- 助理不再常驻项目索引，路由前需要调 `find_workspace`。路由质量没有量化对比：`scripts/pa-eval-run.mjs --e2e` 在当前代码上跑不起来。一是助理已在别的电脑安家时它不会把助理挪到评测的 Worker（已修，见同一提交）；二是它在 bubblewrap 沙箱里启动的 Worker 起不来执行宿主（`execution-host/control.sock` 不出现，会话一直 queued），基线与新版都如此，属于 DEV-107 改执行宿主后评测脚本没跟上，未修。
- Codex 的 `AGENTS.md` 合计上限包括本人自己的全局 `~/.codex/AGENTS.md`；它很大时助理的文件可能被截断（Codex 原生行为）。

## 人工验收

1. 打开“助理”，问它“你知道我哪些事？”。预期：答出你在设置里看得到的记忆；助理目录（家电脑上的 `~/Foundry/personal-agent`）的 `AGENTS.md` 里没有这些记忆。
2. 让它“把 X 放到合适的项目里做”。预期：它先查项目再派出，和以前一样选对项目。
3. 在设置里改助理的名字。预期：下一次对话它用新名字自称（`AGENTS.md` 已更新）。

## 时间线

- 2026-11-02 22:40–23:30：实现与测试（`sess_1793622726235916722`，worktree `../foundry-dev109`，分支 `feat/dev109-assistant-native`，基于 `4649d089`）。
- 2026-11-03 00:40–01:25：路由评测两次尝试均无效（见“已知限制”），改为 scratch 栈手动验证（见“自验”）。
