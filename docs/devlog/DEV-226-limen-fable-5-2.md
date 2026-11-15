# DEV-226 Limen 模型列表加入 Fable 5.2

状态：已部署 dev，待本人验收；已合入 main（PR #268）。

2026-11-16 Agent 代验收：**通过**（范围：cottoncpp 的 Limen 扩展版本、`list_models`、以及 2026-11-13 已在 cottoncpp 记录的真实 Fable 5.2 回合）。未覆盖：本次未新跑模型回合；步骤 3/5 的证据取自同一次部署的已记录回合 `sess_1794586866482839336`。

## Agent 代验收（2026-11-16）

来源：编排会话 `sess_1794464313271186377` 转述本人委托。

- cottoncpp `dev_b12e3eac…` 的 Limen 扩展为 `0.2.2`（installed）。
- `list_models(limen_default, cottoncpp)` 返回 `sonnet`、`opus`、`haiku`、`claude-fable-5-2` 四个。
- 2026-11-13 的 cottoncpp 真实回合 `sess_1794586866482839336`：`usage_turns` 的 model 为 `claude-fable-5-2`、profile `limen_default`、cache read 12229；会话事件含 `configuredWindow {tokens: 1000000, source: official}` 与 `contextWindow: 1000000`，回复为 `fable 1m ok claude-fable-5-2[1m]`。本次未新跑模型回合。

[Devlog](README.md)

## 问题

cottoncpp 上的会话（`sess_1794583027695880257`）发现：在 Limen provider 下只能选 sonnet / opus / haiku，选不到 Fable 5.2。

## 排查

- Limen gateway 没有模型白名单。limen server `ed648b771dcf` 已带 Fable 5.2 计价，client 会原样透传 `--model` / `ANTHROPIC_MODEL`。在 cottoncpp 上 `limen run claude -p --model claude-fable-5-2` 成功，`modelUsage` 为 `claude-fable-5-2`。
- 唯一挡住的是 bundled 扩展 `extensions/limen/foundry-extension.json` 0.2.1，它的 `cli.modelAccess.models` 写死为 `["sonnet", "opus", "haiku"]`；Worker 按它生成 provider 的模型列表（`packages/worker/src/connectors/extensions/model-access.ts`）。

## 修复

- `models` 加入完整 id `claude-fable-5-2`；默认 `model` 仍是 `sonnet`。扩展版本 0.2.1 → 0.2.2。
- 不用 `fable` 别名：limen 仓库 `.claude/rules/verification.md` 记录 Claude Code 2.1.301 / 2.1.317 不认识 Fable 5.2 的 id。模型条目只是字符串，没有显示名，如果别名和完整 id 都加上，列表里会出现两个看起来重复的条目。
- `packages/worker/test/connector-extensions.test.mjs` 里两个 bundled 接管测试原来写死了 `0.2.1`，改为从 manifest 读取版本，旧/新本地副本用 `0.0.1` / `99.0.0`，以后升版本不必再改这两个测试。
- limen server/client 不改。

## 发布

bundled 扩展随 Worker 包发布，Worker 启动时按 SHA-256 原子更新已安装副本（`docs/connector-extensions.md`“来源”）。需要新 Worker 包。补丁交给 conductor `sess_1794555762602239151`，随 Worker `0.5.7-dev.357.g8f394c91.local.1794583663` 发布（只有 `extensions/limen/foundry-extension.json` 和 package.json 与上一版不同；Server、Web 不变），cottoncpp 15:29:45Z 已加载新版。

## 检查

- `go test ./internal/connectors/ -run 'Bundled|Extension'` 通过。
- `node scripts/run-worker-tests.mjs -- --test test/connector-extensions.test.mjs`：22/22 通过（改测试前，两个 bundled 接管测试因写死版本失败）。

## 验收

1. cottoncpp（`dev_b12e3eac…`）的 Worker 更新到包含本补丁的版本后，在 Connectors 页看 Limen 扩展版本，应为 0.2.2。
2. 新对话选择 provider `Limen · default`，模型下拉里应有 `claude-fable-5-2`。
3. 用它跑一个 turn，会话事件里的模型用量应为 `claude-fable-5-2`。
4. 在 `Limen · default` 下，模型下拉和 MCP `list_models` 都应列出 `sonnet`、`opus`、`haiku`、`claude-fable-5-2` 四个。
5. 用 `claude-fable-5-2` 跑一个 turn，对话里的上下文窗口应显示 1M（1,000,000），不是 200K。

## 时间线

- 2026-11-13：修复和定向测试完成，补丁交车次。
- 2026-11-13 15:31Z：端到端检查通过。`list_models`（cottoncpp、`limen_default`）返回 `claude-fable-5-2`。在 cottoncpp workspace 用 `Limen · default` + `claude-fable-5-2` 新建会话 `sess_1794583842244514494`（Claude Code 2.1.311），回答 `fable ok claude-fable-5-2`，事件 `Model request usage` 为 `claude-fable-5-2`。未提交，等 conductor 合入。
- 2026-11-13 16:21Z：第二轮（Foundry 两个 bug）随 train15 上线，cottoncpp 实测通过：`list_models` 返回 4 个模型，Fable 5.2 窗口 1M。待本人验收，未提交。

## 第二轮：Foundry 自身的两个 bug

