# DEV-048 会话归档

状态：实现与自验证进行中，人工验收待确认。实施会话 `sess_1793071569234493142`，协调会话 `sess_1793063405185071529`。设计：[session-archive.md](../session-archive.md)。

## 问题与决定

Foundry 原来只有文件夹删除（永久隐藏），不能将会话可逆地移出列表，原生代理环境也没有配套状态。DEV-048 增加独立归档状态，保留记录、位置、文件、令牌只读访问；恢复后方可继续发送。

2026-10-27，协调会话传达用户批准的决定：D1 Claude 采用 B，将 transcript 与同名目录移至数据目录下的 `archived_sessions/projects/`，保留可逆清单并检查冲突与使用中状态；D2 Web、REST、MCP 均禁止给归档会话发消息，返回 `409 session_archived`；D3 归档请求暂停定时工作，恢复会话不会自动恢复工作。

D4–D7 为协调会话根据用户总体 go-ahead 采用的推荐默认，用户可修改：单会话只归档本身，文件夹为批量路径；Foundry 拥有的原生会话在外部归档后保持 Foundry 状态，下次 Foundry 回合恢复原生会话，未拥有的原生会话双向镜像；v1 文件夹归档和归档页多选恢复，无自动归档；workspace member 可归档，Agent 只控制其有权控制的会话，Personal Agent 对文件夹或超过 3 条请求确认。

同日，WP3 scratch 实测发现 Codex `thread/archive` 级联归档原生子线程，而 `thread/unarchive` 只恢复父线程。协调会话在用户已授权范围内决定：保留原生级联；归档前记录原来未归档的原生后代，恢复父线程时仅恢复清单中仍归档的后代，不恢复本来已归档的后代。D4 针对 Foundry 独立子会话；若原生后代也绑定 Foundry 会话，在线预检显示其将受原生级联影响。离线时只可显示通用原生级联说明。

## 实现

WP0–WP4 已集成。协议增加归档元数据、原生 desired/generation/result 和 capability。服务端以独立表保存归档与审计，事务覆盖文件夹全体、预检成员集合校验、原生别名、队列与定时工作暂停；默认列表过滤先于分页，详情和 transcript 保持只读可读。REST、Web 和 MCP 发送路径均拒绝归档会话。Personal Agent 的 `archive_session` 使用既有确认计划，文件夹或超过三条必须确认。

原生同步独立于 Foundry 状态提交，离线为 Pending，重连按最新 generation 收敛；旧执行宿主返回 unsupported，界面可重试。Codex 使用 app-server API、幂等状态检查、受限 stale-alias 修复与后代清单；不直接改原生 SQLite。Claude 使用外部连接实际的稳定数据目录、可逆 manifest、冲突/进程/近期写入检查和 transcript+同名目录移动。原生扫描读取 active 与 archived，并保留已归档记录的后续观察。

Web 提供可见归档操作、文件夹预检、批次 Undo、独立 Archived 页、筛选和多选恢复、日期/操作者/设备名、原生状态与 Retry。归档对话去掉输入框；独立父子链接显示归档状态。英中双语与共享控件覆盖键盘、忙碌/错误和窄屏。实际 dev 验证发现归档摘要没有合并完整 transcript，已修复缓存与分页合并，并按工作区和归档代次隔离。

实际预检还发现主机 inventory 中无控制权的既有 crontab 被误认为本会话工作。归档现在跳过纯观察且无 native controller 的主机记录，不收编或停止无关系统工作；有控制权的真实任务仍须暂停或先停止。

## 验证证据

WP1/WP2 由实施会话负责，WP3 Worker 与 WP4 Web 分别由同设备 Foundry 子会话 `sess_1793071686413466635`、`sess_1793071686522628251` 负责；交接证据保留在 attachments。自验证由实施 Agent 执行，未声称用户已验收。环境身份见 [test-environment.md](test-environment.md)。全部新会话位于 `e2e-alice` 的合成工作区 `ws_d4da0f57-8b07-40e2-b85d-54f813982f19`，独立 Worker 状态/原生数据在 `~/.foundry/dev048-acceptance/`，未修改真实原生历史。

