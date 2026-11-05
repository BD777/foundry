# DEV-129 Server 持有型网关：一条顺序固定的流水线

状态：已部署 dev（Server `5ab3eb53212ea3ac`、Worker `0.5.7-dev.269.g97415a6e.local.1793878492`，2026-11-05 18:34–19:40 UTC+8）；Agent 自验完成；待人工验收；未提交。编排会话 `sess_1793855865906282308` 下发，方向经本人确认（[方案稿](../research/connector-unification-20261105.md) 第 1、3 节）。

| 环节           | 状态   | 说明                                                                                                   |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| 问题理解/调研  | 已完成 | 见“问题”                                                                                               |
| 代码           | 已完成 | `internal/gateway` 流水线；Cloudflare、飞书迁入；Worker 转发器中性命名                                 |
| dev Server/Web | 已完成 | Server `5ab3eb53212ea3ac`；Web 无改动，未重新部署                                                      |
| Worker 更新    | 已完成 | `…1793878492`，7 台设备守护进程已更新；sg-chaos 上正在跑回合的旧执行宿主未强停（改动是改名，无行为差） |
| Agent 自验     | 已完成 | 三份飞书测试文件零改动且通过，真实 feishu-cli 1.41.0 与 `cf` 0.14.0 合同测试通过，部署后真实只读调用   |
| 人工验收       | 待验证 | 见“人工验收步骤”                                                                                       |

## 问题

飞书（`feishugateway.Gateway.Serve`）和 Cloudflare（DEV-126 后的 `RequestHandle` → `RequestSession`）各有一套“认证、资格、判定、拒绝、传输、限流、审计”，顺序和细节各写各的。网关是安全边界，两套意味着一次改动要改两处，也没有机制保证新连接器不漏掉某一步。

## 方案

组合，不用继承。`apps/server/internal/gateway` 的 `Pipeline.Serve` 是唯一调用 `Upstream` 的地方，顺序固定：

1. 认证：替身哈希 + 设备凭证 → 会话授权；替身有效期；
2. 资格复查（`Pipeline.Live`）：会话仍在这台设备上进行、本人发起、同一 Workspace；账号 `Permitted` 且可用；
3. `Classify`（连接器）：资源与所需级别，或拒绝永不转发的请求；
4. 判定（共用）：资源是否持有 → 级别是否够（连接器声明有序级别）→ 级别要求的 scope 授权里是否还在；
5. 集成开关与令牌桶（共用）；
6. `Upstream`（连接器）：传输，流式；可在发出前拒绝；
7. `Refuse`（连接器）：任何一步的拒绝都用厂商的错误格式；审计（共用）对每个请求写一行，无论怎么结束。

必需接口 `Classify`、`Refuse`、`Upstream`；可选能力用类型断言：`Entitlements`（Cloudflare 的 zone 与级别）、`Entries`（请求怎么进入：飞书的替身在 body、表单、ticket 里；Cloudflare 的超大 body 在认证前拒绝）、`LocalEndpoints`（飞书代答的 tenant token、用户 token 刷新、事件入口与 socket）。

- 飞书 `Classify`：黑名单命中则拒绝，否则 `full`、不分资源；没有加级别。
- 传输各自实现；Worker 写 CLI 配置各自保留；不合并租约表和审计表，不做通用页面编辑器。
- 旧路由是别名：新增 `/api/connectors/feishu/gateway/*`，`/api/feishu-gw/*` 仍是同一个网关且仍是会话材料下发的路径；旧 Worker 能力（`feishu_gateway`、`cloudflare_gateway_v2`）不变；数据表不变。
- Worker 转发器 `startFeishuGatewayForwarder` 改名 `startGatewayForwarder`（`gateway-forwarder.ts`），行为不变；旧文件 `feishu-gateway-forwarder.ts` 保留为别名，因为 `external_accounts_cli_contract_test.go` 按这个路径和名字加载构建产物，而它的断言不能改。
- `audit:modules`：声明新包 `gateway`（依赖 `store`、`externalaccounts`），`connectors` 与 `feishugateway` 可依赖它。

## 迁移前后的测试证据

