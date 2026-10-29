# DEV-044 外部模型连接与 私有网关

2026-10-26，用户在 `sess_1792995418158071510` 要求推进至“能在 Foundry 里使用 私有网关”。用户同意抽象外部连接能力，保持 Worker → Claude Agent SDK → 原生 Claude Code，不将 网关私有协议移植到 Foundry。

## 实现

- 设备 profile 新增 `connectionType: external`，本地配置指向明确的可执行文件、字面参数及经过验证的连接身份；不能提升成 Server model provider。
- 外部连接帮助进程通过 `foundry.connection.v1` 私有管道提供调用环境，原生 CLI 仍由 SDK 直接启动。身份不匹配、超时或帮助进程异常退出都失败关闭；不回退其他账号。
- SDK 持有帮助进程直至原生进程退出，跨轮复用不提前释放；取消先走原生退出流程，再清理连接。调用密钥注册进 transcript redaction，不写日志。
- 外部身份使用独立 native history；Workspace 沙箱在宿主准备连接，独立判断亦在 CLI 沙箱外准备。不会将网关管理凭据目录开放给沙箱。
- 设备页面展示连接、验证状态；外部连接不显示“提升”。模型目录用已配置模型，避免把代理端口当 API，也不借用本机官方账号目录。
- 原生 SDK 推理检查由 `foundry-worker connection check <profile-id>` 显式发起，使用一轮模型额度，永不自动运行。通过后设备心跳上报可用状态。
- 新 daemon 对旧执行宿主增加 `external_connection_v1` 能力检查，等待安全升级期间不能将新连接误交给旧代码。
- 公共协议说明：[external-connections.md](../external-connections.md)。网关适配器源码在独立的私有仓库中，不成为 Foundry 构建依赖，也尚未作为网关 release 发布。

## 验证

证据目录 `.foundry/attachments/20261026/dev042-external-connection/`。

- `check-changed.log`：protocol build/tests、Web tsc/18 个测试文件、Worker build/46 个测试文件、19 个 httpapi 测试、10 项 UI audit、contract 全通过；新模块漏登记导致 modules audit 失败，补登记后 `module-audit.log` 通过（0 violations）。
- `check-followup.log`：execution-host 能力修改相关检查发现既有 `service-stack.test.mjs` 继承执行者的 Claude source home，污染“无来源配置”测试。修正测试自身环境隔离后，17 项有针对性的测试全部通过，包括 host reconnect、旧 host 拒绝 external、helper identity/timeout/loss/cleanup；未修改 service 产品行为。
- `sdk-evidence.json`：linux-dev-3 上真实 Worker SDK + 私有网关 + Haiku 推理通过；Write 工具实际写入临时文件，恢复相同原生 session `c49e8dd2-dfc3-47b6-918b-fd430f567b6a` 回忆上一轮 token；分别收到 27/8 个流式事件；并发两会话分别返回自己的标记、配置目录不同；流开始后取消成功。临时 CA 全部清理。
- 真实浏览器、合成 DeviceProviders fixture：英文亮色、中文深色 390px、API 菜单键盘打开/关闭、external 无提升菜单、pending/error 提示；390px 下 scrollWidth 390。截图 `providers-light.png` / `providers-dark-narrow.png`。这部分使用合成连接展示，不冒充真实聊天验收。
- linux-dev-3 缺少 bwrap，独立只读沙箱测试返回 `agent_verifier_isolation_unavailable`，在 CLI 启动前拒绝。没有降级成非沙箱执行。

## 发布与设备状态

- Web `716b62a5455881a7` 已部署到 `/var/www/foundryapp-dev`，公网 version.json 已确认。
- 与并行会话 `sess_1792999134370683044` 协调合并发布其已验证的 Linux sandbox readiness 修复（该会话负责 sandbox/diagnostics/workspace-ops/mcp_verification 及相关测试，未互相修改文件）。
- Server 实际加载 SHA256 `8975a93be89d2784c81cb37b7c73fdffd1ae3c04456ade9e2615640f98c31086`，PID 752972；healthz ok，startedAt `2026-10-26T07:31:20Z`。启动时执行既有数据库清理约 50 秒，随后设备重连。
- Worker `0.5.7-dev.81.gac22cc1.local.1792999441` 已发布，linux-dev-3 daemon 于 15:31:22 更新。打包后逐文件比对 dist 与包，无差异。
- linux-dev-3 安装 网关 helper（安装在用户目录），profile `gateway_default`，界面名称 `Gateway · default`，默认 Sonnet，可选 Opus/Haiku；保留原有其他 profiles，修改前备份在原配置旁。
- 截至 15:32，执行宿主保留旧版本：`sess_1792897906152291224` 仍有约 16:27 完成的 PnL 后台进程。没有停止它或绕过工作控制。等待自然空闲切换后，完成 Foundry 真实会话验收。