- Go：隔离远程源码检查 `sqlitestore`、`httpapi`、`personalagent` 全包通过（分别约 120s、393s、0.09s）；最后的归档变更再跑对应测试通过。证据 `.foundry/attachments/20261027/dev048/remote-go-safe-receipt.json`。本地第一次完整 check-changed 的 Go 全包与 51 个 store 相关测试也通过；其协议失败已独立修正/复验。第二次完整检查进程收到 SIGTERM（143），不视为完成；最终以聚焦 check-changed、已通过全包与对应增量回归组合记录，最后的聚焦 `scripts/check-changed.sh --files …` 全绿（256s）：格式、协议 build/13 合同测试、Web/Worker 全量 typecheck、4 个 HTTP 和 6 个 store 归档回归、contract audit。日志 `root-check-focused-final.txt`。
- 协议：13 个合同测试通过；contract audit 检查 300 个接口、127 个消息和 40 个 payload 通过。原始第一次集成检查暴露请求/结果 DTO 不一致，已经修正，保留原始失败日志而不标为通过。
- Worker：完整证据与测试边界见 `.foundry/attachments/dev048-worker-handoff.md`。原生归档/dispatch/host、历史扫描/重启、外部 Claude 数据目录全部通过；外部 home 最终四文件 check-changed 包含 11 个测试文件并通过。原始 broad run 的两个失败有独立完整文件重跑通过，原始日志不声称全绿。
- Web：核心 check-changed 通过（66 个相关测试文件、typecheck、10 项 UI audit），后续链接与 hydration 回归、全量 typecheck 通过。见 `.foundry/attachments/dev048-web-checks.txt`、`dev048-web-parent-links-checks.txt`、`dev048-archived-hydration-checks.txt`。
- 实际 dev：Codex 原生归档、app-server archived 列表、原生文件移动、Web Undo/恢复后继续发送通过；REST 发送与 enqueue 均得到 `409 session_archived`。MCP 父会话真实调用 `archive_session` 归档子会话，随后 `send_message` 返回 `session_archived`。
- 实际 dev：运行中的合成子会话使文件夹预检阻塞，显式取消后状态为 canceled，预检通过；确认后成员变化返回 409；文件夹归档暂停未来定时器，批次 Undo 后仍保持暂停；归档页真实键盘多选恢复两条会话，原文件夹位置不变；最终单独归档父会话时，独立 Foundry 子会话仍未归档。定时器最后显式 Stop，operation `wop_85a93afa8cd30e4baae0b85a8fbf12c7` 已 verified，revision 3 / observed stopped。
- 实际 dev：独立合成 Worker 停止后 Claude 归档为 Pending，重连自动变 Archived；原生 `claude --resume` 退出 1 / No conversation found。外部 Codex CLI 归档的未拥有会话被 Foundry 镜像，在真实 Web 恢复后原生文件返回 sessions。
- 实际浏览器：归档详情显示完整提示和答案，15 秒刷新后答案仍在；浅/深色与 390px 宽度下无水平溢出、无输入框；键盘确认、阻塞、批量选择与 Undo 已操作。截图见 `.foundry/attachments/20261027/dev048/deployed-*.png`；`deployed-archived-thread-dark-390.png` 是修复前问题截图，修复后以 `deployed-hydrated-child-*.png` 为准。集成回执 `e2e-integration-receipts.json`。

三个设计 open verification items 均已有 scratch 实测：Codex 父归档级联、父恢复不级联；Claude 过期清理删除 projects 旧文件而保留同龄 archive 文件（`.last-cleanup` 证明执行过）；Claude 已索引记录可以跨 project slug 恢复，移出 projects 后两种 cwd 均不能恢复。具体原生版本、脚本与限制见 Worker handoff 和 `.foundry/attachments/dev048-{codex-native-cascade,claude-native-probe,claude-cleanup-probe}.*`。

## 开发部署与回滚

2026-10-27 部署前，以 SQLite online backup 复制数据库并 `quick_check=ok`。备份 `~/.foundry/server/releases/dev048-archive/previous/foundry-20261027-115501.db`，同时保留原 Server binary、Web index/version 与 Worker release.json，未移动或删除数据库/WAL。

