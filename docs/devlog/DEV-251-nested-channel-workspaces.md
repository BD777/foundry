# DEV-251 通道工作区嵌进助理 home；两个 AGENTS.md 各管各的

状态：已部署 dev（train13-20261116，Server `e8d7649a…`、Worker `0.5.7-dev.361.gd79e5c06.local.1794814326`、Web 不变 `31009f72…`、prompt `2026-11-16.6`）；真实部署后检查通过（见下）；Agent 代验收（2026-11-16，范围见验收记录）；已合入 main（PR #271）。迁移在部署后由后台巡检自动完成。

来源：编排会话 [sess_1794464313271186377](https://dev.foundryapp.app/chats/sess_1794464313271186377) 转述本人的决定：

> 不一定要同时都生效，两种地方其实有不同的场景需求。所以分为两个 workspace 是合理的。这里用户要明确说改哪边。

## 问题

home 对话里写下的规则（例如「回答前先派人去工作区核实」）只写进 home 的 `AGENTS.md`；通道会话跑在通道工作区，永远看不到它。两个地方各维护一份是有意的，但通道工作区原先在 home 旁边（`~/Foundry/message-channel-<id>`），home 对话不能自然地编辑它，也没有任何事实告诉助理「哪个通道的规则在哪」。

## 改了什么

1. **通道工作区嵌进 home**：新通道建在 `<home>/channels/<slug>/`（`channelWorkspacePath`，slug 来自通道名，冲突加 `-2`）。它仍是独立注册的工作区（自己的 ws id、聊天列表和 DEV-234 视图），只是文件夹在 home 下面。home 会话用自己的工具直接编辑 `channels/<slug>/AGENTS.md` 即可；通道会话对整个 home 树（含自己的文件夹）仍然只读。
2. **两套规则互不串**：
   - Claude：通道会话的 `--settings` 层写 `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles = "claude-md"`（`personalAgentChannelInstructionFileSettings`）。Claude 的 agents-md 插件只有四种模式，任何 AGENTS 模式都会把祖先目录的 AGENTS.md 一并加载，因此只加载 `CLAUDE.md`；通道工作区里由 Foundry 生成一行 `CLAUDE.md`：`@AGENTS.md`，用文档化的 import 读回通道自己的规则。`CLAUDE.md` 在 Web 里是 Foundry 生成、只读。
   - Codex：通道会话的配置加 `project_root_markers = [".foundry-channel-root"]`。Codex 从 project root 向下读到 cwd；没有 root 时只读 cwd。这个标记任何祖先都没有，所以即使 home 以后 `git init`，也不会把 home 的 AGENTS.md 带进来。
   - home 会话不变：仍只加载 home 的 AGENTS.md；测试断言它的 run files 不含 `CLAUDE.md` 或 `channels/`。
3. **home 的 managed block 列出通道**：每行是通道名和它的文件夹，并说明「那里的 AGENTS.md 是该通道会话遵守的规则，和本文件分开」——是事实，不是建议。
4. **技能指引**（`assistant-handoff`）：本对话的规则管本对话，通道的规则只管那个通道；本人要求改行为时改他点名的那一边，说不清就问哪一边。
5. **迁移**：`relink_workspace` 增加可选的 `moveFrom`，设备自己用原子 `rename` 把已注册的文件夹移进目标（目标必须不存在、在 managed root 内）；随后沿用原有 relink：重写 workspace 文件与注册表、更新服务器记录、把 Claude 原生会话复制到新路径的项目目录（Codex 按 id 续）。服务器端由每分钟的 `ensureMessageChannelWorkspaces` 触发；通道工作区有排队或运行中的会话时这一轮跳过，下一轮再试。workspace id 不变，`workspace_file_revisions`、聊天记录和 Web 历史都保留。
6. **DEV-242 的项目文件保留**：只读沙箱的读根只有通道工作区自己（`userFiles: "hidden"`），通道读不到 home 的 `.foundry/`，所以索引与摘要继续写在通道工作区里。

## 验证

- Go 定向（CanWendeMac-mini，`scripts/remote-check.sh --go`）：`internal/channels`、`internal/personalagent/prompt` 全包；`internal/httpapi` 的通道/助理用例（含新增的嵌套路径、通道 run 带 `CLAUDE.md`、home run 不带通道文件、只有通道的 `CLAUDE.md` 是 Foundry 生成）全部通过。
- Worker 定向（CanWendeMac-mini，`scripts/remote-check.sh --worker test`）：`workspace-folders`、`session-launch-options`、`assistant-workspace-files`、`personal-agent` 共 47/47 通过；含新增的文件夹移动、Claude 只读会话加载 `CLAUDE.md`、Codex root marker、以及只读通道只收 `CLAUDE.md` 与 `.foundry` 事实。
- 未做：真实 Claude/Codex 运行确认 `@AGENTS.md` import 与 `project_root_markers` 在设备上的实际加载（需部署后的 Worker）；真实 home 会话写通道 AGENTS.md 的端到端检查（部署后在 dev 上做，见下）。

## 部署后的迁移

1. 部署 Train（Server 触发每分钟巡检即可，无需手工调用）。首次通过时会调用设备的 `relink_workspace`：
   `{workspaceId: "ws_0349bea7-71fb-4ff8-8691-e6ef1acea43b", path: "<home>/channels/openlark", previousPath: "/home/windeng/Foundry/message-channel-0e47207b6ad14d91bade", moveFrom: "/home/windeng/Foundry/message-channel-0e47207b6ad14d91bade", nativeSessions: [...]}`。
2. 通道有运行中的回合时会推迟；日志出现 `message channel mch_…: workspace moved to <home>/channels/openlark` 即完成。
3. 验收：该通道设置的「工作区文件」顶部路径变成 `<home>/channels/openlark`；`AGENTS.md` 内容与历史仍在；`.foundry/` 只读、`CLAUDE.md` 只读；从 home 对话说「把通道 X 的规则改成…」后，通道 `AGENTS.md` 更新且在 Web 历史里显示「在别处修改」；通道会话仍不能写文件。
4. 限制：只搬 Foundry 为通道建的 `message-channel-*` 文件夹。本人把某个自己的项目选作通道工作区时，那是本人的项目，文件夹留在原处（服务器仍会给它写生成的 `CLAUDE.md`）；从 home 对话用 Claude 的工具仍能编辑它的 `AGENTS.md`，但它不在 home 树里，不走「自然编辑」。旧顶层文件夹在迁移后不再使用；设备离线时保留旧路径，上线后的巡检再搬。

## 真实部署后检查（2026-11-16，train13）

### 1. 迁移（byte-dev，只读）

- 巡检日志：`message channel mch_0e47207b6ad14d91bade: workspace moved to /data00/home/dengcanwen/Foundry/personal-agent/channels/openlark`。
- 旧路径 `/home/dengcanwen/Foundry/message-channel-0e47207b6ad14d91bade` 已不存在；新路径下有 `AGENTS.md`（2958 B，sha256 `6960ab19…`）、生成的 `CLAUDE.md`（11 B，`@AGENTS.md`）和 `.foundry/`。
- 服务器 `workspaces` 行的 `local_path` 指向新路径，device 仍是 `dev_ab623721…`。
- Web 文件历史：该 workspace 的 `AGENTS.md` 仍有 11-13 的 `seed` 版本（1490 B）；当前 2958 B 是此后在设备上改的，从未在 Web 打开过，所以还没有「在别处修改」那一版——这是 DEV-223 的读时检测正常行为，不是迁移丢失。首次在页面打开时会补记。

### 2. 通道规则与加载范围（真实自聊，一条消息）

按第 1 轮硬规则起一个只负责发送的 session（`sess_1794815128220394208`，ccm-omh-integration，完成后已归档）：

- 先确认 self-chat `7207688166424231939`：`memberCount = 1`，唯一成员是本人（邓灿文 / Canwen Deng）。
- 只发一条 `/ai 你现在遵守的通道规则里，回复位置是怎么规定的？只回答规则原文的那一条`，消息 id `7708672405668957132`（07:46:00Z 左右）。
- 通道会话 `sess_1794797266741838846`（续聊）于 07:46:05 收到，07:46:13 `Loaded workspace /data00/home/dengcanwen/Foundry/personal-agent/channels/openlark`，07:46:24 用 `olk im reply 7708672405668957132` 引用回复。
- 回复 id `7708672522018999288`（07:46:25Z），原文：
  `私聊和自聊：引用回复触发消息，不新开话题；已经存在话题时才在话题里回复。`（另有 `> 来自AI`）。
- 回显投递 `dlv_7eb1e5788ec232348bdaef67` 为 `dropped / own_write`。
- 加载范围证据（该会话的 `claude-sdk.messages.jsonl` 与 `files.json`）：`cwd` 是新通道目录；`files.json` 只记录 `channels/openlark/AGENTS.md` 为 `referenced`；home 的独有标记 `foundry:managed`、`Message channels`、`You are ByteWork`、`# What you are for` 全部 0 次，而通道的 `回复位置`/`私聊和自聊` 分别是 2/3 次。即只加载了通道的 `CLAUDE.md`→`AGENTS.md`，没有 home 的 AGENTS.md。

### 3. home 会话编辑通道 AGENTS.md 与 Web 历史

用空库 scratch 栈（`dev251`，本树 Server/Worker，真实 Codex 登录）建一个合成助理 `asst_d7cd2c54…` 和嵌套通道工作区 `ws_d5daf8b2…`（`<home>/channels/dev251-test/`），先写一个 `seed` 版本；再从 home 会话 `sess_1794816611779664712` 让 Codex 往 `channels/dev251-test/AGENTS.md` 追加一行。文件出现该行，随后用 Web 文件接口读取，历史为 `[('outside', 72, current), ('seed', 46)]`——即「在别处修改」的读时检测生效。合成助理、工作区、scratch 栈与临时目录均已删除；未触碰本人助理。

## 涉及文件

- `apps/server/internal/channels/folder.go`（slug）、`skill.go` 未改；
- `apps/server/internal/personalagent/prompt/{prompt.go,prompt_test.go,testdata/agents_full.golden}`、`skills/assistant-handoff/SKILL.md`；
- `apps/server/internal/personalagent/assistant/instructions.go`（通道事实、通道 run 文件）；
- `apps/server/internal/httpapi/{message_channel_runtime.go,assistant_files.go,workspace_relink.go}` 及测试；
- `packages/worker/src/session/{personal-agent-files.ts,session-launch-options.ts,session-roles.ts}`、`packages/worker/src/daemon/workspace-folders.ts`、`packages/protocol/src/daemon-messages.ts` 及 Worker 测试。
