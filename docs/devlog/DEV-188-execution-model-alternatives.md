# DEV-188 执行模型：默认 + 编排者可选列表

## 状态

已合入 main（[PR #264](https://github.com/BD777/foundry/pull/264)）。

设计已与本人达成共识（2026-11-12，[编排会话](https://dev.foundryapp.app/chats/sess_1794464313271186377)）；Server 和 Web 已实施并部署 dev，工作区保存修复与 Worker 组说明也已完成，待人工验收。

## 问题

- 执行默认值只有一个槽位，只能表达「日常用什么」。某一步超出默认模型能力时，编排者没有地方可查，只能自己挑模型（例：编排者自行派了 opus，没有依据）。
- 规则没有合适的落点：orchestration skill 必须与具体模型无关；模型说明书只描述它自己的模型；编排者的私人记忆不是本人的配置。
- 曾考虑过的做法，被否决的原因：
  - 「较难的步骤」第二槽位：给用户增加了心智负担。
  - 把强模型放进同一个 worker group、不设 TPM：用容量设置表达能力，概念错误。TPM 只是并发限制。
  - 「建了 group 就可用」：准入是隐式的。group 只是 group，配置进执行模型才可用。
  - 任务难度分级：难度不是一条轴；分级会让说明书变成路由表；还要额外有人定级。

## 设计

职责分开：

| 概念         | 回答的问题                                         | 落点                           |
| ------------ | -------------------------------------------------- | ------------------------------ |
| worker group | 一组可以互相替换的模型之间如何分摊负载（TPM/权重） | worker group                   |
| 模型说明书   | 这个模型自己的能力、局限、成本、写 brief 的方式    | model guide（只写本模型）      |
| 执行模型配置 | 编排者能用哪些模型；日常用哪个                     | 本项：默认 + 可选列表          |
| 何时换用     | 某一步命中默认成员说明书「不适合/弱点」的某一条    | orchestration skill 的通用规则 |

- **数据**：`execution_defaults` 行新增 `alternatives`（JSON 数组，默认 `[]`）。每一项与默认值字段相同：`providerKind`、`providerId`、`runtime`、`model`、`workerGroupId`、`effort`，一项要么是一个模型，要么是一个 worker group。
- **工作区覆盖**：整行替换，默认与可选列表一起覆盖；没有覆盖时用全局行。
- **API**：`GET/PUT /api/execution-default`、`/api/workspaces/{id}/execution-default` 的请求和响应增加 `alternatives`。响应里每个 group 项像默认值一样展开 `group`（成员）。严格解码不变。
- **MCP `get_execution_default`**：返回默认值与 `alternatives`（展开的 group）。描述里写明：只能使用默认值和可选列表里的项。
- **Server 不做强制**：编排者开子会话时不校验模型是否在列表内（本人确认）。约束靠 skill 规则，并在派活和汇报中写明理由。
- **Web**：页面改名为「执行模型」/「Execution models」。默认值卡片不变，下方新增「编排者还可以使用」列表，复用同一个选择器，可添加、可删除。工作区覆盖卡片同样包含这两部分，并显示继承来的值。之前加的「只有显式开启 /foundry-orchestration 才会使用」提示保留。
- **skill（第 6 版）规则**，与具体模型无关：
  1. 日常工作用默认。
  2. 某一步命中默认成员说明书「不适合」或「弱点」中的某一条时，从可选列表里挑说明书合适的一项启动，并在派活和汇报中引用命中的那一条原文。
  3. 可选列表里没有合适的，或者说明书没写到，就问本人。不使用列表之外的模型。
  4. 模型说明书只写本模型：不点名、不比较、不路由到其他模型。
- **MCP `model_guides` 描述**：补上「只描述本模型」。
- **worker group 页面说明**：补上一句「把可以互相替换的模型放在一组；TPM 和权重只分摊负载，不代表能力或成本」。

## 不做

- 不做任务难度分级，不给模型打能力标签。
- 不在 Server 端强制限制可用模型。

## 实施与验证

- **Server**：契约新增 `ExecutionModelChoice` 和 `ExecutionModelDefault.alternatives`；SQLite 增加 JSON 列及旧库迁移；全局/工作区 API 支持默认与可选列表的读取、整行替换和 Worker 组展开；MCP 返回完整视图。定向测试覆盖全局/工作区、group 展开、无效 provider、旧请求体与 MCP。
- **Web**：执行模型页面改为“默认 + 编排者还可以使用”，复用同一套模型/Worker 组选择器，支持添加、删除、空状态、继承态只读列表和整体保存；Worker 组页面补上“按额度 / 按权重”的负载分摊说明。
- **工作区保存修复**：旧页面仍发送 `modelPoolId`，严格解码返回 `400 invalid JSON request body`；Worker 组摘要又因仅按展开后的 group 判断，在 group 未展开时落到 provider/model 分支。现在只发送协议内的非空字段，摘要识别 `effective.workerGroupId`。

## 时间线

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                  | 剩余动作                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 2026-11-12       | 与本人讨论定稿（sess_1794464313271186377）                                                                                                                                                                                                                                                                                                                                                                  | 拆分实施：Server/契约/MCP → Web → skill 第 6 版，然后部署  |
| 2026-11-12 15:31 | 工作区执行模型保存失败修复完成并部署。请求只发送协议字段；摘要识别 worker group id。`pnpm typecheck` 通过，`profiles-feature` 31/31，`go test ./internal/httpapi/ -run ExecutionDefault` 通过；Web `574590acda8fd8ff`、Server SHA-256 前缀 `24cfa093091c9100` 已部署，重启计数 `56 → 57`，`/healthz` 200。详见 [save-fix session](https://dev.foundryapp.app/chats/sess_1794466765839981088)。              | e2e-alice 无 provider，成功保存的 2xx 路径只有单测覆盖     |
| 2026-11-12 15:43 | Worker 组编辑器的按额度 / 按权重说明与字段标签统一，Web build `2a99efacde9b9601` 已部署；`pnpm typecheck` 通过，`profiles-feature` 31/31，线上主包确认中英文警告文案存在。截图 `worker-group-list-badges.png`（1280×900）显示两个 Badge。详见 [copy session](https://dev.foundryapp.app/chats/sess_1794467186081409353)。                                                                                   | 该版本已包含在后续 Web `728d8ae198733962` 中；人工视觉验收 |
| 2026-11-12 17:03 | Server 侧完成并部署 dev。`go test ./internal/httpapi/` 8.713s、`go test ./internal/sqlitestore/` 0.219s 通过；Web typecheck 与 protocol build 通过。新二进制 SHA-256 前缀 `0a672c4d073b8529…`，PM2 online，重启计数 `58 → 59`，30 秒后稳定，`/healthz` 200；e2e-alice API 的 GET、旧格式 PUT、清空覆盖均符合预期。详见 [Server session](https://dev.foundryapp.app/chats/sess_1794472615276564772)。        | Web UI；dev API 未写入真实 provider 的 alternatives        |
| 2026-11-12 17:31 | Web 完成并部署 dev build `728d8ae198733962`。默认与 alternatives 的保存/删除/继承态、页面命名与 Worker 组说明已实现；`pnpm typecheck` 通过，`profiles-feature` 34/34，component-system 与 state-layout 审计通过，hint 只剩两条既有失败。截图：`exec-models-light.png`、`exec-models-dark.png`、`exec-models-workspace.png`。详见 [Web session](https://dev.foundryapp.app/chats/sess_1794474486202174079)。 | 编排者最终目视确认；Server 按要求不强制列表                |
