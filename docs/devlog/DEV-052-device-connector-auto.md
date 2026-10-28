# DEV-052 设备持有型连接器本人会话自动可用

2026-10-27，编排会话 `sess_1793063405185071529` 分派给本会话 `sess_1793086917064963647`。状态：实现与 Agent 自验已完成，dev Server/Web 已部署，Worker 已发布。linux-dev 忙碌执行宿主仍待安全切换；代码未提交，人工验收待确认。部署、实际加载与人工验收分别记录。

## 问题与原因

用户反馈：linux-dev 已有 bytedcli 授权，但每到一个 Workspace 都要在 Connectors 点击两次授权。只读检查确认设备状态为 ready、signed_in、版本 0.178.0、cn 登录到期为 2026-11-26；四个 Workspace 分别留下了同一用户创建、`members=false` 的绑定。

`connectors.DeviceHeld.SessionUses` 原先只有命中 Workspace 绑定才派发 `device_login`。设备所有者未绑定的会话既未隔离原生登录，也没有连接器说明，所以 Agent 不知道已可使用。该绑定对本人非沙箱进程没有实际隔离作用，却引入重复操作。Meego 另有独立网页会话授权，不能把它与基础 ByteCloud 登录或 Server-held 飞书 OAuth 混为一谈。

另发现两个状态传递缺口：执行宿主和 daemon 不共享 Worker 内存缓存；SQLite 没有保存 `DeviceConnectorState.Authorizations`，因此重新读取页面/派发时丢失附加授权状态。仅使用内存 store 的单元测试未暴露后一个问题。

## 决定与实现

此决定由编排会话在用户请求范围内作出（2026-10-27 分派消息），用户可调整；不是用户逐字指定的方案，也不是人工验收：

- 设备所有者本人在该设备的非沙箱会话，自动获得设备报告的 ready / expiring 登录，无须 Workspace 绑定。状态须 `signedIn=true`，每次派发按当前时间重新计算到期；已过期、退出、未安装、不可用和读取错误不派发登录。
- 其他成员仍须命中该 Workspace、设备和设备所有者创建的 `members=true` 绑定。未授权或登录失效时保持原有隔离环境变量。Issue execution / clarification 与 verification 会话不获得连接器；Worker 原有沙箱防线继续保留。
- Workspace Connectors 显示“本人会话可直接使用”、登录身份与到期。只有基础登录已退出/过期才出现设备登录入口；登录完成只更新设备状态，不再创建本人专用绑定。成员共享开关独立，关闭时移除本人的共享绑定并保留本人自动使用及他人绑定。保存过程禁用控件，完成后仅在焦点未移到其他控件时恢复共享复选框焦点。
- `DeviceConnectorUse.state` 携带经过清洗的登录身份、到期与附加授权组元数据，解决执行宿主缓存缺失。Worker 说明明确区分 Meego native Feishu Web session 的 ready、missing、expired、unverified；未验证先做只读检查，确实缺失时只要求对应子授权，保留现有基础登录。Meego 原生授权获取方式不变。
- SQLite 增加 `device_connector_states.authorizations` JSON 元数据列（默认 `[]`），保存/重新读取附加授权状态；不包含凭据。部署前使用在线一致快照并 `quick_check`，旧字段和绑定保留。迁移测试覆盖旧表升级两次、登录保留与空附加授权默认值。
- 本轮没有新增按 Workspace 停用本人原生登录：这需要新的存储和产品语义，列为后续。旧 `members=false` 绑定可保留，但不再控制本人可用性；移除共享不声称撤销设备原生权限。

代码入口及设计更新见 [connectors.md](../connectors.md)。DEV-049 已有 FieldHint/Toast 改动保留；Server、Web、Worker 在共享 main 工作树上协调构建，不回滚 DEV-049/050/051。

## 检查与证据

证据目录：`.foundry/attachments/20261027/dev052/`。

