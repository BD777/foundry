# DEV-126 Cloudflare：连接器只管凭据面，`cf` 与 curl 是唯一入口

状态：已部署 dev（Server `05b33acf2a4968c2`、Web `ea8038c615236943`、Worker `…1793871893`，2026-11-05 17:44–18:00 UTC+8）；Agent 自验完成；待人工验收；未提交。负责会话 `foundry-64`（编排会话 `sess_1793855865906282308` 下发，在本人“修复偏离、原则认可”的授权范围内）。

| 环节           | 状态   | 说明                                                                                                                                                |
| -------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 问题理解/调研  | 已完成 | 见“问题”“调查”                                                                                                                                      |
| 代码           | 已完成 | Server 网关、判定、拒绝格式；Worker 转发器；删除 MCP 工具与 CLI 命令                                                                                |
| dev Server/Web | 已完成 | Server `05b33acf2a4968c2`；Web `ea8038c615236943`（Cloudflare 文案）                                                                                |
| Worker 更新    | 已完成 | `0.5.7-dev.269.g97415a6e.local.1793871893`，7 台设备守护进程已更新并上报 `cloudflare_gateway_v2`；byte-dev、sg-chaos 的执行宿主仍在旧版（见“部署”） |
| Agent 自验     | 已完成 | 真实 `cf` 0.14.0 合同测试、Go、Worker 测试                                                                                                          |
| 人工验收       | 待验证 | 见“人工验收步骤”                                                                                                                                    |

## 原则（本人已认可）

- 连接器只管凭据面：身份、刷新、工作区授权、逐请求判定、审计。工具面用厂商自己的 CLI（官方 `cf`）原样使用，Foundry 只在网络上替换替身凭据。
- Foundry 自己的 MCP 工具只做 Agent 原生做不到的事；不重新包装厂商 API，不重复官方 skills / MCP。
- 只有 Server 做决定，Worker 只传话。

## 问题

[研究稿](../research/connector-architecture-20261030.md) 第 2、3 节所述现状在 main 上仍成立：

- Worker 转发器 `cloudflare.ts` 写死 `methods: ["GET"]`，`cf` 的 POST 在设备上就被拒（“This connector is read-only.”），不到 Server，也不进活动日志。
- Server 只注册 `GET …/gateway/{path...}`，`handleCloudflareGateway` 只走 `ReadHandle`；写入只有 MCP `cloudflare` 工具能做（`mcpCloudflare` → `RequestSession`）。两个入口、两套判定，2026-10-30 已因此出过事故（会话 `sess_1793277998160628174` 走了入口 B）。
- `/zones` 只接受 `page`/`per_page`，`cf zones list --name` 被拒；`RequestSession` 的 GET 丢弃 query。

## 调查：MCP `cloudflare` 工具提供什么、`cf` 经网关拿不到什么

- 上游：工具与网关是**同一条**——Server 用账号的 OAuth token 调 `https://mcp.cloudflare.com/mcp` 的 `execute` 工具，代码是 `cloudflare.request({method,path,query,body})`（OAuth 受众是官方 MCP 资源，`externalaccounts/cloudflare.go` `APIRequest`）。工具描述里的 “through the official Cloudflare MCP” 指的就是这条，不存在第二条上游。
- `accounts` 动作（身份名、zone ID、权限、级别）：zone 列表 `cf zones list` 经网关可得；级别与权限不足由写入被拒时的结构化 `foundry` 字段（`reason`、`needed`、`current`、`where`）覆盖。
- 多身份怎么选：存储层已强制**一个工作区至多绑定一个 Cloudflare 身份**（`sqlitestore/external_accounts.go` 的 “select one Cloudflare identity per workspace”，#141 起）。Worker 里 `candidates.length !== 1` 只会遇到 0 或 1 个；多身份场景在现有数据模型下进不来，所以没有 `cf` 做不到的部分。（调查中我一度误判为缺口并向编排会话报告了错误证据，写测试撞到该约束后已更正，编排会话确认。）
- 结论：工具整体删除，不保留缩小版。

