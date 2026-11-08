# DEV-151 Foundry MCP 管理模型来源：增删查改、生效设备、默认模型与检查

## 问题

本人 2026-11-09：“Foundry MCP 要支持一下添加 model provider。也就是 model provider 的增删查改。包括他们对哪些机器生效等等。我打算就用 Agent 的方式去增加 model provider。”此前 MCP 只能读（`list_profiles`、`list_models`），模型来源只能在 Web 的 Model providers 页管理；API 端点也没有显式的检查（只有设备上发现的端点自动检查、启动环境可手动检查）。

## 调查

- 页面的写操作都在 HTTP handler 里（`profiles.go` 的建 / 改 / 删 / 清密钥 / 分配设备，`agent_profiles_http.go` 的设备默认值，`native_sign_in.go` 的订阅登录，`external_connections.go` 的启动环境检查），没有可供 MCP 复用的函数。
- 会话令牌的访问范围（`agentScope`）里没有“拥有的设备”，`deviceOwner` 规则对 Agent 一律拒绝，所以工具层要按会话创建者重新判断设备归属。
- 模型来源只按设备分配（`device_profiles`）；Workspace 用哪个账号由“默认智能体”决定，没有“对某个 Workspace 生效”的模型来源设置。
- Worker 记录工具调用的地方：会话事件只脱敏 `detail` 与消息正文，`metadata`、审批卡的问题、Foundry 自己的 SDK 日志（`claude-sdk.messages.jsonl`、`codex-sdk.events.jsonl`）、子代理与原生对话摘要都不脱敏；转义 JSON、`apiKey: value`、`--api-key value` 等形式也漏过文本规则。

## 修复

- **同一套实现**：把 handler 拆成 HTTP 与 MCP 共用的函数（`createServerProfile` / `updateServerProfile` / `saveProfile` / `deleteServerProfile` / `clearServerProfileCredential` / `setDeviceProfiles`、`checkDeviceProfileInput` + `saveDeviceProfile`、`nativeSignInStep`、`checkDeviceAccountTarget`），HTTP 行为不变。
- **6 个工具**（`httpapi/mcp_model_providers.go`、`mcp_tools.json`）：`list_model_providers`（订阅 / API 端点 / 启动环境 / 设备上发现，含设备、状态、默认值、检查；分页 ≤50，首页带本人设备）、`save_model_provider`（建 / 改 API 端点：地址按 runtime 纠正、`apiKey` / `clearApiKey`、默认模型与 effort、`deviceIds` 为完整生效设备集，新建默认不分配）、`delete_model_provider`、`check_model_provider`（API 端点、启动环境走设备官方 SDK 一回合；订阅读登录状态；发现的端点返回其自动检查结果）、`set_model_defaults`（订阅、启动环境在某设备上的默认模型与 effort）、`sign_in_subscription`（start / status / code / cancel，设备 CLI 登录，只回传链接与码）。登出、提升、移除启动环境仍只在页面上做。
- **谁能用**：`providerManagerFor`——本人登录的账号，或本人自己的对话与助理（会话有创建者、不在 Issue 里、角色不是 Issue 执行 / 澄清、不是 verifier、不是命名等工具会话）。另一个成员的会话以那个成员身份行事，只能看到 / 改自己的。`mcpToolAllowed` 让 Issue 角色与 verifier 的工具列表里根本没有这 6 个。设备凭据（`foundry` CLI 在设备 shell 里用设备凭据时）不能管理。
- **API 端点的检查**（新）：`POST /api/profiles/{id}/check {deviceId}`（连接所有者 + 设备所有者）与 MCP 共用 `checkServerProfile`；Server 把定义与解封的密钥像 `run_session` 一样发给设备（`check_agent_profile`，Worker 声明 `profile_check` 才发，否则提示更新 Worker），Worker 用 `profileConfigFromDefinition` + `withDispatchCredential` 跑 `provider-check.ts` 的同一回合，不写本机检查记录。结果存表 `profile_checks`（端点 × 设备，只在仍分配时列出；保存、删除、清密钥、取消分配即清除；设备移除时一并清理），投影到服务器行的 `check`。Web：端点编辑器每个已分配设备显示检查状态并提供“验证”（先确认会消耗额度），卡片上显示“已在 N 台设备上验证 / N 台验证失败”。
- **密钥**：只经 `apiKey` 进入，封存在页面使用的同一处，回答只有 `keySet`。Worker 新增按字段名的结构化脱敏 `redactTranscriptValue`，用于工具步骤详情、事件 `metadata`、整条消息（含审批卡问题）、Foundry 的 SDK 日志（`redactedJSONLine`）、原生对话摘要；文本规则补上转义 JSON、`apiKey: value`、`--api-key value`；`--api-key-file` 不受影响。`foundry provider create/update` 只接受 `--api-key-file`，不接受命令行上的密钥。
- **Foundry skill revision 27**：SKILL.md 一条指引 + `references/model-providers.md`（密钥只放 `apiKey`、检查耗额度先说明、登录只转交链接、不直接请求端点）。文档：`model-providers-design.md` “经 Agent 管理”，`models-and-accounts.md`。

