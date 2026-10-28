# Foundry Devlog

按事项维护当前状态，并在事项下按时间追加进展。待办、优先级与完成标准只在 [Roadmap](../roadmap.md) 维护；本页记录已启动事项的执行过程与证据，Roadmap 的“详情”列链接到这里。同一事项跨 session 延续时沿用编号，不按 session 重复建项。

首次整理：2026-10-19。初始证据范围为北京时间 2026-10-18 00:00 至 2026-10-19 13:35 有活动的本 workspace session，包括其中追溯的较早进展。初始状态以该时间点为准；2026-10-19 已按用户反馈更新验收和接续安排，不代表持续实时监控。

## 记录约定

- 六个环节分别记录：问题理解/调研、代码、dev Server/Web 部署、Worker 更新、Agent 自验、人工验收。部署和更新填写具体环境、设备或版本。
- 状态使用：未开始、进行中、已完成、待验证、待确认、不涉及、暂停。没有证据写“待确认”，不推断为未做。
- 代码实现、提交合入、发布包、设备实际加载分别描述；Session completed、测试通过均不代表人工验收通过。
- 有进展时更新总表，并在对应事项的流水末尾追加“时间、变化/证据、剩余动作”。修正旧结论也追加记录，不抹去原始过程。
- 人工验收仅记录用户明确确认及范围；授权实施、反馈“更新了”不算验收通过。用户可明确委托 Agent 准出，须记录委托日期、来源和验证范围，标明“委托 Agent 准出”，不得写成用户亲自测试。
- 时间统一使用北京时间（UTC+8）；只有日期的记录不推断具体时刻。来源中的状态若被后续证据覆盖，以后续记录为准。

## 当前事项总表

2026-10-29 浏览器工具：[DEV-077 playwright-cli 开箱可用，agent-browser 不再外泄代理密码](DEV-077-browser-tools-env.md)。playwright-cli 0.1.22 只找 `chromium-1247` 或 Chrome 稳定版，会话环境现在用 `PLAYWRIGHT_MCP_EXECUTABLE_PATH` 指向本会话的 Foundry 浏览器启动器（设备已有的 Playwright Chromium），不再下载第二个浏览器。agent-browser 0.38.2 会把 `HTTP(S)_PROXY` 里的用户名和密码写进 `launch` 参数，广播给无鉴权的本地画面流；现在凭据拆到 `AGENT_BROWSER_PROXY_USERNAME/PASSWORD`，`launch` 里不再出现，代理认证照常生效；密码登记为已知秘密，转写、事件和 Worker 日志里都会去掉。画面流本身无鉴权、启动时无法关闭，已写上游 issue 草稿（未提交）。Worker `.1793222409` 已发布到 dev，daemon 已加载；执行宿主空闲切换后生效。人工验收待确认。

2026-10-29 Workspace 服务：[DEV-076 常驻 Web 服务与远程访问](DEV-076-workspace-services.md)。从未可用的根因：预览域名未配置，且同站模式用的三级域名不在 Cloudflare Universal SSL 覆盖内。改为每个服务一个一级子域 `<名字>-<随机>.foundryapp.app`（独立源，SPA 可挂根路径）；Server 自检公网路由，未验证前不给 Open 链接；Worker 上报监听端口，显示 Running / Not running / 最后在线，并把 Workspace 目录里未登记的服务列为 Detected 可一键发布；Agent 起长驻服务后调用 `register_service`；卡片去掉会话信息，可移除映射；同站威胁逐项加测试。Server/Worker（dev 服务器设备）已部署，Web 随 DEV-075 联合部署；公网可用待本人应用 nginx 配置（文件与回滚命令见条目）。人工验收待确认。

2026-10-29 验收修复：[DEV-073 委托验收遗留问题（DEV-055 开关、DEV-063 小问题、合成设备凭据）](DEV-073-acceptance-fixes.md)。关闭“从会话打开工作区外文件”后路径仍是链接：设备状态事件替换设备时丢了只给所有者的 `outsideFilesOff`，开关在页面里回到开启；改为统一保留查看者专属字段，读取合并也取读取值。复选框保存时用 `aria-disabled`，焦点不再丢到 body。问题卡片在回合结束时实时收起（正在作答时不收）；回合导航对回答显示“回答了 Agent 的提问：B”，不再显示信封。DEV-048 合成设备凭据已轮换（旧凭据 401）。dev Web `95d45cc1fa3ac9b5`（含 DEV-071 第二轮），单测 948/948，真实 dev 浏览器自验通过；人工验收待确认。

2026-10-29 实施：[DEV-075 Agent 实时画面 第一期：每步截图](DEV-075-tool-step-screenshots.md)。工具已经返回给模型的截图（Playwright MCP、computer_use 等 MCP 图片，agent-browser / playwright-cli 报告的截图文件）现在会挂到对应步骤：过程组下显示缩略图和“查看画面”，右侧 Context 有“画面”详情（最新帧、胶片条、键盘操作），面板不会自动打开。图片保存在执行设备的工作区里，只有会话查看者能通过会话路由读取，不进入 MCP 和交接；每个会话保留 200 张 / 50 MB，更旧的显示为已清理。不读取 agent-browser 的原始画面流。dev Server `bacef1e6…`、Web `8d54a6ed0632c60e`、Worker `.1793219656`（dev 服务器设备 daemon 已加载，执行宿主待空闲切换）；真实 dev 合成会话产生 3 帧，light/dark × 1280/390 浏览器自验通过；人工验收待确认。

2026-10-29 调研：[DEV-074 Agent 浏览器 / 电脑操作的实时画面](DEV-074-agent-live-view-research.md)。用户希望像 Codex 桌面 App 那样在聊天页看到 Agent 正在操作的浏览器/电脑画面。结论：分三期——P1 把工具已产生的截图（Playwright MCP、computer_use、agent-browser / playwright-cli 截图文件）挂到工具步骤，行内缩略图 + 右侧 Context “画面”详情（4–6 人日）；P2 有人观看时只读转发本会话 agent-browser 的 CDP 画面流，只转帧、限速、可丢（7–10 人日）；桌面连续画面与接管暂不排期。实测 agent-browser 原始流带启动参数（含代理密码）且本地端口无鉴权，不可透传。仅调研，无代码；待用户就分期、自动展开、默认开关、保留期与分享范围做决定。备忘：[agent-live-view-20261029](../research/agent-live-view-20261029.md)。

2026-10-29 提示统一：[DEV-071 去掉顶部整宽横幅，提示分临时 / 常驻 / 就地三类](DEV-071-unified-notices.md)。顶部 “Local API is not reachable” 是误报：服务器 00:00 前后没有重启；一次后台读取失败就会置为 fallback，而事件流续传时不再读取，横幅因此一直挂着。修复：失败后每 4 s 重读，持续 8 s 才提示，文案改为 “连接不上 Foundry 服务器 · 正在重试”。提示分三类：临时反馈用 Toast，按视图放在避开输入框的角落（对话类在右上，其他页面右下，窄屏顶部），悬停/聚焦暂停，可带动作；全局常驻状态用新组件 StatusIndicator，在侧栏品牌行显示胶囊，详情放弹层，有 live region，不推动页面；就地说明用 Alert。归档对话提示移到输入框位置，Skills 页顶部的错误改为 toast，后台读取失败不再弹 toast。第二轮新增统一加载组件（Spinner / LoadingState / Skeleton / Button busy），迁移约 60 处纯文字加载提示，修正 toast 垂直居中，删除发送后的 “is responding” toast。第一轮 dev Web `ce2e4fe1ec59fa5e` 已部署；第二轮随 DEV-073 发布于 dev Web `95d45cc1fa3ac9b5`，Web 单测 948/948，在线复验通过；人工验收待确认。

