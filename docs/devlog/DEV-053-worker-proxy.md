# DEV-053 Worker 到 Foundry Server 的代理

状态：实现、Agent 自验证、发布与 byte-dev-sg 实际加载验证完成；人工验收待确认。

2026-10-27 用户希望网络直连 Foundry Server 较差的设备经过代理，包含 HTTP(S) 与 SOCKS5。背景是 byte-dev 上行约 10 KB/s、下行约 422 KB/s，详见 [DEV-051](DEV-051-chat-images.md)。代理支持使设备可以选择更好的路由，本条目不声称本机环回代理能改善 byte-dev 的跨网带宽。

## 原因与范围

原先 `connection-reports.ts` 读取 HTTPS_PROXY/ALL_PROXY/HTTP_PROXY 只用于报告；控制 WebSocket 未设置 agent，Node fetch 也没有显式 dispatcher。报告“有代理”不代表连接走代理。安装/自更新进一步把服务器 tarball URL 交给 npm，无法统一 SOCKS5 行为。只改 WebSocket 或全局 fetch 均不足：Foundry CLI/MCP 与连接器网关转发使用 Node HTTP request，服务隧道还有独立 WS。

采用单一、仅供 Foundry Server 请求使用的 `server-proxy.ts`：HTTP(S) fetch 使用 Undici ProxyAgent，SOCKS5 fetch 使用 Undici Agent 加 `socks` 库 connector；Node HTTP/WS 使用 `https-proxy-agent` / `socks-proxy-agent`。没有手写生产代理协议或安装全局 dispatcher。SOCKS5 本地 DNS、SOCKS5h 代理端 DNS；HTTPS 代理和目标均验证证书。参考官方 [Undici dispatcher](https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md) 与 [proxy-agents](https://github.com/TooTallNate/proxy-agents)。

编排会话在用户请求范围内确定 v1：所有 Worker↔Server 流量、NO_PROXY、命令行配置、诊断和地址显示；Web 端编辑留后续。模型/Provider 推理请求保持其自己的运行环境。本实现不修改 provider/catalog 的请求，也不把设备代理写入 Agent 环境。服务器诊断现有 `connection.proxy` 字段足以显示脱敏路由，不需要新增协议或 Server 存储。

## 行为与使用

完整配置说明见 [设备与 Workspace](../devices-and-workspaces.md#worker-到服务器的代理)；安装说明见 [开发指南](../development.md)。

```bash
# 在需要代理的设备执行，地址由设备所有者选择；本次没有修改真实设备代理。
~/.foundry/bin/foundry-worker proxy set socks5h://127.0.0.1:1080
~/.foundry/bin/foundry-worker proxy set http://proxy.example:3128 --no-proxy 'localhost,127.0.0.1,.internal'
~/.foundry/bin/foundry-worker proxy show
~/.foundry/bin/foundry-worker doctor
~/.foundry/bin/foundry-worker proxy clear

# 新安装时在 Worker CLI 启动后、配对和下载之前保存；初始 npx 仍需自己能联网。
foundry-worker install --server https://dev.foundryapp.app --token '<one-time-token>' --proxy socks5h://127.0.0.1:1080
```

优先级：当前状态根的 owner-only `worker-proxy.json` > FOUNDRY_PROXY > HTTPS_PROXY/https_proxy > ALL_PROXY/all_proxy > HTTP_PROXY/http_proxy。已保存 noProxy 优先于 NO_PROXY/no_proxy；空列表可写 `--no-proxy ''`，`*` 全部直连；clear 恢复环境变量回退。无可用代理时明确报错并按现有 1–30 秒退避，不静默直连。

设置变化只重连 daemon 控制连接；可靠 outbox 保留/补发未确认消息，执行宿主在下一次服务器请求时读新配置，无需中断执行。请求下载的 Worker 包先流式写入 owner-only 临时文件，npm 只接收本地 tarball，成功/失败均清理临时目录；npm registry 依赖仍采用 npm 的网络配置。

地址显示只保留 scheme + host:port；代理认证不进入 Server 请求头。CLI 参数错误、daemon 错误、连接报告、diagnostics 和 transcript/log URL 均脱敏。配置解析错误也不给出原始 JSON 内容。`doctor` 经过实际路由访问 `/healthz`，打印耗时；Devices → 诊断显示代理、HTTP 和控制连接延迟。

## 自验证据

证据目录：`.foundry/attachments/20261027/dev053/`。`files.txt` 为本条目的文件清单；多个已有文件含并行条目工作，只改代理相关最小 hunk，保留原改动。DEV-051 继续独占 transport 和文件分片/优先级实现，控制连接代理 hunk 经双方协调。

- 第一轮聚焦 37/37：代理协议、配对/安装相关、诊断、连接报告与 CLI 帮助。最终 `worker-final-check-results.txt` 全绿：35 个受检文件、36 个 Worker 测试文件、重建、格式和模块边界；总耗时 194.7 秒。
- 第二轮 28/28：Foundry CLI/MCP、连接器 HTTP+upgrade 转发、服务隧道及代理集成；补充原生 MCP、Claude/Codex 配置等 34/34（`mcp-checks.txt`）。Web 全量 typecheck、3 个相关测试文件及 11 项 UI audits 通过（`final-check-results.txt` 的相应行）。该中间检查的 Worker 红测来自 CLI 源码与构建时序，最终冻结源码重建后由上述 Worker checker 全绿替代。
- 新增真实本地 HTTP CONNECT、HTTPS CONNECT、SOCKS5/SOCKS5h 测试代理；带认证的 fetch/WS、192 KiB 分块上传下载、服务器 release 查询、Worker tarball 暂存、NO_PROXY 精确主机/后缀/端口/IPv6、远端 DNS、凭据不进入目标请求头、TLS 不信任拒绝、CLI 输出和日志脱敏、配置 watcher 均验证。
- 真正 dev：e2e-alice 的独立合成设备 `dev_2682e76d-069e-459b-88cc-697bf2c848fe`、工作区 `ws_f6059fa3-9711-4c02-95d8-8d4f09780e1b`，私有状态在仓库外 `~/.foundry/dev053-proxy-acceptance/`。只设置此设备的环回临时 HTTP 代理。配对、注册、WSS 控制连接成功；初轮真实 Codex CLI 会话 `sess_1793097180956476997` 返回 `DEV053_PROXY_OK`，256 KiB 文件 264 ms。最终新启动执行宿主（PID 1589899）上的会话 `sess_1793098721988494549` 成功调用 `foundry.list_sessions` 并返回相同标记；256 KiB 文件逐字节一致，377 ms；健康检查 393 ms，WS RTT 19 ms。代理记录 11 次 CONNECT，目标均为 dev Server:443。详见 `live-e2e.json`；这是 Agent 验证，不是用户本人测试。

## 发布与收尾

最终真实测试把代理改为带合成认证的不可达地址，观察 1/2/4/8 秒退避；日志无用户名/密码，改回可达代理后恢复。执行宿主 PID 在变更前后保持 1589899，无需重启执行宿主（`live-e2e.json`、`recovery.json`）。真实页面已检查浅色 1280 与深色 390，数字地址可换行，390 视口的 document/body 为 380，无页面横向溢出。

Web `1792b54a13066032` 已包含最终中性代理文案；真实 Chromium 检查中英文、浅/深色、1280/390，键盘触发诊断并观察忙碌到完成。实际代理一行是正常状态，只有 scheme/host:port，无凭据；窄屏 document 为 380/390，无水平溢出。`browser-final-qa.json` 与 `deployed-diagnostics-*.png` 保存部署后证据。合成源码 Worker 的版本标签仍为 0.5.6，实际执行宿主入口/加载 stamp 另存 `synthetic-refreshed.json`，不以源码版本标签代替加载证据。

修复依赖声明后的联合 Worker `0.5.7-dev.81.gac22cc1.local.1793102942` 公共 tarball SHA256 为 `9a5f5642bea6b52bb1941c6e2293564648868435d37f9bb9adb055f1bdee1116`，包内核对 `socks ^2.8.3` 及两项代理模块，见 `published-proxy-proof.json`。byte-dev-sg 通过既有 Devices self-update 同一入口成功，daemon PID 888601 与执行宿主 PID 888796 都实际加载该不可变目录，`doctor` 直连 HTTP 200/68 ms，前后可用空间 448.14/448.13 GiB；真实代理设置仍为 direct，见 `byte-dev-sg-update.json`。DEV-051 负责其他两台设备和最后的图片渲染联合包，后续版本与临时进程清理回执另补。首次 npx 下载和 npm registry 依赖不受 Worker 专用代理设置控制。真实 byte-dev 的代理选择与吞吐改善需设备所有者设置实际代理后再测；本次不替换其代理配置。

### 最终联合发布（2026-10-27 20:26–20:28）

DEV-051 完成图片渲染修正后统一发布 `0.5.7-dev.81.gac22cc1.local.1793103861`，本条目代理源码保持冻结。Worker tarball SHA256 `7749b9d91114aeb93008bcfd1dcfa367c7344b2ee33dd6586bdbfb5dc878f77a`，包内代理模块和 `socks ^2.8.3` 再核对，见 `published-proxy-proof-ultimate.json`；上一版 manifest 与两个包均保留（发布回执见 DEV-051）。Web 保持 `1792b54a13066032`。

byte-dev-sg 再经同一安全自更新入口完成：daemon PID 893533、执行宿主 PID 893612，实际 `/data00/home/<user>/.foundry/runtime/…1793103861/node_modules/@bd777/foundry-worker/` 不可变路径均为最终版本。更新记录 succeeded，直连 `doctor` HTTP 200/282 ms，前后可用 448.13 GiB，代理仍为 direct；compute lease 已释放。证据 `byte-dev-sg-ultimate-update.json`。byte-dev 与 sg-chaos 的最终更新由 DEV-051 验证，见其条目的设备加载表；忙碌的旧执行宿主需空闲后安全切换，未强停。cottoncpp、MacBook、Mac mini 按本次范围跳过。

同一合成 Worker 还协助 DEV-051 从真实 Server 经代理验证 1,057,794 B PNG：预览 19,558 B，冷读 2.106 秒、重复 28 ms；原图与完整下载 SHA 一致。详见 [DEV-051](DEV-051-chat-images.md) 与其 `preview-production-adaptive.json`，不将此 SG 环回代理结果作为 byte-dev 带宽改善。

测试结束后已核实自己的 daemon/host PID 消失、环回 37955 端口关闭、合成执行 service inactive，浏览器关闭，临时 Cookie 删除；`list_session_work` 无运行项。保留合成工作区与明确命名的测试文件供追溯，没有删除真实文件或修改真实设备代理。清理证据 `cleanup-verified.json`。

### 旧 ffmpeg 兼容包补发（2026-10-27 20:39）

DEV-051 在 byte-dev 旧 ffmpeg 验证后发布最终兼容包 `0.5.7-dev.81.gac22cc1.local.1793104558`（代理源码未变），Worker SHA256 `ebbf89c60213f6b8d5a86da80dbc7df3fdace39cffb0f2c0175aacf2b569855b`。本条目独立核对包内代理模块及 `socks ^2.8.3`，见 `published-proxy-proof-compat.json`。byte-dev-sg 同一安全自更新入口 succeeded；实际 daemon PID 897396、执行宿主 PID 897414 均由 `/proc` 与不可变目录 package.json 核实加载 `.1793104558`，`doctor` 直连 HTTP 200/67 ms，可用 448.13 GiB，代理仍为 direct；compute lease 已释放。见 `byte-dev-sg-compat-update.json`。没有重新启动已清理的合成代理、Worker 或浏览器；其他设备与渲染兼容性证据由 DEV-051 汇总。

### 设备 npm 解析兼容性修正（2026-10-27）

联合 Worker `.1793102069` 首轮在 byte-dev 自更新时，npm 报 `ETARGET: No matching version found for socks@^2.8.10`，安装在重启前停止。发布方立即将公共 Worker manifest 恢复至 `.1793093010`，保留两版 tarball；新版 Web `1792b54a13066032` 与 Server 保持健康。没有用不可安装的包替换设备的既有运行时。

直接依赖改为 `socks@^2.8.3`：生产 fetch connector 直接调用 `SocksClient`，所以保留显式依赖；无需强制最新补丁。`socks-proxy-agent` 自身也声明该最低范围。其余三项经过目标设备实际解析与安装验证，可保留既有兼容范围。

通过 byte-dev compute lease，在该设备配置的 registry 上分别执行四项 `npm view <package>@<range> version`，全部成功；刷新元数据后该设备也已可见 2.8.10，说明首轮不能依赖新补丁立即可解析。用自更新所携带的基础环境与 `--prefer-offline --ignore-scripts --omit=optional --no-audit --no-fund --no-package-lock` 在两个独立临时目录实际安装：

- 修正范围解析安装成功：socks 2.8.10、socks-proxy-agent 8.0.5、https-proxy-agent 7.0.6、undici 6.29.1；四个模块导入成功。
- 另将 socks 精确固定为最低 2.8.3，安装成功；复制最终生产 `server-proxy.js` 及两项本地依赖，实际经本地带认证 SOCKS5/SOCKS5h 代理完成 fetch 和 Node HTTP agent 往返，包含代理端 DNS，共 4 次连接，全部成功。

两处临时安装目录均在 finally 中清除，compute lease 已释放；没有改真实设备的代理、原生配置或运行时指针。原始回执在 `registry-compatibility.json`；修正包已发布，byte-dev-sg 两层实际加载验证见上。

## 验收步骤

1. 设备更新到本条目所记发布版本后，执行 `proxy set` 和 `proxy show`：只显示 scheme/host:port，无账号密码；Devices 在线，`doctor` 报 HTTP 200 与耗时。
2. 发一条会话并上传/下载合成文件；代理端应观察到 Server 连接，回到 Web 能看到回复，文件字节一致。
3. 设置错误代理：设备短暂离线、日志明确显示脱敏代理与逐步退避；改回可达代理后自动恢复，无需重启执行宿主。
4. `--no-proxy '<server-host>'` 绕过代理；`proxy clear` 恢复环境配置。Devices → 诊断显示实际 route，浅/深色和窄屏均可读。

原生 Claude/Codex HTTP MCP 通过执行宿主内的环回转发器访问 `/api/mcp`，逐请求应用服务器代理；只转发会话自身的认证，不注入设备凭据，不开放其他 API 路径。模型请求的环境和目标保持原样。

## 2026-10-27 提交前修复

- 在设有 `HTTPS_PROXY` 的 shell（编排会话的沙箱）中跑 Worker 测试，3 个用例（skill 包下载诊断、自更新放弃、连接失败收尾）的回环请求被调用方代理接走而失败。测试启动器 `packages/worker/scripts/run-worker-tests.mjs` 现在像清除 `FOUNDRY_*` 一样清除 `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY`（任意大小写）；代理用例自行设置。复跑 23/23 通过。

## 提交

- 2026-10-27 夜间窗口经 PR #150 合并到 main（merge `60496ca`），本事项一个提交；多事项共用文件随最后改动它的事项提交。CI 首轮暴露的 Node 22 / 无 Claude CLI / 测试竞态问题在同一 PR 内修复。
