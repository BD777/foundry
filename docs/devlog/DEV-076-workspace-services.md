# DEV-076 · Workspace Services：常驻 Web 服务与远程访问

状态：Server、Web、Worker（dev 服务器设备）已部署；本人已应用 nginx 配置，公网路由自检通过，合成服务经 Foundry 真实打开、WS echo 正常。人工验收待确认。

## 用户问题（2026-10-29 01:50）

Workspace 的 Services 面板“还没用得上”：卡片里混着 session 信息（“Creation session”、Service details）；本意是让 Workspace 持有常驻服务，例如某个工具跑起来的本地控制台 Web Server，应出现在 Services 里，并且本人在任意机器登录、拥有该 Workspace 权限即可访问（功能上类似 SSH 隧道）。此前从未成功用过，Session 里起的 Web Server 也没被代理出来。

## 现状与根因

DEV-034 已实现完整链路：`service_tunnels` 映射、`register_service` MCP/CLI、Web 登记表单；Worker 对每个上游连接单独发起出站二进制 WS（`service_tunnels_v1`）；Server 流式反代 HTTP/WS/SSE；一次性登录交换 + 每个应用 host 的 `__Host-` cookie，每个请求及流每 5 s 复核两个 Workspace 的 Member 角色。同站加固（`FOUNDRY_PREVIEW_SAME_SITE=1`）已开启。从未可用的原因：

1. `FOUNDRY_PREVIEW_DOMAIN` 未设置，所有映射状态为 `preview_domain_unconfigured`，URL 为空。
2. 同站模式的主机名是三级域名 `<label>.ws-<uuid>.foundryapp.app`。Cloudflare 通配 DNS 能解析，但 Universal SSL 只覆盖一级子域，边缘 TLS 握手直接失败（curl 实测 `sslv3 alert handshake failure`）。
3. 一级子域 `https://<任意>.foundryapp.app` 在边缘已可用：TLS 正常，回源到本机，由 nginx 兜底 server 返回空 204。说明通配记录已代理到本源站、SSL 模式不是 strict（兜底证书名不匹配也能通）。缺的是一个把这类 host 转给 Foundry（:31982）的 nginx server 块。
4. Session 起的服务：没有自动发现，Agent 也不知道要登记；即使登记了，因第 1 点也没有 URL。
5. 截图中的两条 “Failed” 是 DEV-006/007 合成验收遗留的 process 工作（paused/failed，`python3 /tmp/foundry-dev006007-*.py`），位于本人 foundry Workspace。是否删除等本人确认，本项只改界面，不动数据。

## 方案（已实施）

| 方面       | 选择                                                                                                                                                                                                                                                               | 理由与取舍                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 地址       | 每个服务一个一级子域 `https://<slug>-<32 位随机 hex>.foundryapp.app/`                                                                                                                                                                                              | 独立浏览器源：SPA/控制台可以挂在根路径，应用脚本拿不到 Foundry 的 DOM/存储。路径方案 `/ws/<id>/svc/<name>/` 被否决：任意应用 JS 与 Foundry 同源，可直接调用 Foundry API（账号接管），而且根路径的 SPA 会坏。主机名不再含 Workspace 段（证书深度限制）；归属记录在映射里。已有映射的 label 本来就是这个形状，地址不变。 |
| 域名       | 同站模式下默认取控制台源的可注册域（`dev.foundryapp.app` → `foundryapp.app`），`FOUNDRY_PREVIEW_DOMAIN` 仍可覆盖                                                                                                                                                   | 不用重建 pm2 环境，SIGHUP 交接即可生效。                                                                                                                                                                                                                                                                               |
| 公网可达性 | Server 启动时及之后每 5 分钟（失败时每 30 s）请求 `https://probe-<随机>.foundryapp.app/__foundry/route-check`，只有返回本进程内存中的 nonce 才算“已路由”                                                                                                           | 未验证前不给出 Open 链接，状态为 “Not reachable yet”。nginx/DNS 将来配错也会自动收回链接，不会把人带到别处的兜底页。                                                                                                                                                                                                   |
| 登记       | ① Agent 调用 `register_service`（会话设备说明里新增一行，提示 Agent 在起长驻 Web 服务后登记）；② Web 手动添加；③ **新**：Worker 上报本机监听端口（`service_listeners_v1`），cwd 在该 Workspace 目录内、尚未登记的进程显示为 “Detected in this workspace · Publish” | 发现只做建议，不自动发布；只有该设备所有者看得到。进程名只报可执行文件/脚本名，不报 argv（命令行可能含密钥）。                                                                                                                                                                                                         |
| 存活       | 列表时向设备取监听端口（每个 Workspace 缓存 4 s）：Running / Not running / Device offline / Worker update needed / Not reachable yet；在跑时记录 `lastSeenAt`（每分钟最多写一次）                                                                                  | “停止服务即显示已停止”；旧 Worker 不报存活时只显示 Available，不猜。                                                                                                                                                                                                                                                   |
| 卡片       | 一行一个服务：状态点、名称、`状态 · 设备 · :端口 · 最后在线`、Open、⋯ 菜单（共享给成员 / 关闭访问 / 移除…，移除需确认）                                                                                                                                            | Session 来源不再出现在 Web 服务上；后台进程行去掉 “Creation session” 按钮、argv 详情和 Work ID，只在 ⋯ 菜单保留 “Open session that started it”。                                                                                                                                                                       |
| 清理       | 新增 `DELETE /api/workspaces/{id}/service-tunnels/{tunnelId}`（仅所有者；Agent 只能删私有映射），立即吊销授权和流                                                                                                                                                  | 随机 label 不会再分配，旧源站的 cookie/localStorage 不会落到新服务上。                                                                                                                                                                                                                                                 |
| 认证/WS/流 | 沿用 DEV-034                                                                                                                                                                                                                                                       | 已有完整测试与浏览器证据。                                                                                                                                                                                                                                                                                             |

