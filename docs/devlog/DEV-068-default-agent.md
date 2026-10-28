# DEV-068 工作区与渠道的默认智能体（账号 / 模型 / 推理强度）

| 环节            | 状态   | 说明                                                                                                                                                                                   |
| --------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 问题理解/调研   | 已完成 | 需求与解析顺序由用户批准（2026-10-28，“按你的建议增加这个feature”），协调会话 `sess_1793063405185071529` 转达                                                                          |
| 代码            | 已完成 | Server（store / sqlitestore / httpapi / feishu）+ Web；未改 protocol 包与 daemon 文件                                                                                                  |
| dev Server 部署 | 已完成 | 随 DEV-066 共享树部署（2026-10-28 21:11–21:13）：sha256 `51c002635f415499`（与本项构建一致），SIGHUP 交接，pid 2484312，healthz 200；回滚 `dev023-candidate/foundry-server.pre-dev066` |
| dev Web 部署    | 已完成 | 同次部署，build `6796efb44e5fdab8`（前一版 `421f79759d57b573` 存于 `releases/dev066-runner/web/`）                                                                                     |
| Worker 更新     | 不涉及 | 只改 Server 与 Web                                                                                                                                                                     |
| Agent 自验      | 已完成 | Go/Web 测试、scratch 栈 API 与浏览器矩阵，以及部署后 dev 上的 API、浏览器矩阵与既有会话核对                                                                                            |
| 人工验收        | 待确认 | 见“验收步骤”                                                                                                                                                                           |

## 问题

一个工作区默认用哪个账号（provider profile）、模型和推理强度，没有地方可以设置；飞书渠道的会话也无法单独指定。原先没有指定账号时由 Server 自己挑：本人在该工作区最近一次完成的会话用的账号 → 本人助理的账号 → 第一个可用的（`session_accounts.go` 的 `pickAccount`），模型和强度沿用账号自己的默认值。

## 设计（用户已批准）

解析顺序从具体到一般，Web 新对话、飞书话题、MCP `create_session` 和定时任务都走这一个顺序：

1. 本次启动显式指定的。
2. 渠道默认：工作区飞书机器人的默认；配对的单个会话可以单独设置，优先于机器人默认。
3. 工作区默认。
4. 本人最近使用 / 本人默认（即原来的行为）。
5. 第一个可用账号。

每一级可以只设账号、模型、推理强度中的任意几项，没设的字段沿用下一级。配置的账号不可用（未登录、检查未通过、已不在设备上）时跳过，并给出可见说明；从不在别人的或不可用的账号上悄悄运行。

## 实现

- 存储：表 `agent_defaults`（`sqlitestore/agent_defaults.go`）。主键为 workspace_id + scope（`workspace` / `feishu_bot` / `feishu_chat`）+ route_id，列有 profile_id、runtime、model、effort、updated_by、updated_at。三项都不设时删除该行。会话的单独设置只在该会话仍配对在本工作区时生效（列表时与 `feishu_bot_routes` 关联）。表登记在 `workspaceOwnedRows`，删除工作区时一并删除。迁移只有 `CREATE TABLE IF NOT EXISTS`，每次启动都很快。
- 解析：`httpapi/agent_defaults.go` 的 `resolveAgent`。
  - 账号：取最具体的一级中可用的账号，否则按 `pickAccountFrom` 走原规则，并记下来源（`last_used` / `personal` / `first_usable`）。
  - 模型与推理强度：取第一级为这个账号设的值。“为这个账号设的”指该级指定的就是这个账号，或该级没指定账号且比选中账号的那一级更具体。更一般的级别是为已被覆盖的账号选的模型和强度，不再沿用。各值只用于选它们时的运行时；推理强度还要属于该运行时（Claude：low…max；Codex：minimal…xhigh）。
  - 显式指定了账号的启动整体沿用自己的选择，不补默认的模型和强度。只给了模型、强度或运行时的启动，其余部分照常解析。命名任务和摘要任务不使用默认值。
