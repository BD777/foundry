# DEV-192 foundry-orchestration Skill 第 4–6 版

## 状态

第 4–6 版均已实现并部署到 dev（2026-11-12）；第 6 版随后随 Worker 包更新到 7 台在线设备。导航守卫、执行模型卡片、`model_guides` 描述和两份模型说明书的数据修订均已生效。未提交（等提交窗口）。

## 问题

- 第 3 版允许编排者自行承担实现、检查、部署和浏览器验收，导致上下文快速膨胀，也让本人的下一项任务排在编排回合之后。
- 第 4 版把“默认委派”写成硬规则后，Claude Code 与 Codex 仍可能根据普通用户提示隐式选择 `foundry-orchestration`；本人希望只有显式输入 `/foundry-orchestration` 才进入这套角色。
- 第 6 版需要把模型选择落成“默认 + 编排者还可以使用”的显式配置，并避免模型说明书变成跨模型路由表。

## 调查

- 第 4 版的两个实现会话：[Server](https://dev.foundryapp.app/chats/sess_1794466486827053237)、[Worker](https://dev.foundryapp.app/chats/sess_1794466680947943838)。
- 第 5 版的调用控制与页面提示：[sess_1794468838799195362](https://dev.foundryapp.app/chats/sess_1794468838799195362)。
- 第 6 版和执行模型规则：[sess_1794474498379601393](https://dev.foundryapp.app/chats/sess_1794474498379601393)。
- Claude Code 的原生 skill frontmatter 支持 `disable-model-invocation: true`；Codex 在 `agents/openai.yaml` 的 `policy.allow_implicit_invocation: false` 控制隐式调用，`$skill` 显式调用仍可用。
- Foundry 的 skill 打包递归收集整个目录，Worker materializer 会把 `agents/openai.yaml` 一并写到物化目录，因此两个运行时可各自使用原生守卫。

## 修复

### 第 4 版：默认委派

- 在 `Stay out of the work` 中明确：需要构建、部署或真实浏览器检查的改动，不论大小都先派给 Worker。
- 编排者只保留范围、架构、验收和最终审查；只有几次读取就能决定下一份 brief、改动比 brief 更短且不需要构建/部署/浏览器检查，或同一处已失败两次时，才由编排者自己动手。
- 编排者审查 diff 和证据；检查、部署与浏览器登录由 Worker 执行。
- 选择模型只能走执行模型配置，不再以“平衡配额”为理由临时挑模型。

### 第 5 版：只允许显式触发

- 两份 `SKILL.md` 的 description 改为纯编排角色，并加入 `disable-model-invocation: true`。
- 两份 `agents/openai.yaml` 加入 `policy.allow_implicit_invocation: false`。
- 执行模型设置卡片补中英文提示：只有本人在对话里输入 `/foundry-orchestration` 才把工作交给该执行模型；否则 Agent 使用自己的原生 subagent。

### 第 6 版：默认 + 可选列表

- `get_execution_default` 改为读取“默认 + 可选列表”；普通工作用默认模型或默认 Worker 组。
- 只有某一步命中默认成员说明书 `avoid` 或 `weaknesses` 中的具体条目时，才从可选列表选择替代项，并在 brief 和汇报里引用命中的原文；没有合适项或说明书未覆盖时询问本人。
- 选择 Worker 模型后先 `model_guides resolve/get`，按该模型自己的说明书写 brief；失败经验晋升到同一说明书的短条目。
- `model_guides` 的工具描述补上“只描述本模型”，skill 正文也禁止点名、比较或路由到其他模型。
- Worker 组页面补充“成员可互相替换，TPM 和权重只分摊负载，不代表能力或成本”的说明。

## 部署与版本证据

| 版本    | 部署证据                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第 4 版 | Server 新二进制时间为 `2026-11-12 14:56:37 +0800`，大小 `64,688,783` bytes；PM2 online，重启计数 `55 → 56`，30 秒后保持 `56`，`unstable_restarts=0`。同源请求返回 `401`，确认 Server 正常应答；本地物化出两份 revision 4 skill。未重启 Worker。                                                                                                                                               |
| 第 5 版 | Server 新二进制时间为 `2026-11-12 15:39:18 +0800`；PM2 online，重启计数 `58`，30 秒后不变，`unstable_restarts=0`；健康端点返回 `401`。Web build `2a99efacde9b9601` 已部署，真实浏览器确认执行模型提示渲染。按范围未发布 Worker。                                                                                                                                                              |
| 第 6 版 | Server 新二进制 `64,747,974` bytes，mtime `2026-11-12 17:17:36 +0800`；PM2 online，重启计数 `61`，30 秒后不变；`/healthz` 返回 `200`。Worker 包 `0.5.7-dev.354.geb87723d.local.1794475758` 已发布，7 台设备最终均为同一 Worker/Server version、`state: none`、`inProgress: false`。完整设备更新记录见 [sess_1794475644973224328](https://dev.foundryapp.app/chats/sess_1794475644973224328)。 |

执行模型页面和默认/可选列表的前端部署见 [DEV-188](DEV-188-execution-model-alternatives.md)；第 6 版依赖它提供的配置，而不是在 skill 内硬编码模型。

## 模型说明书数据修订

- `deepseek-flash-1017` 升到第 4 版，删除了把工作转给其他模型的建议，改成该模型自身的适用边界、成本与 brief 要求。
- `claude-opus-limen` 升到第 3 版，删除了点名更便宜模型进行路由的建议，改成该模型自身的能力和成本特性。
- 两次修订均由 [编排会话 sess_1794464313271186377](https://dev.foundryapp.app/chats/sess_1794464313271186377) 在 `2026-11-12T07:58Z` 提交；`model_guides get` 回读确认 revision、change summary 与正文一致，别名未变。

## 检查

- 第 4 版：`go test ./internal/builtinskills/` 通过；`node scripts/run-worker-tests.mjs -- foundry-skill.test.mjs` 为 `5 pass / 0 fail`；两份 skill 目录字节一致。
- 第 5 版：`go test ./internal/builtinskills/` 通过；Worker skill 测试 `5/5`；Web `pnpm typecheck` 通过；`profiles-feature` `31/31`；真实浏览器确认中文提示。`audit-hints` 仍只有两条既有失败。
- 第 6 版：`go test ./internal/builtinskills/` 通过；`go test ./internal/httpapi/ -run 'MCPTool|ModelGuide'` 通过；两份 skill 目录 `diff -r` 为空；JSON 描述合法。
- 第 6 版首次 Worker skill 检查为 `4 pass / 1 fail`，失败来自并行会话尚未把 `update_worker` 加入 CLI 映射，不是 skill 正文差异；该映射随后随 Worker 包发布，但本记录没有把合并后的重跑写成已通过。
- `model_guides get` 回读确认 DeepSeek revision 4、Claude Opus revision 3；正文不再包含跨模型路由建议。

## 限制

- 第 6 版没有在 Server 端强制限制子会话只能使用默认值和 alternatives；边界由 skill 规则和 brief 保证。
- 第 6 版会话中按单行 `grep` 检查物化 skill 未命中，因为正文在 `Never` 后换行；改用不含换行限制的语义匹配后找到 3 个新 skill-set，SHA-256 与仓库正文一致。
- 第 5 版部署后仍有两条模型说明书 hint 的既有审计失败；与本次 skill revision 无关。

## 验收步骤

1. 在普通对话里不输入 `/foundry-orchestration` 发出实现请求：不应进入这套编排角色；显式输入 `/foundry-orchestration` 后，Agent 应只做计划、派活和审查。
2. 打开执行模型设置：应看到默认值、编排者还可以使用的列表，以及“只有显式开启才会使用”的提示。
3. 在一项 Worker 任务里命中默认模型说明书的 `avoid`/`weaknesses`：编排者应引用对应的具体条目后才选择可选列表中的替代项；不命中时应使用默认项。
4. 打开两份模型说明书：应分别显示 revision 4 和 revision 3，且正文不点名或路由到其他模型。