## 同站威胁分析

服务 host 与 `dev.foundryapp.app` 同属 `foundryapp.app`（同站不同源）。逐项结论：

- **Foundry 登录 cookie 不会到服务 host**：`__Host-foundry_session`，Secure、HttpOnly、Path=/、无 Domain，只属于 `dev.foundryapp.app`。测试 `TestServiceTunnelSameSiteControlCookieAndProvenance` 断言无 Domain，且旧名 cookie 不被接受。
- **服务页面无法借用户身份调用 Foundry API**：浏览器会在同站请求中带上 `SameSite=Lax` 的登录 cookie，所以 Server 对所有携带账号 cookie 的请求做来源校验——有 Origin 时必须**逐字等于**控制台源；无 Origin 的 GET 只接受 `Sec-Fetch-Site: same-origin` 或地址栏导航，`same-site` 一律拒绝；WS 必须带精确 Origin。新增 `TestServiceTunnelSameSiteServiceOriginCannotUseControlAPI`：以已登记服务的 host 作为 Origin/Referer，GET、POST、DELETE、登出与 WS 全部 403；`TestServiceTunnelSameSiteAllControlGETRoutesRejectSiblingCookie` 遍历全部 70+ 个 GET API。
- **服务 cookie 与 Foundry 互不可用**：服务授权 cookie 是该服务 host 的 `__Host-` cookie（host-only，兄弟域不能用 Domain= 种入）；拿它访问 Foundry API 得到 401（新测试断言）。应用自己的 cookie 由 Server 改名为带受众的 `__Host-` 名，只在对应映射和登录会话下还原。
- **SameSite 设置**：登录 cookie `Lax`；预览授权交换的 state cookie `None`（60 s、host-only、只用于一次性 POST 交换）；应用 cookie 按应用原设置但强制 host-only。
- **名称不冲突**：服务 label 形状为 `slug(≤20)-32hex`，`dev`、`www`、`api`、`app` 等不可能匹配；nginx 精确 `server_name` 也优先于正则。仓库里只有 `dev.foundryapp.app` 一个真实 host；apex、`www`、`app`、`api` 目前都落到源站兜底的空 204，没有生产站点。
- **剩余风险**（DEV-034 已记录）：同站兄弟应用可以消耗父域 cookie 配额或制造超大 Cookie 头（可用性，不是机密性）；必须保证 zone 下没有悬空的第三方 CNAME。独立注册域仍是隔离最强的选项。

## 基础设施（需本人 sudo / Cloudflare，未由 Agent 执行）

文件：`deploy/service-tunnels-flat.conf.example`（`nginx -t` 已在临时前缀下以非 root 通过）。

