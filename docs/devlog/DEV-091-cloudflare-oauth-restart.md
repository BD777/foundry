# DEV-091 Cloudflare 授权跨服务器重启不丢失；回调失败给出原因；账号卡片权限摘要

状态：已部署 dev（Server 2026-10-30 01:40:18 SIGHUP，sha256 `6120e1c9…`；Web 01:42:46，`a47d655fe9f8385a`，与 DEV-092 合并发布）；Agent 自验通过（Go 单测、真实 Chromium 跨站回调 + 模拟重启、临时栈卡片 light/dark × 1280/390、公网回调页复查）；真实 Cloudflare 往返待编排确认；待人工验收；未提交。负责会话 `sess_1793287454327716188`，编排 `sess_1793063405185071529`。

## 问题

本人在 dev 的 Connectors 页连接 Cloudflare，从 Cloudflare 返回后只看到 `{"error":"open Foundry from its own origin; browser provenance required"}`。

编排会话查到的时间线（北京时间 2026-10-29）：

| 时间     | 事件                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| 23:19:32 | `POST /api/connectors/cloudflare/sign-in` 202，开始一个授权码登录                                                |
| 23:20:53 | 今晚发布做了 Server SIGHUP 交接，新进程启动                                                                      |
| 之后     | 本人在 Cloudflare 完成授权，浏览器打开 `GET /api/connectors/cloudflare/oauth/callback`（nginx 有意不记这条路径） |
| 23:21:06 | 本人点关闭，`DELETE …/logins/{id}` 返回 404                                                                      |
| 23:21:20 | 本人重新开始                                                                                                     |

## 原因

- 待完成的授权码登录（state、PKCE verifier、redirect、issuer、目标账号）只在 `externalaccounts.Service.logins` 内存里。新进程没有这条记录。
- 跨站回调靠 `sameSiteOAuthCallbackAllowed` → `AuthorizationCodeCallbackAllowed` 这个窄例外通过浏览器来源检查；找不到登录时返回 false，`authenticateAccountRequest` 就回了通用的 JSON 403。
- 关闭对话框时同样找不到登录，于是 404。

## 修复

1. **授权跨进程保留**（`sqlitestore/external_code_logins.go`，`externalaccounts/authorization_code.go`）
   - 新表 `external_code_logins`，在 `setupExternalAccounts` 中 `CREATE TABLE IF NOT EXISTS` 创建，未改 `migrations.go`。表里存 id(=state)、owner、provider、请求 id、目标账号、app、redirect、issuer、授权 URL、阶段、请求的 scopes、结果、过期时间。
   - PKCE verifier 用服务器密钥封存在密钥库 `external-login:<id>`，不进表、不进日志；授权码从不存储。回调认领后、关闭时、失败或过期清理时删除封存的 verifier。
   - 单次使用跨进程成立：回调先在数据库里把结果从 `""` 原子地改成 `used`（`EndExternalCodeLogin`）才去换 token，交接期间新旧两个进程同时在线也只能换一次。
   - 过期时间不变（10 分钟），只绑定发起人。断开/撤销 Cloudflare 账号时，除了原有的内存 epoch，也把数据库里该人未完成的登录标为 `superseded`。
   - 新进程按 id 找不到内存记录时，从数据库读取；仍可完成的（`authorize` 阶段、未过期、verifier 和 app 都在）收进内存，之后流程与原来相同。准备阶段（还没拿到授权链接）就被重启打断的，标为失败，提示“重新开始”，不会一直等待。
   - 已结束的登录，新进程按数据库结果显示（完成并带账号、失败原因、已关闭、已取代）。结果先写库再更新内存，任何进程都不会把已结束的显示成“验证中”。另一进程刚认领、尚未写出结果的，90 秒内显示“验证中”，之后提示到 Connectors 查看。