2026-10-29 消息失败：[DEV-072 后台任务运行时消息失败（运行时 key 随窗口来源变化）](DEV-072-runtime-key-context-window.md)。根因：运行时 key 把 `contextWindow.source` 算在内，而兼容端点的 `/models` 目录每回合读一次（5 s 超时，失败回落到官方窗口表），一次读取失败或恢复就让同样的 1M 窗口变成“另一份配置”；旧进程空闲时被静默替换，有后台任务时拒绝，消息失败。不是 DEV-068 输入框或 Server 引起的。修复（Worker）：key 只认窗口大小；目录读取失败时沿用上次成功的结果；key 变了但进程只在跑后台任务、定时器或自己续跑的回合时，消息交给该进程并说明哪些改动（模型/推理强度/权限）等后台工作结束后生效，换账号时拒绝并说明怎么做。Web：失败 toast 文案注明原因在对话里。Worker 全量 989 项 0 失败；已发布 `.1793206791`；10-29 01:33 用户 Linux 开发机 经 “立即切换” 换到新运行器（页面误报失败：新运行器首次扫描阻塞约 106 s 才应答，daemon 约 10 s 就放弃；已在 `.1793209725` 修复，首扫不阻塞、按心跳等待、切换启动即返回）。10-29 又修了两处：一是设备待切换时新回合被扣留长达 30 分钟（新版本还会重置扣留起点），改为最多扣留 30 s 且不重置，等待时会话里显示 “Worker update in progress”（Worker `.1793213531`）；二是从未开始就被取消的消息不会出现在下一回合的上下文里，现在会带上并注明 “No answer”（Server `43f11448…`，已 SIGHUP 上线）。dev 服务器设备 连接服务已到 `.1793213531`；用户 Linux 开发机 今晚按用户要求不再改动。人工验收待确认。

2026-10-28 代码隐私清理：[DEV-070 公开仓库代码隐私清理](DEV-070-code-privacy-scrub.md)。接续 DEV-069，把源码注释、约 50 个测试夹具和 Personal Agent 提示词中的真实设备名、用户名、内部项目名、同事姓名和第三方网关域名换成中性名字；提示词按规则升版本为 `2026-10-28.1` 并用 `-update` 重生 golden，diff 只有名字。产品行为不变，不需部署；Git 历史不改写。

2026-10-28 隐私清理：[DEV-069 公开仓库文档隐私清理](DEV-069-privacy-scrub.md)。把 main 上较早文档中的用户名与 home 路径、真实设备名、登录邮箱、内部项目名和公网 IP 换成通用描述（`~/`、`<user>`、`dev-server`、`linux-dev`、`mac-laptop`、`203.0.113.x` 等），含设备名的调研文档改名；redact 注释与三处测试的公网 IP 改为文档地址，Go 测试通过。只改文字，Git 历史不改写；代码夹具与提示词中的设备名留待单独决定。

2026-10-28 聊天文件面板：[DEV-065 路径可复制、Diff/File 切换保留焦点、下载移入标题栏](DEV-065-chat-file-panel-polish.md)。回答里的路径和面板路径都加了复制按钮（回答里悬停或聚焦时显示，触屏设备常显；复制后显示 “Copied”），面板路径文字可选中。切换 Diff/File 后焦点丢失的原因是两种模式的根组件类型不同，React 重建了分段控件；现在两种模式共用同一个 document，焦点保留。“Download file” 那一行改为标题栏 X 旁的下载图标（Tooltip，busy/错误状态；busy 时焦点不丢），进度和失败原因只在有内容时显示在正文。只改了 Web；tsc、web tests、audit:ui 通过；dev Web 已发布 `b0ba3d5929f1811e`，真实浏览器矩阵（light/dark × 1280/390、键盘）通过。验收：打开 https://dev.foundryapp.app/chats/sess_1792897906152291224?workspace=ws_7a62ebd5-ba52-46df-8306-c23ad1c22c51 。人工验收待确认。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-28 会话运行器切换：[DEV-066 运行器排空切换（含 DEV-067 卡死运行器回收）](DEV-066-runner-drain-switch.md)。运行器只在被问到的那一刻空闲时才换版本，用户 Linux 开发机 因此停在 dev.53 约 6 天。修复：装了新运行器后进入 pending，新回合留在 daemon（Server 侧保持 queued），运行中的回合跑完再切换，最多扣留 30 分钟，回合不会被自动停止；所有者可在设备页用 “立即切换” 停止列出的回合（409 防止误停新回合）。设备页 Worker 一节分为 “连接服务 / 会话运行器” 两行，列表有 “运行器待切换” 徽标。DEV-067（用户的 Mac 离线 34 分钟）：卡死运行器（接受连接不回复、忽略 SIGTERM）按心跳和握手判定后，bootout 并按 identity KILL 回收；daemon 不再被运行器阻塞，启动即有心跳；运行器 fatal 或阻塞超过 5 分钟时 SIGKILL 自身；macOS watchdog 也守护运行器；更新要等新 worker 上线才算成功。dev 服务器设备 scratch 真机验证：排空切换、浏览器里的立即切换、SIGSTOP 卡死 74 s 内回收。已部署 dev（Server `51c00263…`、Web `6796efb44e5fdab8`、Worker `.1793191889`）；用户 Linux 开发机 的连接服务已更新，运行器仍是 dev.53，等一个受管后台任务结束后自动切换（未强制）。人工验收待确认。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：未关闭**——dev 服务器设备 运行器仍为 `.1793172116`；用户 Linux 开发机 运行器按用户决定等待后台任务结束后自动切换。

2026-10-28 默认智能体：[DEV-068 工作区与渠道的默认智能体（账号 / 模型 / 推理强度）](DEV-068-default-agent.md)。此前一个工作区默认用哪个账号、模型和推理强度无处可设，飞书会话也不能单独指定。现在不指定账号的启动按以下顺序解析：显式指定 → 飞书会话的单独设置 → 机器人默认 → 工作区默认 → 本人最近使用或本人默认 → 第一个可用；每一级可只设部分字段，其余沿用下一级。配置的账号不可用时跳过，会话照常启动，并在会话记录（飞书另回一张卡片）里说明改用了哪个账号。新表 `agent_defaults`，API `GET/PUT /api/workspaces/{id}/agent-defaults`。Web 新增：“Agents & execution” 里的 “Default agent”、Channels 里机器人的默认与会话的 “Set agent for this chat…”、新对话预选默认并注明来源。Go/Web 测试、scratch 栈 API 与浏览器矩阵均通过；已随 DEV-066 共享树上线（Server `51c00263…`、Web `6796efb44e5fdab8`），dev 上 API、浏览器矩阵与既有会话核对通过；人工验收待确认。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-28 Diff 可用性：[DEV-064 Change 面板 “Could not load the diff”](DEV-064-diff-availability.md)。根因：详情面板只凭 `inGitRepo` 就按 Change 打开文件，于是 Git 仓库里只被回答提到的文件（shell 或其他会话写的，ledger 为 `reference`）也显示 Diff 页签，而 Worker 只给工具写入的文件出 diff，所以必然失败。dev 库统计：3,439 个 Change 视图条目中 448 个（13%）属于这种情况。修复：只有工具写入的文件才是 Change，被提到的文件直接按 File 打开；Worker 在回合结束时上报 `diff`/`totalDiff`（text/binary/tooLarge/noBaseline），Web 据此预先隐藏 Diff 页签并注明原因，新文件加 “New file” 徽标；旧设备上的 binary 文件不再请求文本 diff。不用 Git HEAD 给被提到的文件造基线，以免把别人的改动算到本聊天。scratch 栈真实 Codex 回合加浏览器矩阵（light/dark × 1280/390、键盘）通过；Server（`edac08df5a13b9fc`）和 Web（`b3d2617e4d7a847c`）已在线；Worker 已含在发布的 `.1793172116`，dev 服务器设备 执行宿主待切换（DEV-066）。人工验收待确认。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-28 Server 重启：[DEV-062 部署重启导致 1–2 分钟 502](DEV-062-server-fast-restart.md)。根因是每次启动都在约 1 GB 库上先跑全表 JSON 回填和孤儿清理（DB 副本上 13.6 s，线上冷缓存约 63 s），跑完才监听。修复：一次性迁移记录在 `applied_migrations` 中只跑一次；孤儿清理和 digest 脱敏移到就绪后的后台，分批短写；bcrypt dummy hash 不再阻塞启动；先监听再开库，就绪门持有请求，`/healthz` 就绪前返回 503；停止时先停 accept，避免丢弃请求；可选的 `FOUNDRY_RESTART_HANDOFF=1` supervisor 用 SIGHUP 做 socket 交接，零拒绝；Web 的 GET 静默重试，Worker 重连加抖动。dev 已部署（与 DEV-057 合并，sha256 `aa09f6b2…`）：稳态重启 328 ms 就绪，nginx 从约 200 个 5xx 降到 3 个 502；副本上 SIGHUP 交接 1290 个请求 0 个 5xx。15:39 起 dev 以 supervisor 模式运行（pm2 app 用干净环境重建，去掉泄漏的会话变量），SIGHUP 交接期间 nginx 0 个 5xx；人工验收待确认。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-28 Agent 提问：[DEV-063 Agent 结构化提问显示为纯文本](DEV-063-interactive-agent-questions.md)。截图中的三选一问题来自 Codex 非阻塞工具 `request_user_input_async`（gpt-6 系列默认启用）；Foundry 原先只保留后备文本。第一阶段已实现：Worker 保留 `questions`，Server 存储并支持入队即 steer（`steer: true`，`boundary`），Web 显示问题卡片（单选/其他回答/键盘；等待、已回答、按假设继续、未回答；收起后可迟到回答），回答使用 Codex 官方的回答信封。scratch 栈上真实 Codex 回合内与迟到回答均通过；dev Web 已发布 `421f79759d57b573`。待设备 runner 切到新 Worker（DEV-066）和下次 Server 部署（回答默认 `boundary`）；通知列为后续；阻塞式提问暂缓。状态：待人工验收。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-28 数据库锁：[DEV-059 Timers 面板 “database is locked (SQLITE_BUSY)”](DEV-059-sqlite-busy.md)。根因有两层：一是事务以延迟方式开始，读后升级为写时 SQLite 不走 busy handler，别的进程持写锁就立即 500；二是 `foundry-server users reset-password` 在线上库上跑完整 migration 和清理，持写锁 4.7 s。修复：写事务改为 `BEGIN IMMEDIATE`（等待 busy timeout）；不改变内容的保存与观测走读池，不取写锁；读 Timers 时导入遇锁只降级不报错；锁超时返回 `503 database_busy` + `Retry-After`；`users`/`devices` CLI 改为 admin 模式（不跑 migration/维护）；Web 显示“正在重试”并自动重试一次；设备轮询把 workspace 查询移出 `workMu`、去掉无变化写入。与 DEV-055/060 合并部署：Server `61e2c75f0adfb0d6`，Web `5581a718c528ce0b`。线上 `/work` p90 从 1.88 s 降到 0.28 s，设备 POST p90 从 1.37 s 降到 0.70 s；scratch 栈上真实浏览器在 8 s 锁窗口与注入 503 两种场景下都不出现红卡。人工验收待确认。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-28 Codex 自动 compact：[DEV-061 Codex 会话没有自动 compact，撞满上下文后卡死](DEV-061-codex-auto-compact.md)。`sess_1793108134561127918` 连续 5 回合 “ran out of room”。端点目录报总窗口 1,048,576，Foundry 原样传给 Codex，Codex 在 90%（943,718）才 compact，而端点约 922K 即拒绝（与同端点 921,600 一致）；被拒后 Codex 0.164 把活跃上下文估成 0，此后不再预检 compact，每回合重发整段历史。Worker 修复：兼容端点写 `model_auto_compact_token_limit` = 窗口 × 80%；回合因 `contextWindowExceeded` 失败时调用 `thread/compact/start` 并续接一次、告知用户、不丢历史。单元测试与真实 Codex 0.163 + 本地 mock 端到端通过；联合 Worker `.1793172116` 已发布，用户 Linux 开发机 daemon 已加载，执行宿主待空闲切换，人工验收待确认。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：未关闭**——无线上样本，待用户 Linux 开发机 运行器切换后在兼容端点会话上验证。