Server 二进制位于 `~/.foundry/server/releases/dev048-archive/foundry-server`，原子替换 PM2 `foundry-server` 已有 target `~/.foundry/server/releases/dev023-candidate/foundry-server`。最终 SHA256 `e35fbf0280f4ca98413e63cab7d50391bc104da9d13b62d8f9a362580a91bde5`；PID 1318064，healthz `startedAt=2026-10-27T04:21:51Z`。实际健康检查为 `http://127.0.0.1:31982/healthz`，public API/browser 同步检查。重启期间短暂 502 后恢复，未强制停止活动会话。

真实原生往返还发现恢复决策早于 runner 归档恢复 guard：设备未完成恢复时会把归档文件判成缺失并开启新原生线程。已将 Claude 恢复移至 presence 判定前，并将 archived Codex 历史视为可恢复；49 个聚焦测试包含完整合成 Claude SDK 启动，证明 options.resume/result/reported 保留原 ID，且不产生新会话警告。实际 dev 在安全空闲升级后的合成执行宿主上复验通过：e265a365-6b4a-406b-b0df-fb711981133b 原生归档后，两分钟保护到期，真实 Web Retry 成功；恢复后 SDK 继续同一个 native ID，返回 `DEV048 same native restored.`，未开启新线程。

Web 部署至 `/var/www/foundryapp-dev`，中间 build `347a2e79ccda81eb` 已验证 hydration 修复。后续 Archived 硬导航修复将数据 reconciliation 与显式选中分开；27 个路由/选择回归和 10 项 UI audit 通过，最后 build 内全量 typecheck 已通过。最终 bundle `b7db1353504bd230` 已部署，public version.json 与目录一致。真实硬导航复验及刷新证据为 `deployed-hard-route-final-*.png`。

Worker release 在 `~/.foundry/server/worker-packages`，最终已发布 `0.5.7-dev.81.gac22cc1.local.1793076524`（包括恢复顺序修复）。通过 Devices 使用的 `startSelfUpdate` 路径更新 dev-server，status=succeeded；第二次自更新 status=succeeded，runtime/current 指向最终新版本，但实际忙碌执行宿主 PID 1224409 仍加载 `.1793065621`，不会强停，空闲后才切换。该阶段 native_archive_v1 不得仅凭 daemon 新版本宣称可用。合成验收独立 Worker 已加载实现。

磁盘低于 AGENTS 阈值的远程机器按协调会话明确决定跳过更新，保持实际 loaded `.1793065107`（并非最初假定的 `.1793065621`），native archive 显示 unsupported。只清理核实可丢弃缓存，未删历史/数据库/正在使用的 runtime：

| 设备        | 删除缓存与分配大小                                                                                                                                   | 空间前 → 后                                               | 结果           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------- |
| linux-dev-3 | `~/.npm/_cacache` 25,312 KiB                                                                                                                         | 1.8 GiB / 100% → 同前                                     | 跳过更新       |
| mac-desktop | `~/.npm/_cacache` 1,014,488 KiB；`~/Library/Caches/go-build` 212,420 KiB；`~/Library/pnpm/store` 840,404 KiB；`~/Library/Caches/Homebrew` 75,704 KiB | 13 GiB / 94% → 14 GiB / 93%                               | 仍过阈值，跳过 |
| mac-laptop  | 清理调用断线，重连核实候选缓存仍在，未计入任何回收                                                                                                   | 起初 9.2 GiB / 98%；后来观察 19 GiB / 96%，不归因于本任务 | 跳过更新       |

远程设备版本/磁盘原始回执 `device-disk-and-version-receipts.json`；三条 compute leases 已 released。本地只回收四个已废弃、无进程/FD 的本任务 Go build 临时目录约 1.3 GiB；最终约 13 GiB / 88%。保留唯一回滚副本。

## 限制与后续验收

