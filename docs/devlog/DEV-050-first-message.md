# DEV-050 · 长会话开场请求不可见

2026-10-29：已关闭（Agent 委托验收，用户 2026-10-28 授权），范围与保留限制见文末。

来源：[用户问题的协调会话](https://dev.foundryapp.app/chats/sess_1793063405185071529)、[实现会话](https://dev.foundryapp.app/chats/sess_1793083941049229028)。用户示例：[sess_1793071783626149651](https://dev.foundryapp.app/chats/sess_1793071783626149651?workspace=ws_56c549f3-a9cf-482e-a699-286c860b190c)。2026-10-27 实施；人工验收待确认，未提交 Git。

## 问题与根因

初次排查时服务端有完整的 640 条事件（此会话仍在继续，15:20 只读复查已增至 718 条），首条是 2026-10-27T03:29:43.626149651Z 的 `User message`。Web 初次只读最近 200 条，开场请求在第 4 页。模型层在已有其他用户消息时不会补一个 prompt；这符合事件作为对话记录的约定，缺失发生在分页入口与触发阶段。

1. `useChatTranscript` 离开聊天时清空 loader（包括 `earlier` 游标），但全局 `loadedSessions` 仍记得此聊天已加载；返回缓存聊天时没有重新读取，所以仍只有最近 200 条，顶部也不再有“加载更早的消息”。真实 Chromium 复现：切走再返回，`events=200 / calls=1 / scrollTop=0`，第一行是 `Synthetic follow-up 440`，无加载按钮。截图 `before-cached-return.png`。
2. Virtuoso 的 `startReached` 按首项 index 去重。加载前只有占位消息时即可消耗该回调，真实最近窗口取代占位消息后首项 index 未变，再滚到顶部不一定重新通知。单靠它不能可靠驱动历史分页。原组件 fixture 在初次打开后滚到 `scrollTop=0` 仍停留在最近 200 条，但手动加载入口有效。
3. 返回已有部分历史的缓存聊天时，新恢复的游标会先读到重叠页。即使事件合并后没有增加行，也必须按推进后的游标重新检查顶部；否则自动分页又停住。200 个工具事件被折叠成同一个短进度行时也会出现相同问题：页推进了，首行 index 却未变。

部署前也在完整 dev 应用复现同一缓存路径（e2e-alice，浏览器内隔离数据）：Web `fb84ebdf93ac9e78`，点击“新建对话”后再选合成长会话，聚焦列表 Ctrl+Home 并滚到 `scrollTop=0`，`recentReads=1 / pageReads=[]`，首行仍为 440，且加载更早入口消失。`deployed-before-cached-return.png`、`deployed-before-receipt.json`。

## 修改

| 层次            | 结果                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| transcript hook | 每次选中聊天都读取最近窗口，以恢复分页状态；事件继续 append-only 合并，已有历史不丢失。                                                  |
| virtual list    | 用公开的 `atTopStateChange` 跟踪实际顶部；仅在用户阅读历史时请求旧页，避免初始化跟随最新消息时预取。游标更新后再次检查仍位于顶部的视口。 |
| native history  | 原生聊天的加载回调也随可见历史游标推进而更新，使用相同顶部触发机制。                                                                     |
| 页面入口        | 保留现有常显的“加载更早的消息 / 正在加载 / 重试”，最终显示“对话开始”；无 hover-only 入口。                                               |
| model           | 仍使用真实事件，不额外插入 opening prompt，避免和第 4 页重复，也避免将 `session.input.prompt`（最新输入）误当开场请求。                  |

每次重新选中多读一个最多 200 事件的最近窗口。缓存包含较早页时可能读到重叠页；合并按事件 ID 保留全部历史，游标照常推进。

## 时间排序旁支

RFC3339Nano 去掉小数尾零，使 `.12Z` 的字符串序排在 `.123Z` 后，整秒 `Z` 又排在小数秒后。旧窗口查询在文字序中分页虽不直接遗漏记录，却会给出非时间序的页边界，而且与已按真实时间比较的 catch-up 游标不一致。15:40 对用户示例的 718 条事件只读比较，文字序与时间序恰好相同，因此这不是该示例缺失开场消息的根因；本次修复的是由构造边界测试证实的独立排序缺陷。`example-current-summary.json`。

`session_event_window_order.go` 保持原 `(session_id, created_at)` 索引，额外读全游标秒与截断页的边界秒，在 Go 中解析纳秒时间、以 rowid 破同刻平局，再截取窗口。代价是“一页＋两端秒内事件”，不扫描/排序整段聊天，不改旧记录、不新增迁移。多次边界查询通过已有 `readSnapshot` 在同一读取事务中完成，防止同秒并发追加在 count 与 page 之间消耗预留行数而提前结束分页。游标仍保留原始时间与 rowid，格式兼容。

测试覆盖整秒、小数秒不同精度、同刻事件和每一种页大小；每个窗口的 newest 游标还通过 catch-up 反向核对。

## 自验与证据

证据目录：`.foundry/attachments/20261027/dev050/`。

- `chat-history-paging.test.mjs`：640 事件、四页、失败/重试、resync/repair、重选缓存、重叠页回调重新触发，及模型层开场请求只出现一次。`paging-unit-tests.txt`。
- `scripts/check-changed.sh --files …` 全部通过：格式、Web typecheck、54 个聊天相关测试文件、4 个 storage window 测试、11 项 UI audit 与模块审计；日志 `check-changed.txt`。最后的短视口触发条件由 compact 浏览器补验，最终 Web build 另含全量类型检查。单独执行 `pnpm audit:ui` 同样通过，`audit-ui.txt`。
- 最后补充的读取快照护栏经 window/catch-up focused Go 回归通过（5.888s），`server-snapshot-tests.txt`；已随 DEV-051/052 合并 Server 候选部署（16:19），初始 15:31 binary 不含此护栏。
- 原生聊天历史回归：`native-history-tests.txt`。
- Server window/catch-up 相关测试及真实源数据只读核对通过。`example-readonly-windows.json`：200/200/200/40，640 个唯一 ID，首事件 `evt_8a7e25b2-f7f4-4b89-8c35-452ac6779dd8`，开场文本只留 SHA256。诊断使用生产 SQLite 的 `mode=ro`＋`query_only`，未调用迁移、未修改用户会话；临时诊断测试已移除。
- 折叠工具历史：`?compact=1` 的 200 个事件仅渲染成不足一屏的进度/后续输入；初始恰好一次请求，聚焦列表按 Ctrl+Home 后连续读至 640 条，`scrollTop=0`、开场请求可见。`compact-window.png`、`compact-browser-receipt.json`。
- 本地真实组件 fixture：仅 transport 为合成数据；使用实际 hook、事件合并、模型和 Virtuoso。初始请求只读 200 条；滚到顶部逐页读取至 640，开场消息唯一且实际矩形位于视口内；返回缓存后仍可到达。`after-{light,dark}-{1280,390}.png`。
- 最终部署 Web `f0af1c5d7df5517d`：e2e-alice 登录完整 dev 应用，初次仅最近 200 事件，点击“新建对话”后返回缓存聊天，最近窗口请求从 1 次变 2 次；聚焦列表 Ctrl+Home 并向上滚动，连续请求游标 440 / 240 / 40，合并为 640 事件、320 个用户 turn，开场请求实际矩形在视口内。1280×900 与 390×844 的浅/深色四张全页截图均人工查看，开场请求、对话开始和输入区可见，均无水平溢出。`deployed-browser-receipts.json`、`deployed-{light,dark}-{1280,390}.png`。浏览器 errors 为空。
- 加载失败保持原游标；可见 Retry 聚焦后 Enter 成功，busy 按钮禁用。`retry-error.png`、`retry-focus.png`、`loading-earlier.png`。390px `scrollWidth=390`。

## 部署

Server 2026-10-27 15:31 恢复健康；PID `1455280`，health `startedAt=2026-10-27T07:31:20Z`。release binary 与 `/proc/1455280/exe` 的 SHA256 均为 `191e6922bc991c4d36018ee9507b1dbb2e20c97ffa87646f6e64662e0bd272cf`。`server-check-build.txt`（HTTP window 回归通过）、`server-health.json`。PM2 继续使用已有显式 `FOUNDRY_DB_PATH`，约一分钟启动维护期间短暂 502 后恢复，未停止 Worker/运行中的 Agent。16:19 由 DEV-051 合并部署读取快照护栏：PID `1492872`，health `startedAt=2026-10-27T08:19:12Z`，loaded/artifact SHA256 `315645e9da1e43d665ad5190c91492e1d388e91eb22aad12e8ad0c3e6827bcd7`。包含 DEV-051 local_files 与 DEV-052 migration；复用 DEV-052 在线备份 `~/.foundry/server/releases/dev052-device-connectors/previous/foundry-20261027-155245.db`（quick_check=ok），未增加 DB 副本或清理缓存。回执 `.foundry/attachments/20261027/dev051/server-{loaded,artifact,health,public-api,build-budget}.json`。最终浏览器验收版本为 Web `f0af1c5d7df5517d`（16:22 DEV-052 基于当前主树构建，覆盖 16:21 DEV-049 候选 `3b449cf945b20c61`）；DEV-049 确认三个 DEV-050 Web 源文件与其冻结候选逐文件 SHA256 相同。typecheck、11 UI audits、核心菜单/归档/Toast 回归与 Vite build 由 Web 发布方通过；DEV-049 其余全项目旧断言迁移不计入 DEV-050 通过范围。部署后的四页/返回缓存及四种主题尺寸验收通过，见上文证据。

DEV-050 本身无迁移；初次独立 Server 发布按协调会话要求复用当天已有备份 `~/.foundry/server/releases/dev048-archive/previous/foundry-20261027-115501.db`，不再复制数据库。

上一 Server binary、Web index/version 已保留在 `~/.foundry/server/releases/dev050-first-message/previous/`；Web 与 DEV-049 共用一次最终构建部署，旧 assets 保留。Worker 不涉及。

## 验收步骤与局限

1. 刷新 dev，打开用户示例长会话，向上滚动至最早部分。每次到已加载部分的顶部会继续读取；读完后应看到“对话开始”及开场请求。
2. 切到另一聊天再切回，重复上述动作；“加载更早的消息”应始终可达，直到所有页读完。
3. 窄屏/深色同样可读；遇网络失败应保留重试入口，重试后继续，而不是丢消息。

不登录为用户、不修改用户真实聊天。用户示例目前核对的是生产数据经实际 Store window 函数的只读分页结果；实际 dev 浏览器验收使用 e2e-alice 和浏览器内隔离的合成 API transport，不将 stub 结果冒充真实模型或用户页面操作。这覆盖真实应用的分页交互与渲染，但没有以用户身份调用该真实聊天的 HTTP window 路由，亦未声称操作过用户页面；实际 Store 的只读结果和 HTTP handler 回归分别提供服务端证据。人工验收仍待用户确认。

## 时间线

- 2026-10-27 15:31：DEV-050 初版 Server 发布、健康，Web 候选等待其他事项共同构建。
- 2026-10-27 16:19：DEV-051 合并发布最终读取快照护栏，实际 PID / SHA / health 已核对。
- 2026-10-27 16:28：DEV-050 在 Web `f0af1c5d7df5517d` 完成合成 transport 部署后浏览器自验；代码未提交，用户示例人工验收待确认。

## 2026-10-27 委托 Agent 准出（编排会话 sess_1793063405185071529）

用户于 2026-10-27 在编排会话中明确：“验证的话你自己接口级别+端到端级别自行验证吧”。以下为 Agent 自验证据，不代表用户本人测试；只关闭已验证范围。

- 结论：通过（委托 Agent 准出）。证据：编排会话在 640 事件 fixture 中实测浅色 1280 / 深色 390：初始 200 条，上滑后加载到 640 条，顶部显示“对话开始”与首条用户消息。

## 2026-10-29 Agent 委托验收（用户 2026-10-28 授权）

- 委托：用户 2026-10-28 约 23:35 在编排会话 `sess_1793063405185071529` 中把发布验收委托给 Agent（“验收这块，你先做到你自己去端到端验收，没问题的话，大概率就OK了……”）。以下是独立验收 Agent `sess_1793201829998538711` 在 2026-10-28 23:37 至 2026-10-29 00:40 取得的证据，不代表用户本人测试；只关闭已验证的范围。
- 环境：真实 dev（Web `b0ba3d5929f1811e`，Server `51c00263…`），e2e-alice 登录（密码只由脚本从仓库外文件读取）。DEV-048 合成设备临时用已发布的 Worker `.1793191889` 运行，验后停止；合成工作区 `ws_d4da0f57-…`。一条合成 Codex 会话 `sess_1793202140770104457`（gpt-6.1-sol，8 个短回合）同时用于 DEV-051/054/055/057/063/064/065，验后已归档。截图在 `.foundry/attachments/20261028/acceptance/<item>/`，不入库。
- 在当前 Web 上复跑本项的浏览器内只读 640 事件合成 transport（`deployed-fixture.js`，不写数据、不运行模型）：浅色 1280 初始 100 回合，切到新对话再返回仍为 100 回合；向上滚动后 3 次分页读取，加载到 320 回合，开场请求在可视区内；深色 390 同样加载到 320 回合并看到开场请求；两者均无横向溢出。截图 `dev050/opening-{light-1280,dark-390}.png`。
- 仅 Agent 证据：用户的真实长会话没有以用户身份打开，服务端结果沿用 10-27 的只读 Store 核对。网络失败后的重试入口本轮未复测。
- 结论：已关闭（Agent 委托验收）。

## 提交

- 2026-10-27 夜间窗口经 PR #150 合并到 main（merge `60496ca`），本事项一个提交；多事项共用文件随最后改动它的事项提交。CI 首轮暴露的 Node 22 / 无 Claude CLI / 测试竞态问题在同一 PR 内修复。