```
sudo install -m 0644 -o root -g root deploy/service-tunnels-flat.conf.example /etc/nginx/conf.d/foundryapp-services.conf
sudo nginx -t && sudo systemctl reload nginx
curl -s -o /dev/null -w '%{http_code}\n' https://probe-0123456789abcdef0123456789abcdef.foundryapp.app/   # 期望 404（来自 Foundry），应用前为 204
```

回滚：`sudo rm /etc/nginx/conf.d/foundryapp-services.conf && sudo nginx -t && sudo systemctl reload nginx`。

TLS：目标是 Cloudflare Origin CA 证书（`*.foundryapp.app` + `foundryapp.app`）配合 zone 的 “Full (strict)”；临时方案是 “Full”（非 strict）加名字不匹配的 dev 证书，即当前状态。改为 strict 后，其他被代理的名字（apex、`www`、通配兜底）会因证书不匹配变成 526，它们目前只返回空 204；`dev.foundryapp.app` 是 DNS-only，不受影响。另需确认 `*.foundryapp.app` 没有 Cache Everything 规则。应用 nginx 后 30 s 内 Server 日志出现 “public route to this server verified”，Open 链接随之出现。

## 实现

- Server：`service_tunnels.go`（一级主机名、默认域、DELETE、状态）、`service_tunnel_site.go`、`service_tunnel_route.go`（公网自检）、`service_tunnel_listeners.go`（存活/发现）、`daemon_wire.go`/`daemon_inbound.go`（`list_service_listeners`）、`store`/`sqlitestore` `service_tunnels.go`（`lastSeenAt`、`MarkServiceTunnelSeen`、`DeleteServiceTunnel`）、`routes.go`、`server.go`、`security.go`、`cmd/foundry-server/lifecycle.go`。
- Worker：`service-listeners.ts`（Linux 读 `/proc/net/tcp{,6}` 与 `/proc/<pid>/{fd,cwd,cmdline}`，macOS 用 `lsof`；只算 127.0.0.1/0.0.0.0/双栈 `::` 可达的端口，排除 Foundry 自身端口与受保护端口）、`daemon/handlers/service-tunnels.ts`、`workspace-ops.ts`（能力）、`resource-pool.ts`（会话说明）。
- Protocol：`daemon-messages.ts`、`service-tunnels.ts`（`not_listening`、`preview_unrouted`、`routed`、`detected`、`lastSeenAt`）。
- Web：`components/workspace/workspace-service-tunnels.{tsx,css}`、`workspace-services.{tsx,css}`、`api/service-tunnels.ts`、`i18n/locales/{en,zh-CN}/workspaces.ts`。
- 其他：`scripts/audit-module-boundaries.mjs`（`service-listeners` 归入 transport 模块）、`deploy/service-tunnels-flat.conf.example`。

## 部署与版本

- Server：2026-10-29 04:00–04:14（UTC+8）三次 SIGHUP 交接，最终 sha256 `45bf44239847a6985d583cd6c0f68458ec72a39c8ebc40d00cccf1053514628e`，回滚副本 `foundry-server.pre-dev076`。构建自共享树的副本：保留已上线的 DEV-072 改动，排除 DEV-075 未上线文件；部署前在副本上跑了 DEV-072 的两个新测试与本项全部 tunnel 测试。
- Worker：`0.5.7-dev.126.g4cf538f.local.1793218601`（protocol `f94cb210…`、worker `76cedeaf…`）。构建自 `4cf538f` + DEV-072 已发布文件 + 本项文件，排除 DEV-075；与上一版包逐文件比较，只有本项文件不同。上一版备份在发布目录旁的 `releases/dev076-worker/previous-worker-packages/`。dev 服务器设备 daemon 已更新（`runtime/current` → `.1793218601`）；其运行器仍是忙碌中的旧版本，等空闲自动切换，未停止任何回合。用户 Linux 开发机按要求未更新（其映射显示 Available，不报存活）。
- Web：与 DEV-075 约定由其从共享树统一部署，并在部署前跑本项两个 Web 测试；build id 见流水。

## 验证