- Claude 有两分钟近期写入保护；native 状态可以为 failed，稍后 Retry。归档与取消归档并非原生操作的同步承诺，Foundry 状态立即保存，原生结果独立展示。
- Claude 两步 rename 普通错误有回滚；断电/硬杀及遗留锁恢复未验证，可能需人工检查冲突，绝不覆盖同名文件。Windows ps/lsof guard 未实测。
- 外部 Codex 归档若无 Foundry manifest，无法推断后代此前是否已归档；对 Foundry 归档的选择性后代恢复有实测保证。原生扫描保留每 root 2,500 文件上限。
- 部分设备因磁盘或忙碌宿主暂不具备原生同步；Foundry 状态、只读与拒发仍有效。
- 仍需人工验收以下明确范围；不把 Agent 自验证描述成用户测试。

1. 在 dev 合成工作区选择完成的会话，键盘进入归档确认；确认列出会话、暂停工作、原生级联含义。确认后列表消失，Undo 恢复原文件夹位置。
2. 打开已归档页，筛选、多选、恢复；进入归档详情看到完整历史、日期、操作者、设备与原生状态，输入框由只读说明代替。切换浅/深色并在窄屏确认布局。
3. 对运行会话所属文件夹归档应提示先停止；停止后归档，工作面板显示定时任务暂停。恢复会话后定时任务仍暂停。
4. 在支持新 Worker 的合成设备验证 Codex/Claude 原生历史往返；离线时 Pending，设备上线后自动收敛；原生失败可 Retry，旧宿主明确 unsupported。

### 最终收尾（2026-10-27）

Web `b7db1353504bd230` 的真实硬导航在工作区 hydration 与 16 秒后刷新均保留 Archived 页；显式选中父会话进入归档详情，完整答案加载且 waiting=false/composer=false。浅色 390px 的 `scrollWidth=390`，再过 16 秒答案仍保留。最终截图 `deployed-hard-route-final-{dark,light-390}.png` 与 `deployed-archived-parent-final-{dark,light-390}.png`。

合成 daemon 已通过原 tracked terminal 正常退出；合成执行宿主用官方 stopExecutionHost 生命周期停止，专属 systemd unit `foundry-execution-2f24728fc1335ada.service` 回执 MainPID=0 / ActiveState=inactive，旧 PID1342605 已不存在。浏览器已关闭。未来定时器的 verified Stop 回执见前文，未留下应执行的测试工作。保留合成只读会话与证据供验收；合成设备因此显示离线，离线恢复预期先显示 Pending。主设备的真实执行宿主未停止。

### 独立复核修正（2026-10-27，已部署与自验证）

协调会话根据独立审查 `sess_1793077327437782034` 要求修正：归档观察不得让已删除文件夹的 owner 或异常归档元数据中断整个设备注册/同步；窄屏列表 pane 必须显示 Undo 与错误；原生恢复应等待并重检并发锁、识别过期锁、完整读取 Codex 首行并拒绝无法识别的后代；Claude 归档源 fork 不应恢复源；Web 统一 Dialog、焦点回归、busy 拒绝、阻塞理由本地化和恢复行即时移除。实现、检查及重新部署结果在本节续记。

明确后续项（本轮不改变语义）：① Codex 每目标后代扫描、预检超时告警，以及 scanner 上限旁路的负载；② ListArchivedChats/attachArchiveChat 的 N+1 查询与 native_archive_targets 的 workspace/session 索引。

删除 Workspace 会清除 Foundry 原生目标记录，但 Claude 原生文件保留在 `<Claude数据目录>/archived_sessions/projects/<slug>/`；需要恢复时先确认会话已停止，再将对应 `<id>.jsonl` 与同名目录无覆盖地移回 `projects/<slug>/`（原路径可由归档 manifest 核对）。

复核修正进展：归档观察已改为 best-effort，owner/Workspace 的 ErrNotFound/NoRows 静默跳过，其余错误写日志而不回滚设备报告。新回归覆盖删除文件夹后才出现的原生 binding、后续 chat 与 agent 注册继续保存、异常归档 JSON 的 owned/unowned 两条路径；均通过。阻塞项补充兼容旧客户端的可选 code/issueId/workTitle，Server 在 dev 的真实预检已返回 `code=running`；此验证只给离线合成子会话排队，随后已确认取消，未发起模型请求。