基线（迁移前，同一台机器）：`httpapi` 的 `Gateway|CLIContract|Cloudflare|ExternalAccount|Feishu` 27 项通过、3 项按设计跳过；`connectors`、`feishugateway` 通过。

**飞书断言一条未改：**`git diff HEAD` 对 `httpapi/external_accounts_cli_contract_test.go`、`httpapi/external_accounts_gateway_test.go`、`feishugateway/gateway_test.go` 输出为空（三个文件未出现在 `git status`），迁移后全部通过：`TestFeishuCLIContractThroughTheGateway`（真实 feishu-cli 1.41.0，经真实 Worker 转发器和网关，覆盖用户/Bot 调用、21 MiB 分片上传、Range 下载）、`TestFeishuGatewaySwapsHandlesForRealTokens`、`…StreamsUploadsAndRangedDownloads`、`…AccessEndsImmediately`、`…RefusesBlockedAndLocalOnlyCalls`、`…HonoursIntegrationsSwitchAndRateLimits`、`…DelegatesEventConnections`、`…AnswersUserRefreshWithStandIns`，以及 `feishugateway` 包测试。`TestFeishuCLIEventConsume…` 默认被跳过（它找 `dist/feishu-gateway-forwarder.js`，该路径在转发器搬进 `connectors/` 后一直不存在，迁移前就是跳过）；临时建一个指向 `connectors/` 的符号链接后跑，通过（真实 `feishu-cli event consume` 经网关的事件 socket），随后删除符号链接。

**Cloudflare：**真实 `cf` 0.14.0 合同测试 `TestCloudflareCLIContractThroughTheGateway` 通过，`httpapi` 的其余 Cloudflare 测试（含 `TestCloudflareAccessLevelAndActivityHTTP` 的活动日志逐条断言）全部通过。`connectors` 包的测试原先直接调用 `RequestHandle`/`RequestSession`（已不存在，因为那会是绕过流水线的第二个入口），改为经 `Serve` 发请求：新增 `cloudflare_call_test.go` 的 `callGateway` 把 HTTP 答复还原成测试原来断言的形状（`*CloudflareRefusal`、`ErrCloudflareHandleExpired`、数据）；`cloudflare_gateway_test.go` 只把 8 处 `gateway.RequestHandle(ctx, …)` 换成 `callGateway(gateway, …)`，`cloudflare_writes_test.go` 只把 `RequestSession(…)` 换成 `f.call(…)` 并在夹具里先签发替身；所有断言原样保留。
**新增**：`gateway/pipeline_test.go`：顺序与不可跳过（未认证、他设备、会话结束、换 Workspace、账号取消绑定或需重新授权等 12 种情形下连接器的 `Classify`/`Upstream` 都没被调用）、结束的会话销毁授权而仅换 Workspace 不销毁、替身过期、资源/级别/scope 的比较顺序、`Otherwise` 先查资源、Classify 的拒绝照样进审计、`Upstream` 发出前拒绝、限流与集成开关在 `Upstream` 前、`Live` 复查。

全量：`scripts/check-changed.sh --files …` 的 prettier、gofmt、worker build、worker tests（12 个文件）、go test（`connectors feishugateway gateway httpapi` 整包）、`audit:contract`、`audit:modules` 通过（结果见“检查”）。在 `foundry-int` 上重跑：`connectors`、`feishugateway`、`gateway`、`externalaccounts` 全包，`httpapi` 的 Gateway/CLIContract/Cloudflare/ExternalAccount/Feishu/Route/Policy/MCP/Skill 测试，worker 4 个相关文件（22 项，1 项按设计跳过）通过。

## 行为差异（有意的，都是更严或更一致）