**决定（本次，编排会话在授权范围内作出，本人可调整）**：不做“按请求里的 zone/account 解析身份”的多身份语义（它没有数据能触发）。**将来若放开“一个工作区多个 Cloudflare 身份”**，要在判定的第一步做：路径里的 zone id 在各身份已绑定的 zone 里查找，`/zones` 合并列出；解析不到、或同一 zone 对应多个身份时一律拒绝，拒绝里列出候选身份和处理位置，不猜；Worker 只发一个替身、`SessionMaterials` 只下发一份。已写进 `docs/connectors.md`。

## 修复

Server（`apps/server/internal/connectors`、`httpapi`）：

- 路由 `GET|POST|PATCH|PUT|DELETE /api/connectors/cloudflare/gateway/{path...}`，同一个 `handleCloudflareGateway`，经 `RequestHandle` → `RequestSession(method, path, query, body)`。读写一个判定点；`RequestSession` 补上 GET 的 query。级别改动对同一会话的下一次请求立即生效。body 上限 16 KiB，写入不带 query。
- 拒绝返回 HTTP 403 与 Cloudflare 形状 `{success:false, errors:[{code,message}], messages:[], result:null}`，另带 `foundry:{refused, reason, needed?, current?, where?}`。`reason`：`no_grant`、`zone_not_bound`、`access_level`、`scope_missing`、`path_not_allowed`、`query_not_allowed`、`bad_request`。原先许多拒绝只有一句 “no current Cloudflare grant”，现在都说明原因。
- Cloudflare 自己的错误原样传回：`errors` 的 code/message 不改，HTTP 状态取工具文本里的上游状态（`Cloudflare API error 404: …`），拿不到则 502；上游答复 `success:false` 的写入以 400 返回、正文不变。
- `/zones`：支持 `name`（域名全等，或 Cloudflare 的 `contains:`、`starts_with:`、`ends_with:`、`not_equal:`、`equal:` 及 `_case_sensitive`）和 `account.id`，只在已绑定的 zone 内匹配；仍逐个按 id 读取，不请求上游账号级列表。
- `cf --zone <域名>`：cf 需要账号 ID，非交互下没有 `CLOUDFLARE_ACCOUNT_ID` 就读 `/accounts`、`/memberships`（网关不转发，也不代答）。所以会话启动时 Server 在材料里带 `providerAccountId`（契约新增字段；取自绑定 zone 的 `account.id`，不是秘密，只在所有绑定 zone 同属一个 account 时才设；按 zone 记在内存），Worker 设为 `CLOUDFLARE_ACCOUNT_ID`，cf 用自己的方式 `GET /zones?account.id=` 再按域名匹配。跨 account 时不设，skill 与 docs 写明要先 `cf zones list --name` 查 ID。
- 删除 MCP `cloudflare` 工具（`mcp_tools.json`、`mcp.go`、`mcpCloudflare`、`cloudflareToolAvailable`）和 Worker 的 `foundry cloudflare accounts|read` 命令及测试。

Worker（`packages/worker`）：

- 转发器只做传输：校验和续期替身、附加设备凭证、拒绝 upgrade；删除 `methods` 白名单（共享转发器的 `methods` 选项一并删除，没有其他使用者）。`candidates.length !== 1` 改为 `=== 0`。
- 声明 `cloudflare_gateway_v2`（`availableDaemonCapabilities`）。**旧 Worker（v1）的行为**：转发器只放行 GET，读照常；写在设备本地返回 403 “This connector is read-only.”，不到 Server，也不进活动日志；MCP 工具已删，所以旧 Worker 的设备上写入不可用，需要更新 Worker。Foundry skill 告诉 Agent 认出这条提示并请本人更新。Server 不读取这条能力（它只是设备上报的事实，用于核对部署）。