2. **回调无法匹配时显示说明页**（`httpapi/cloudflare_connectors_callback_page.go`）
   - 回调的所有结果都用同一个 HTML 页面：标题、具体原因和“返回连接器”链接（`/connectors/cloudflare`），按 `Accept-Language` 显示中文或英文。原因包括：未知、已过期、已使用、已关闭、已被取代、属于另一个 Foundry 账号、issuer 不符、尚未就绪、未登录、浏览器未确认顶层返回、Cloudflare 拒绝、换取未确认。
   - 来源检查不变：只有回调路径（`GET /api/connectors/cloudflare/oauth/callback`）在被拒绝时把 JSON 换成这个页面，状态码仍是 403（未登录为 401），不运行 handler，不认领、不换取，只读查询原因。其他路由仍返回原来的 JSON（有测试覆盖）。页面无脚本、CSP `default-src 'none'`、`no-store`、`no-referrer`，不回显查询参数。
3. **关闭已不存在的登录**：`DELETE /api/connectors/cloudflare/logins/{id}` 对未知、已结束、他人或已被其他对话框接管的登录返回 `200 {"status":"gone"}`，不再 404；正常关闭仍是 204。
4. **账号卡片**（`features/external-accounts/cloudflare-account-card.tsx`、`cloudflare-scopes.ts`，编排追加的需求）
   - 第一行：邮箱，右侧是“重新授权”“断开授权”。第二行：“授权时身份已核实”和可复制的用户 ID（小号等宽字体，`CopyButton`）。
   - 摘要：“Asked for 5 · Granted 200 (100 write)”。不把 `offline_access` 算作权限，所以 Foundry 请求的 6 项显示为 5。请求的 scopes 来自 Cloudflare provider 的 `ScopePreset`，即 `PresetScopes`。
   - 完整列表收在“查看权限”里，默认收起（原生 `<details>`，有可见箭头和键盘焦点样式）。按产品分组（Access、Account、DNS、Zone、Workers…），每个资源显示 read/write 徽标；超过 30 项时出现筛选框（`TextInput tone="boxed"`），没有匹配时给出提示。不嵌套卡片，悬停和展开不移动上方内容。
   - 本人有意授予广泛权限，所以不显示警告，只用一行中性说明写出 Foundry 用到的内容。原先的版本提示过“超出所需”，按编排更正改成了这行说明。核对过 Foundry 自身的调用：身份读取（MCP `whoami`）、`cloudflare.request` 固定为 GET、网关只放行 zones/DNS/证书的 GET 路径，没有用到请求范围以外的权限。DEV-092 会加入按工作区的 DNS 写入，这句说明（`cloudflare.foundryUses`）从此由 DEV-092 维护。

## 文件

Server（补丁 `git diff d4537b1`，交给 DEV-090 合并构建）：`externalaccounts/{authorization_code,logins,accounts,cloudflare}.go`、`externalaccounts/code_login_restart_test.go`、`httpapi/{cloudflare_connectors,security,service_tunnel_site}.go`、`httpapi/cloudflare_connectors_callback_page.go`、`httpapi/cloudflare_callback_restart_test.go`、`sqlitestore/{external_accounts,external_code_logins}.go`、`store/external_accounts.go`。

Web：`api/connectors.ts`、`features/external-accounts/{cloudflare-connector.tsx,cloudflare-connector.css,cloudflare-account-card.tsx,cloudflare-scopes.ts}`、`i18n/locales/{en,zh-CN}/externalAccounts.ts`、`test/cloudflare-scopes.test.mjs`。

与 DEV-092（`sess_1793289872322286135`）的分工：网关、`CloudflareBinding`、写入级别、活动记录归 DEV-092；卡片骨架、scope 摘要、OAuth 状态与回调归本项。DEV-092 会在卡片中加一行 `<CloudflareActivity>`，也会修改共享文件。所以本项的 Server 和 Web 改动都单独保存为补丁，从干净的工作树构建。

## 验证