- Cloudflare 网关新增按会话的限流，20 次/秒、突发 60；此前没有。这是新增的行为，编排会话（2026-11-05）确认保持这个数值。为什么这样定：限流是流水线的共用一步，沿用飞书按会话的现有默认，而不是另起一个数；`cf` 的正常命令是顺序的几次请求，远低于这个速率，它挡住的是失控循环；Cloudflare 自己的限额仍在其后。
- 集成开关关闭时，Cloudflare 请求在上游调用前被拒（503，Cloudflare 形状），此前由账号服务在上游调用处报错。
- 共用复查多了一条：授权的 Workspace 必须等于会话现在的 Workspace（此前只有 Cloudflare 查；飞书不查，但会话不会换 Workspace）。会话只是换了 Workspace 时授权不销毁；会话结束才销毁（飞书原有行为，现在 Cloudflare 也一样）。
- Cloudflare：授权的账号必须是 Workspace 绑定里的那个账号（一个 Workspace 至多一个 Cloudflare 身份，所以等价）。
- 被拒的 Cloudflare 写入在改动带 query、方法不支持时也进账号活动（此前这两种在认证之前被拒、不留记录）；超过 16 KiB 的 body 仍在认证之前被拒、不留记录（`TestCloudflareAccessLevelAndActivityHTTP` 断言这点）。

## 部署

2026-11-05（UTC+8），持 `/tmp/fdy-deploy.lock`，在 `foundry-int`：我的文件整份带入（经核对，`foundry-int` 里这些文件与主树的差别只有本项）；`routes.go` 手工合入 5 行；`index.ts` 只改一行注释。`foundry-int` 的 Worker 编译产物与线上包（`…1793874861`）逐文件比较，只差本项的 5 个文件（`cloudflare.js`、`feishu.js`、`feishu-gateway-forwarder.js`、`gateway-forwarder.js`、`index.js` 的注释）。

- Server：`5ab3eb53212ea3ac`（原 `6dd7a009daf5d1d2`，回滚 `releases/dev023-candidate/foundry-server.pre-dev129`），18:34 SIGHUP，`restart handoff: new server pid 903518 took over; previous pid 845318 exited after 662ms`，`/healthz` 200。数据库无结构变化。
- Web：无改动，未重新部署。
- Worker：`0.5.7-dev.269.g97415a6e.local.1793878492`（原 `…1793874861`，`release.before-dev129.json`）。7 台设备经计算租约 `foundry-worker update`（macbook 用 `~/.foundry-stacks/dev/bin/foundry-worker`，sg-chaos 用自己的租约、脱离会话启动），Server 的设备记录里 7 台全部上报新版和 `cloudflare_gateway_v2`。sg-chaos 上两个正在跑回合的旧执行宿主（`…1793867080`、`…226`）没有强停；本次 Worker 改动只是转发器改名，旧宿主上的行为一致。
- 磁盘：构建前后 9.7 GiB → 9.1 GiB 可用（91%），低于 10 GiB 的线但高于 5 GiB；没有删除别人的文件，只新增了约 0.6 GiB（构建缓存、发布包）。

部署后真实调用（本会话在 sg-chaos，它的飞书替身是部署前签发的，所以也验证了替身经重启的 Server 继续有效）：`feishu-cli api GET /open-apis/authen/v1/user_info --as user` 返回本人信息（HTTP 经网关转发）；`GET /open-apis/bot/v3/info --as bot` 返回应用 Bot；`POST /open-apis/auth/v3/app_ticket/resend --as bot` 被拒，飞书形状 `{code:99991672, msg:"Foundry gateway: … is not available to sessions (issues app credentials; …)"}`；请求表按顺序有 `forwarded`（user_info、bot/v3/info）、`local`（tenant_access_token/internal）、`blocked` 各一行，身份字段 `user`/`bot`/空 与调用一致。dev 上没有真实的 Cloudflare 账号，Cloudflare 只有假上游的自验（同 DEV-126）。

## 人工验收步骤

1. 在有飞书账号的工作区开新会话，让它 `feishu-cli api GET /open-apis/authen/v1/user_info --as user` 和 `--as bot` 调 `bot/v3/info`。预期：返回正常；Connectors → 飞书的网关记录（或 `GET /api/feishu-gateway/requests`）有对应行。
2. 让它调 `POST /open-apis/auth/v3/app_ticket/resend`。预期：被拒，信息说明原因；记录里 outcome 是 blocked。
3. 让它用 `feishu-cli event consume` 订阅事件（若已配置事件）。预期：照常收到。
4. Cloudflare（有真实账号时）：按 [DEV-126](DEV-126-cloudflare-gateway-only.md) 的验收步骤跑一遍，预期与之前一致；另外只读级别下 `dns records create` 的拒绝信息仍写明 `dns_edit` 与当前级别 `read`。