- 入口：`chooseSessionAccount` 改用该解析，飞书、MCP、只给运行时的启动都经过它。飞书新话题带上 `FeishuRouteID`（`ws_manager.go` `handleNewTopic`，`CreateAgentSessionInput` 的 `json:"-"` 字段）。定时任务和子会话沿用父会话的显式账号，与原来一致。
- 不可用时的说明：跳过的级别写进会话的 `ProfileTransitionNote`，在会话记录里显示为边界说明（Skill 试用不写，以保持历史干净）。飞书话题另外回一张橙色卡片“默认智能体未能使用”。
- API：`GET /api/workspaces/{id}/agent-defaults`（工作区 viewer 及以上）返回配置、可选账号，以及解析结果：`effective`（当前用户的 Web 新对话）、`feishuBot`、按 route 的 `feishuChats`，每项带来源和 `skipped`。`PUT`（maintainer 及以上）一次设置一级，校验 scope、会话归属、账号是否在本设备，以及推理强度是否属于该运行时。助理的 `get_workspace` 在 `accounts` 中增加 `defaultAgent`；`create_session` 和 `get_workspace` 的说明已更新（`mcp_tools.json`）。
- Web：
  - 共享组件 `components/workspace/agent-default-fields.tsx`：账号、模型、推理强度三个 `SelectMenu`，各带 “Not set (inherit)” 选项；下方一行显示解析结果；有跳过的账号时显示警告 Alert，不可用的账号带 Unusable 徽标。模型列表取自该 profile 的模型加设备目录。
  - 数据钩子 `use-agent-defaults.ts`。
  - 工作区 “Agents & execution” 新增 “Default agent” 区块（`features/agent-defaults`），非维护者只读，原来的 “Manage agents and execution on …” 入口保留。
  - Channels：Web Chats 卡片注明 “New chats use the workspace default agent.”；飞书机器人下新增 “Default agent” 面板；会话行增加 “…” 菜单 “Set agent for this chat…”，在对话框中单独设置，行内显示 “Own default” 或 “Uses the bot's default”。
  - 新对话输入框：读取解析结果并预选该账号及其模型和推理强度，账号选项下注明来源（如 “Workspace default”）。改选只影响这个对话。已经为这个草稿手动选过的仍然优先。
  - 两种语言的文案都在 `agents` 命名空间的 `defaultAgent.*` 下。
- 文档：`docs/models-and-accounts.md` 关键决定增加 2026-10-28（DEV-068）一条。

## 自验

- Go：`TestResolveAgentLevels`（10 种层级、回退、运行时与强度组合），`TestWorkspaceDefaultAgent`（HTTP 读写与权限：成员只读、成员写返回 403、错误的强度、不在本设备的账号、未知会话；工作区、机器人、会话三级的胜出与回退；显式账号不补默认值；账号退出登录后跳过并写说明；命名任务不使用默认；清空后恢复继承），`sqlitestore.TestAgentDefaults`（一级一行，清空即删除，会话改配到其他工作区后单独设置不再生效）。`go test` 覆盖 httpapi 全包（962 s，需 `-timeout 40m`）、sqlitestore、store、feishu，全部通过。
- Web：typecheck、audit:ui 11 项、audit:modules 通过；`test/agent-defaults.test.mjs`、`chat-runtime-choice.test.mjs` 通过。草稿已有手动选择时不再等默认值读取，避免改变原有的重载恢复行为。`chat-runtime-selection.test.mjs` 按 fetch 次数统计模型目录请求，新对话多出的默认值读取使其中 4 项失败；已改为测试桩对 `/agent-defaults` 返回 404，只统计目录请求，11 项全部通过。全量 Web 测试（928 项）中另有与本项无关的失败：`accounts-gate` 1 项、`file-delivery` 3 项、`foundry-skill-page`、`local-image`、`session-work-controls`、`worker-commands` 各 1 项、`workspace-services` 2 项（该文件还挂起约 15 分钟）。这些失败都与读取失败后的重试、离线态有关，不经过本项代码，应来自共享树中其他会话对 `api/http.ts` 重试逻辑的改动；未处理，已告知协调会话。`workspaces-feature`、`workspace-unserved`、`workspace-skill-versions` 单独运行通过（全量中失败只因前一个文件挂起）。
- scratch 栈（实时 DB 的副本，integrations off），用一个已配对飞书会话的工作区测试：
  - API：错误的强度返回 400；工作区设 Codex + 模型 + high 后，Web、机器人、会话三处都显示来自工作区；机器人设 low 后，机器人和会话的强度变为 low，Web 不变；会话设未登录的 Claude Local 后，跳过 1 项并回到工作区 Codex；会话设外部连接 profile + max 后，会话使用该 profile、max，来源为会话设置，工作区的模型不再沿用。
  - 浏览器（light/dark × 1280/390）：设置页、Channels、会话对话框、新对话输入框，均没有页面错误。键盘操作：焦点移到 Effort，Enter 打开菜单，方向键与 Enter 选择 Medium，保存后结果行更新。会话对话框显示 Unusable 徽标和 “A configured default cannot be used” 警告。新对话预选 Codex Local 并显示 Medium，菜单中该选项下注明 “Workspace default”。截图在 `/tmp/dev068-check/out2/`（本机临时目录，未入库）。