- Go（隔离工作树：`d4537b1` + 本项 Server 补丁）：`go vet` 本项涉及的包；`go test ./internal/externalaccounts ./internal/connectors`；`./internal/httpapi -run 'Cloudflare|ExternalAccount|SameSite|Provenance|Auth'`，全部通过。共享树里 `sqlitestore` 全量通过；`httpapi` 全量中本项测试通过，唯一的失败 `TestSessionObserversReactInOrderAfterViewers` 属于 DEV-090 的观察者列表，已告知。
  - `TestCloudflareSignInSurvivesServerRestart`：进程 A 开始，进程 B（同库、空内存）读到对话框的登录、通过来源检查、同一请求 id 不新开，B 完成回调；A 再提交同一 state 得到 `used`；token 只换一次；verifier 已删除；第三个进程看到“完成”和账号。
  - `TestCloudflareStaleCallbackReasons`：未知、已关闭（同进程和重启后）、他人、issuer 不符、已取代（新旧进程）、已过期；关闭已结束或缺失的登录得到 `ErrLoginGone`；过期的回调不会请求提供方。
  - `TestCloudflareSignInInterruptedBeforeAuthorize`：准备阶段被重启打断时提示重新开始，新的尝试不复用它。
  - `TestCloudflareCallbackAcrossRestartAndStaleStates`（HTTP，preview same-site 模式）：多种失败页面（未知、中文、他人、未登录、cors 模式）都是 HTML，带返回链接，不含 provenance JSON 和 code；`/api/auth/state`、`/api/connectors/devices`、`…/logins/{id}` 仍返回原来的 JSON 403；重启后跨站回调成功，重放提示已使用，再次重启后也一样，GET login 显示完成；关闭缺失或已结束的登录返回 `gone`，关闭上一个进程开始的登录返回 204，之后回调提示已关闭。
  - Web：`test/cloudflare-scopes.test.mjs`（分组、计数、筛选），`external-accounts.test.mjs` 通过；`tsc --noEmit` 通过；prettier 通过。
- 真实浏览器回调（Chromium headless，`DEV091_CALLBACK_FIXTURE` 测试夹具：TLS 源 127.0.0.1，合成提供方页在 localhost，即跨站；进入提供方页时换成全新的 Service，模拟重启）：返回后显示 “Cloudflare authorization received”；后退再点返回，显示 “This authorization was already used”；用未知 state 返回，显示 “Foundry has no record of this authorization”，链接 `/connectors/cloudflare`，页面没有 provenance JSON；Tab 聚焦到返回链接；中文显示“Foundry 没有这次授权的记录”，390 宽可读。
- 卡片（`scripts/scratch-stack.sh` 空库临时栈 `dev091`，`FOUNDRY_INTEGRATIONS=off`；scratch-admin 名下合成账号 `synthetic.user@example.invalid`，200 项权限，其中 100 项写入，无任何真实令牌）：light/dark × 1280/390 下，摘要为 “Asked for 5 · Granted 200 (100 write)”；默认收起；键盘 Enter 展开；展开和悬停不移动内容；无横向溢出；筛选 “dns” 只剩 DNS 组，无匹配时有提示；复制按钮有可访问名称。最终部署候选构建 `99192ef82b08ecb5` 在同一栈上复验通过。

## 部署

- Server：DEV-090 会话（`sess_1793286475110448503`）负责一次构建，内容为 `d4537b1` + DEV-085 + DEV-090 + 本项补丁（sha256 `220affa7…`），并做一次 SIGHUP 交接。sha256 和回滚副本以其交接消息为准，见下方流水。
- Web：候选 `99192ef82b08ecb5` = `d4537b1` + DEV-089 文件 + 本项 Web 补丁。先在同一工作树只放 DEV-089 文件构建，build id 复现为当前线上的 `51a0c49cac0b97f3`，确认没有带上或丢掉其他会话的改动，再加本项。按 DEV-092 提议改为合并发布：DEV-092 在本项候选工作树上叠加它的 Web 补丁，在 Server 交接后用 `scripts/deploy-web-dev.sh` 发布一次，并通知 DEV-089；本项不单独发布。实际 build id、发布时间和回滚副本见流水。

## 限制

- 只覆盖浏览器授权码登录（Cloudflare）。Feishu 的设备码登录仍只在内存里，重启后需要重新开始，与本次问题无关，未改。
- 已认领、正在换 token 或验证身份时进程退出，换到的 grant 在内存里会丢失。新进程 90 秒后提示到 Connectors 查看，没有就重新连接。这个窗口只有几秒到几十秒。
- 页面无样式：CSP 不允许内联样式，与原有回调页一致。
- 真实 Cloudflare 往返需要本人账号，未做，等编排确认。