原则（本人 2026-11-13，经 `sess_1794583027695880257` 转达）：bug 在哪里就修哪里。Foundry 消费 connector manifest 出错时修 Foundry，不改 manifest 已有的字段或语义；本轮 Limen manifest 不动。已写进 `docs/connector-extensions.md`“边界”。

**Bug 1：`list_models` 丢掉合法模型。** cottoncpp 上 `list_models(limen_default)` 只返回 `claude-fable-5-2`。原因是 `httpapi/mcp_workspaces.go` 的 `chatModelForRuntime`：Claude runtime 的模型只要 id/label 不含 `claude` 就丢，于是丢掉了 Limen 声明的 `sonnet`/`opus`/`haiku`；原生登录目录里的 `default`、`opus[1m]` 等别名，以及 Claude runtime 走兼容端点时的非 Claude id（`deepseek-…`、`auto_model/…`），也都被丢掉。修复：去掉按厂商名的猜测（改名为 `chatModel`），只保留端点目录里的非对话模态过滤（embedding、图像、视频、音频、3D）；connector profile（`profile.Connector != nil`）完全不过滤，manifest 声明什么就返回什么。Web 对话的模型选择器把 profile 自己的列表和发现结果合并（`use-chat-runtime.ts` `mergeModelOptionLists`），不按名字过滤，不受影响。

**Bug 2：Fable 5.2 跑在 200K。** Foundry 的 Claude runtime 跟随 npm `stable`（目前 2.1.311），它不认识 `claude-fable-5-2`：按 200K 算，`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 也被忽略；名字写成 `claude-fable-5-2[1m]` 就跑 1M（cottoncpp 经 Limen 实测）。Foundry 加 `[1m]` 的逻辑（`claudeRunModel`）依赖解析出的窗口，而 `resolveSessionContextWindow` 只处理兼容端点 profile，原生登录和 connector profile 都没有窗口。修复：

- protocol `model-context.ts`：官方表加 `claude-fable-5-2: 1M`；把它加进“Claude Code 只有用 `[1m]` 才跑 1M”的集合，并注明原因是它比 stable 运行时新。
- worker `context-window.ts`：Claude 的原生登录和 connector 连接仍沿用 CLI 自己的窗口，只有 Claude Code 必须用 `[1m]` 才跑 1M 且官方窗口 ≥1M 的模型，才解析出官方窗口。启动名因此是 `claude-fable-5-2[1m]`；Foundry 显示和记录的仍是不带后缀的名字。别名（`sonnet`、`opus[1m]`）和 CLI 已认识的模型（`claude-opus-4-8`）照旧没有窗口。
- 没有改 runtime 跟随 `stable` 的策略：升到 2.1.323 只解决这一个模型，而且会影响所有会话；补全模型表对以后的新模型同样有效。

**测试（本轮）**

- Server：`go test ./internal/httpapi/ -run 'TestChatModelKeeps|TestListModels'` 通过。新增 `TestListModelsAnswersEveryModelAConnectorProfileDeclares`：Limen 声明的 4 个模型全部按顺序列出，旧过滤下这个测试会失败；`TestChatModelKeepsEveryChatModelAndDropsOtherModalities` 覆盖别名和非 Claude id。
- protocol：`node --test test/model-context.test.mjs` 通过（Fable 5.2 的官方窗口、`[1m]` opt-in）。
- Worker：`context-window` + `connector-extensions` 36/36；新增用例覆盖 connector profile 和原生登录跑 `claude-fable-5-2` 时窗口 1M（official）、`ANTHROPIC_MODEL=claude-fable-5-2[1m]`、`FOUNDRY_AGENT_MODEL=claude-fable-5-2`，别名和已知模型不变。相关的 12 个 launch/external/native/profile 测试文件 23+93 通过。

**发布与实测（第二轮）**

- conductor `sess_1794555762602239151` train15-20261113：Server sha256 `50b43edf…`，16:18:29Z 起运行，healthz 200，回滚副本 `foundry-server.pre-train15-20261113`；Worker `0.5.7-dev.357.g8f394c91.local.1794586501`，cottoncpp 16:19:38Z 更新完成。conductor 在 byte-dev 上用车次树重跑：httpapi ok，protocol 4/4，Worker 56/56。
- cottoncpp `list_models(limen_default)`：`sonnet`、`opus`、`haiku`、`claude-fable-5-2`，total 4（修复前只有 `claude-fable-5-2`）。
- cottoncpp `Limen · default` + `claude-fable-5-2`，会话 `sess_1794586866482839336`（Claude Code 2.1.311）：CLI 回答自己是 `claude-fable-5-2[1m]`，Foundry 记录的模型是 `claude-fable-5-2`。Server 库里该会话的 context 事件为 `configuredWindow {tokens: 1000000, source: official}`、`contextWindow: 1000000`（来自 CLI 的 `modelUsage`）。对照：第一轮会话 `sess_1794583842244514494` 没有 configuredWindow，`contextWindow: 200000`。

## 限制

- 将来 stable 运行时自己就认识 Fable 5.2（2.1.323 起）后，启动名仍是 `claude-fable-5-2[1m]`。这样不会出问题：`sess_1794583027695880257` 在 cottoncpp 上用 CC 2.1.323 经 Limen 网关跑 `--model 'claude-fable-5-2[1m]'`，请求成功，`modelUsage` 的键是 `claude-fable-5-2[1m]`，contextWindow 1000000；不带 `[1m]` 也是 1000000（2026-11-13）。stable 升级后可以把它从 opt-in 集合里移出，但不是必须。