## 15:49 更新

- 最终 Worker `0.5.7-dev.81.gac22cc1.local.1793000734` 已发布并安装到 linux-dev-3；`connection check --help` 可用。该版本包含显式检查命令、检查结果/配置变更的心跳刷新、并发清理等待修正、禁止注入但允许清除继承的 TLS bypass/运行时注入变量。
- 最终 Web `13308dab7cbbcfe8` 已部署，公网 version.json 一致。
- `check-registration.log` 全通过（Web tsc、17 个测试文件、Worker build、6 个测试文件、UI/modules）；`check-cleanup.log` 全通过；最终 `check-final-worker.log` 全通过（Worker build、29 个测试文件、modules）。
- 正式已安装的 Sonnet profile 于 `2026-10-26T07:37:38.139Z` 明确通过原生 SDK 推理检查，Server `list_profiles` 已返回 `gateway_default` healthy / check passed；模型列表为 sonnet、opus、haiku。
- 网关 helper SHA256 已核对（值见私有记录）。
- 执行宿主仍是旧版本，保留 PnL 后台任务。已在 Foundry 登记一次性持久续办 `work_894ba6f65d0edd37cc31c523e87d6072`，北京时间 **2026-10-26 16:32** 继续本会话，检查自然切换并完成完整产品验收。续办不是执行宿主已切换的证明。

## 待完成

- 完整 Foundry 会话与续聊验收已于 16:34 通过（见下文）。
- 人工验收待用户确认；代码尚未提交。

## 16:28 复核修复

来源：编排会话 `sess_1792999134370683044` 转交独立复核结论。修复全部六项必修及建议项：

- helper 仅继承基本 OS 变量，在私有临时目录启动；请求和最终 CLI base 清除其他 provider 的凭据、headers 与端点。settings 采用校验后的快照，含宿主凭据时拒绝。
- 沙箱只传递 helper 明确 set 的值，先在宿主生成最终 Claude configHome，再按 owner/runtime/workspace 校验复用；helper 所见 settings 与 SDK 完全一致。
- 仅 external connectionType 可启用 helper；远端 upsert 拒绝修改 external 配置。helper 可执行文件失效时不采信旧 passed 检查。
- daemon 按实际 profileId/dispatch profile 解析连接类型检查 execution-host 能力，不再依赖可能缺失或过期的 fingerprint。
- 关闭管道并有界清理，防止逃逸后代保留 stdio 导致永久等待；headers/带凭据 URL 纳入脱敏，明确的非秘密字段除外。Foundry server host 加入 NO_PROXY/no_proxy。自动检查遍历明确排除 external。
- 回归：`review-checks.log` 全通过（Worker build、41 个测试文件、modules）。新增外部连接测试覆盖真实 OS writable_tree 的 runWorkspaceSession 分支（假 SDK、无模型调用）、宿主凭据隔离、无效/null/array/超长回复、upsert、helper 删除、无 fingerprint/旧 fingerprint 门槛、最终配置一致性和持有 stdio 的逃逸子进程。
- 本次 Worker 包同时纳入编排会话已验证的 sandbox session-work 观察修复；Server 无新增变更。不做 Git 提交。

## 16:32 修复版发布与交接

- Worker 修复版 `0.5.7-dev.81.gac22cc1.local.1793003292` 已发布；打包 dist 与当前构建逐文件核对一致。
- linux-dev-3 daemon 在 16:30:58 更新，MainPID 1162962；执行宿主的 systemd ExecStart 也已实际指向 `.1793003292`。原 PnL 后台进程自然完成，未被中断。
- 已按编排会话要求交接实现文件所有权给 DEV-045 会话 `sess_1793003459594287015`，后续本会话只改 DEV-044 文档/devlog；如产品验收发现缺陷先反馈编排会话。
- 已创建只读产品验收聊天 `sess_1793003521483492628`，linux-dev-3 / `gateway_default` / Haiku，测试 `pwd` 和跨轮标记记忆；等待结果。