## 人工验收步骤

1. dev → Connectors → Cloudflare → Connect Cloudflare，打开 Cloudflare 授权页。在授权页停留期间，可以请人做一次 Server 交接，或直接完成授权。预期：回到 “Cloudflare authorization received / 已收到 Cloudflare 授权”，对话框随后显示已连接。
2. 在浏览器历史里重新打开同一个回调地址。预期：显示“这次授权已被使用”和“返回连接器”链接，不出现 JSON。
3. 开始连接后先关闭对话框，再在 Cloudflare 完成授权。预期：显示“这次授权已关闭”。
4. 账号卡片：第一行是邮箱，右侧是两个操作；第二行是“授权时身份已核实”和可复制的用户 ID；然后是“请求 5 项 · 授予 N 项（M 项写入）”；“查看权限”默认收起，展开后按产品分组，权限多时可以筛选。不显示警告。

## 流水

- 2026-10-30 00:40 前后：定位原因，实现 Server 持久化、回调说明页、关闭返回 gone 和账号卡片；按编排更正，把“超出所需”的提示改成中性说明；与 DEV-092 约定文件分工；Server 补丁交给 DEV-090 合并部署（`dev091-server.patch`，sha256 `220affa7704e275e…`）。
- 2026-10-30 01:05 前后：Web 改为与 DEV-092 合并发布（DEV-092 负责）。已提醒：DEV-092 的 Web 依赖它自己的 Server 接口，它的 Server 补丁需要进入同一次交接，或者等包含它的 Server 上线后再发布 Web。同时提供本项卡片检查脚本 `card-e2e.mjs`，用于复验合并后的构建。
- 2026-10-30 01:40:18（UTC+8）：Server 已上线。DEV-090 会话做了一次 SIGHUP 交接，同时上线 DEV-085/090/091/092；新进程 3.2 s 就绪，旧进程 3.3 s 后退出，healthz 200，7 台设备重新连上。二进制 sha256 `6120e1c99759258c…`，由 `d4537b1` 加四个补丁构建，本项补丁 sha256 `220affa7…`。回滚副本 `releases/dev023-candidate/foundry-server.pre-dev085-092`（`2181e7f3…`）。线上库已有 `external_code_logins` 表。本项在公网复查：不带登录、带跨站导航头访问回调，返回 401 HTML“Sign in to Foundry first”，并链接 `/connectors/cloudflare`；`/api/connectors/devices` 仍是原来的 JSON 403（provenance）；不带登录的 DELETE 仍是 401 JSON。Web 仍是 `51a0c49cac0b97f3`，等 DEV-092 合并发布。
- 2026-10-30 01:42:46（UTC+8）：Web 已上线，合并构建 `a47d655fe9f8385a`，由 DEV-092 用 `deploy-web-dev.sh` 发布，入口资源一致，API 返回 JSON。内容是本项工作树（`d4537b1` + DEV-089 + 本项 Web）加 DEV-092 的 Web 补丁。上一版 `51a0c49cac0b97f3` 保存在 `~/.foundry/server/releases/dev092-web/previous-20261029T174242Z`。发布前，DEV-092 在同一构建上用本项 `card-e2e.mjs` 和它的合成夹具（208 项权限）复验：light/dark × 1280/390 全部通过，摘要为 “Asked for 5 · Granted 208 (103 write)”。发布后，e2e-alice 在 dev 确认了 version.json 和 Cloudflare 页文案。
- 2026-10-30 01:50 前后：`scripts/audit-module-boundaries.mjs` 指出 `httpapi/cloudflare_callback_page.go` 引用了 externalaccounts，只有连接器自己的 HTTP 文件可以这样做。该文件已改名为 `cloudflare_connectors_callback_page.go`，内容不变；审计通过，相关 httpapi 测试通过。线上二进制按旧文件名构建，行为相同，不需要重新部署。