- Server 聚焦测试：`go-focused.txt`，connectors / sqlitestore / httpapi 通过；覆盖无绑定本人使用、成员隔离、共享成员、过期/退出/异常/未知所有者、Issue 沙箱及 verifier、旧 Worker 不派发。使用 linux-dev 实际状态形状（ready、cn、0.178.0、<user>、11 月 26 日到期）的新 Workspace 单元测试，不在用户 Workspace 创建会话。
- Worker：`connectors-device-held.test.mjs` 15/15 通过，新增无 daemon 缓存的执行宿主身份与 Meego ready/missing/expired/unknown/unavailable 状态说明验证。
- Web：`device-held-connectors.test.mjs` 11/11 通过；新增打开即自动可用且零授权/绑定写入、显式共享与撤销、Viewer 只读、AWS 自动使用、基础登录过期后登录完成不创建绑定。
- 真实浏览器：`browser-check.json` 9 个场景通过。英文亮/暗色 1280px、中文亮/暗色 390px 均无横向溢出；完整页面正常缩放截图已目视核对。每种主题/宽度均使用键盘 Space 开启/关闭共享，保存后焦点恢复，开启只写 `members=true`，关闭删除共享，始终零 sign-in 请求且本人继续可用。另覆盖 Meego ready/needs_auth 的独立状态、基础登录过期、Viewer 禁用、共享失败与重试；重试期间复选框/检查按钮禁用，最后共享成功。截图为 `light-en-1280.png`、`dark-en-1280.png`、`light-zh-CN-390.png`、`dark-zh-CN-390.png`、`capability_ready-dark.png`、`capability-dark.png`、`expired-login.png`、`sharing-error.png`。
- 数据库在线一致快照：`~/.foundry/server/releases/dev052-device-connectors/previous/foundry-20261027-155245.db`（992100352 bytes，`quick_check=ok`，15:56 完成；`backup.json` 收据）；原 Server binary 同目录保留。第一次分步在线备份在活跃写入下无法及时完成，终止本会话备份进程后复用同一目标，通过显式 WAL 只读事务完成一致快照，没有删除数据库/WAL。
- SQLite 旧表迁移：`go-migration.txt` 通过，覆盖旧表升级两次、原登录保留、附加授权往返与清空。
- linux-dev 真实设备只读复核：计算租约调用原生 `bytedcli --json auth status` 和 `bytedcli --json --site cn meego status`，只保留过滤的状态元数据（`linux-dev-readonly.json`）。基础登录 authenticated / ready、身份 <user>、cn、11 月 26 日到期；Meego 的 `goapi.state=ready`。根和临时目录各有 86.21 GiB 可用，设备可安全走常规 Worker 更新。第二次仅检查构建工具的计算请求超时并释放租约，没有依赖它作任何验收结论。
- 完整 `scripts/check-changed.sh --files`（19 文件，`check-changed.txt`）：格式、protocol build/tests、Web 全量类型检查、Worker build/4 组相关测试、Go httpapi/sqlitestore/connectors/store、11 项 UI audit、contract 均 PASS。Web 两文件的 29 项中 28 PASS、1 FAIL：设备登录改动误用了与飞书共享的 `workspace.authorize` 文案键。已改为专用 `workspace.signInDevice`，保留飞书原授权文案，受影响 Web 测试在 `web-recheck.txt` 29/29 PASS。另将成员共享重试文案独立为 `workspace.retrySharing`，保留飞书的 `retryBinding`；最终 Web 全量 typecheck 与 11 项审计在 `web-final-check.txt` 全 PASS。首次中断的锁等待日志留在 `check-changed-interrupted.txt`，不作为成功证据。
- 部署与实际加载证据见下节，人工验收待确认。

## 部署

与 DEV-051 协调合并 Server/Worker 构建；本会话单独构建 DEV-052 Web。旧 Server binary、Web index/version 与本次 DB 快照位于 `~/.foundry/server/releases/dev052-device-connectors/previous/`。具体状态：

