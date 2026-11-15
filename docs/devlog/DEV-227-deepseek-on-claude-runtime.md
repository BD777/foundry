# DEV-227 DeepSeek execution moves to the Claude runtime

状态：已部署 dev（Server train16-20261113），配置已切换并自检通过；Codex TokenHub provider 已撤下全部设备（byte-dev 最后撤下，2026-11-13T22:00Z）。代码已并入共享树 main，等 22:00 提交窗口；Worker 部分随 Worker `0.5.7-dev.357.g8f394c91.local.1794593951`（train18）上线。待人工验收。已合入 main（PR #268）。

2026-11-16 Agent 代验收：**通过**（范围：Model providers、Worker 组、以及本验收会话在默认执行组上的真实运行）。未覆盖：未单独复验“已在运行的 Codex DeepSeek 会话不受影响”（历史行为）。

## Agent 代验收（2026-11-16）

来源：编排会话 `sess_1794464313271186377` 转述本人委托。

- `list_model_providers`：Tencent TokenHub (Claude) `prof_2c4c55cc…` 在 7 台设备上，6 台在线设备的检查均为 passed；Tencent TokenHub (Codex) `prof_a8985449…` 的设备列表为空。
- `worker_groups`：`deepseek-flash-1017` 两个成员均为 `claude` runtime、`prof_2c4c55cc…`、`xhigh`、TPM 1M / 6M。
- 步骤 3：本验收会话 `sess_1794760093665392985`（foundry 工作区、默认执行组）的 runtime 为 `claude`，profile 为 `prof_2c4c55cc…` / Tencent TokenHub (Claude)，model 为 `deepseek-v4.1-flash-1017`；`usage_requests` 有 cache read（例如 29568）。会话标题栏 UI 未另外打开查看，但会话与用量数据来自线上库。
- 步骤 4 的“已在运行的 Codex 会话不受影响”未单独复验。

## 问题

本人依据 [DeepSeek harness A/B](../research/deepseek-harness-ab.md) 做了决定：同一 `deepseek-v4.1-flash-1017` 上，Claude runtime 中位 57 s，Codex 90 s；每个解决任务 $0.019 对 $0.030；盲评 4.59 对 4.37；两组都是 27/27 通过。执行默认和 executor 改用 Claude runtime 的 TokenHub provider（DEV-209），不再使用 Codex × DeepSeek 模式（「那就改成claude，然后把我的那些executor也改成用claude的那种，那就codex Deepseek的模式就可以去掉了」）。

## 调查：修改前

只读查询线上库（`mode=ro`），列出所有引用 Codex TokenHub provider `prof_a8985449-4ebc-42ef-ab50-35a55fa7f282` 的配置：

| 位置                                                                 | 修改前                                                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Claude TokenHub provider `prof_2c4c55cc-e65e-4c76-bbed-4495af2b7617` | 只分配给 sg-chaos                                                                                                                   |
| Codex TokenHub provider `prof_a8985449…`                             | 7 台设备（macbook 离线）                                                                                                            |
| 全局执行默认                                                         | Worker 组 `wgroup_c8029c91-f8e8-4d83-bb38-9fd012f435f7`（deepseek-flash-1017），没有 alternatives                                   |
| 该组成员                                                             | Codex `prof_a8985449`：`deepseek/deepseek-flash`（xhigh，1M TPM，weight 1）和 `deepseek-v4.1-flash-1017`（xhigh，6M TPM，weight 1） |
| 工作区执行覆盖                                                       | 无（`execution_defaults` 只有全局一行）                                                                                             |
| 其他 Worker 组                                                       | 无                                                                                                                                  |
| 助理 executor 覆盖（`executionModels`，DEV-194）                     | 只有 ByteWork 设置了，指向 `codex_provider_llm_gateway`，与 DeepSeek 无关                                                           |
| 旧 executor 角色配置（`roleOverrides.executor`）                     | 已停止的助理 `asst_abe30eaf…` 及其 legacy 行：Codex `prof_a8985449` × `deepseek-v4.1-flash-1017` xhigh                              |
| model guide `deepseek-flash-1017`                                    | 只有两个 Codex 别名；weaknesses 里写着「Codex 按 1M 算」                                                                            |
| 历史                                                                 | 两条已发送的 chat queue items、历史会话、guide 别名（只是记录）                                                                     |