## 检查

`scripts/check-changed.sh --files <本项 31 个文件>`（2026-11-05，全部 PASS）：prettier 14 个文件、gofmt 17 个文件、worker build、worker tests 12 个文件、go test（`connectors feishugateway gateway httpapi` 整包，646 秒）、audit:contract、audit:modules。

## 测试缺口：被静默跳过的 Worker 构建依赖测试（编排会话要求，同日补做）

`feishu_events_cli_test.go` 按 `dist/feishu-gateway-forwarder.js` 找转发器，该文件早已搬到 `dist/connectors/`，所以这个测试一直在“Worker 未构建”的名义下被跳过，真实 `feishu-cli event consume` 经网关的事件 socket 没有任何自动覆盖。修复：

- 新增 `httpapi/worker_build_test.go` 的 `requireWorkerBuild(t, rel)`：按真实位置检查构建产物；缺失时，在 CI（`CI` 已设）和 `scripts/check-changed.sh`（现在导出 `FOUNDRY_REQUIRE_WORKER_BUILD=1`）里失败，其他环境才跳过。没有 feishu-cli / cf 二进制、没有 node 时仍然跳过，未改。
- 四个依赖构建产物的测试都改用它，并把构建检查放在二进制检查之前（否则没有 feishu-cli 的 CI 会先跳过、永远走不到构建检查）：`feishu_events_cli_test.go`（路径改为 `connectors/feishu-gateway-forwarder.js`）、`external_accounts_cli_contract_test.go`、`cloudflare_cli_contract_test.go`、`session_work_test.go`（`session-work/supervisor.js`）。**只改了加载与跳过的守卫，没有改任何断言。**
- 全仓库查过：Go 测试里 `Skip` 加路径存在性判断的写法就这四处加 `feishuevents/socket_cli_test.go`（只检查 feishu-cli 二进制，属于允许跳过的一类）；Worker 与 Web 测试里的 `skip` 只有 macOS `sandbox-exec`、外部登录程序是否存在两类，是环境判断，不是过期路径。
- 证据：缺失产物时，默认环境跳过、`FOUNDRY_REQUIRE_WORKER_BUILD=1` 和 `CI=true` 下失败（临时测试验证，已删除）；设了 `FOUNDRY_REQUIRE_WORKER_BUILD=1` 后 `TestFeishuCLIEventConsumeThroughTheServer`（真实 feishu-cli 1.41.0 经转发器、网关、事件 socket 收到事件）、`TestFeishuCLIContractThroughTheGateway`、`TestCloudflareCLIContractThroughTheGateway`、`TestSessionWorkResidentSupervisorActuallyWakesAnIdleSession` 全部真实运行并通过。Server 不因这次测试修复重新部署。

## 限制

- 只有两个 Server 持有型连接器，租约表（`feishu_gateway_grants`，Cloudflare 也用它）和审计表仍是各自的；等第三个连接器或统一审计页面时再合并。
- 飞书没有级别和资源；若要给飞书加级别，是另一个产品决定。
- 可选接口 `ListResources`（页面的资源选择器）未实现：Cloudflare 的 zone 发现仍走 `GET /api/connectors/cloudflare/accounts/{id}/zones`。
- Cloudflare 仍不是字节级透传（经官方 MCP `execute`），见方案稿 3.4。
- 真实 Cloudflare 账号的核验仍待本人。

## 后续

- 会话材料继续下发旧的飞书网关路径 `/api/feishu-gw`（新路径 `/api/connectors/feishu/gateway` 已可用，是同一个网关）。等旧 Worker 都淘汰后再切换材料里的路径，并删掉旧路由（编排会话 2026-11-05 决定）。

- 2026-11-06 03:20 UTC+8：已合入 main，PR #205（squash `3d073ffb`）；dev Server/Web 已切到 main（Web `d8c1b9352ad92570`），Worker `0.5.7-dev.298.g03b62a30` 已发布并更新到 7 台在线设备（byte-dev、sg-chaos 各有旧执行宿主承载运行中的回合，结束后换新）。