- Web：16:22:05 部署 `f0af1c5d7df5517d` 至 `/var/www/foundryapp-dev`，公网 version.json 一致、入口 6 个引用资源的 SHA256 与 artifact 相同。原 Web `3b449cf945b20c61` 的 index/version 备份在 previous，原 assets 保留。复用已安装依赖，独立输出 `~/.foundry/server/releases/dev052-device-connectors/web`，产物 6.3 MiB，构建成功（`web-build.txt`）；在 DEV-049 最终发布后切换，避免冻结快照覆盖本轮 UI。随后 DEV-049 发现共享 Popover 的 390px 裁切，追加其已实测的 5 行公共 CSS 修复，最终候选在 `web-final`，16:40:40 部署 `069a4d3a7c0f6c77`（`web-final-deployment.json`），公网 index/version 与 6 个入口资源 SHA256 均匹配；f0af1 的入口另存 `previous/before-popover/`，原 assets 保留。该 CSS 由 DEV-049 所有者复验：中文暗色 390px 的共享账户说明弹层 left18/right378/width360、clientWidth=scrollWidth=358，完整换行；截图 `.foundry/attachments/20261027/dev049/popover-fixed-zh-dark-390.png` 已交叉目视检查。标准 Vite 大 chunk 提示保留，未扩大本轮范围调整分包。
- Worker：DEV-051 合并发布 `0.5.7-dev.81.gac22cc1.local.1793088606`，protocol 92556 bytes、Worker 556523 bytes；该会话已核对公开下载 SHA256 与连接器文件内容。设备回执引用 `.foundry/attachments/20261027/dev051/device-update-receipts.json`。linux-dev daemon PID3003453 与 Server 注册版本均为新版本，但忙碌执行宿主 PID1193234 仍为 dev.53，未强停；不能声称新 Meego 会话说明已在该宿主生效。linux-dev-2 daemon PID816740 与实际宿主 PID816763 均已加载新版本。dev-server/Mac/低磁盘设备本轮暂缓 runtime 安装。
- Server：DEV-051 合并增量编译 3 个包后链接发布，16:19:12 恢复健康。PID1492872，`/proc/1492872/exe` 与 artifact SHA256 均为 `315645e9da1e43d665ad5190c91492e1d388e91eb22aad12e8ad0c3e6827bcd7`；实际入口 `~/.foundry/server/releases/dev023-candidate/foundry-server`，构建 artifact 在 `releases/dev051-chat-images/foundry-server`。合并包含 DEV-050 快照护栏、DEV-051 图片和 DEV-052 迁移；未重复重启。回执引用 `.foundry/attachments/20261027/dev051/server-{loaded,artifact,health,build-budget}.json`。复用本项 DB 快照和旧二进制，无第二份 DB 备份。
- 部署后只读检查（`after-migration-dry-owner.json`）：新增 authorizations 列已存在，linux-dev 原登录 ready / <user> / cn / 0.178.0 / 11 月 26 日到期及四条旧绑定保留。根据该真实行进行无绑定 Workspace 的本人访问干算，结果为 `device_login`；对应 Go 回归直接调用生产 `SessionUses`。没有在用户 Workspace 创建会话。旧行的附加授权列默认 `[]`，需下一次设备状态检查填充；在此之前说明按 unverified 处理，不误报 missing。独立原生命令已经只读确认 Meego ready。

部署后收到编排会话追加的全树构建护栏：消息到达时合并 Server 已发布。已补跑整个共享主树和冻结源码副本的 `go build ./...` 与本区域 sqlitestore/httpapi 测试，均 PASS（`server-whole-tree-gate.txt`、`server-snapshot.json`，native exec47015/60964 均 exit0），不回填为发布前已执行。`server-tree-postdeploy-stat.txt` 是明确标注的部署后 diff stat；`server-source-timing.json` 证明没有 Go 源文件 mtime 晚于该 artifact。包含其他会话的 Server 改动按上述记录，未再次重启 Server。

磁盘：一致备份后约 9.9 GiB 空闲，低于 AGENTS 10 GiB 门槛，已向编排会话报告（排队期间消息拒收）并通过当前会话异步询问 Go 缓存清理；没有删除缓存、数据库或 WAL。后续复用已编译依赖，仅增量编译/链接与 6.3 MiB Web / 约 634 KiB Worker 小体积 staging，无依赖树复制和大型安装；最终空闲 9.612 GiB（10320809984 bytes，90.21% 已用）；真实写入预算见 Server/Web receipts。未把清理授权的缺失扩大为阻止小体积验证发布。

最终快照在 16:33:28 捕获：`~/.foundry/server/releases/dev052-device-connectors/snapshot`，607 个 Web 源文件，摘要 `3b716c6fb476be555c63bd43dd9f1a314afaba3a49e099490dd07a62913e9685`（`web-snapshot.json`）。复用依赖软链接，包含 DEV-049/050/051 稳定源码及 DEV-052，排除 DEV-051 随后新增的预览/下载需求；Server 源文件也独立冻结，未复制任何 DB/WAL。pnpm11 在快照中尝试 dependency-status 自动 install，因无 TTY 拒绝，未执行安装；改用已有二进制直接跑 11 项审计和 Vite。原失败日志留在 `web-snapshot-pnpm-aborted.txt`；直接二进制的最终 11 项审计和 Vite 构建在 `web-final-build.txt` 全通过。

重新排队时仅对本会话尚未启动的 Web flock1499898 发过单 PID SIGTERM；Server1498751 已开始，保护断言阻止其终止，两次 Go 检查均自然完成。DEV-049 同时报告自己的检查收到143；没有针对其 PID、进程组或 Foundry 工作控制的 stop 操作，原因未确认，不把它解释为其回归通过。