文档：`foundry` skill 的 `references/device-and-accounts.md`（两份逐字节一致）、`docs/connectors.md`、`docs/security.md`（新增 Cloudflare Gateway 一节）、Web 的 Cloudflare 说明文案（中英文）。

## 验证

- **真实 `cf` 0.14.0 合同测试**（`httpapi/cloudflare_cli_contract_test.go`；`cf` 与真实 Worker 转发器、真实网关，对假的官方 MCP；cf 的 HOME 在临时目录、代理指向死端口）：
  - `cf zones list` 只列已绑定 zone；`--name` 在已绑定 zone 内匹配，未绑定的域名匹配不到；
  - 给了 `CLOUDFLARE_ACCOUNT_ID`（Server 随会话材料下发）后，`cf dns records list --zone <域名>` 直接成功，不读 `/accounts`、`/memberships`（先前不设该变量时 cf 会读这两个路径并在非交互下失败，已用探针确认）；未绑定的域名找不到；
  - read 级别 `cf dns records create` 被拒，cf 输出里有 `dns_edit` 和当前级别 `read`，且没有请求到达假 Cloudflare；
  - 本人把级别改成 `dns_edit` 后，**同一个会话、同一个 cf 环境、不重启**，`create`（POST）、`edit`（PATCH）、`delete`（DELETE）成功，假 Cloudflare 收到的恰是这三个写入，且全程只见账号的真 token；
  - DNS 之外的写入（`cache purge`）被拒；不存在的记录的 DELETE 返回 Cloudflare 自己的 404、code 7003 与消息；
  - 账号活动按新到旧依次为：失败的 DELETE、被拒的 purge、DELETE、PATCH、POST（成功）、POST（因级别被拒），逐条记录；
  - 替身近到期（Worker 时钟拨到过期前 15 秒）后，下一次 `cf` 请求经真实 `session-handle` 端点续期并成功；会话结束后替身失效。
- Go：`connectors`（单点判定的读写拒绝原因、`/zones` 的 name 与 account.id 过滤、`providerAccountId` 只在同账号时给出、`account.id` 格式）、`httpapi`（经网关的 HTTP 级流程：403 的 Cloudflare 形状与 `foundry` 字段、级别在同一替身上即时生效、超 16 KiB 拒绝、未绑定后替身 403；MCP 工具目录不再含 `cloudflare`）、`externalaccounts`、`store` 全部通过；`httpapi` 整包唯一一次失败是我写的活动日志断言（PATCH 的记录名在该 fixture 里为空），已修正。
- Worker：转发器测试改为 POST/PATCH/PUT/DELETE 带 body 原样到达 Server 并带续期后的替身与设备凭证，错误替身仍 403；`CLOUDFLARE_ACCOUNT_ID` 只在 32 位小写十六进制时设置；`check-changed` 的 worker tests 37 个文件通过。
- `scripts/check-changed.sh`：prettier、gofmt、protocol build/tests、web tsc、worker build、worker tests、audit:ui、audit:contract、audit:openapi、audit:modules 全部通过；Go 全量在主工作区跑过一次（上面那一处失败已修，随后重跑 Cloudflare 相关测试通过）。`foundry-int` 里再跑：worker 6 个文件 44 项（43 通过，1 个按设计跳过）、Go `connectors`、`externalaccounts`、`store` 全包、`httpapi` 的 Cloudflare/MCP/Skill/Route/Wire/Contract 测试通过。

## 部署

2026-11-05（UTC+8），持 `/tmp/fdy-deploy.lock`，在 `foundry-int` 里：干净文件直接带入；`routes.go`、`mcp_tools.json` 只替换我的段落；契约在该树重新生成（只多出 `providerAccountId`，别人的生成物不变）。