2026-10-28 归档性能：[DEV-060 归档检查与归档请求过慢](DEV-060-archive-performance.md)。主因是工作列表查询带 `json_each` 的 OR 分支导致 `session_work` 全表扫描并逐行解析 JSON（约 87 ms/次，每个会话多次）；改为索引 UNION（1 ms），dry-run 走只读快照且不等 `workMu`，设备预览并发限时 3 s，归档列表批量读取，后台标签页不轮询。DB 副本上检查 10 个会话 4.4–5.1 s → p95 223 ms，归档 4.9 s → p95 323 ms；1–4 个会话均低于 100 ms。已随 DEV-055/059 合并部署 dev；线上 nginx 检查 32 ms、归档 110 ms、恢复 18 ms；待人工验收。 已经 PR #154 合并到 main。 **2026-10-29 已关闭**：Agent 委托验收（用户 2026-10-28 授权）测得设备在线时归档检查 0.4–1.4 s，用户确认可以接受。

2026-10-28 外部连接用量：[DEV-058 外部连接的用量展示](DEV-058-external-connection-usage.md)。订阅看板只覆盖本地订阅登录；外部连接每回合的 token 与标价估算已记录在 `turnUsage`，可按连接聚合展示。额度百分比 Foundry 单方面拿不到（SDK `get_usage` 经 helper 代理不会被转发，协议 v1 无 usage 动词），可行来源为被动记录 CLI 的 `rate_limit_event`（网关是否透传待实测）和协议新增的 helper 自答 `usage` 请求（需 helper 维护方实现）。[调研与设计](../research/DEV-058-external-connection-usage.md)。状态：已关闭（用户决定不实施：Limen 官方未提供用量前不做，也不做 Foundry 侧统计）。已随 PR #152 合并（merge `29fe37c`，2026-10-28 夜间窗口）。

2026-10-28 会话协作：[DEV-057 子会话 steer 频率分析](DEV-057-subsession-steer-frequency.md)。只读分析 `sess_1793108134561127918` 与子会话的消息往来：46 条 agent 间消息中 35 条以 steer 注入运行中回合，子→父 11 条（4 条真阻塞），父→子 35 条（约 26% 可省或合并）；父会话编排回合 89+ 分钟未回复用户。结论为频率偏高、打断过多，建议消息分级 + 汇总投递、Prompt/brief 约定、状态通道与幂等发送。10-28 补充调查：Claude 官方默认就是工具边界队列（`priority` 分 now/next/later）；Codex 0.164 的 steer 会立即抢占推理（7/11 的子会话 steer 打断了父会话推理）。建议三档 `interrupt`/`boundary`/`turn_end`，并改用收件箱，不再丢弃 “not accepting active steer input” 的消息。10-28 用户批准后实现：会话间消息走 Server 持久收件箱，不再丢弃（held/unknown/accepted/delivered/consumed 回执、`inputId` 幂等、10 分钟同文本去重）；`send_message.delivery` 分三档 interrupt/boundary/turn_end（会话发出的消息默认 boundary，interrupt 每 30 分钟 2 次，boundary 最长 15 分钟，turn_end 最长 10 分钟）；Codex 的 boundary 由 Worker 等工具运行时再 steer；foundry Skill 修订到 11。Server 随 DEV-062 部署（`aa09f6b2…`，07:22Z 起健康），线上合成会话验证了排队时 held、不可 steer 时 held 后补投、重复去重、turn_end 回合结束后 consumed；Worker `.1793172116` 已发布，Codex boundary 的线上验证要等执行宿主切换；验收步骤见条目。人工验收待确认。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：未关闭**——interrupt 降级（步骤 4）与真实设备 Codex 会话上的 send_message boundary（步骤 5）待运行器切换后补验。

2026-10-28 链接按钮对齐：[DEV-056 链接按钮与上方文字左对齐](DEV-056-link-button-alignment.md)。共享 `link` 变体去掉尺寸带来的左右内边距和边框，归档 Toast 的 Undo 及列表/说明中的链接与同列文字左对齐；5 处原本借内边距作间距的调用改用 `size="inline"` + 空格，或新增的会话链接列表 gap。首次发布 `bf02cf6e76e0debc` 漏带 `VITE_API_BASE_URL=`，10-28 00:22–00:34 dev 所有 API 指向用户本机，已回滚。之后加上生产默认同源与 `scripts/deploy-web-dev.sh` 发布防护，经该脚本发布 `f90e5a18c022a3d3`，真实浏览器 API 均同源；人工验收待确认。已随 PR #152 合并（merge `29fe37c`，2026-10-28 夜间窗口）。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-28 Foundry 链接：[DEV-054 id 自动成链与无 workspace 链接路由](DEV-054-foundry-id-links.md)。消息中的 `sess_/iss_/dev_/ws_` 由渲染管线识别成真实链接（代码块和已有链接除外，原生 id 只显示 title），同源 Foundry 链接在应用内打开；`/chats/<id>`、`/issues/<id>` 不带 workspace 时自动打开对象所在的 workspace（replaceState，自动切换为可调整的推荐方案）；飞书卡片按 `FOUNDRY_WEB_ORIGIN` 生成链接；skill 改为“只写 id”。Server `afc7f429` 与 Web `ca6ba388cb6b4c2e`（经部署脚本）已部署，真实浏览器自验通过；跨 workspace 的 Issue 与飞书卡片未做真实端到端验证，人工验收待确认。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-28 会话文件路径：[DEV-055 回复中的文件路径可点击](DEV-055-chat-file-paths.md)。示例 key 由 shell 命令写在工作区外，Worker 回合结束时的验证不链接它。Phase 1：回答中的工作区内路径点击后才经设备读取，在工作区浏览器中预览和下载；设备拒绝返回 404。Phase 2（用户 2026-10-28 批准推荐方案）：工作区外文件仅设备所有者可打开，需带意图头，`no-store`，访问只记元数据；凭据库和浏览器配置目录直接拒绝；密钥类文件遮罩，提供显示/复制，不提供下载；Devices 页可按设备关闭。合并 Server `61e2c75f…`、Web `f7dbf6c64e63bb21`、Worker `.1793154141`（dev 服务器设备 已自更新）已部署；所有者矩阵与各项拒绝在真实设备上 Agent 自验通过。开关变更事件一行待下次 Server 部署；人工验收待确认。 已经 PR #154 合并到 main。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：未关闭**——步骤 8 未通过：设备关闭“从会话打开工作区外文件”后，会话中的工作区外路径仍是链接（服务端已正确拒绝）。

