# DEV-131 授权变化后复用旧原生环境，Cloudflare 配置不进入命令

状态：修复已发布 dev，相关回归通过；sg-chaos 执行宿主仍由运行回合占用，待自然换新后原会话复验；未提交。

## 问题与证据

本人报告 `sess_1793887488081951927` 已在页面授权 Cloudflare DNS 编辑，Agent 仍提示 `No authentication token found` 并要求反复保存绑定。

- 后台只读核对：Cloudflare 账号 ready；工作区 `ws_d8330c3d-6ddd-4eae-ac25-bd2867bbc75e` 绑定两条 zone、`dns_edit`；绑定 15:09:38Z、权限更新 15:09:44Z。账号、设备、会话所有者相同。
- 15:10:04Z 和 15:18:05Z 的事件仍是 `Reused active Codex thread`，复用 14:04 启动、当时没有 Cloudflare 配置的原生线程对象。
- `CodexAppServerThread` 构造时捕获 readonly env；`activeRuntimeKey` 原先排除了 env，并仅散列模型连接相关环境，不含连接器环境。因而新增授权后，新的 Cloudflare 配置没有进入复用对象。
- Cloudflare 的 loopback forwarder 每轮启动、轮末关闭，故原来就有 Cloudflare 的会话也不能跨轮继续使用旧地址。不是 Cloudflare 提供方拒绝写入，也不是 scope 不足。
- 排除了初步“Codex 默认过滤 TOKEN”的推测：官方当前默认已不自动过滤此类变量，实际根因由缓存键与事件证实；未改动 Codex 的默认环境过滤策略。

## 修复

通用 `activeRuntimeKey` 加入 `sessionConnectorEnvironment(session.id)` 的排序后 SHA-256 摘要，涵盖 Codex、Claude、服务端与设备连接器；不把句柄或 token 输出到日志/配置。连接器环境未变继续复用；新增/撤销授权、网关地址变化、Docker 配置增加时，重新准备原生运行对象，仍恢复同一个 nativeSessionId，不清空历史、不强停其他回合。

## 验证与部署

- `runtime-isolation.test.mjs` 8 项通过；新增复现“先无连接器、后授予 Cloudflare”，验证新对象、相同 nativeSessionId、环境不变复用、下一轮新网关不复用旧对象，以及 Claude 的同类缓存键变化。
- `check-changed.sh --files`：格式、Web 类型/3 个测试文件、Worker 构建、Go httpapi 7 项/连接器整包、15 个 UI 审计、契约/OpenAPI/模块审计通过。Worker 54 文件的 352 项测试中，348 通过、3 跳过，唯一失败来自已有 SOCKS 默认端口测试跟随本机 Nginx 的 ag.strangeoutlier.com 重定向；该测试改为 `redirect: manual`，单独复跑 server-proxy 8 项全过。未更改代理产品行为。
- 2026-11-05 23:35 UTC+8 Server `db5b7786b5baf9ed` 发布，healthz ok（startedAt 15:35:22Z）；切换附近一次 MCP 请求遇到 502，重试恢复，后续健康正常。
- Worker `0.5.7-dev.269.g97415a6e.local.1793892617`，7 台设备守护进程更新；CanWendeMac-mini 首次更新超时后重试成功。执行宿主已加载新版：CanWendeMac-mini、byte-dev-sg、cottoncpp、limen-canada、macbook。sg-chaos 与 byte-dev 仍有运行中的旧宿主，未强停。sg-chaos 本人部署会话与本修复会话仍在运行，修复能否在原会话生效须待它们结束当前轮后验证。
- 构建采用 `foundry-int` 已部署的暂存基线加本次差量，未带入 triage 工作树改动；依赖树复用，临时构建禁止 pnpm 自动重装。相关主树改动均保留，未提交。磁盘从 14 GiB 降至约 12 GiB 空闲。

## 人工验收

待 sg-chaos 执行宿主自然换新后，在原会话发“继续，先检查 Cloudflare 连接器”。预期新回合加载新配置，`cf zones list --name strangeoutlier.com` 不再报缺少认证变量；随后由原部署任务按本人已授权范围配置 DNS。若提供方返回独立的权限/范围错误，保留原始错误进一步排查，不能把此回归测试当作已完成真实 DNS 写入。