复核 Server 已重新部署：SHA256 `7f5e026f5aca4723f283868e92570abc955efd4a258d33002557ba5305630a97`，PM2 PID1371124，health startedAt `2026-10-27T05:22:39Z`；本次无新增迁移，启动期间常规既有数据库维护约 55 秒后恢复健康。上一部署的 binary/index/version/release 元数据保存在 `~/.foundry/server/releases/dev048-archive/review-20261027/previous/`，原数据库备份继续保留。

远端复核：linux-dev-3 1.8GiB/100%，mac-laptop 18GiB/96%，mac-desktop 15GiB/93%，三者 installed/loaded 仍为 `.1793065107`；按既定磁盘规则继续跳过写入和 Worker 更新，本次未额外清理。三条临时 compute leases 均已释放，回执 `.foundry/attachments/20261027/dev048-review/remote-disk-versions.json`。

2026-10-27 用户通过协调会话明确确认审查项 10：保持简单统一的 D7，拥有控制权的 Agent 可以恢复会话，不区分原归档人，与 rename_session 一致；不更改授权语义。归档页继续显示归档人，归档与恢复审计补充 actorLabel/actorUserId/actorSessionId，明确操作人。此项已从待决定事项移除。

同日用户验收指出 FoundryDev 文件夹误报三条 legacy Claude 子代理为活任务；协调会话补充九条已结束会话中的 Codex unified-exec 终端记录也有相同问题。本轮优先修正：非运行/排队 owner 的 observed Claude/Codex 任务不暂停、不停止、不显示、不阻止归档；Foundry 独立子会话也不随父会话暂停，只有真正独立的 process/schedule 进入工作预检。保留真实阻塞时返回可执行的 Stop/Unlink 或文件夹移出操作数据，避免无法处理的 Open 链接。

按协调会话后续安全指示，实际用户文件夹不做归档/Undo；此前仅做过只读的五条成员与工作状态基线查询。真实数据的全量验收由协调会话在开发 DB 副本上逐文件夹/会话调用 Store DryRun 完成；本实施会话只用合成账号和五会话 fixture 做布局与可操作性验证，不创建 owner 浏览器认证状态。

Store DryRun 入口：`(*sqlitestore.Store).ArchiveChats(ctx context.Context, input store.ArchiveChatsInput, restore bool) (store.ArchiveChatsResult, error)`。文件夹输入 `WorkspaceID + GroupID + DryRun:true`，单会话输入 `WorkspaceID + ChatIDs + DryRun:true`，`restore=false`；检查 `result.Blockers`（DryRun 有阻塞时仍可返回 nil error）。归档路径使用不持久化修复的工作投影，新回归证明预检不重写旧 native work JSON。

最终复核 Server 包含无持久化修复的 DryRun：SHA256 `d3d55942e45a20802da055877c5936e9058210d54a075adeaea2349e6aa991aa`，PID1391205，health startedAt `2026-10-27T05:43:55Z`。工作动作元数据回归还证明：真实 managed process 阻塞项的 Stop 参数可直接调用既有 ControlSessionWork，收到 verified Stop 后再次预检不再阻塞。

Worker 复核修正已发布 `.1793079469` 并通过同一 Devices 自更新流程安装（status=succeeded）；主执行宿主 PID1224409 仍加载 `.1793065621`，保持忙碌直到安全空闲切换。七文件 checker 通过（79s、14 个测试文件），原生归档/session 聚焦 36/36，通过 stale-owner/两年旧锁/future/live-owner、300KB 首行与无效首行拒绝、归档 fork 源不变、并发恢复等待/重检等回归。

复核 Web 最终部署 build `59ec8d20e4642e40`（public version.json 与 `/var/www/foundryapp-dev` 一致）。23 文件最终 checker 通过（219.7s）：格式、全量 typecheck、54 测试文件、10 项 UI audit；最后小幅预检错误保护再跑当前 typecheck、聚焦 9/9、10 audits 通过。保留原始中途 fixture type 错误与 grid 审计失败日志，修复后不增加 UI 基线债务。