2026-10-27 设备网络：[DEV-053 Worker 代理](DEV-053-worker-proxy.md)。支持 HTTP(S)/SOCKS5/SOCKS5h、认证、NO_PROXY、owner-only 持久配置、自动重连、doctor 与设备诊断；覆盖 Worker↔Server HTTP/WS、CLI/MCP、连接器转发及安装/自更新下载，模型请求环境保持原样。真实代理集成、dev 合成会话/MCP/256 KiB 文件传输与浏览器诊断通过；联合 Worker `.1793104558` 已发布，linux-dev-2 daemon/执行宿主均核实加载。真实设备代理未改，人工验收待确认；检查与清理回执见条目。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-27 设备连接器：[DEV-052 本人会话自动使用设备登录](DEV-052-device-connector-auto.md)。本人非沙箱会话自动使用设备有效登录，成员仍需显式共享；补 Meego 子授权状态持久化与会话说明。Go 全树/区域测试、29 Web 测试、11 audits 与 9 个浏览器场景通过；dev Server/Web `069a4d3a7c0f6c77` 已部署、Worker `.1793088606` 已发布。linux-dev daemon 已更新，繁忙执行宿主仍 dev.53，待安全切换。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-27 会话图片与文件：[DEV-051 加载、完整下载与恢复](DEV-051-chat-images.md)。实测 linux-dev 上行约 10 KB/s；恢复/重试、完整文件下载与路径对齐之外，补交互优先/4 KiB bulk credit、四路读取、64 MiB 授权缓存、≤40 KiB 预览/≤2 KiB 小图及预推送、原图进度和有界失败缓存。Server 19:53:33、Web `1792b54a13066032`、兼容旧 ffmpeg 的 Worker `.1793104558` 已发布；三台 daemon 实际加载，linux-dev/dev-server 忙碌宿主保留。真实浏览器合成 1 MB 图预览 19.6 KB/2.11 s、重复 126.5 ms；旧 ffmpeg 真实文件/缺工具/失败缓存已自验。最终真实用户弱链路请求与人工验收仍待确认；会产生临时仓库提交的 Git fixture 用例已在夜间窗口复验通过。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-27 对话历史：[DEV-050 长会话开场请求不可见](DEV-050-first-message.md)。修复返回缓存聊天丢失分页游标、虚拟列表顶部回调被占位消息消耗及重叠页不继续加载的问题；窗口时间排序改为索引读取后解析边界秒。四页合成数据及用户示例只读核对通过；最终 Server 已健康部署，Web `f0af1c5d7df5517d` 的返回缓存、连续分页及 1280/390 浅深色浏览器自验通过。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。 **2026-10-29 Agent 委托验收（用户 2026-10-28 授权）：已关闭（Agent 委托验收）**，验证范围与保留限制见条目。

2026-10-27 提示与菜单：[DEV-049 统一提示、操作反馈与菜单](DEV-049-hint-ui.md)。358 入口盘点；操作反馈统一悬浮 Toast，字段说明与动作菜单共享原语，归档入口移入右键/键盘菜单。最终 Web `069a4d3a7c0f6c77` 已部署；119 文件分段覆盖、最终 delta checker 与四组浏览器验证通过，人工验收待确认。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。

2026-10-27 会话归档：[DEV-048 会话归档](DEV-048-session-archive.md)。用户批准 D1–D3，D4–D7 采用可调整的推荐默认；协议、服务端事务与设备同步、原生归档和 Web 界面已集成并部署 dev；真实浏览器、REST/MCP 拒发、Codex/Claude 原生往返、离线收敛、文件夹与定时工作及路由/历史加载回归已自验证；独立复核与用户反馈中的历史 native 工作假阻塞、窄屏反馈和归档弹窗已修正，Web `59ec8d20e4642e40` / Worker `.1793079469` 已部署；D7 统一恢复规则由用户确认。部分设备因低磁盘或宿主忙碌未加载新 Worker，真实数据 DB-copy DryRun 由协调会话验证，人工验收待确认。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。

2026-10-27 持续工作：[DEV-047 暂停已退出的服务无法确认](DEV-047-pause-exited-service.md)。暂停已失败的服务时设备报 `No live supervised process to pause`、永远无法确认；改为已退出时直接确认。Worker `.1793065621` 已发布，dev-server 执行宿主空闲切换后确认两项合成服务的暂停。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。

2026-10-26 模型连接：[DEV-045 外部连接的登记与设备页管理](DEV-045-external-connection-management.md)。网关安装程序通过 `foundry-worker connection add/remove/list` 登记连接，幂等、原子写入、不动其他 profile；设备页逐行显示四种状态，提供“验证 / 移除”，由 `external_connection_manage_v1` 能力把关。顺带修复 DEV-044 每个心跳都重报 registration 的问题。测试与合成浏览器检查已通过；10-26 17:10–17:13 已部署 dev Server/Web 并发布 Worker `0.5.7-dev.81…1793005823`（dev-server 执行宿主已加载）。10-27 按只读复核修复检查中移除、重新登记保留关闭状态与非所有者提示，Web `cd4869d4` 与 Worker `.1793065107` 已部署到四台设备。待通过 Limen 的真实“验证”与人工验收。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。

2026-10-26 验证会话：[DEV-046 验证会话沙箱内 session-work 崩溃](DEV-046-verifier-session-work-crash.md)。只读复核中后台 Bash 任务的观测路径惰性创建设备级 supervisor，`mkdir ~/.foundry/session-work` 在只读沙箱中失败并使进程退出；观测改为只用已存在的实例。Worker `0.5.7-dev.81…1793003292` 已发布，linux-dev-3 已加载；10-27 已在 dev-server 验证沙箱中复验通过（超时与真实后台任务均不再崩溃）。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。

2026-10-26 模型连接：[DEV-044 外部模型连接与 Limen](DEV-044-external-connections.md)。通用外部连接适配器保持原生 Claude Agent SDK，Limen 为独立私有实现。真实推理、工具、恢复、并发、取消与页面展示通过；Server/Web 已部署、linux-dev-3 daemon 已更新。linux-dev-3 daemon 与实际执行宿主均已加载修复版 `.1793003292`，真实 Foundry 会话的 Bash 工具和同一原生 session 续聊验收已通过。 17:48 扩展接入 mac-laptop / mac-desktop / dev-server，三台原生 SDK 检查及服务端状态通过；三台实际执行引擎均已更新；dev-server 经用户明确授权中断后于 17:58 切换，17:59 原生 SDK 再次检查通过。两个旧合成测试服务因原临时目录已清理而恢复失败，详见 DEV-044；复核唤醒均已禁用。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。

2026-10-26 验证会话：[DEV-043 验证会话沙箱就绪检查](DEV-043-verifier-sandbox-readiness.md)。Worker 原先只按平台判断能否运行验证会话，缺 `bwrap` 的 Linux 设备照常声明能力、启动即失败；改为实测 `bwrap` 与 user namespace，Server 拒绝文案补充安装提示。linux-dev 已装 bubblewrap，失败的复核已重跑完成。dev Server 已部署，Worker `0.5.7-dev.81…1793000734` 已发布（设备随常规更新生效）。已随 PR #150 合并（merge `60496ca`，2026-10-27 夜间窗口）。

2026-10-26 对话展示：[DEV-042 Claude 进度说明与思考分类](DEV-042-claude-narration.md)。明确标记的 narration 改为 commentary，覆盖实时、后台续接与带标记的历史适配；相关测试和真实组件浏览器验证通过。新版 Worker 已安装，daemon 已更新；活动 execution host 保留旧版，实际生效及人工验收待安全切换后确认。旧事件缺失的分类元数据不追溯猜测。