## 部署 / 版本

2026-11-09 06:39 CST 经 PR #232 squash 合入 main（`f06cdf1d`），CI 四项通过（第一次 CI 中 `server-profile-check` 因 runner 没有 `~/.claude` 失败，测试改用自己的 HOME 后通过）。合入后 dev 主仓库快进到 `f06cdf1d`（之前应用的 DEV-150/151 未提交改动存为 stash，内容均已在 main 中）；运行中的 Server、Web、Worker 与合入内容只差测试、文档和一处常量位置，未重新部署。

2026-11-09 05:28–05:30 CST 在 `/tmp/fdy-deploy.lock` 下把分支对 `origin/main` `08add543` 的 diff 以 `git apply --3way` 应用到 dev 主仓库（diff 存于 `~/.foundry/server/releases/dev150/dev150.diff`），同时在主仓库的还有 DEV-150（助理编排）的改动。

- Server：主仓库 `go build`，binary sha256 `4d2cf4aabe1884f8…`；旧 binary 留作 `releases/dev023-candidate/foundry-server.pre-dev150`；重启前在线备份 `backups/foundry-20261109-0529-pre-dev150.db`（integrity ok，删去最旧的 `…0926-pre-dev146b.db`，保留 3 份）；`pm2 restart foundry-server`（未用 `--update-env`），healthz ok，启动时建了 `profile_checks` 表；6 台在线设备重新连上。
- Web：`dda5d4d6bc962b5a`（上一版 `9bdc17f82ea8ab38`，入口保存在 `releases/dev150/previous-20261108T212952Z/`），经 `scripts/deploy-web-dev.sh` 发布，入口资源逐字节一致、同源 API 返回 JSON。
- Worker：`0.5.7-dev.321.g08add543.local.1794173489`（上一版 `release.json` 在 `worker-packages-rollback/before-dev151/`）；sg-chaos 用独立 systemd 单元 `foundry-worker update`，byte-dev、byte-dev-sg、cottoncpp、limen-canada 经 compute 租约以 `systemd-run --user` 后台更新，CanWendeMac-mini 经租约前台运行 `foundry-worker update`（第一次后台运行在释放租约时被结束，第二次完成）。7 台在线设备都重新连上并声明 `profile_check`；旧执行宿主按排空规则在运行中的回合结束后切换。macbook 离线，未更新。

## 检查

- Go：`mcp_model_providers_test.go` 6 个测试——一条对话完成建（带密钥、地址纠正）→ 分配设备 + 默认模型 / effort → 检查（断言发给设备的是定义和解封的密钥、投影行带 `check`）→ 改地址清检查 → 清密钥 → 删除；bob 的会话对 alice 的端点与设备全部 “not found”、列表看不到；verifier、命名会话、无创建者会话被拒；Issue 角色与 verifier 不给工具；未分配 / 旧 Worker 的检查被拒（HTTP 路由同样）；`set_model_defaults` 发给设备的 upsert 与页面一致；`sign_in_subscription` 转交 begin 与链接 / 码。每次调用都断言回答里没有密钥。`go test ./internal/...` 其余包通过；`TestAgentProfileCredentialGating` 发现并修正了一次检查顺序回归。
- Worker：`server-profile-check.test.mjs`（假 Claude Code 收到 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 与模型，结果不写本机、回复不含密钥；失败返回 Agent 原话）、`foundry-cli.test.mjs`（6 个命令，`--api-key-file` 读文件）、`daemon-dispatch`、`foundry-skill`（skill 与 Server 内置副本逐字节一致、只提到存在的工具）、`transcript-redaction` / `secret-redaction`（各记录路径）。
- Web：typecheck、`audit:ui` 15 项、`profiles-feature` 等 6 个测试文件。
- `scripts/check-changed.sh`（52 个文件）：gofmt、protocol 构建、Web tsc 与 6 个测试文件、Worker 构建、sqlitestore / store 的 Go 测试、`audit:ui`、`audit:modules` 通过；第一次未过的四项均已修正后单独复跑通过——prettier（两个测试文件）、protocol 的 daemon 词汇对齐（新消息常量移到 `daemon_wire.go`）、Worker `foundry-cli`（skill 文件清单加上新参考文件）、httpapi 的两个按角色列工具的测试（verifier 与 Issue 执行本来就不该有这 6 个工具，测试的期望补上）。