用户 B 样式反馈已按共享 Dialog 重做：短描述、带数量的紧凑单行/省略号滚动列表、可折叠原生说明、可选暂停工作、warning Alert 内的实际 Stop/Unlink/移出操作和 Refresh、禁用原因可见。合成五会话与 legacy-native 形状预检启用 Archive 5；真正 managed 阻塞有操作按钮，pending/failed 回执不提前放行，verified 后刷新解锁。源测试验证精确 API、revision、关联 revision 与作用域，样式与焦点在真实 Chromium 验证。

前后对照均在 `.foundry/attachments/20261027/dev048/`：`user-dialog-before.png` 为用户提供的原图；`dialog-after-five-{light,dark}-390.png`、`dialog-after-five-light-1280.png` 为新设计合成 fixture 的正常比例全页；`dialog-managed-blocker-{light,dark}-390.png`、`dialog-managed-pending-light-390.png`、`dialog-managed-resolved-light-390.png` 覆盖真实类型的控制回执状态（fixture 不声称停止真实 Worker 工作）。

实际部署浏览器补验：390px 列表 pane 中归档一条合成 native-only chat，Undo 可见；仅将本浏览器临时离线后 Undo 失败，错误仍在列表 pane 可见（width=390）；恢复网络后重试，API 与页面均确认合成 chat 恢复，错误清除。另在 1280px 关闭对话框，焦点返回原 Archive 按钮。截图 `deployed-dialog-review-light-390.png`、`deployed-dialog-review-dark-1280.png`、`deployed-review-undo-list-light-390.png`、`deployed-review-error-list-dark-390.png`。未操作用户真实文件夹，未创建 owner 认证状态；root 与 Web 验证浏览器均已关闭，未启动新的合成 Worker/定时工作。

根集成最终 checker 全绿（186s）：协议 build/13 合同测试、Web/Worker typecheck、3 个 HTTP 归档回归、38 个 store/work 相关回归、store 全包、格式/contract/module audits。额外 native-work eligibility、无持久化 DryRun、可执行 Stop 到 verified 的回归均通过；证据 `.foundry/attachments/20261027/dev048-review/`。本轮修改/新建清单 `files.txt`，完整功能合并清单 `full-feature-files.txt`。Worker/Go 中会创建 Git fixture commit 的既定测试仍留给协调会话，未扩大运行范围。性能项 6 继续为后续，D7 已由用户确认保持现状。真实工作区的全量 DB-copy DryRun 由协调会话负责，人工验收尚未代替用户完成。

## 2026-10-27 委托 Agent 准出（编排会话 sess_1793063405185071529）

用户于 2026-10-27 在编排会话中明确：“验证的话你自己接口级别+端到端级别自行验证吧”。以下为 Agent 自验证据，不代表用户本人测试；只关闭已验证范围。

- 结论：Foundry 侧归档通过（委托 Agent 准出）；linux-dev 原生归档待其执行宿主切换后自动收敛。
- 真实数据 dry-run：DB 快照上对本 workspace 4 个文件夹、98 个对话预检，用户文件夹 `claude遗体` 0 阻止项；仅正在运行的会话被正确阻止；预检前后 session_work 指纹一致（不修改数据）。
- 端到端（MCP，真实 linux-dev 会话 `sess_1793094096858842675`）：archive 成功；归档期间 send_message 返回 `session_archived`；restore 后发送得到回复 OK；最后再次归档。原生状态 `unsupported`（linux-dev 执行宿主仍为 dev.53；`workspace-ops.ts` 按宿主能力声明，重连时 `reconcileNativeArchives` 重试）。
- 浏览器（合成 fixture）：归档对话框、右键菜单、Toast+Undo，浅/深色、1280/390。

## 2026-10-27 CI 修复

- `archive_session` 补上 CLI 命令 `foundry session archive <sessionId> [--workspace] [--sessions a,b] [--group] [--restore]`（每个 MCP 工具都需有 CLI 命令，`foundry-skill.test.mjs`）。随下一次 Worker 发布生效。

## 提交

- 2026-10-27 夜间窗口经 PR #150 合并到 main（merge `60496ca`），本事项一个提交；多事项共用文件随最后改动它的事项提交。CI 首轮暴露的 Node 22 / 无 Claude CLI / 测试竞态问题在同一 PR 内修复。