2026-10-26 原生会话：[DEV-041 原生会话完整历史、Codex 工作区指令与插件缓存](DEV-041-native-history.md)。原生对话只读日志前 1 MiB 的问题改为“最新部分 + 向前翻页”，接管后的会话逐页导入到开头；Foundry 的 Codex 会话此前从未加载工作区 `AGENTS.md`（untrusted 项目），现经生成的 Codex home 提供；关闭 Codex 插件市场克隆（每会话约 100 MB）。dev Server/Web 已部署，Worker 已发布，linux-dev-3 已更新，`sess_1792942466521638962` 已修复；经 PR #146 合入 main（`3160507`），人工验收待确认。

2026-10-24 文档：[DEV-017 Roadmap 按模块重组](DEV-017-roadmap-restructure.md)。唯一 Roadmap 移到 `docs/roadmap.md`，按模块图组织并带完成标准；连接器抽象、Chats 跟随原生演进与工作流平台拆分设计已写入对应文档；模块图更新。合入状态见事项记录。

2026-10-24 模型服务：[DEV-040 Base URL 校验纠正与 MCP 可见性](DEV-040-provider-endpoint.md)。保存时纠正 Claude `/v1` 等常见错误，并拒绝无效地址；MCP `list_profiles` 可查看模型服务的端点。经 PR #144 合入 main（`3081b85`），dev Server 已按合入版本重新部署（Foundry Skill 升到 revision 10）；Worker 已发布，本机 daemon 已更新，活动执行宿主保留旧版。人工验收待确认。

2026-10-23 错误展示：[DEV-039 Worker 错误诊断与恢复建议](DEV-039-worker-failure.md)。经 PR #144 合入 main（`3081b85`）。统一分类、Worker 上报、事件持久化与中英文展示已验证，dev Server/Web 已部署；Worker 包与本机 daemon 已更新，活动执行宿主保留旧版。旧错误展示已生效，人工验收待确认。

2026-10-23 Skill 启动：[DEV-038 启动准备复用](DEV-038-skill-preparation.md)。代码、自验、dev Server/daemon 与实际执行宿主切换完成；两项既有服务已恢复并核验 running。真实会话13个 Skill 准备69ms、全部复用且零下载/解包；人工验收待确认。

2026-10-23 AWS CLI：[DEV-037 设备连接器](DEV-037-aws-cli-connector.md)。经 PR #144 合入 main（`3081b85`，含 CI 中宿主 `aws` 干扰测试的修复）。代码与相关检查完成，dev Server/Web 和 Worker daemon 已更新；实际执行宿主因活动工作保留旧版，待空闲切换或获准维护。真实 AWS 账户与人工验收待确认。

2026-10-23 发送恢复：[DEV-036 诊断测试覆盖工作区登记表](DEV-036-workspace-registry-recovery.md)。经 PR #144 合入 main（`3081b85`）。dev-server 五个工作区登记已恢复，Web `390c82e7c4f2c855` 已部署，相关检查与浏览器错误态通过；用户原账号实际收发待验收。

2026-10-20 运维恢复：[DEV-026 磁盘满导致 dev API 502](DEV-026-disk-full.md)。已清理约 17 GiB 构建缓存，健康检查与实际 daemon API 请求恢复；人工验收待确认。