- Go：`go test ./internal/httpapi ./internal/store`（全包，1026 s）通过；tunnel 相关测试含新增的同站来源、服务 cookie 非控制凭据、保留名、默认域、公网自检（兜底 204 不算、过期 probe 404、未验证不给 URL）、存活/发现/删除。
- Worker：58 项（含 `service-listeners`：真实子进程在 Workspace 内/外监听、退出后消失、排除端口、argv 不外泄）全部通过。
- Web：`workspace-service-tunnels`（7 项，含未路由无链接、停止显示 Not running + 最后在线、移除先确认、Detected → Publish 私有登记）与 `workspace-services` 通过；`tsc`、全部 UI 审计通过。`audit:contract` 与 `audit:modules` 仅剩 DEV-075 未完成文件的条目。
- 真实 dev 端到端（e2e-alice，新建合成设备 “DEV076 synthetic services” 与工作区 `ws_eb2f887a-5546-42fd-bbcb-0511370a765a`，Worker 为当前树构建）：
  - 合成 Codex 会话 `sess_1793217793937550357` 按提示在工作区内后台启动 `dev076-svc/server.js`（静态页 + WS echo），并调用 `register_service` 登记 “DEV076 echo”；工具返回 `preview_unrouted`、空 URL（nginx 未应用时的预期）。
  - Services API：映射存在、`routed:false`；另在工作区目录启动未登记的 `python3 -m http.server`，API 的 `detected` 返回 `{port:18478, process:"python3 http.server"}`。
  - 设备能力实际上报 `service_tunnels_v1`、`service_listeners_v1`。
- 浏览器（Web build `49ffe22bb1da6bbe`，DEV-075 联合部署；e2e-alice 独立 headless profile）：未路由时显示 “Web access isn't routed to this server yet”，行内 Open 不可用；合成服务进程已退出时该行显示 “Not running”；工作区目录内未登记的 `python3 http.server` 出现在 “Detected in this workspace” 并带 Publish。亮/暗 × 1280/390 无横向溢出（截图 `.foundry/attachments/20261029/dev076/services-*.png`）；键盘聚焦 ⋯ → Enter 打开菜单（Share with workspace members / Close access / Remove…）→ Escape 关闭，焦点回到触发按钮。
- nginx 应用后（2026-10-29 07:25 Server 日志 “public route to this server verified”）：
  - 合成服务运行时 API 返回 `routed:true`、`ready`、`lastSeenAt` 与 URL `https://dev076-echo-<随机>.foundryapp.app`。
  - 全新 headless profile 以 e2e-alice 登录 → Services → Open：新标签页经 Foundry 登录交换打开服务 host，页面显示 `api: from dev076`、`echo: ping-… (ok)`（经公网 Cloudflare 边缘的 HTTP + WebSocket）。截图 `proxied-app.png`。
  - 拒绝：e2e-alice（非本人 Workspace 成员）授权本人的 Atlas 映射得到 404，读本人 Workspace 服务列表 404；匿名访问服务 host 的页面、应用 API 路径以及 `/api/auth/state` 均为 401（服务 host 不进入 Foundry 控制面）。
  - 停止服务进程后，界面显示 “Not running · … · :18476 · seen this minute”，Open 不可用；API 状态 `not_listening`。
  - 本人已有映射：Open Lark（:3333）与 Atlas（:18082）状态均为 `ready`，URL 分别为 `https://open-lark-<随机>.foundryapp.app`、`https://atlas-<随机>.foundryapp.app`；匿名访问 401（要求 Foundry 登录）。e2e-alice 不是成员，未代为打开，真实打开留给本人验收。

## 安全审查（2026-10-29，独立只读审查会话）与处理

结论：没有 Critical/High。逐项处理：