## 16:34 完整产品验收通过

- 会话：[私有网关 接入验收：工具与续聊](https://dev.foundryapp.app/chats/sess_1793003521483492628?workspace=ws_7a62ebd5-ba52-46df-8306-c23ad1c22c51)。选择 linux-dev-3 / `gateway_default` / Haiku，实际返回模型 `claude-haiku-5-5`。
- 第一轮实际执行 Bash `pwd`，返回 `GATEWAY_FOUNDRY_OK_20261026` 和 `~/workspace/linux-dev-3`；第二轮不调用工具，仅返回上一轮要求记住的 `ANCHOR_GATEWAY_7392`。两轮均 completed，原生 session 始终为 `84abf6ac-adaf-4f75-9b90-092609f2bf67`。
- 使用已加载的修复版 Worker `.1793003292`，覆盖 Server 分发 → execution host → Claude Agent SDK → 私有网关 → 原生工具与续聊。不是只运行独立 SDK 脚本。
- 用户可直接打开上述会话继续，或在 linux-dev-3 工作区新建聊天，选择 `Gateway · default`；默认 Sonnet，另可选 Opus、Haiku。
- 16:32 持久续办因为本会话已在处理验收而返回 session busy，未重复启动；完成后已请求停止该续办，控制操作 `wop_908467f12f0f157abff1ba257ad18da5` 已获 verified 回执；16:36:11 设备确认 revision 2 / stopped，无后续唤醒。
- 实现与 Agent 自验已完成，人工验收仍待用户确认。无 Git 提交。

## 2026-10-26 17:48 三台设备接入

用户在 `sess_1793007654865154049` 明确授权继续第四步；mac-laptop 在身边，mac-desktop 如需人工授权可延后。本次没有出现需用户处理的钥匙串弹窗。

- 三台 daemon 已更新为 `0.5.7-dev.81.gac22cc1.local.1793005823`。通过现有 `startSelfUpdate` 更新，保留活动执行，不强停会话。
- 由私有 adapter 打包 helper 并安装在每台的用户目录，三台校验和一致。不是新的公开网关 release。
- 每台 helper 的 `--describe` 验证各自的连接身份，使用 `connection add` 登记 `gateway_default`，默认 Sonnet，可选 Sonnet / Opus / Haiku。已有配置先备份为 `agent-profiles.local.json.before-gateway-20261026-0946`，未覆盖其他 profile。
- 三台均使用设备上已有或经包管理器安装的 Bun 运行 helper；dev-server 的 helper 身份验证与原生 SDK 推理均通过。
- mac-laptop 的 Foundry dev 状态目录是独立的 dev stack 目录，其余两台为各自 `~/.foundry`；注册使用对应 stack 的 CLI。

| 设备        | 原生 SDK 检查（UTC） | 实际执行引擎                    | 状态                                           |
| ----------- | -------------------- | ------------------------------- | ---------------------------------------------- |
| dev-server  | passed，09:46:27.019 | PID 3325667，旧版 `.1792735712` | 配置与推理检查通过；等待当前会话结束后自动切换 |
| mac-laptop  | passed，09:46:35.840 | PID 71903，新版 `.1793005823`   | 已接入                                         |
| mac-desktop | passed，09:46:43.584 | PID 45419，新版 `.1793005823`   | 已接入，无需现场操作                           |

三台的服务端 `list_profiles` 均已收到 `gateway_default` healthy / check passed。检查通过 `foundry-worker connection check` 调用原生 Claude Agent SDK，未直接请求模型推理端点。本次未新建 Foundry 验收聊天，也未声称完成人工页面验收。

dev-server 在 09:48 UTC 的活动 claim 仅本会话。为让执行引擎自然切换，结束本轮后于 **17:52（UTC+8）** 一次性继续复核，工作 `work_b9ce92428e6a7da54cb6603061f60974`；尚未观察到切换，不能宣称 dev-server 已可启动外部连接聊天。

用户验收：选择 mac-laptop 或 mac-desktop 上的工作区，新建聊天并选择 **Gateway · default**；设备页应显示检查通过。dev-server 等上述实际执行引擎复核完成。两台 Mac 更新后分别仍有约 24 GiB / 15 GiB 可用空间。

## 2026-10-26 17:52 dev-server 复核：尚未完成执行引擎切换

- 17:50 按用户要求再次执行标准 Worker 更新，日志确认 `.1793005823` 已安装并完成服务激活，daemon 新 PID 836634。
- 17:52 再次读取 `execution-host/identity.json` 和实际进程，执行引擎仍为 PID 3325667 / `.1792735712`，没有自动切换成功的证据。
- 本地 `connection list` 与服务端 `list_profiles` 仍为 `gateway_default` passed / healthy，原生 SDK 检查时间保持 09:46:27.019 UTC。这不能代替执行引擎版本检查。
- 当前唯一 active claim 是本次复核输入；这解释了复核期间不能安全切换，但尚不足以说明两轮之间为何没有切换。因此不再承诺“本轮结束必定完成”，也不强停执行引擎或其他任务。
- 两台 Mac 的接入结论不变。dev-server 剩余项是确认执行引擎的空闲判定与安全切换；本次未重新安装 helper、修改隔离或创建子会话，也不循环创建提醒。

## 2026-10-26 18:00 dev-server 已切换，私有网关 检查再次通过

用户在本会话明确要求直接切换，并于 17:56 追加“别等了，让他们中断就中断吧”，授权中断运行任务。

- 空闲升级的实际阻塞：旧 execution host 的 `sessionWorkBusy()` 把两个长期运行的 DEV-006/007 合成验收服务计为忙碌；它们的进程也位于旧 execution host 的 systemd cgroup。因此仅结束聊天不足以触发升级。
- 先通过 Foundry 控制停止原有两个服务，再以独立、有限执行的 systemd oneshot 停止 daemon 和旧 execution host，启动 daemon。使用已安装版本，未重装 helper，也未修改产品代码。
- 17:58 实际执行引擎已变为 PID **841306** / `0.5.7-dev.81.gac22cc1.local.1793005823`；daemon PID **841294**。`identity.json`、实际进程命令行及 `switch.log` 的 `SWITCH_VERIFIED` 一致。证据与一次性切换脚本在 `.foundry/attachments/20261026/gateway-sg-switch/`。
- 17:59:33 再次执行 `foundry-worker connection check gateway_default`，原生 Claude Agent SDK 检查 **passed**。服务端 `list_profiles` 已同步新时间 `2026-10-26T09:59:33.180Z`，状态 healthy。三台设备现均完成连接注册、SDK 推理检查及新版执行引擎加载；用户可在对应工作区选择 **Gateway · default**。

### 测试服务恢复限制

已通过原有服务的 `resume` 恢复启用配置，未新建替代服务：

- 合成 Server：`work_2de671aff5f6b54978a980c3d9b18601` revision 17，resume 回执 `wop_27221c2b953b0430e91219d2ea0d9244` verified。
- 合成 Worker：`work_e079566a13f5dbbd745d90199ccd6a54` revision 25，resume 回执 `wop_f80fc82f6d9951042294698f0b05a33a` verified。

**控制回执不等于启动成功**：两者最终均 exit 1 / failed。旧临时目录 `/tmp/fdy-iirZAF/foundry-scratch/isolation-dev006-007` 已不存在：Server 缺少 `instance.env`，Worker 缺少旧 runtime 的 `dist/cli.js`。daemon 日志记录清理了 idle session `sess_1792389561205511349` 的 `/tmp/fdy-iirZAF`。本次切换脚本没有删除目录，但旧测试环境依赖会话临时目录，无法按原命令恢复；没有重建替代环境或声称已恢复。该限制不影响 私有网关 接入。

本次恢复核验唤醒 `work_1776607c74a57c445ba93f24924e004b` 已禁用后续运行，revision 2；pause 回执 `wop_13b017ba65bd6daee9bdbd3ec86d4ad0` **verified**。此前的复核唤醒仍保持 paused，不循环创建提醒。未新建 Foundry 验收聊天，人工界面验收仍由用户完成。

## 提交

- 2026-10-27 夜间窗口经 PR #150 合并到 main（merge `60496ca`），本事项一个提交；多事项共用文件随最后改动它的事项提交。CI 首轮暴露的 Node 22 / 无 Claude CLI / 测试竞态问题在同一 PR 内修复。
