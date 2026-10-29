# DEV-092 Cloudflare：按工作区授予 DNS 编辑

状态：已部署 dev（Server 2026-10-30 01:40:18、Web `a47d655fe9f8385a` 01:42:46，北京时间）；Agent 自验完成（Go 单测、合成栈真实 Chromium 键盘流程 light/dark × 1280/390、上线后只读核验）；待人工验收；未提交。负责会话 `sess_1793289872322286135`，编排 `sess_1793063405185071529`。

| 环节           | 状态   | 说明                                                                                           |
| -------------- | ------ | ---------------------------------------------------------------------------------------------- |
| 问题理解/调研  | 已完成 | 见下方“问题”                                                                                   |
| 代码           | 已完成 | Server 网关写入级别、访问级别接口、活动日志；Web 会话权限单选与活动列表；工具说明              |
| dev Server/Web | 已完成 | Server sha256 `6120e1c9…`（随 DEV-085/090/091 一次交接）；Web `a47d655fe9f8385a`（含 DEV-091） |
| Worker 更新    | 不涉及 | 只改 MCP 工具（服务端）；`cf` CLI 经 Worker 转发器仍只读，见“限制”                             |
| Agent 自验     | 已完成 | 见“验证”                                                                                       |
| 人工验收       | 待验证 | 见“人工验收步骤”                                                                               |

## 问题

本人有意给 Cloudflare 授权了全部权限。Mac 上的会话 `sess_1793277998160628174` 需要在本人的 zone 里加一条指向局域网 IP 的 A 记录，以及证书续期用的 ACME DNS-01 TXT 记录，但 Foundry 的 `cloudflare` 工具按设计只读：网关只放行若干 GET 路径，说明里写着 “No DNS writes”。本人问怎样授权写入。

## 设计

- **级别属于工作区绑定**：`external_account_bindings` 新增 `access` 列（空 = 默认只读）。级别由账号所有者在 Connectors → Cloudflare 的“工作区访问”里选择：只读（默认），或只读 + DNS 编辑。级别表放在 `externalaccounts.CloudflareAccessLevels`（名称 + 所需 scope），随 provider 描述（`accessLevels`）下发给 Web；每个级别允许的方法与路径放在网关 `connectors.cloudflareWriteRules`。以后加级别只需各加一项。
- **DNS 编辑允许**：`POST /zones/<绑定 zone>/dns_records`，以及 `PATCH`/`PUT`/`DELETE /zones/<绑定 zone>/dns_records/<记录 id>`。其他写入一律拒绝；被拒绝时的说明写明需要哪个级别、由谁在哪里设置。若 grant 已不含 `dns.write`（比如重新授权时没勾选），说明会让所有者重新授权。
- **凭据与来源不变**：仍经官方 MCP 的 `execute`，代码由服务端用结构化的 method/path/body 生成。body 先解码成普通 JSON 对象再编码，不能夹带代码，大小上限 16 KiB。token 不离开服务器。
- **每次写入都记活动日志**（`external_account_events`，kind `cloudflare_write`，detail 为 JSON）：工作区、会话、方法、路径（id 记作 `:id`）、zone 与记录 id、记录名称/类型/内容、结果（succeeded / failed / refused）和 Cloudflare 的错误码与消息。DELETE 先读一次被删记录，日志写明删掉的是什么。切换级别记 `access_changed`。账号卡片的“活动”折叠区列出最近 50 条，会话标题可点开对应对话。不做逐次确认：所有者选择级别即为同意。
- **Cloudflare 的错误原样回给会话**：调用失败时只取 `errors[].code/message`（最多 3 条，各截 200 字），不含响应体、URL、头或凭据。
- **scope 不足时不可选**：grant 不含所需 scope 时，单选项禁用，并说明需要哪项权限、用身份上的“重新授权”并在 Cloudflare 页面允许 DNS 写入。服务端同样拒绝（409）。Foundry 默认申请的 scope 仍是只读那一组，不扩大。
- **工具说明**（`mcp_tools.json` 的 `cloudflare`）改成能力描述：两个级别各允许什么、由本人在 Connectors → Cloudflare 按工作区授予、每次修改都会记入日志、被拒时会说明缺哪个级别。新增 `method` 与 `body` 参数；annotations 改为 `readOnlyHint: false`、`destructiveHint: true`（验证会话本来就拿不到 Cloudflare，行为不变）。
- **与 DEV-091 的分工**：账号卡片、权限摘要和 OAuth 状态归 DEV-091；本项负责网关、绑定级别、活动日志，以及卡片里的一行 `<CloudflareActivity>` 和 `cloudflare.foundryUses` 文案（DEV-091 交接）。DEV-091 那条“超出所需”的提示已改为中性说明。