| 项   | 内容                                    | 处理                                                                                                                                                                                                                                                                                  |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2   | 一个账号可占满全局容量                  | 已修：每账号 ticket ≤16（超出 429）、grant ≤64（淘汰最旧）、流 ≤32；全局上限改为后备（ticket 4096、grant 8192、流 1024、每设备 64、每映射 32）；Foundry 登出即丢弃该登录的全部 grant 与 ticket。                                                                                      |
| L1   | 服务主机可被边缘缓存                    | 代码已修：服务主机所有响应（404、路由自检、错误、代理）一律 `Cache-Control: no-store`。边缘规则待本人（见下）。                                                                                                                                                                       |
| L2   | 客户端身份头转发给上游                  | 已修：剥离 `remote-user`、`x-remote-user`、`x-forwarded-user`、`x-auth-request-*`、`x-webauth-*`、`x-original-*`、`x-rewrite-url`、`cf-*`、`true-client-ip`、`x-real-ip`、`x-client-ip`、`x-user`、`x-email`、`x-authenticated-*`（另有原有的 `authorization`、`x-forwarded-*` 等）。 |
| L3   | 可发布危险控制端口                      | 已修：拒绝 2375/2376、9222/9229、6443、10250、8500（既有映射若在其上则视为关闭）；Worker 识别 `--remote-debugging-port`、`--inspect` 进程并标记，Server 拒绝登记且不列入 Detected；共享前必须确认，提示只共享 Web 应用。                                                              |
| L4   | 授权 cookie 为 Lax                      | 已修：`SameSite=Strict`。从 Foundry 打开属同站，流程不变；从其他站点的链接会先走一次授权。                                                                                                                                                                                            |
| L5   | 登录提示页链接错误主机                  | 已修：去掉服务链接（按 ID 解析主机会把不可猜测的主机名交给持有 ID 的人），改为“登录后重新打开服务链接”。                                                                                                                                                                              |
| INFO | 监听进程名、共享文案、他人服务          | 已修：进程名只随工作区内监听上报；共享确认文案写明“此 Workspace 中现在及以后所有 Member 及以上成员”；打开他人运行的服务先显示“Run by <所有者> on <设备>”，点 Continue 才登录。                                                                                                        |
| M1   | 边缘到源站不校验证书、可绕过 Cloudflare | 待本人决定，步骤见下。                                                                                                                                                                                                                                                                |
| M3   | 同站兄弟应用（cookie 炸弹、仿冒页）     | 待本人决定：独立可注册域名，或加入 Workspace 需本人接受邀请。                                                                                                                                                                                                                         |

### M1 与 L1 的操作步骤（需本人 Cloudflare 与 sudo）

1. Origin CA 证书：Cloudflare → `foundryapp.app` → SSL/TLS → Origin Server → Create Certificate，主机名 `*.foundryapp.app`、`foundryapp.app`，RSA，15 年。保存为 `/etc/ssl/foundryapp-origin/cert.pem`、`key.pem`（`chmod 600 key.pem`，属主 root）。
2. Authenticated Origin Pulls：SSL/TLS → Origin Server → Authenticated Origin Pulls → 开启（zone 级）。从 Cloudflare 文档 “Authenticated Origin Pulls → Zone-level” 页面下载其公布的 origin-pull CA 证书（以该页当时的链接为准），存为 `/etc/ssl/cloudflare/origin-pull-ca.pem`。
3. 只改服务主机的 server 块 `/etc/nginx/conf.d/foundryapp-services.conf`：
   ```
   ssl_certificate     /etc/ssl/foundryapp-origin/cert.pem;
   ssl_certificate_key /etc/ssl/foundryapp-origin/key.pem;
   ssl_client_certificate /etc/ssl/cloudflare/origin-pull-ca.pem;
   ssl_verify_client on;
   ```
   `sudo nginx -t && sudo systemctl reload nginx`。`dev.foundryapp.app` 是 DNS-only，不受影响，不要在它的 server 块里开 `ssl_verify_client`。
4. SSL/TLS → Overview → 加密模式改为 **Full (strict)**。
5. 验证：`curl -s -o /dev/null -w '%{http_code}\n' https://probe-0123456789abcdef0123456789abcdef.foundryapp.app/` 仍为 404（来自 Foundry）；绕过 Cloudflare 直连 `curl --connect-to probe-…foundryapp.app:443:<源站 IP>:443 https://probe-…foundryapp.app/` 应在 TLS 阶段被拒；Server 日志 30 s 内出现 “public route to this server verified”。回滚：去掉两行 `ssl_client_certificate`/`ssl_verify_client`，证书改回原路径，加密模式改回 Full，reload。
6. L1 边缘缓存：Caching → Cache Rules → Create rule，名称 “Foundry services: bypass”，条件 `(http.host wildcard "*.foundryapp.app" and http.host ne "dev.foundryapp.app")`，动作 Cache eligibility = **Bypass cache**，Browser TTL = **Respect origin**，部署。验证：同一路径连续请求两次，`cf-cache-status` 为 `DYNAMIC` 或 `BYPASS`，不得出现 `HIT`。

## 验收步骤（本人）