## 部署

- 构建：共享树，基线 commit 与 `git status` 存于 `releases/dev068-agent-defaults/`（`base-commit`、`tree-status.txt`）。
- 协调会话询问 DEV-066 能否从共享树一并部署 Server 和 Web；本项答复可以原样上线（schema 已定）。DEV-066 于 21:11–21:13 部署，Server sha256 `51c002635f415499…`，与本项构建的二进制一致；Web build `6796efb44e5fdab8`。本项没有单独部署。

## dev 部署后验证（2026-10-28 21:2x）

用 e2e-alice 在 DEV-048 合成工作区 `ws_d4da0f57-…` 验证（无飞书机器人；渠道级已在 scratch 栈验证）：

- API：Codex 配 Claude 的 `max` 强度返回 400，不属于本工作区的会话 route 返回 404。设外部连接 profile + max 时，解析为该 profile、max，来源为工作区默认。改设未登录的 Claude Local 时，该行标为 `not_signed_in`，解析跳过 1 项并回到本人最近使用的 Codex。设 Codex + gpt-5.5 + high 时，解析为工作区默认。
- 浏览器（独立 headless profile，light/dark × 1280/390）：设置页结果行正确；键盘把 Effort 从 High 改为 Medium 后已保存；Channels 的 Web Chats 卡片文案正确；新对话预选 Codex Local + Medium；没有页面错误。390 宽度下聊天页先显示列表，输入框预选在 1280 宽度核对。
- 既有会话不受影响：设置前后该工作区 4 个会话的 id、profile、model、status 完全一致。本项没有创建会话，也没有运行模型。
- 收尾：工作区默认已清空（恢复为 `last_used`），已登出；Server 日志没有本项相关的错误，healthz 200。

## 已知限制

- 默认值只在启动时解析。已有会话继续用自己的账号；改了默认值，已打开的新对话草稿要重新打开才会刷新。
- 输入框只在账号选项下注明来源（菜单展开时可见）；收起时的按钮不显示来源。
- Channels 页面的默认值不随事件实时刷新：保存的人立即看到，其他人刷新页面后才看到。
- 不可用说明是英文写入会话记录；飞书卡片标题为中文，正文同为英文说明。

## 验收步骤

1. 打开 https://dev.foundryapp.app/workspace/settings ，在左侧选择一个你是维护者的工作区。在 “Default agent” 中选择账号、模型、推理强度。预期：每次选择后出现 “Default agent saved.”，下方显示 “New chats use: … — workspace default”。
2. 打开 https://dev.foundryapp.app/chats ，点 “+” 新建对话。预期：输入框预选上一步的账号、模型和推理强度；展开账号菜单时，该账号下注明 “Workspace default”。改选其他账号只影响这个对话，再新建对话时仍预选默认。
3. 打开 https://dev.foundryapp.app/workspace/channels 。预期：Web Chats 卡片写着 “New chats use the workspace default agent.”；飞书机器人下的 “Default agent” 显示新话题会用什么。把 Effort 设为另一个值后，结果行的来源中出现 “Feishu bot default”。
4. 在同一页的会话行点 “…” → “Set agent for this chat…”，为它单独选一个账号。预期：行内显示 “Own default”；在飞书该会话里 @机器人 发起新话题，话题会话使用这个账号（Web 中打开该会话可看到账号）。
5. 把某一级的账号设为一个未登录的账号。预期：该级显示 Unusable 徽标和警告；新会话改用下一级，会话记录开头有 “Default agent: passed over …” 说明；飞书话题另回一张 “默认智能体未能使用” 卡片。
6. 用非维护者账号打开第 1 步页面。预期：三个下拉框都不可用，并提示 “Only workspace maintainers change the default agent.”

## 时间线

| 时间（北京）     | 变化/证据                                                             | 剩余动作                    |
| ---------------- | --------------------------------------------------------------------- | --------------------------- |
| 2026-10-28 16:52 | 会话额度用尽中断，恢复后继续                                          | —                           |
| 2026-10-28 21:03 | 实现与自验完成；答复协调会话：schema 已定，可随 DEV-066 共享树部署    | 部署后在 dev 验证；人工验收 |
| 2026-10-28 21:13 | DEV-066 部署共享树（Server `51c00263…`，Web `6796efb44e5fdab8`）      | dev 验证                    |
| 2026-10-28 21:2x | dev 上 API 各级与回退、浏览器矩阵、既有会话不变均通过；合成配置已清空 | 人工验收                    |