| ID / 事项                                                                                            | 总体状态                            | ① 理解/调研                                            | ② 代码/合入                                                                    | ③ dev Server/Web                           | ④ Worker                                                     | ⑤ Agent 自验                                                     | ⑥ 人工验收                                    | 下一步                                                                   |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| [DEV-049 提示、反馈与菜单统一](DEV-049-hint-ui.md)                                                   | 已部署；待人工验收                  | 358 入口盘点与原图/根因                                | Toast、FieldHint、RowMenu 与全项目迁移                                         | Web 069a4d3a7c0f6c77；保留旧 assets        | 不涉及                                                       | 119 文件分段覆盖、delta checker 全绿、四组浏览器矩阵             | 待人工验收                                    | 143 中断与补跑证据、外部动作边界见记录                                   |
| [DEV-001 任务管理、漏停和任务误报](#dev-001)                                                         | 已关闭                              | 已完成                                                 | 已实现，PR #133 合入                                                           | 均已部署                                   | dev-server、linux-dev 实际宿主已升级相关版本                 | 回归、浏览器、真实进程控制通过；原事故 stop_all verified         | 2026-10-19 用户验收通过                       | 无；复发时重开并追加证据                                                 |
| [DEV-002 定时任务无法唤醒](#dev-002)                                                                 | 已关闭                              | 已完成                                                 | 已修复                                                                         | 相关修复已部署                             | linux-dev 加载修复版本 1792260170                            | 总控自然触发及模型执行有证据；独立审计仅确认接管                 | 2026-10-19 用户验收通过                       | 无；复发时重开并追加证据                                                 |
| [DEV-003 私有模型上下文窗口回退](#dev-003)                                                           | 已关闭                              | 已完成                                                 | 修复随 PR #133 合入；隔离分支继续完善                                          | 不涉及，核心在 Worker                      | 待确认 linux-dev 加载该修复；此前升级早于此补丁              | 真实 CLI 新建/恢复/窗口切换通过；目标业务窗口未确认              | 2026-10-19 用户验收通过                       | 无；复发时重开并追加证据                                                 |
| [DEV-004 Mermaid 图表渲染](#dev-004)                                                                 | 已关闭                              | 已完成                                                 | 已实现并合入                                                                   | 均已部署                                   | 不涉及                                                       | 图表、主题、窄屏、回退和导出通过                                 | 2026-10-19 用户验收通过                       | 无；复发时重开并追加证据                                                 |
| [DEV-005 中文 Markdown 渲染](#dev-005)                                                               | 已关闭                              | 已完成                                                 | PR #134 合入，main c2e46c6                                                     | 已部署                                     | 不涉及                                                       | 13 项 Markdown 测试及浏览器回归通过                              | 2026-10-19 用户验收通过                       | 无；复发时重开并追加证据                                                 |
| [DEV-006 Session 配置隔离与 Skill 完整性](#dev-006)                                                  | 已关闭（委托 Agent 准出）           | 已完成                                                 | 已整合；统一 PR/回执见 DEV-025                                                 | Server/Web 已上线并实测                    | dev-server 实际 host 1792399633                              | 两类 Issue 完整集成、草稿隔离和负向检查通过                      | 2026-10-20 委托 Agent 准出                    | 源码统一合入见 DEV-025；复发重开                                         |
| [DEV-007 Workspace Skill 草稿与对照试验](#dev-007)                                                   | 已关闭（委托 Agent 准出）           | 已完成                                                 | 已整合；统一 PR/回执见 DEV-025                                                 | Server/Web 已上线并实测                    | dev-server 实际 host 1792399633                              | 固定版本试验、新宿主及两类 Issue 通过                            | 2026-10-20 委托 Agent 准出                    | 源码统一合入见 DEV-025；复发重开                                         |
| [DEV-008 Codex writer 退出清理](#dev-008)                                                            | 已关闭（已验证修复范围）            | 已完成                                                 | 退出确认及清理已整合；见 DEV-025                                               | 不涉及                                     | dev-server 1792399633；linux-dev 实际 host 1792427546 含修复 | 真实锁、子进程退出、取消及同线程重试回归通过                     | 2026-10-20 委托 Agent 准出                    | 原 linux-dev-3 业务未代发重演；新现场出现再追查                          |
| [DEV-009 Task 归属及存活核查](#dev-009)                                                              | 已归档（只读核查）                  | 已完成                                                 | 不涉及                                                                         | 不涉及                                     | 不涉及                                                       | 当时 Foundry 清单已核实；底层 OMH 任务未查                       | 2026-10-20 委托归档                           | 无；新状态需重新只读核验                                                 |
| [DEV-022 原生持续工作统一抽象与面板重构](DEV-022-native-work.md)                                     | timer-only已上线；待联合合入        | 用户明确timer-only；Agents独立                         | 14路径精确delta；PA单一CI/合入                                                 | Web a3e6df1daecced03 已实测                | 本轮未改；保留029async运行版本                               | 48文件回归/23定向、119 条混合库存、双语/主题/窄屏/键盘与重试通过 | 按既有委托验证本轮；非用户亲测                | PA联合CI；保留库存、聊天记录与Workspace服务                              |
| [DEV-023 Personal Agent 完整实施](DEV-023-implementation.md)                                         | 委托Agent验收通过，PR138交付        | 修订方案及推荐默认已确认                               | 已提交[PR138](https://github.com/BD777/foundry/pull/138)，排除未验028/034      | 核心已部署，精确版本见报告                 | 核心actual host已核；追加续接修复加载回执见PR138             | 完整format/verify通过，CI终态见PR138                             | 2026-10-21明确委托Agent准出                   | [交付、CI、merge及运行时回执](https://github.com/BD777/foundry/pull/138) |
| [DEV-024 完成恢复、Skill 下载与 SQLite 旧读](DEV-024-stalled-response.md)                            | 已上线（委托 Agent 准出已验范围）   | SQLite 取消读泄漏因果复现，官方 1.40.1 修复            | 源码交付及 CI/merge 回执：[PR #137](https://github.com/BD777/foundry/pull/137) | Server 实际 binary 1.40.1，hash 已核对     | dev-server host/daemon 1792510265；合成 Worker 保留 9633     | 因果 A/B、Store 回归、实际进程与本机/Mac 租约闭环通过            | 按既有委托准出已验证范围                      | 保留历史丢事件与原下载 cause 边界；新证据出现重开                        |
| [DEV-027 Foundry 子会话与原生委派选择边界](DEV-027-delegation-policy.md)                             | 已交付（委托 Agent 准出已验范围）   | 三分规则与真实能力差异已核对                           | PR #137/#138 已合入；最终main 69f2084                                          | 组合Server已加载rev9，live分发已核验       | dev-server actual host .1792596448 已加载                    | 19条审计/fresh12情境/原native续接通过；CI全绿                    | 2026-10-20 委托 Agent 已测 Codex 范围准出     | 旧失败保留；Claude实际行为未测，复发按新证据重开                         |
| [DEV-028 Mac 指定 App 操作与不抢占输入](https://dev.foundryapp.app/chats/sess_1792510285202880973)   | 本地通过，正向实机待基线窗口        | mini锁屏无人可授权；备用mac-laptop已解锁且driver已授权 | 窗口作用域/后台默认/失效锁屏拒绝已实现                                         | 未部署本项                                 | 无需用户先更新；未发布本项                                   | 锁屏拒绝实测通过；启动前采样中止，未发送输入                     | 完整交付未关闭                                | [详细记录](DEV-028-macos-app-control.md)；租约和probe均清理              |
| [DEV-029 Connector 授权抽象与设备作用域 UI](DEV-029-connector-authorization.md)                      | 异步授权已部署，真实grant待验证     | 基础/附加能力分离；45秒超时与旧CLI遮蔽已修             | 分阶段同op恢复、原始PNG回执；未提交                                            | Server 3b640364、Web 9a3d8d1e2d827097      | linux-dev daemon/host1792579126；Mac本轮未动                 | race/有界FIFO/慢响应断线浏览器/作用域回归通过                    | 本人批准/扫码后确认Meego；不冒称业务权限ready | PA联合PR/CI；保留最新版组合及禁用自动发布                                |
| [DEV-030 Services 卡片与共享 UI 用法整改](https://dev.foundryapp.app/chats/sess_1792565531251379197) | 已修复、dev已部署、Agent自验通过    | Panel缺内容布局与Services无CSS；嵌套确认层级缺陷       | 共享组件组合、刷新恢复、仓库空态、公共Dialog层级                               | Web f74abfdf92de463d；Server未重启         | Worker1792566321保持不变                                     | 固定候选40/40、10UI审计、真实浏览器多状态/主题/390px             | 已按授权Agent准出本项范围                     | [证据](DEV-030-ui-components.md)；交统一CI/PR集成                        |
| [DEV-031 官方订阅账号 Usage 侧栏](https://dev.foundryapp.app/chats/sess_1792568479405969993)         | 已合入；最终 main CI 通过           | Codex 多桶；Claude 实验原生 usage/缓存语义已核         | 额度/隔离/紧凑侧栏与对齐已合入 PR138                                           | Server fb96a556；Web 751e32929d69edee 已核 | Linux/Mac daemon 1792570873 已加载；活跃 host 保留           | 原生与隔离已验；生产CSS对齐/浏览器通过                           | 信息完整获确认；视觉修正委托准出              | Claude 实机未返回百分比，诚实显示不可获取；不推理探测                    |
| [DEV-032 设备生命周期与失效引用](DEV-032-device-lifecycle.md)                                        | 已部署自验，待联合源码合入          | 已核精确身份与历史/候选混用根因                        | 43路径生命周期＋11项共享提示UI增量；交DEV023联合CI                             | 生命周期Server fb96a556；提示Web 4a50be1c  | 本项不涉及；原指针及宿主未更新                               | HTTP513；UI18文件/11浏览器场景/公开只读复验通过                  | 按委托准出已验范围；非用户亲测                | 联合CI补6个Git夹具，按固定delta集成                                      |
| [DEV-033 侧栏全局与 Workspace 作用域重排](https://dev.foundryapp.app/chats/sess_1792573633505867631) | 用户追加视觉合同已部署并 Agent 自验 | Workspace置顶/常驻范围线；单图标对齐；折叠功能键组     | 聚合11代码测试路径+报告；固定候选tools                                         | Web8577a1b9c462b8ca；Server3b640364不变    | 保持1792579126，未重启host                                   | 冻结37测试、10UI、14生产样式场景/公网通过                        | 按用户委托 Agent 准出；非用户审美确认         | [最新报告](DEV-033-sidebar-scope.md)；精确manifest交唯一CI owner         |
| [DEV-034 本地 Web 服务与账号鉴权隧道](DEV-034-authenticated-service-tunnels.md)                      | 同站加固已上线；公网未准出          | 官方调研与Workspace三级归属已核                        | 注册、流式代理、Host/Cookie/来源隔离已验                                       | Server abf238d7 / Web 97ff6d63；模式已启用 | 主host与linux-dev实际6448                                    | 全相关gate与真实Nginx浏览器通过；18082已登记                     | 未完成                                        | CF授权与DNS/TLS配置后，用本人账号验真实服务                              |
| [DEV-035 Cloudflare Connector](DEV-035-cloudflare-connector.md)                                      | 可授权，待本人批准                  | 官方 OAuth、Workspace zone绑定、受控只读 CLI/MCP       | 已实现并自验                                                                   | Server500780ba / Web5ff6b37d               | 授权模块/实际宿主及CLI已核                                   | 官方DCR、公网入口、CLI fixture、浏览器/race与相关gate通过        | 本人真实CF授权及资源核验未完成                | 本人批准后只读验真与精确DNS/TLS计划                                      |

本轮统一准出、归档与源码合入记录：[DEV-025](DEV-025-release-closure.md)。委托范围仅覆盖已验证交付；以下 DEV-010–021 状态不变。

DEV-006/007 统一负责人：[Astra 接续 session](https://dev.foundryapp.app/chats/sess_1792389911761860653)。本地 main 已整合并保留 DEV-008 修复；部署与 Agent 自验完成，2026-10-20 按显式委托准出。源码统一集成由 [PR #136](https://github.com/BD777/foundry/pull/136) 承载，回执见 [DEV-025](DEV-025-release-closure.md)。具体证据见 [统一交付记录](DEV-006-007-isolation-drafts.md)。

2026-10-21 推进授权：用户要求 Personal Agent 完成修订方案的全部核心范围（P0–P3），其他已启动事项亦持续到验证和交付；沿用推荐默认，仅真实需用户决策或本人操作时请求介入。构建与部署同时遵守 AGENTS.md 的磁盘容量检查。

## 事项流水

<a id="dev-001"></a>

### DEV-001 · 任务管理、漏停和任务数量误报

| 时间                | 变化与证据                                                                                                                                                       | 剩余动作                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 2026-10-17          | 建立持久工作清单与分类面板，统一 MCP/CLI/compact 上下文；实现单项与批量控制、停止屏障及设备确认。随后修复空面板、历史记录误计活跃和普通命令误识别后台任务。      | 部署、设备加载和深度复核                           |
| 2026-10-18          | 补齐任务定义/单轮执行、稳定投递身份、停止回执、离线上报及进程退出处理；dev Server/Web 已部署，相关设备宿主升级。原事故 38 条记录均终态，stop_all 最终 verified。 | 最终人工验收；不能将其他未知来源任务一概算作已停止 |
| 2026-10-19 盘点     | 修复已随 PR #133 合入；未找到用户对最终版明确验收通过的记录。                                                                                                    | 保留人工验收待确认                                 |
| 2026-10-19 用户反馈 | 用户反馈“目前没发现问题，可以 close”；按用户验收关闭。                                                                                                           | 已关闭；复发可重开                                 |

来源：[任务管理 session](https://dev.foundryapp.app/chats/sess_1792197549245061512)、[深度复核](../session-work-deep-audit-20261018.md)、[验收记录](../session-work-management-validation.md)。

<a id="dev-002"></a>

### DEV-002 · 定时任务无法唤醒自己

| 时间                   | 变化与证据                                                                                                                                                                           | 剩余动作                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 2026-10-18 01:33       | dev-server 已加载新宿主；linux-dev 虽安装新包，旧 dev.28 宿主仍运行，计划 ack=0、无执行记录。                                                                                        | 让实际执行宿主接管                                                |
| 2026-10-18 01:51–02:08 | 按用户授权切换 linux-dev 宿主；继续修复网关 HTTP 传输和失败后的 writer 清理，最终加载 1792260170。02:05 时隙自然投递，02:07 完成压缩并产生模型用量。强制切换中断过在途轮次，已记录。 | 独立审计任务只确认接管，尚缺其后自然触发结果；不等于 OMH 业务完成 |
| 2026-10-19 用户反馈    | 用户反馈“目前没发现问题，可以 close”；按用户验收关闭，历史独立审计证据缺口不再阻塞结项。                                                                                             | 已关闭；复发可重开                                                |

来源：[任务管理 session](https://dev.foundryapp.app/chats/sess_1792197549245061512)、[深度复核](../session-work-deep-audit-20261018.md)。

<a id="dev-003"></a>

### DEV-003 · 私有 Provider 上下文窗口回退

| 时间                | 变化与证据                                                                                                                                     | 剩余动作                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 2026-10-18          | 复现隔离 CODEX_HOME 遗漏启动阶段模型目录，导致 921600 回退到 272000；实现受管模型目录并在 app-server 启动时加载。真实 Codex CLI 对照测试通过。 | 目标设备部署及真实窗口验证                                |
| 2026-10-18–19       | PR #133 合入修复基线；隔离重构继续补充沙箱目录、数据路径及准备流程。新建、恢复和切换窗口测试有通过证据。                                       | 未见 linux-dev 在修复后加载新宿主并恢复目标窗口的闭环记录 |
| 2026-10-19 用户反馈 | 用户反馈“目前没发现问题，可以 close”；按用户验收关闭，不补造历史设备验证证据。                                                                 | 已关闭；复发可重开                                        |

来源：[窗口回退 session](https://dev.foundryapp.app/chats/sess_1792288811055545537)、[根因与验证](../research/private-provider-context-regression-20261018.md)、[隔离审查 session](https://dev.foundryapp.app/chats/sess_1792313282802875171)。

<a id="dev-004"></a>

### DEV-004 · Mermaid 图表渲染

| 时间                | 变化与证据                                                                                                                       | 剩余动作                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 2026-10-18 17:27    | 采用 Streamdown 官方 Mermaid 插件，支持缩放、全屏和下载；Server/Web 已部署 dev。浏览器验证中文图表、主题、窄屏、错误回退及导出。 | 人工验收                         |
| 2026-10-18–19       | 后续中文 Markdown 修复重新回归 Mermaid；图表基线已合入。                                                                         | 不把后续没有异议当作明确验收通过 |
| 2026-10-19 用户反馈 | 用户反馈“ok，close”；验收关闭。                                                                                                  | 已关闭；复发可重开               |

来源：[渲染 session](https://dev.foundryapp.app/chats/sess_1792314903846430673)、[图表验收](../mermaid-rendering.md)。

<a id="dev-005"></a>

### DEV-005 · 中文 Markdown 加粗与链接兼容

| 时间                   | 变化与证据                                                                                                                                          | 剩余动作             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 2026-10-18 23:02–23:12 | 用户反馈加粗未渲染；定位中文标点邻接语法问题，在共享解析层修复。避免完整 CJK 插件截断显式链接；流式和完成态一致。已部署 dev，测试和浏览器回归通过。 | 修复后的人工验收     |
| 2026-10-19 00:43       | PR #134 合入；main 为 c2e46c6。                                                                                                                     | 未见用户明确验收通过 |
| 2026-10-19 用户反馈    | 用户反馈“ok”；视为本事项验收通过并关闭。                                                                                                            | 已关闭；复发可重开   |

来源：[渲染 session](https://dev.foundryapp.app/chats/sess_1792314903846430673)、[Markdown 复核](../markdown-rendering-review-20261018.md)。

<a id="dev-006"></a>

### DEV-006 · Session 配置隔离与 Skill 完整性

| 时间                   | 变化与证据                                                                                                                                                                                             | 剩余动作                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 2026-10-18             | 审查配置隔离、登录/历史路径、凭据持久化、沙箱模型目录和 Skill 快照问题；完成统一启动准备与生命周期设计。设计随 PR #133 合入。                                                                          | 分阶段实现及验证                                              |
| 2026-10-19 01:26       | 接续原会话，提交并推送 f832e75，建立草稿 PR #135。首批检查、真实 CLI 与远端 CI 通过。                                                                                                                  | 后续生命周期、草稿与完整验收                                  |
| 2026-10-19 10:38–11:09 | 后续实现与 Linux/Mac 专项、类型检查、生产构建通过；仍在隔离分支，大量改动未提交，未合 main，未部署日常 dev，也未更新日常 Worker。                                                                      | 完整 Issue 执行→验证→Accept；真实 Keychain 登录验收仍缺       |
| 2026-10-19 13:32       | 原定今晚 22:00 的继续任务已停止；13:35 查询控制回执为 verified。旧回复“今晚继续仍有效”已过时。                                                                                                         | 需要后续明确接续；本记录不创建或恢复计划                      |
| 2026-10-19 用户反馈    | 用户授权新 session 推进上线；与 DEV-007 由同一 session 负责，避免共享实现冲突。允许直接部署 dev Server/Web，Worker 在无中断风险时可自行更新。                                                          | 按总表下一步推进                                              |
| 2026-10-19 14:49       | 主树整合与 dev Server/Web 部署已核验；最终 Worker 1792392272 发布并安全更新 daemon。草稿真实 CLI/UI 与 Issue 草案有新证据，升级期间能力门已修复。详见[统一交付记录](DEV-006-007-isolation-drafts.md)。 | 完整候选 Verify→Accept→集成、旧宿主空闲切换及人工验收仍待完成 |
| 2026-10-19 15:44       | 继续无新增commit验证：独立只读Issue已真实执行、封存、独立Verify并显式Accept集成，所有commit对象仍仅原baseline；负向版本/证据/过期检查通过。发现并修复Verify缺省model空串，已交共同发布。               | 原新增result.txt场景、修复发布及实际宿主加载仍待完成          |
| 2026-10-19 16:18       | 共同包1792396585及四公网hash独立核验；日常Web/Server、daemon和合成Worker已更新，已安装包缺省模型真实Verify通过。旧宿主继续保护活动任务。                                                               | 原改动型集成、实际宿主加载及人工验收仍待完成                  |
| 2026-10-19 16:58       | 最终共同包1792399633公开/本地hash及保留修复核验通过，daemon已加载；实际host仍旧。原两合成服务和计划均保全，短停/idle升级方案未执行。                                                                   | 改动型集成、实际宿主安全加载及人工验收仍待完成                |
| 2026-10-19 20:04       | 授权短维护已完成；实际host374938/公开1792399633已核实。新host当前回合刷新、fresh include/exclude和普通会话发现通过；正式9633独立Verify实测通过。两服务原记录恢复，已接受Issue与数据保全。              | 原改动型候选集成及人工验收仍待完成                            |
| 2026-10-19 22:17       | 原新增result.txt场景真实执行、独立Verify、准确review显式Accept及源集成成功；3/3通过，源clean。正常修订取证草案补系统改动清单，失败历史保留，旧输入/跨Issue/过期review均拒绝；未改源码或重发布。        | Agent自验完成，按统一交付记录人工验收；两合成服务保留         |
| 2026-10-20 01:07 起    | 用户明确委托 Agent 对已验证范围准出归档；本轮核对专项证据与残余边界，详见 [DEV-025](DEV-025-release-closure.md)。没有冒充用户亲自验收。                                                                | 已归档；源码事项随统一集成收尾，复发按新证据重开              |

来源：[原会话](https://dev.foundryapp.app/chats/sess_1792313282802875171)、[接续会话](https://dev.foundryapp.app/chats/sess_1792343538905021176)、[设计](../session-isolation-design.md)、[PR #135](https://github.com/BD777/foundry/pull/135)。实施记录当前位于隔离工作树 `../foundry-session-isolation/docs/session-isolation-implementation-20261019.md`。

<a id="dev-007"></a>

### DEV-007 · Workspace Skill 草稿、刷新与 Creator 对照试验

| 时间                | 变化与证据                                                                                                                                                                                             | 剩余动作                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 2026-10-18          | 用户提出 workspace 内跨 session 试用草稿；确定不可变摘要、正式版与草稿来源、刷新和 with/without/previous 试验方案。                                                                                    | 实现                                                          |
| 2026-10-19          | 实现扫描/快照、当前轮刷新、能力协商、固定版本试验、跨设备传输和 Web 来源/试用界面。真实 CLI 验证 v1/v2、排除目标 Skill、锁定旧摘要、普通会话发现与当前轮刷新；独立 Codex 判定有通过证据。              | 完整 Issue 确认执行→Verify→显式 Accept→集成成功               |
| 2026-10-19          | 停止独立测试栈后误删其合成 DB；工作区、日志与截图保留。旧 Issue/Session ID 不能再查询或复用。日常 dev 未部署。                                                                                         | 重建隔离测试栈，重跑全链路；完成后更新 PR、部署及人工验收     |
| 2026-10-19 用户反馈 | 与 DEV-006 属于同一交付中的基础层和产品能力层，共用代码、PR 和验收链路；安排同一个新 session 接续，不并行拆开写。                                                                                      | 按总表下一步推进                                              |
| 2026-10-19 14:49    | 主树整合与 dev Server/Web 部署已核验；最终 Worker 1792392272 发布并安全更新 daemon。草稿真实 CLI/UI 与 Issue 草案有新证据，升级期间能力门已修复。详见[统一交付记录](DEV-006-007-isolation-drafts.md)。 | 完整候选 Verify→Accept→集成、旧宿主空闲切换及人工验收仍待完成 |
| 2026-10-19 15:44    | 继续无新增commit验证：独立只读Issue已真实执行、封存、独立Verify并显式Accept集成，所有commit对象仍仅原baseline；负向版本/证据/过期检查通过。发现并修复Verify缺省model空串，已交共同发布。               | 原新增result.txt场景、修复发布及实际宿主加载仍待完成          |
| 2026-10-19 16:18    | 共同包1792396585及四公网hash独立核验；日常Web/Server、daemon和合成Worker已更新，已安装包缺省模型真实Verify通过。旧宿主继续保护活动任务。                                                               | 原改动型集成、实际宿主加载及人工验收仍待完成                  |
| 2026-10-19 16:58    | 最终共同包1792399633公开/本地hash及保留修复核验通过，daemon已加载；实际host仍旧。原两合成服务和计划均保全，短停/idle升级方案未执行。                                                                   | 改动型集成、实际宿主安全加载及人工验收仍待完成                |
| 2026-10-19 20:04    | 授权短维护已完成；实际host374938/公开1792399633已核实。新host当前回合刷新、fresh include/exclude和普通会话发现通过；正式9633独立Verify实测通过。两服务原记录恢复，已接受Issue与数据保全。              | 原改动型候选集成及人工验收仍待完成                            |
| 2026-10-19 22:17    | 原新增result.txt场景真实执行、独立Verify、准确review显式Accept及源集成成功；3/3通过，源clean。正常修订取证草案补系统改动清单，失败历史保留，旧输入/跨Issue/过期review均拒绝；未改源码或重发布。        | Agent自验完成，按统一交付记录人工验收；两合成服务保留         |
| 2026-10-20 01:07 起 | 用户明确委托 Agent 对已验证范围准出归档；本轮核对专项证据与残余边界，详见 [DEV-025](DEV-025-release-closure.md)。没有冒充用户亲自验收。                                                                | 已归档；源码事项随统一集成收尾，复发按新证据重开              |

与 DEV-006 共用 PR #135 和约 90 个后续未提交文件项，不能重复计算工作量。实现记录位于 `../foundry-session-isolation/docs/session-isolation-drafts-20261019.md`。来源：[接续会话](https://dev.foundryapp.app/chats/sess_1792343538905021176)。

<a id="dev-008"></a>

### DEV-008 · Codex active writer 与退出清理

| 时间                   | 变化与证据                                                                                                                                                                      | 剩余动作                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 2026-10-19 07:59–08:32 | linux-dev-3 原会话失败后残留进程持有真实 writer 文件锁。修复为等待原生进程及受管进程组退出确认后才释放资源，并补齐旧启动包装进程识别。21 个相关测试文件、真实锁与立即重试通过。 | 发布包及目标设备恢复验证                                         |
| 2026-10-19 08:31       | 发布 0.5.7-dev.39.gc2e46c6.local.1792369800，公网下载哈希通过；仅 Worker 改动，Server/Web 无需重部署。未代替用户更新设备。                                                      | linux-dev-3、dev-server 更新，确认实际执行宿主切换，再恢复原会话 |
| 2026-10-19 13:35 盘点  | 本地 main 仍有该事项 12 个未提交文件项；未见设备升级后的恢复证据。                                                                                                              | 提交合入与设备闭环均待完成                                       |
| 2026-10-19 用户反馈    | 用户确认已升级，尚未验收；新增确定性故障回归、实际宿主版本、原线程恢复三层验收说明。偶发问题不能仅靠“暂未复发”证明修复。                                                        | 按总表下一步推进                                                 |
| 2026-10-20 01:07 起    | 用户明确委托 Agent 对已验证范围准出归档；本轮核对专项证据与残余边界，详见 [DEV-025](DEV-025-release-closure.md)。没有冒充用户亲自验收。                                         | 已归档；源码事项随统一集成收尾，复发按新证据重开                 |

验收方法见 [DEV-008 验收说明](DEV-008-writer-cleanup.md)。

来源：[清理修复 session](https://dev.foundryapp.app/chats/sess_1792367997309541585)、[修复与发布记录](../research/codex-writer-cleanup-20261019.md)。

<a id="dev-009"></a>

### DEV-009 · Task 归属和存活状态核验

| 时间                | 变化与证据                                                                                                                               | 剩余动作                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 2026-10-18 15:13    | 核验截图对应 Foundry 工作清单：2 项运行中、3 项等待触发；折叠结束区另有 1 项已停止，回执 verified。                                      | 只证明该时刻 Foundry 任务状态；底层 OMH 业务任务未核查 |
| 2026-10-19 用户反馈 | 用户表示不知如何验收。本项是一次性只读核查，不是新功能；历史结论可归档，若要验当前状态应按当前任务清单重新核对。保留待确认，不自动关闭。 | 按总表下一步推进                                       |
| 2026-10-20 01:07 起 | 用户明确委托 Agent 对已验证范围准出归档；本轮核对专项证据与残余边界，详见 [DEV-025](DEV-025-release-closure.md)。没有冒充用户亲自验收。  | 已归档；源码事项随统一集成收尾，复发按新证据重开       |

验收范围：本项没有代码变更，无需重演历史状态。若要确认现在的面板，Agent 应重新读取对应 session 的持久工作清单，对照任务来源/父会话、启用状态、最近执行和停止回执，再与面板核对。你只需确认归属和显示符合预期；涉及真实任务启停时另按明确授权操作，不为验收干扰业务。若只关心当时的结论，可确认“核查记录归档”后关闭。

来源：[只读核查 session](https://dev.foundryapp.app/chats/sess_1792307579675482580)。

## 待启动、暂停及历史待核实事项

2026-10-24 起，这些事项（DEV-010–DEV-021）的状态、依赖与完成标准统一在 [Roadmap](../roadmap.md)，对应关系见[已迁入的历史清单](../roadmap.md#已迁入的历史清单)；原表保留在 Git 历史中。事项启动后仍沿用原编号，在本页建立事项流水。

来源：[2026-10-18 TODO 盘点所在 session](https://dev.foundryapp.app/chats/sess_1792313282802875171)。

## 追加流水模板

在已有事项末尾追加，避免按日期新建重复事项：

| 时间（UTC+8）    | 变化与证据                                                       | 剩余动作                               |
| ---------------- | ---------------------------------------------------------------- | -------------------------------------- |
| YYYY-MM-DD HH:mm | 本次实际完成的变化；附 session、PR、测试记录、部署版本或用户确认 | 明确下一步及阻塞；同步更新总表六个环节 |