接口：`PUT /api/workspaces/{id}/external-accounts/{accountId}/access`（工作区 maintainer，且必须是账号所有者，并且绑定由本人建立）；`GET /api/connectors/cloudflare/accounts/{accountId}/activity`（账号所有者）。

## 验证

- Go：`connectors`（级别拒绝及其说明、DNS 编辑的增改删、未绑定 zone、整个集合 DELETE、对记录 POST、batch、purge_cache、settings、zone DELETE、`..`、缺 body、非对象 body、多值 body、带 body 的 DELETE、OPTIONS，都在发往 Cloudflare 之前被拒绝；scope 被收回；Cloudflare 报错的透传；解绑立即失效；重存 zone 不丢级别；他人不能设置级别；每次尝试都有日志、不含 token），`externalaccounts`，`sqlitestore`，以及 `httpapi -run Cloudflare`（级别接口的 404/409/400、他人 404、MCP 工具从拒绝到允许、`accounts` 显示级别、活动接口的顺序/工作区/会话标题、不含 token）。全部通过，`go vet` 无输出。
- 补丁在 DEV-090 的合并树副本（d4537b1 + DEV-085/090/091）上 `git apply` 后，与本工作树文件逐字节一致，并在其上重新跑了 build/vet/测试，结果见流水。
- 真实浏览器（Chromium headless；`TestCloudflareAccessBrowserFixture`（`httpapi/cloudflare_connectors_access_browser_test.go`）合成栈：临时库、合成用户与 Cloudflare 身份，假的官方 MCP 在内存里保存 DNS 记录，不连 Cloudflare；会话用自己的 session token 调 `/api/mcp`，与 Agent 的 MCP 客户端相同）：
  1. 授权前，会话的 POST 被拒绝，说明含 `dns_edit` 和 “Connectors → Cloudflare”。
  2. 用键盘选工作区；会话权限默认“只读”；在单选组里按 ↓ 选中“只读 + DNS 编辑”，立即保存并提示，焦点留在单选上（第一次跑时保存期间单选被禁用导致焦点丢失，已修复）。
  3. 会话新增一条 A 记录，再删除它；用键盘展开“活动”并刷新，依次显示 DELETE（已完成）、POST（已完成）、权限切换、此前被拒的 POST（含原因），每条带时间、工作区、会话标题链接。
  4. 按 ↑ 切回“只读”后，会话再次写入被拒绝。
  5. light/dark × 1280/390 截图；390 下无横向溢出；无控制台错误。
  6. 不含 `dns.write` 的授权：“只读 + DNS 编辑”不可选，并说明如何重新授权。
- 截图：`.foundry/attachments/20261029/dev092/`。

## 部署