- Server：`05b33acf2a4968c2`（原 `e55cc3ed3c3261e0`，回滚 `releases/dev023-candidate/foundry-server.pre-dev126`），17:44 SIGHUP，`restart handoff: new server pid 767019 took over; previous pid 668909 exited after 980ms`，`/healthz` 200。数据库无结构变化。
- Web：`ea8038c615236943`（原 `f0115c5668a68287`，回滚 `releases/dev126/previous-20261105T094600Z`），入口资源逐字节一致，API 回 JSON。
- Worker：打包 `0.5.7-dev.269.g97415a6e.local.1793871893`（原 `…1793871218`，`worker-packages/release.before-dev126.json`）。打包前核对：`foundry-int` 的 Worker 编译产物与线上包只差本次改的 4 个文件（别的会话刚发过 `…1793871218`，没有被回退）。经计算租约 `foundry-worker update`：limen-canada、byte-dev-sg、cottoncpp、CanWendeMac-mini、macbook（它的 Worker 在 `~/.foundry-stacks/dev`，用该目录的 `foundry-worker`）、byte-dev、sg-chaos。守护进程都换到新版，Server 的设备投影里 7 台全部上报 `cloudflare_gateway_v2`。**加载的执行宿主**：limen-canada、byte-dev-sg、cottoncpp、CanWendeMac-mini、macbook 已是新版；byte-dev（`…1793815663`）和 sg-chaos（`…1793867080`、`…226`）的旧执行宿主还被正在运行的回合占着，没有强停，会话结束后换到新版；在那之前这两台上新开的会话的转发器可能仍是 v1（只读）。没有设备的会话因此中断。
- 没有真实 Cloudflare 账号绑定在 dev，因此线上没有跑 `cf` 的端到端；这一项由本人验收（见下）。

## 人工验收步骤

前提：Connectors → Cloudflare 里账号已授权，工作区已绑定 zone，且执行宿主是新版（新开的会话）。

1. 在该工作区开新会话，让它运行 `cf zones list`、`cf zones list --name <你的域名>`、`cf dns records list --zone <你的域名>`。预期：只列出已绑定的 zone，按域名也能列 DNS 记录（zone 都在同一个 Cloudflare account 时）。
2. 工作区级别保持“只读”，让会话 `cf dns records create`。预期：被拒，输出里写明需要 `dns_edit`、当前 `read`，会话告诉你到 Connectors → 该工作区 → Cloudflare 改，不去找别的凭据；账号活动里有一条“被拒”。
3. 在页面把级别改成“只读 + DNS 编辑”，**不开新会话**，让它重试。预期：创建成功；再让它修改（edit）、删除（delete）这条记录，也成功；活动里每个写入一条。
4. 把级别改回“只读”，再让它写。预期：立即被拒。
5. 会话里 Foundry 的工具列表不再有 `cloudflare`，`foundry cloudflare …` 命令不存在。

## 检查

见“验证”；`check-changed.sh` 结果摘要：prettier、gofmt、protocol、web tsc、worker build、worker tests、各项 audit 全部 PASS。

## 限制

- 旧 Worker 上 `cf` 写入仍被设备拒绝，直到更新。
- `cf … --zone <域名>` 只在所有绑定 zone 同属一个 Cloudflare account 时可用；跨 account 时用 zone ID。
- 账号级路径（`/accounts/<id>/…`）不在允许清单里（以前也不在），没有按 account 解析身份的需求，因为一个工作区只有一个身份。
- 一个工作区只能绑定一个 Cloudflare 身份是存储层既有约束，本次依赖它。
- 真实 Cloudflare 账号的批准与真实资源核验仍待本人（见 DEV-035、DEV-092）；本次所有自验都用假 Cloudflare。

- 2026-11-06 03:20 UTC+8：已合入 main，PR #205（squash `3d073ffb`）；dev Server/Web 已切到 main（Web `d8c1b9352ad92570`），Worker `0.5.7-dev.298.g03b62a30` 已发布并更新到 7 台在线设备（byte-dev、sg-chaos 各有旧执行宿主承载运行中的回合，结束后换新）。