1. 应用上面的 nginx 配置；30 s 后打开 [foundry Workspace 概览](https://dev.foundryapp.app/workspace?workspace=ws_8d046eba-109d-4017-b22f-6311250f90a7) 的 Services 区：顶部不再出现 “Preview hostnames … must be configured”。
2. 在某个 Workspace 的会话里让 Agent 启动一个 Web 服务（例如工具的本地控制台），并说 “登记到 Services”。预期：Agent 调用 `register_service` 并回复 `https://<名字>-<随机>.foundryapp.app/`；Services 里出现一行 “Running · 设备 · :端口”，点 Open 在新标签页打开（首次经 Foundry 登录跳转）。
3. 在另一台已登录 Foundry 的电脑上打开同一链接：可访问；未登录的浏览器只会被要求登录。
4. 停掉该服务：几秒内该行变为 “Not running · … · seen 刚刚”，Open 变灰；⋯ → Remove… 可移除（服务进程不受影响）。
5. 在 Workspace 目录里手动起一个服务但不登记：Services 底部出现 “Detected in this workspace”，点 Publish 即登记为仅本人可用。

## 限制

- 用户 Linux 开发机未更新 Worker，其两条已有映射不显示存活，只显示 Available；运行器切换后自动具备。
- 自动发现以进程 cwd 是否在 Workspace 目录内判断；在别处启动的服务需手动或由 Agent 登记。
- 只支持 HTTP(S) loopback 端口；DEV-034 列出的兼容边界（JS 管理的登录 cookie、Authorization 头、外部登录跳转、Service Worker 等）不变。
- 两条 DEV-006/007 合成 “Failed” 行仍在，待本人决定是否移除。

## 流水

- 2026-10-29 10:43 安全审查修复与表单简化上线：Server `f704734c…`（SIGHUP，回滚副本 `foundry-server.pre-dev076c`）、Web `1956b86551054059`、Worker `0.5.7-dev.139.g408e64d.local.1793256296`（= `.1793222409` + 本项监听改动 + main 上已合入的一行重连修复；上一版备份在 `releases/dev076-worker/previous-worker-packages-review/`），dev 服务器设备 daemon 已在独立 systemd unit 中安全更新，用户 Linux 开发机未动。内容见上方“安全审查”表；另按本人决定简化“添加 Web 服务”：设备与 Workspace 固定为当前 Workspace 所在设备（不再有跨设备选择，API 保留，因为已有一个 Mac Workspace → Linux 开发机的跨设备映射），端口从该 Workspace 检测到的监听里选（端口 · 进程名），可改为手填；协议默认自动检测（Worker 对工作区内监听做一次 TLS 握手，答 TLS 即 https），手动协议与关联进程收进“高级”。新增/更新测试：`service_tunnel_review_test.go`（配额、登出丢弃、no-store、身份头、控制端口与调试器、Strict、登录页无主机链接、他人服务先确认、协议检测）、Worker `service-listeners`（工作区外不带进程名、调试器标记、TLS 判别）、Web（共享先确认、表单从检测端口起步且不带协议）。changed-file 全部检查通过（13 项）。
- 浏览器（e2e-alice，全新 profile）：Strict 授权 cookie 下从 Foundry 打开合成服务仍正常（页面、API、WS echo 均 ok）；表单亮/暗 × 1280/390 无横向溢出，键盘 Enter 打开，检测到的 `python3 http.server :18478` 默认选中并预填名称；共享确认框文案正确，Escape 关闭。截图 `.foundry/attachments/20261029/dev076/form-*.png`、`share-confirm.png`。
- 审查第 9 项（本人两条映射，均为 `private`，仅本人可开）：匿名文档请求 303 到 `dev…/authorize`，非 HTML 请求 401，同一路径两次请求均 `cache-control: no-store`、`cf-cache-status: BYPASS`（无 HIT）；e2e-alice 授权两条均 404。
- 2026-10-29 07:44 Web `0118e56ddf949849`（共享树，含 DEV-078 已上线改动与本项“隐藏已确认移除”修复）；全部 UI 审计（含 DEV-078 布局契约）与两个 Services Web 测试通过。
- 2026-10-29 07:46 Server `9748b878…`：本人打开 Open Lark 成功，但 `<link rel="manifest">` 的请求 401——浏览器默认以 credentials "omit" 抓取 manifest，`__Host-` 授权 cookie 不会带上。修复：未授权、同源、`Sec-Fetch-Dest: manifest` 的 GET/HEAD 由 Foundry 生成最小 manifest（名称取主机名中已公开的可读部分，`start_url: "/"`，`Cache-Control: no-store`），不访问设备、不泄露应用内容。逐类核对其他无凭据请求：同源的 `crossorigin="anonymous"` 图片/脚本/预加载、EventSource、Worker 都会带 cookie（同源 credentials 模式），不受影响（Worker 本就被 CSP 禁止）；显式 `fetch(credentials:"omit")`、跨站请求、未授权图片/脚本保持 401，因为它们是私有内容。公网实测：manifest 返回 `{"name":"open-lark",…}`，无凭据脚本仍为 401。测试 `TestServiceTunnelCredentiallessManifestIsSyntheticOthersStayPrivate`。
- 2026-10-29 07:29 本人打开 Open Lark 得到 503 “service connection timed out”。根因：用户 Linux 开发机到 Server 的控制连接当时已停滞——Server 07:31:05 以 “no data from device for 70s” 关闭该连接，07:31:09 重连后报告会话消息延迟 1m30s；设备自身日志同一时段出现 “Work reconciliation: TimeoutError / fetch failed”。打开请求排在停滞的连接上，Worker 没收到，Server 等 10 s 后超时。只读核验（compute 租约，已释放，未改设备）：Worker `.1793206791` 声明 `service_tunnels_v1`，隧道处理代码与当前一致，无代理；18082、3333 均在监听；从该设备到隧道端点的 WebSocket 升级 250–900 ms。因此不是版本、能力或路由问题，也不需要长连接复用。
- 2026-10-29 07:37 Server `e3925751…`（SIGHUP，回滚副本 `foundry-server.pre-dev076b`）：隧道打开、超时、慢打开（>2 s）与被拒数据通道均记日志（设备、映射、端口、耗时、设备静默时长）；设备控制连接静默超过 40 s（设备每 30 s 发 ping）时立即返回 503 并说明“设备当前没有响应 Foundry，连接看起来停滞，会自动重连”，超时与断开也各有说明，带 `Retry-After`。新增测试 `TestServiceTunnelStalledDeviceFailsFastWithAReason`。
- 2026-10-29 07:28 经本人同意（编排会话转达），通过正常 remove 移除两条 DEV-006/007 合成进程服务（argv 均为 `/tmp/foundry-dev006007-{server,worker}.py`），设备已确认（confirmedRevision 19/27）。发现 Services 面板仍列出已确认移除的条目，已在 Web 中改为设备确认后隐藏（附测试），随下一次 Web 部署上线（当前树中有其他会话未完成的 Web 改动，本项不单独部署）。
- 2026-10-29 07:25–07:35 本人应用 nginx；完成上面的公网端到端验证。合成 Worker、其运行器与合成服务已停止，e2e-alice 已登出，临时浏览器 profile 已删除。

- 2026-10-29 03:05 评估完成并发给编排会话；03:07 交付 nginx 文件与应用/回滚命令。
- 2026-10-29 04:00–04:14 Server 部署（见上）；04:20 Worker 发布并更新 dev 服务器设备 daemon。
- 2026-10-29 04:24 DEV-075 部署 Web `49ffe22bb1da6bbe`（含本项 Web 文件，部署前跑了本项两个 Web 测试）与 Server `bacef1e6…`（本项 45bf4423 + DEV-075）。04:30 完成上面的浏览器界面检查。发现：合成会话以 `setsid nohup` 启动的 `server.js` 在停止合成 Worker 前台 daemon 时一并退出（测试环境中 daemon 由本会话前台运行；本人设备的运行器是独立 unit，不受 daemon 重启影响）。后续打开验证前会重新启动该合成服务。
- 2026-10-29 04:40 DEV-075 从共享树发布 Worker `0.5.7-dev.126.g4cf538f.local.1793219656`（= `.1793218601` + DEV-075），dev 服务器设备 daemon 已加载；忙碌中的运行器仍为旧版本，未停止。本项 Worker 改动随之保留。Web 现为 `8d54a6ed0632c60e`（DEV-075 小修，本项文件未变）。
- 2026-10-29 04:21 暂停，等待两件外部事项：本人应用 nginx 配置，DEV-075 联合部署 Web。编排会话会在两者完成后通知，届时运行浏览器 E2E（脚本已备好，在仓库外）。当前留存：合成服务 `dev076-svc/server.js`（127.0.0.1:18476，由合成会话启动）继续运行，供后续打开验证；合成 Worker daemon、临时 `http.server`、临时 nginx 已停止，e2e-alice 已登出、cookie 已删除。