## E2E（dev，合成数据）

合成端点：本机 `127.0.0.1:18640` 上的假 Anthropic 兼容服务（`~/.foundry/dev-mcpprov/mock-anthropic.mjs`，只在 bearer 与合成密钥一致时回 “OK”，不接任何真实模型），合成密钥只存在仓库外 `~/.foundry/dev-mcpprov/key`。

1. **真实 Claude 会话（本人账号）**：`sess_1794173638952644688`（Claude，hell-tw，sg-chaos，标题 “DEV-151 E2E…”），逐步：建 “DEV-151 synthetic mock”（`keySet: true`、无设备）→ 只分配给 sg-chaos、默认 `synthetic-opus` / high → `check_model_provider` passed（假服务日志 21:40:31Z 两次 `POST /v1/messages?beta=true auth=match`，即 sg-chaos 的 Claude Code 带着密钥调用）→ 改名、改模型（检查随之清除、密钥保留）→ 删除，列表中消失。会话事件里工具参数显示为 `"apiKey": "[REDACTED]"`；全部 109 个事件中只有本人（这里是父会话）发出的消息原文含密钥。
2. **页面每一步（e2e-alice，真实 Chromium）**：e2e-alice 的设备没有 Claude 登录，同样的五步由她在合成工作区 `ws_68dbe9ca-…` 的 Codex 会话 `sess_1794173701449558394` 经 MCP 完成，每步后用 headless Chromium 登录 dev 截图 Model providers › API 端点（仓库外 `~/.foundry/dev-mcpprov/shots/`）：01 新增后卡片 “已配置 · 未分配”；02 “synthetic-opus · 已配置 · 1 台设备”；03 MCP 检查后卡片 “已在 1 台设备上验证”、编辑器设备行 “已验证 · 05:36”；04 在页面上点 “验证” → “运行一次简短对话？会消耗额度” → 再点，设备行 “已验证 · 05:38”；05 改名改模型后 “尚未在这台设备上验证”；06 删除后 “已保存 0 个”。该会话的 Foundry 事件与 `codex-sdk.events.jsonl` 不含密钥（新 Worker 构建）；Codex 自己的 rollout 文件含原始工具参数（属于 Codex，不改）。

## 限制

- **本人自己的消息**：人在对话里贴出的密钥作为该消息原文保存在 Server（会话输入与 “User message” 事件），读得到这个会话的人都能看到；Foundry 不能在 Agent 收到之前改写它。建议只在助理或私有工作区的对话里给密钥。
- Claude Code / Codex 自己在设备上的原生记录（JSONL、rollout）保存工具调用原文，Foundry 不改写这些文件；短于 16 字符、出现在普通句子里的密钥文本规则不会识别。
- 飞书群里的话题会话以绑定人身份运行，群里其他人的消息也能驱动它；这与现有其他写工具相同，本次未单独区分群聊。
- 删除没有走“先问本人”的卡片流程（`archive_workspace` 那种）；skill 要求 Agent 删除前先确认。
- e2e-alice 部分用 Codex（她的设备没有 Claude 登录），Claude 部分在本人账号下完成；本人账号下没有做浏览器截图（没有本人的登录）。
- macbook 离线，仍是旧 Worker；在它上面检查 API 端点会提示“更新 Worker”。

## 验收

1. 在助理对话里说：“帮我加一个 Anthropic 兼容的模型服务，地址 …，密钥 …，只给 <设备> 用，默认模型 …”。预期：助理调用 `save_model_provider`，回答里不出现密钥；Model providers › API 端点出现该卡片，“1 台设备”，默认模型正确。
2. 说“验证一下”。预期：助理先说明会消耗少量额度，再调用 `check_model_provider`；编辑器里该设备行显示“已验证 · 时间”，卡片显示“已在 1 台设备上验证”。在页面上点“验证”应得到同样结果。
3. 说“改名为 …、默认模型换成 …”。预期：卡片更新，检查清除为“尚未在这台设备上验证”，密钥仍为“已加密保存”。
4. 说“删掉它”。预期：助理先确认，删除后卡片消失。
5. 在一个 Issue 的执行会话里，工具列表没有这 6 个工具；另一个成员的会话看不到你的端点。