- Server：DEV-090 会话（`sess_1793286475110448503`）用 d4537b1 + DEV-085/090/091/092 四个补丁一次构建，2026-10-30 01:40:18（北京时间）SIGHUP 交接。新二进制 sha256 `6120e1c99759258c…`，回滚副本 `releases/dev023-candidate/foundry-server.pre-dev085-092`（`2181e7f3…`）。本项补丁：v1 `/tmp/dev092/dev092-server.patch`（`ea205e1e…`）+ 增量 `/tmp/dev092/dev092-server-v2-incremental.patch`（`fdd85229…`，gofmt、活动 DTO 移到 `store.CloudflareActivityEntry`、夹具开关；行为不变）；完整 v2 为 `dev092-server-v2.patch`（`a00767e1…`）。DEV-090 在 v1 上跑完整 Go 测试，在 v2 上跑 build/vet/gofmt 与相关包测试后交接；`/healthz` 200，7 台设备 10 s 内重连。
- Web：`a47d655fe9f8385a` = DEV-091 候选树（d4537b1 + DEV-089 文件 + DEV-091 Web，DEV-091 已确认基线可复现线上 `51a0c49cac0b97f3`）+ 本项 Web 补丁 `/tmp/dev092/dev092-web.patch`（`052c393c…`，只含 Cloudflare 部分，另一会话的 `holding`/`setupSteps` 文案已排除）。2026-10-30 01:42:46 用 `scripts/deploy-web-dev.sh` 发布，上一版 `51a0c49cac0b97f3` 保存在 `~/.foundry/server/releases/dev092-web/previous-20261029T174242Z`。DEV-091 不再单独发布。
- 发布后核验（e2e-alice，独立临时浏览器 profile，验后删除；未触碰本人账号与 zone）：`version.json` 为 `a47d655fe9f8385a`；Connectors → Cloudflare 显示新文案；provider 下发 `accessLevels` = read / dns_edit（需 `dns.write`）；`GET …/accounts/<不存在>/activity` 与 `PUT /api/workspaces/<id>/external-accounts/<不存在>/access` 均返回各自的 “external account not found”（对照的未知路径为 405），说明路由已在线。
- 发布前在同一构建上复跑了 DEV-091 的卡片检查（`card-e2e.mjs`，合成栈 208 项权限）：light/dark × 1280/390 均为 “Asked for 5 · Granted 208 (103 write)”，默认收起，Enter 展开，展开/悬停不移动内容，无横向溢出。

## 限制

- 只有 MCP 工具能写入。会话里的 `cf` CLI 经 Worker 的本地转发器访问网关，转发器和网关路由仍只放行 GET；要让 CLI 也能写，需要另行更新 Worker。
- 活动列表从账号最近 1000 条事件中取最近 50 条写入和级别变更。读取很频繁时，较早的写入可能不在列表里，但仍在数据库中。
- 只验证了合成的 Cloudflare 上游。`cloudflare.request` 接受 `body` 是依据官方 MCP 的 README 示例；真实写入要等编排同意后在本人的 zone 上做。
- 级别对所有者在该工作区的绑定生效，与会话从哪台设备运行无关（仍要求是所有者本人在自己设备上的会话）。
- 写入只在会话里可用。Mac 会话原计划把证书续期做成每 60 天运行的后台任务，那不在会话里，用不到本工具。可以每次续期起一个会话（如定时工作），或在设备上另配一个只限该 zone 的 DNS 令牌。
- 为满足 `audit:modules`（只有 `cloudflare_connectors*.go` 等连接器 HTTP 文件可引用 `externalaccounts`），部署后把 `httpapi/cloudflare_access*.go` 改名为 `cloudflare_connectors_access*.go`，内容不变，二进制不受影响。

## 人工验收步骤

1. dev → Connectors → Cloudflare：在“工作区”里选会话所在的工作区，确认它已保存 zone。
2. 在“会话权限”里选“只读 + DNS 编辑”。预期：立即提示“会话权限已设为只读 + DNS 编辑”。如果此项不可选，说明授权里没有 `dns.write`：点身份上的“重新授权”，在 Cloudflare 页面勾选 DNS 写入。
3. 对该工作区的会话（如 Mac 上的 `sess_1793277998160628174`）说：“工作区现在有 Cloudflare DNS 编辑权限。先用 `cloudflare` 工具 action `accounts` 确认 access 为 dns_edit，再用 action `request`、method `POST`、path `/zones/<zone id>/dns_records` 添加所需的 A 记录和 `_acme-challenge` TXT 记录。”预期：记录创建成功。
4. 回到 Connectors → Cloudflare，展开身份下的“活动”并点“刷新活动”。预期：能看到这些写入、所在工作区、会话标题和结果。
5. 切回“只读”，让会话再试一次写入。预期：被拒绝，说明需要 DNS 编辑级别以及在哪里设置。

## 流水

- 2026-10-30 00:30–01:30 前后（北京时间）：实现、测试、合成栈浏览器自验；与 DEV-091 约定文件分工；Server 补丁交 DEV-090，Web 补丁基于 DEV-091 候选，约定只发布一次 Web。
- 01:20 前后：`check-changed` 发现协议 DTO 对照缺 Go 结构、测试文件未 gofmt、文档未 prettier，已修；增量补丁交 DEV-090 一并上线。
- 01:40:18 Server 交接；01:42:46 Web 发布；01:45 上线后只读核验通过。之后为 `audit:modules` 改名三个 httpapi 文件（不影响已部署二进制）。