缺失的能力：Worker 组的 REST 路由只接受已登录的本人（`accountOnly`），也没有对应的 MCP 工具，所以 Agent 改不了组成员。

## 修复

代码（Server，经 deploy train 上线）：

- 新增 MCP 工具 `worker_groups`（`list` / `save`），与 Model providers 页的组编辑器做同样的事。权限与 model provider 工具相同：只有本人的对话和助理能用，Issue、clarification 和 verifier 会话不能用。
- 不带 `id` 时新建组；带 `id` 时替换成员（`label` 省略则保留）。成员的 provider 必须属于本人且 runtime 一致，effort 必须对该 runtime 有效。
- REST create/update 与 MCP 共用 `saveWorkerGroup`，行为不变。
- 另加 CLI `foundry worker-group list|create|update`（随 Worker train18 上线），以及 foundry skill `references/model-providers.md` 的一条说明（两份副本相同）。builtin skill revision 38 → 39，由 conductor 在 train 中补上，worktree 已同步。
- 改动的文件：`apps/server/internal/httpapi/{worker_groups.go, mcp_worker_groups.go, mcp_worker_groups_test.go, mcp.go, mcp_model_providers.go, mcp_tools.json}`、`apps/server/internal/builtinskills/{builtinskills.go, builtinskills_test.go, foundry/references/model-providers.md}`、`packages/worker/skills/foundry/references/model-providers.md`、`packages/worker/src/agent-surface/foundry-cli-commands.ts`。

配置（都通过 MCP 完成）：

1. `save_model_provider`：把 `prof_2c4c55cc` 分配到与 Codex provider 相同的 7 台设备。
2. `worker_groups save`：把 `wgroup_c8029c91` 的两个成员换成 `prof_2c4c55cc` 上的同名模型，TPM（1M / 6M）、weight 1 和 effort `xhigh` 都不变。组 id 不变，全局默认因此自动跟随，不用改执行默认。
3. effort 的取舍：Claude runtime 的 effort 是 low…max，Codex 是 minimal…xhigh。两者都有 `xhigh`。A/B 的 Claude 一组就是用 `--effort xhigh` 跑出了本人采纳的结果，所以保持 `xhigh`，不改成 `max`。A/B 也指出，Codex 的模型目录没有给这个模型列 reasoning levels，原来的 `xhigh` 可能根本没传到 provider。
4. `save_model_provider deviceIds`：Codex provider 从 6 台设备撤下，只留 byte-dev。byte-dev 上 `sess_1794583466320780196`（ccm-omh-integration，Codex × `deepseek-v4.1-flash-1017`）还在运行；按「运行中的会话不中断」，等它结束后再撤下 byte-dev。Foundry 没有单独的「停用」开关：不分配给任何设备就是停用，provider 本身和 sealed key 保留。不删除，因为删除会让历史会话和用量记录失去它们的 provider。 该会话 2026-11-13T21:53:58Z 完成，确认没有其他运行中的 Codex TokenHub 会话后，于 22:00Z 以 `deviceIds: []` 撤下 byte-dev，`devices` 回读为空。
5. `model_guides upsert`（revision 5）：
   - 加入 `prof_2c4c55cc` 的两个 Claude 别名。
   - 「Codex 按 1M 算」改为与运行时无关的事实：provider 没有配置上下文窗口。
   - 截断点从 250k 改为约 200k。
   - 补上 TokenHub 账号级 60 RPM 的限制。
   - guide 仍然只描述这个模型。旧的 Codex 别名保留，使历史会话的事实仍归到这份 guide。

`asst_abe30eaf` 的旧 executor 配置按编排者的决定不动。即使这个助理重启，全局组仍然优先：`run/resolve.go` 的 `executorModels` 依次查助理的 `executionModels`、工作区默认、全局默认，命中就返回；只有三者都不存在时，才读 `roleOverrides.executor`，而且只取它的 token 预算和超时。本人现在有全局默认，所以那条 Codex 配置不会被用来选模型。如果将来全局默认被清空，这条配置会指向一个不在任何设备上的 provider，选账号时会明确报错，而不会悄悄跑 Codex。

## 检查

