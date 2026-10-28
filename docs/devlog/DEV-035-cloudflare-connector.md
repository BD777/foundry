# DEV-035 Cloudflare Connector

状态：官方授权入口已公开上线并通过实际页面验证；本人 Cloudflare 批准与真实资源核验待完成。daemon 与实际 CLI 执行宿主均已升级并核实能力；真实 Cloudflare 资源仍待本人批准后验证。

## 目标与边界

在 Foundry Connectors 中连接 Cloudflare，明确 Foundry 用户、Cloudflare 用户/账户和 zone 的区别；由用户选择 Workspace 与可用资源。会话通过受控 CLI/MCP 入口访问获准资源，长期凭据只保存在 Server 的既有密钥存储中，不写入共享 OS 的全局账号配置。真实登录与批准由本人完成；合成测试或共享测试账号不能代替本人授权。

DEV034 负责 Workspace 服务、隧道和后续 DNS/TLS 方案。本项只负责 Connector 授权及消费能力。首个场景先读取 zone、DNS 和证书现状，不修改记录、不部署 Workers、不启用收费项。界面与绑定不能硬编码 foundryapp.app；具体写权限待精确计划明确后增量申请。

## 已核实的一手能力

- [官方 Cloudflare MCP](https://github.com/cloudflare/mcp) 提供 `https://mcp.cloudflare.com/mcp`，通过 OAuth 登录和选择权限；`whoami` 区分用户与账户凭据，`execute` 通过 `cloudflare.request()` 调用公共 API。它的令牌只应交给对应 MCP 资源，不直接复制给 CLI。
- 实际未认证请求获得 401 及 protected-resource metadata 地址；授权服务器元数据实际返回 200，公布动态客户端注册、Authorization Code、Refresh Token、PKCE S256 和公开客户端 `none` 认证方式。可利用这条官方链路避免让用户手动创建第三方 OAuth 应用。探测只读取公开元数据，未注册客户端或创建真实授权操作。
- [第三方 OAuth client 文档](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) 明确第三方不支持 Device Authorization；不能因为 Wrangler 支持 device flow 就为 Foundry 伪造该能力。
- [官方 cf CLI](https://github.com/cloudflare/cf/blob/main/packages/cli/README.md) 面向公共 API；[Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/general/) 面向 Workers，近期版本有 `login --device --browser=false`。二者登录权限不能混同 DNS 管理权限。
- npm 实际元数据：最新 `cf@1.0.0-beta.20` 要求较新的 Node（当前本机 Node 24.11.0 不满足）；`cf@0.14.0` 要求 Node >=22，可作为待验证的固定兼容版本。已固定安装到独立受管前缀，未运行登录。官方 [环境变量文档](https://developers.cloudflare.com/cf/environment-variables/) 提供 API base URL 配置；真实 `cf zones list` 已通过隔离网关 fixture 验证，不使用原生 Cloudflare 凭据。

本机 PATH 和常见受管/bin 路径未发现 cf、wrangler、cloudflared；常见 `.wrangler`、`.config/.wrangler`、`.config/cloudflare`、`.cloudflare`、`.cloudflared` 路径不存在；环境没有 Cloudflare 凭据变量。该结论仅覆盖本机已检查路径，不推断其他设备没有登录；未读取凭据正文。

## 已实现的模块契约

复用 `connectors.Module.ServerHeld`、现有 external account/app/grant/Workspace binding 和刷新、撤销、审计路径。为现有 provider 契约添加明确的 Authorization Code 能力，保留 Feishu device flow；不要把 MCP OAuth 伪装成原生 device flow。回调由固定配置的可信 Web origin 构建，绑定启动用户、操作、state、PKCE 与有效期；不得信任任意 Host/redirect 参数。

初始申请基础身份、账户发现与必要的 zone/DNS/证书只读 scope，避免全权限预设。Workspace 应显式选择 zone 范围。MCP/CLI 消费入口每次检查当前 session、创作者、设备所有者、Workspace 绑定、资源范围与授权状态，解绑或撤销立即生效。需要新增绑定资源范围时必须兼容并保留既有 Feishu 绑定。

拟验证官方 MCP 作为上游、Foundry 作为带审计的会话网关：CLI 只拿受限会话凭据和网关地址；Cloudflare OAuth token 留在 Server，最终仅用于官方 MCP。任意 JavaScript `execute` 不能被当作可安全检查资源范围的请求，必须通过结构化、可限制方法与路径的调用入口。不得为了提供 MCP 注册自动加载 Cloudflare 的外部 Skills。

## 协作与基线

PR138 的联合候选由 DEV023 统一收尾，本项是其后的独立增量，不混入已验证候选。DEV034 最新代码已冻结在 `~/workspace/foundry-dev034-tunnels`，清单 `/tmp/dev034-evidence/source-manifest.json`；其后续 auth/security/service-tunnel 变更需局部协调。Cloudflare 相关新增模块、externalAccounts 命名空间和 Connector 契约由本项负责；不整树同步共享 dirty，也不覆盖 DEV028。

研究证据在 `/tmp/dev035-evidence/research/`：官方 MCP 源码、README、公开 OAuth metadata 与 npm 版本信息。2026-10-21 23:44 配合已授权宿主维护保存检查点；同一 owner 接续继续实现，不将维护当作任务取消。当前磁盘约 10.75 GiB 可用，任何依赖安装或大构建前重新检查并复用依赖。

## 实施检查点

2026-10-22 00:01：已新增明确的 Authorization Code provider 契约与 owner/state/PKCE 回调骨架、Cloudflare 官方 MCP OAuth adapter，复用既有账号密钥存储和刷新路径；原 Feishu device flow 保持独立接口。当前仅 `externalaccounts` 包编译检查通过（没有执行测试），尚未接入 HTTP 路由、资源绑定、消费网关或 Web，也未部署，不能作为可用入口。

已在独立受管前缀安装 `cf@0.14.0` 及 62 个依赖，安装脚本禁用，未更改全局 PATH/默认账号，未运行登录。官方 CLI 的网关消费仍待实际 fixture 验证。第二次宿主维护请求到达时，已保存源码清单、精确 hash 与未解决项到 `/tmp/dev035-evidence/checkpoint.json`；原服务已由维护 owner 恢复，本项不会据“已安装”声称新宿主已加载。

## 2026-10-22 实现与验证

现有 Server-held provider 拆分 Device Flow 与 Authorization Code 能力；Feishu 保留原链路，Cloudflare 使用官方 MCP 的公开客户端注册、PKCE S256、固定回调及 refresh/revoke。回调绑定 Foundry owner、issuer、操作和有效期，单次消费；拒绝错 owner、缺失/错误 issuer、过期、重放以及普通跨站 API 请求。初始操作立即返回 receipt，重复请求恢复同一操作；新窗口接管后，旧窗口延迟关闭不能取消新窗口的操作。

批准后先核验真实 Cloudflare 身份，再保存既有外部账号及密封 grant。核验/保存暂时失败保留已批准操作，在期限内重试，不再次兑换同一个 code 或要求重复授权。服务器重启后未保存操作明确 unknown，界面先刷新已有账号。撤销在本地立即阻止后续消费；若上游撤销未确认，显示 pending 并允许重试，禁止旧授权回调把账号恢复为可用。新授权核验为另一身份时不覆盖原账号。

Workspace 绑定沿用 external_account_bindings，增加明确的 zone ID 集合，保留既有 Feishu 与其他成员绑定。每位用户在同一 Workspace 选择一个 Cloudflare 身份、1–50 个 zone；多个 Workspace 可以独立选择不同资源。页面区分 Foundry 身份、Cloudflare 用户身份、Cloudflare account 与 zone，不把缓存 identity 当作所有业务权限实时可用。

Cloudflare MCP 令牌仅发往官方 MCP origin。Foundry `cloudflare` 工具接受结构化 GET path/query，服务器生成固定调用代码；不暴露任意 JavaScript execute。受控 API 网关允许选中 zone 的 DNS、证书等必要只读路径，每次检查 session、用户、设备、Workspace、绑定及授权状态。根 zone 列表仅逐一读取已选资源，支持 page/per_page；其他列表过滤参数明确拒绝，不静默忽略。工具调用写入既有 Connector 审计。

官方 `cf@0.14.0` 通过会话专用 loopback forwarder 使用短期 Foundry stand-in，凭据有效期 30 分钟并按活跃授权自动续期。长期 OAuth token 不发送 Worker，不写共享全局 CLI/Codex 配置；解绑、撤销、设备移除或会话结束后重新检查会拒绝访问。CLI 能力要求实际新版 Worker 与官方 CLI；MCP 消费不依赖 CLI 安装。未把“安装包已更新”当作执行宿主已加载。

Web 提供 Connectors 的 Cloudflare 页及 Workspace 内入口、官方授权链接、操作状态、明确 zone 选择、保存失败重试、解绑保留登录、全局撤销确认。申请中的权限和已获权限分别标注。附加 DNS/TLS/缓存只读探测不自动扩大 OAuth 权限；缺少 scope 时先给具体结果，再由后续精确计划决定是否增量授权。

验证证据（均为合成身份，不能代替本人授权）：

- `externalaccounts`、Connector、HTTP 定向回归通过；PKCE、owner/issuer/replay、过期、同操作恢复、旧窗口取消、验证失败恢复、撤销竞争与跨设备/资源/Workspace 拒绝均覆盖。
- Cloudflare 授权和网关 `go test -race` 通过。
- 真实安装的官方 `cf@0.14.0` 子进程完成 `zones list`，网关续期、并发去重、错误 handle、写操作拒绝及结束关闭测试通过，3 项全部执行，无跳过。Feishu forwarder 原回归通过。
- Chromium 实际渲染英文亮色与中文暗色 390px 窄屏；授权链接→合成批准→zone 选择→绑定失败→重试→解绑闭环通过。回执丢失只创建一个 grant；未知操作先刷新账号；键盘 Escape 关闭与横向无溢出通过。截图位于 `.foundry/attachments/20261022/dev035/`。
- 最新同站 cookie 规则下的 HTTP callback 交叉检查通过；真实跨站浏览器回跳与固定组合完整 gate 正在运行，结果另补，不预报通过。

隔离候选 `~/workspace/foundry-dev035-cloudflare` 以已验 DEV034 same-site rev2 为基线，保留已合入 PR138 和 tunnel/cookie/Host 门，排除 DEV028。候选依赖的 protocol 链接指向自身 packages/protocol。精确 035 清单、每文件 delta、前后 hash 与测试日志在 `/tmp/dev035-evidence/`；没有从主树混合 dirty 整包发布。

## 尚待完成

固定候选必要 gate、真实同站 callback 浏览器、配套 Server/Web/Worker 发布和实际能力加载确认。之后由本人打开官方页面批准，再只读验证实际身份、选中 zone 与 DEV034 所需 DNS/TLS/缓存现状。没有修改 DNS、购买或启用收费服务、部署 Workers、读取浏览器 cookie 或代为批准真实第三方 grant。

## 公开部署与首用边界

2026-10-22 02:07（UTC+8）显式发布，未启用自动发布器：

- Server PID2139336，实际加载 SHA256 `500780bab82354ef8242b68cfea3e960fdff2eafbd7a6ca047ef2bdadc58bc84`；健康 startedAt `2026-10-21T18:07:25Z`。
- Web build `5ff6b37dd7b5fb81`，公网 index SHA256 `c990136076fc02a1ce98bfd53437c84c5647ab08c0893c5f74b7596af8388575`。保留 DEV034 rev2 的 Host、`__Host-foundry_session`、same-site 和静态隔离头；callback 精确 location 不写 query 访问/错误日志，`nginx -t` 与 reload 成功。
- Worker 发布 `0.5.7-dev.52.g7e5297f.local.1792605745`，包 SHA256 `c83b4b848aba412df3548e9da76885bb260fae904d48006663fed8e5a669fbd2`，pointer SHA256 `33566f4af05d7d66dbee08da9b77c3c2a4819ac77f80d4459c34e16789326a9a`。标准 update 成功，daemon PID2140207；actual host PID2062401 仍为6448，活动执行被保留。`cloudflare_gateway_v1` 受实际 host capability 门控，旧宿主不会被宣传为支持 CLI。维护 owner 接续按已授权合成服务维护流程升级；不强停用户业务。

官方公开注册真实返回201，接受固定 HTTPS callback 与 public-client/PKCE 契约。部署后在独立 e2e-alice Foundry 测试账号的真实浏览器验证 Connectors→Cloudflare→官方授权链接：URL、issuer host、PKCE S256、固定 redirect 都正确；只到未批准页面即取消，未登录或批准任何 Cloudflare 账号，测试账号 Cloudflare account 数为0，并清理本次本地测试 client 记录。中文/英文合成闭环不能冒充本人真实账号接通。公网暗色390px无横向溢出，截图 `.foundry/attachments/20261022/dev035/public-authorization.png` 和 `public-empty-dark.png`。

完整相关 gate 执行1220.6秒。初次格式、Workspace DTO声明、两条旧MCP工具清单断言及品牌文案审计失败均修复并逐项复查：Cloudflare作为带个人凭据的只读工具仍须明确绑定，验证/Issue执行/未绑定会话不能因read-only标签获得它。最终定向HTTP回归6.763秒、全部UI审计、Web typecheck/构建、格式、模块边界通过；其余完整相关检查通过。Worker最终16项回归全执行、无跳过，包含真实官方cf子进程、旧宿主能力门控、Feishu与tunnel回归。没有通过降低审计基线掩盖问题。

版本与逐文件证据：`/tmp/dev035-evidence/release-source-manifest.json`（48项本增量，2197项继承原样）、`delta.patch`、`validation-final.json`、`deployment.json`、`public-browser.json`、`package-delta.json`、`actual-runtime.json`。PR140已合入最新main `7e5297f3a8287bf3778ad96b18cf12557016b0d6`；后续提交只带本项delta与README035行，不重新带034或未验028。

首用：[Connectors → Cloudflare](https://dev.foundryapp.app/connectors/cloudflare)，点击“授权 Cloudflare”，本人在官方页面批准只读权限，返回选目标 Workspace 与所需 zone 后保存。其他项目可复用同一身份分别绑定。服务器 MCP 网关不依赖 CLI 宿主更新；真实资源访问仍以本人批准后的只读身份/zone验证为准。CF登录、DNS/TLS和缓存规则结果尚未完成，不把入口可用说成域名方案已落地。未修改 DNS、证书/缓存规则、订阅或 Workers部署。

2026-10-22 02:23 维护后只读复核：actual host PID2144701 已加载 `0.5.7-dev.52.g7e5297f.local.1792605745`，旧2062401消失。加载的 `execution-host/server.js` SHA256 为 `756c02871f2e40468a17d414493d7311cc13211a47a7d28c57788cf3bf9ac233`；`connectors/cloudflare.js` 与已验证候选逐字节相同。Server 当前设备投影为 connected，Worker5745，明确上报 `cloudflare_gateway_v1`。本机 `cf --version` 实际为0.14.0。上述检查只证明执行能力已就绪，不代表拥有真实Cloudflare账号权限。

原两项合成保护服务按原ID恢复且receipt verified（Server rev13/PID2146897，Worker rev20/PID2147187，iss107/108仍accepted）；证据 `/tmp/dev023-evidence/dev035-maintenance/final-receipt.json` 与本项 `/tmp/dev035-evidence/runtime-final.json`。没有重复维护、停止业务或恢复旧计时器；本项旧续接remove操作 `wop_09aa463bd30bc686467dc9fe048fb6af` 已verified。当前用户可用Cloudflare账号数量仍为0，等待本人批准，不发起额外真实grant或读取业务数据。

源码交付：[PR141](https://github.com/BD777/foundry/pull/141) 独立承接本项，不带未验设备控制改动。完整 CI 首轮发现新增 MCP 工具缺少对应的 Foundry CLI 命令表入口；已补 `foundry cloudflare accounts` 与 `foundry cloudflare read /zones --account <Foundry-account-id> --query '{"page":"1"}'`，复用相同 MCP 权限网关。它与官方 `cf` 是两种消费入口，不新增凭据体系。命令表契约测试正确识别固定 action 参数，新增子进程回归验证结构化参数及非法 JSON 本地拒绝，相关13项测试全通过。该补充仅改变 Worker 的 CLI 命令表，Server/Web和原有账号权限不变；完整 CI 终态见 PR141 的最新提交检查记录。

CLI 映射补包已于2026-10-22 02:40显式发布为 `0.5.7-dev.54.g076bb8d`，Worker包 SHA256 `43cfe7bafec0acd375aa2f542ab9d897a4f150ffcd5f1fc3aaa42bc8addcdde8`，pointer `d6e11274e7f2bc95c9f7bac472d816d9fd6f4a490a82bede95768ee7cd765496`。逐包比较只有 `dist/foundry-cli-commands.js` 改变；协议产物、Cloudflare授权/网关模块、Server和Web完全相同。标准更新后daemon PID2158934；actualhost2144701继续保留活动执行，仍加载5745，其Cloudflare模块与新包相同，无需为独立CLI命令表再做宿主维护。

安装产物的Foundry CLI帮助已列出Cloudflare命令。当前原生会话没有导出Foundry session credential，实际CLI调用被既有guard拒绝并要求使用MCP；没有为测试提取或注入真实会话令牌。官方 `cf@0.14.0` 的专用短期句柄网关不依赖该通用CLI凭据，仍以已完成的真实CLI fixture和本人批准后的实际访问为验收依据。补包、52路径PR清单、修复回归与运行时证据位于 `/tmp/dev035-evidence/cli-fix/`；真实CF批准仍未由Agent代为完成。