公开最终版本复验由 DEV-049 所有者在 e2e-alice 中文账户页执行：390px 暗色点击、亮色键盘 Enter 打开说明，Escape 回到“界面语言说明”；Popover left12/right368/width356、clientWidth=scrollWidth=354，完整中文换行、页面无横向溢出，未修改账户或聊天。证据 `.foundry/attachments/20261027/dev049/deployed-final-help-{dark,light}-390.png`。本项的连接器 9 场景与该公共样式复验分开记录；人工视觉验收仍待用户。

## 人工验收步骤

1. 在 linux-dev 的一个没有 bytedcli 绑定的新/既有 Workspace 打开“连接器”。预期显示本人会话可直接使用，登录为 <user>、cn、到期为 2026-11-26；没有“使用现有登录”或基础登录授权按钮。
2. 在同一设备新建本人普通会话，要求只读查看 bytedcli 状态。预期 Agent 已知道设备登录可用，无须到 Workspace Connectors 再次授权。其他设备各用自己的登录。
3. 查看 Meego 网页会话那一行。若本地凭据 ready，不应仅因基础 Workspace 未绑定就再次请求授权；若 missing/expired，只在需要 Meego 的任务中要求这一项授权，不重做 ByteCloud 登录。
4. 用键盘切换“共享给其他成员…”；预期保存时禁用、保存后焦点回到复选框。关闭共享后本人继续可用，其他成员不再获得登录。成员实际第三方调用需本人确认测试范围，Agent 自验只使用合成数据。
5. 基础登录真实到期/退出时应显示对应状态与设备登录入口。不要为验收主动退出当前生产登录；该路径已用隔离 fixture 覆盖。

## 时间线与限制

DEV-050 所有者已在本项 `f0af1c5d7df5517d` 上完成其部署浏览器自验（切走/返回、640 事件分页、1280/390 亮暗色），记录见 [DEV-050](DEV-050-first-message.md) 与其 `deployed-browser-receipts.json`。本项不替代其人工验收；最终仅 Popover CSS 变化未改其三个来源文件。

| 时间（北京时间）       | 变化 / 证据                                                                                                 | 剩余动作                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 2026-10-27 15:42–15:58 | 核对设计、活动会话与真实只读状态；完成实现、聚焦测试、9 个浏览器场景及一致 DB 备份                          | 迁移、完整检查与部署；人工验收待确认               |
| 2026-10-27 16:08–16:16 | 受影响 Web 29/29、最终类型检查/11 audits 通过；Worker `.1793088606` 发布并更新 byte 两设备                  | linux-dev 忙碌宿主仍 dev.53，未强停                |
| 2026-10-27 16:19–16:22 | 合并 Server 健康、迁移与真实行干算通过；Web f0af1 上线、6 资源哈希一致                                      | 后续全树 Go 护栏与公共 Popover CSS                 |
| 2026-10-27 16:33–16:40 | 冻结 607 文件 Web 与 Server 源码；主树/冻结树 Go 全构建及区域测试通过；最终 Web 069a4d3a7c0f6c77 上线并复验 | 代码未提交；人工验收、linux-dev 宿主安全切换待确认 |

设备登录状态仍是最近一次本地检查，不等于业务权限验证；页面/手动检查会刷新状态，没有新增后台轮询。已有运行中的会话不会自动重写其启动说明，需要下一次派发或新会话。Worker 更新需核验实际执行宿主；忙碌宿主保留旧版本直至安全切换，不强停会话。

## 2026-10-27 委托 Agent 准出（编排会话 sess_1793063405185071529）

用户于 2026-10-27 在编排会话中明确：“验证的话你自己接口级别+端到端级别自行验证吧”。以下为 Agent 自验证据，不代表用户本人测试；只关闭已验证范围。

- 结论：本人会话自动可用通过（委托 Agent 准出）；Meego 子授权状态写入会话说明待 linux-dev 执行宿主切换。
- 端到端：在从未绑定的 linux-dev workspace `ws_da716f18…` 新建验证会话 `sess_1793094096858842675`，会话说明含 bytedcli 可用行，`bytedcli --json auth status` 为 authenticated=true（<user>）；无需任何绑定或点击。该会话随后已归档。

## 提交

- 2026-10-27 夜间窗口经 PR #150 合并到 main（merge `60496ca`），本事项一个提交；多事项共用文件随最后改动它的事项提交。CI 首轮暴露的 Node 22 / 无 Claude CLI / 测试竞态问题在同一 PR 内修复。