- 代码：
  - CanWendeMac-mini `remote-check --go ./internal/httpapi -run 'TestWorkerGroup|TestExecutionDefaults|TestModelProviderTools|TestMCPGenericToolDescriptions|TestMCPTool|TestWireDrift|TestExecutorWorkerGroup'` 通过。
  - `go test ./internal/builtinskills/` 通过。
  - worker `test/foundry-skill.test.mjs` 5/5。
  - `foundry-cli.test.mjs` 有 5 个失败，在未改动的共享树上同样失败（环境原因），与本改动无关。
  - conductor 在 byte-dev 上对 train 复跑同一组测试，加上 `TestChatModelKeeps|TestListModels`，均通过。
- 部署：Server sha256 `3078976596202e134ffb4ca5541aec7f7700c9446ba0a4f697c7f91f7fd02092`，2026-11-13T16:28:09Z 启动，healthz 200；回滚副本 `foundry-server.pre-train16-20261113`。
- Provider 检查：`check_model_provider` 在 6 台在线设备上全部 `passed`（16:03:00–16:03:23Z）：CanWendeMac-mini、byte-dev、byte-dev-sg、cottoncpp、limen-canada、sg-chaos。macbook 离线，只分配，未检查。
- 经 Worker 组的真实短会话 `sess_1794587353739154907`（foundry 工作区，sg-chaos，16:29:13–16:29:22Z，已归档）：
  - 会话的 runtime 是 `claude`，provider 是 `Tencent TokenHub (Claude)`，model 是 `deepseek-v4.1-flash-1017`。payload 里有 `claudeEffort: "xhigh"`，`workerGroupId` 指向本组。
  - 没调用任何工具就逐字引用了 AGENTS.md「Native agents first」的第一条，说明 AGENTS.md 已在上下文中（DEV-209 当时没有）。随后 `pwd` 和 `git log -1` 都执行成功。
  - `usage_turns`：input 58,650，cache read 29,056，cache write 0，output 410，2 个 requests；`usage_requests` 两行，runtime 都是 `claude`，profile 是 `prof_2c4c55cc`，第二个请求 cache read 29,056。
- Executor 路径：没有通过本人的助理派发合成任务（编排者的决定）。
  - 对 `asst_abe30eaf` 的工作区 `ws_240d283d…` 调用 `get_execution_default`，返回的是全局组，两个成员都是 Claude。
  - executor 解析由 `TestExecutorWorkerGroupAndAlternatives` 覆盖（通过）。
- 60 RPM 与重试：A/B 原始证据（CanWendeMac-mini `~/.foundry/compute/dsh-ab/runs/claude-T09-r1/events.jsonl`）里，Claude Code 遇到 TokenHub 429 时发出 `{"subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":60000,"error_status":429,"error":"rate_limit"}`，按 provider 给的 60 s Retry-After 等待，最多 10 次。
  - Worker 的 `claudeQuotaExhaustion` 用 `diagnoseWorkerFailure` 判断，`rate_limit` 归为 `model_rate_limit`，不是 `model_quota_exhausted`，所以 Claude Code 的重试不会被截断。
  - 回合仍失败时，Server 再按同一模型重试最多 5 次。
- 修改后的引用：两个 Worker 组成员、全局默认、所有助理的 `executionModels` 都不再引用 `prof_a8985449`。剩下的引用只有 `asst_abe30eaf` 的旧角色配置（不会被使用，见上）、历史记录、guide 别名。

## 验收步骤

1. Model providers 页：「Tencent TokenHub (Claude)」应在 7 台设备上，在线设备的检查为通过；「Tencent TokenHub」（Codex）不在任何设备上。
2. Worker 组 deepseek-flash-1017：两个成员都是 Claude runtime、Tencent TokenHub (Claude)，effort xhigh，TPM 1M / 6M。
3. 新派出一个 helper 或执行会话：会话标题栏应显示 Claude 和 deepseek 模型；用量页能看到 cache read。
4. 已在运行的 Codex DeepSeek 会话不受影响，继续跑完。

## 限制

- ~~byte-dev 上最后一个 Codex 分配要等 `sess_1794583466320780196` 结束后才撤下~~：已于 2026-11-13T22:00Z 撤下（会话 21:53:58Z 完成）。如果再给这个会话发消息，需要切换到 Claude provider（`profileId: prof_2c4c55cc…`），由本人决定。
- Claude Code 不认识 `deepseek-v4.1-flash-1017`，按 200k 上下文和 32k 最大输出处理（A/B 中观察到）。provider 的上下文窗口没有配置：不在本项范围内，也还没查证这个 checkpoint 的权威数值。
- 没有在 executor 路径上真实运行模型，用的是解析测试加 `get_execution_default`。
