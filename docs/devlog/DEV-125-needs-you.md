# DEV-125 “等你处理”：多会话下不漏掉 Agent 要你做的事

## 状态

状态：P1 与 P2 已部署 dev，Agent 自验完成，待人工验收；未提交（提交窗口 22:00–09:00）。P2 从回答正文识别要你做的事，经评估默认推荐 my-cpa `gemini-3.8-flash-high` · low（不用 xhigh）；识别默认关闭，需本人在「待处理」页选择模型后开启。

| 环节                | 状态   | 说明                                                            |
| ------------------- | ------ | --------------------------------------------------------------- |
| 问题理解/调研       | 已完成 | 见“问题与数据”；延续 [DEV-079](DEV-079-agent-decision-inbox.md) |
| 代码                | 已完成 | P1 四步、P2，见“改动”                                           |
| dev Server/Web 部署 | 已完成 | Server `e55cc3ed3c3261e0`、Web `86c41e696d230e8a`，见“部署”     |
| Worker 更新         | 见部署 | P2 的协议改动（`triage` 为只有提示词的工具会话）随 Worker 发布  |
| Agent 自验          | 已完成 | 单测 + 真实浏览器（线上 DB 副本的 scratch 栈），见“自验证据”    |
| 人工验收            | 待确认 | 见“验收步骤”                                                    |

## 问题与数据

2026-11-05 本人：在多个会话间切换，有的会话留了问题，我漏看了；一个会话的正文会被其他会话、它自己的子 Agent、后台任务刷屏。要 Foundry 产品层面的方案，不局限于聊天；结合「待处理」一起看。

只读取证（Server DB `mode=ro`）：

- 截图中的编排会话 `sess_1793764358364457763`：6,121 个事件；回合由谁发起：本人 46（含 2 次中途发送），其他会话 207，定时器/后台 36，约 85% 不是本人的对话。234 次回答里约 37 次在结尾向本人提问（关键词粗估，如截图的 “Decisions I need from you” 六项），「待处理」只记到 1 项（回合失败）。
- 「待处理」自 10-29 起共 39 项：回合失败 23、需要你操作 7、问题 9（全部来自 Codex 问题卡片）。正文里的提问一项都没进来（DEV-079 的 P2 当时因成本暂缓）。
- 本人顶层聊天每天 150–350 次回合结束（10-29 至 11-05）。

三个问题：识别（只认结构化信号，最常见的“回答结尾的请求”看不到）；路由（「待处理」是单独一页，进到会话里没有“这里在等你”）；阅读（本人与 Agent 的对话和机器流量混在一起）。

## 决定（2026-11-05，本人经 AskUserQuestion 卡片）

- 正文识别：做，用本人在 Model providers 里选的模型（模型 + effort），默认用它，随时可换。设计见“P2 设计”。
- 非本人流量：默认折叠，提供开关。
- 先做 P1。
- 不改 Agent 的提示词与行为（沿用 DEV-079、DEV-120 的原则）。

## 计划（P1，确定性，不调用模型）

1. 正文降噪：定时器、后台任务后 Claude 自行继续的回合，与 DEV-119 已折叠的“其他会话发起的回合”一样折叠成一行（不折叠正在运行的和最新的回合）；会话标题栏加“只看我的对话”开关，打开时这些回合整段隐藏，只留本人发起的回合。
2. 会话内置顶：输入框上方一条“等你处理 · N”，列出本会话未处理的待处理项（标题、出处、跳到原消息、回复/完成/忽略），替代只在标题栏的按钮，正文再刷屏也看得到。
3. 聊天列表：每行一个状态，按优先级：等你处理（N）＞ 有新回答 ＞ 运行中 ＞ 空闲；列表可筛选“等我处理”。
4. 系统来源：聊天之外需要本人动手的事也进「待处理」：Issue 等你验收/澄清、设备或连接器登录过期、Worker 更新需要你允许、定时工作连续失败。（具体规则实施时按代码中的状态逐项确认。）

## P2 评估（2026-11-05，开发前）

本人追加：规则漏得太多（截图中 “Still waiting on your decisions:” 三项未识别），改为低成本模型；先评估再开发；effort 做成界面上可选；先用 low/medium 看正确率。

方法（数据只在 `/tmp`，评估后删除）：

- 样本：最近 8 天本人顶层对话的 1,326 个最终回答中分层抽 160 个（明显提问 50、通过关键词预筛的其他 80、预筛会跳过的 30）。
- 参考标注：两个 Opus 子 Agent 按与提取提示词相同的定义独立标注（只读文件，不看模型输出）：101/160 含非“顺带提议”的请求，共 217 项。标注者自报的模棱两可项（“先别做 X”、可选的“可以…”、验收步骤、隐含建议）单独记录。
- 预测：scratch 栈（线上 DB 副本，`FOUNDRY_INTEGRATIONS=off`），每个样本一个会话，my-cpa，经 Claude Code（符合“模型请求只经 Agent 自己的 CLI”）。提示词要求只输出 JSON：`{"items":[{kind, quote(原文), question, options, recommendation}]}`，kind 含 `offer`（顺带提议）。
- 首轮 153/160 因本会话的 HTTP 代理（`127.0.0.1:45737`）重置到本地 scratch 的连接而失败；给 Worker 加 `NO_PROXY=127.0.0.1,localhost`、评估脚本不走代理后重跑，三组全部完成。

结果：

| 配置                           | 回答级 精确率/召回率 | 条目级 精确率/召回率 | 原文引用命中 | 明显提问的召回（含提议） | 中位耗时 | 中位输出 token |
| ------------------------------ | -------------------- | -------------------- | ------------ | ------------------------ | -------- | -------------- |
| gemini-3.8-flash-high · low    | 94% / 80%            | 89% / 72%            | 99%          | 86%（91%）               | 24 s     | 186            |
| gemini-3.8-flash-high · medium | 99% / 78%            | 92% / 69%            | 100%         | 88%（93%）               | 44 s     | 4,672          |
| gemini-3.5-flash-lite · low    | 86% / 82%            | 65% / 58%            | 95%          | 88%（88%）               | 16 s     | 115            |

- low 足够：明显提问的漏检只剩定义边界（“先别补材料”、可选的“可以直接回复”、验收步骤列表）；误报多为可辩护的（“等你验收 DEV-111 后我再删” 实际隐含请求；“要不要我配上？” 是提议还是决定）。medium 精确率略高、召回不升，输出 token 约 25 倍、耗时约 2 倍；lite 条目精确率和引用命中明显差。effort 确实生效（输出 token 随之变化）。
- 关键词预筛不可用：预筛会跳过的 30 个回答中 8 个含真实请求（如“需要找小C再验证吗：”“What needs you”“如果你同意…”“建议你现在就提交”），模型在其中 5 个识别到。改为只按结构跳过：回合失败、本人已在识别前回复、非本人顶层对话、过短的回答。
- 成本：评估用的是完整聊天会话，每次输入约 2.7 万 token（几乎全是聊天会话的系统提示与工具）；生产走工具会话（同生成标题的 Claude 工具会话，中位输入约 2,200 token），预计每次 3–5 千输入、约 200 输出，每天约 160 次。

## P2 设计（按实际实现）

- 何时运行：本人发起的顶层聊天（`source=chat`、无父会话）回合正常结束、回答至少 40 字，20 秒后（防抖，本人在此之前再发消息就取消）Foundry 起一个 `triage` 工具会话：只有提示词，没有会话令牌，不在聊天列表出现（与生成标题、项目小结同一机制）。输入为最新回答、本人这一轮的消息、该对话现有的未处理项（id + 标题）。
- 输出 JSON：`items`（kind、quote 原文、question、options、recommendation、same）与 `closes`。Server 只记 quote 确实出现在回答里的项（规范化后比对，模型编的引文丢弃），`offer`（顺带提议）不记；`same` 指向已有项时计为同一项（次数 +1）；`closes` 只关闭本对话的项（标为已回复）。项的消息 id 与转录一致（有消息对象用其 id，Claude 流式回答用事件 id），“打开原消息”能定位。
- 定义（本人未答，按建议默认实现，可改）：直接等你回答是/否的问题算“决定”，只是提一下可选的不算；一组验收步骤算一项；“先别做 X”不算。
- 模型选择：与助理解耦。本人的助理在线上自 10-25 起处于停止状态，挂在助理设置上的识别永远不会运行，所以改为按人保存的独立设置（`pending_triage_settings` 表，`GET/PUT /api/pending-items/triage`，只能选自己的设备，effort 须是该运行时有的档位）。入口就在「待处理」页标题右侧：“识别回答：<模型> · <强度> ›”或“识别回答：未开启 ›”，点开对话框选启用、设备、连接（该设备上的连接，来自 Model providers 与设备账号）、模型（连接的模型列表）、强度（Claude low…max，Codex minimal…xhigh），保存后下一次识别起生效；关闭时保留其余选择。不新增全局设置页。
- 默认关闭，直到本人选了模型：不在本人不知情时产生费用。识别出的项标为“回答里的请求”。
- 未做：识别次数与 token 用量的展示（工具会话的用量在会话记录里，暂未汇总到「待处理」页）。

## 改动

1. 正文降噪（Web）
   - 定时器与后台任务后 Claude 自行继续的回合，在转录里带 `continuation`（`scheduled` / `background`），作为回合起点；`session-turn-folds.ts` 折叠所有“不是本人发起”的回合（其他会话、定时器、后台），不折叠：正在运行的、本人在其中说过话的、含未回答提问卡片的、最新的回合。折叠行按来源写明（“N 个不是你发起的回合 · 2 个来自其他会话、1 个由定时器触发”）；全部来自其他会话时沿用 DEV-119 的文案。
   - 标题栏“只看我的对话”开关（`aria-pressed`，本浏览器记住，`foundry.chat.onlyMine`）：打开时这些回合整段隐藏，最新的也隐藏（运行中的除外），按钮写明“已隐藏 N 个回合”（只计已加载的历史）；只在会话有这类回合或开关已打开时出现。
2. 会话内置顶（Web）：`PendingChatBar` 在输入框顶部显示“等你处理 · N”和第一项标题，展开即各项（回复、打开原消息、完成、忽略），替代原标题栏按钮与对话框（`pending-chat-button.tsx` 删除）。
3. 聊天列表（Web）：搜索框下“等我处理 · N”筛选，只列有未处理待处理项的对话，按项数排序。最初也算未读与失败，在线上数据副本上为 77 个（多为子会话未读，本人顶层对话未读也有 43 个），无法使用，改为只按待处理项（运行失败本来就会生成待处理项）。
4. 系统来源（Server + Web）：「待处理」新增两种属于本人、不属于任何工作区/会话/Issue 的来源：`account`（已连接账号需重新授权，`needs_reauth`）与 `connector`（本人设备上设备持有型连接器的登录已过期，`expired`）。状态会随时间变化而不写库，所以在列出待处理时对账（`pending_personal.go`）：每个过期周期（按过期时间区分）只开一项，同一周期再读不计次数，本人完成/忽略的保持，修复后自动标为“已被取代”；只在有变化时写库。Web：归入“你的账号和设备”一组，标题为“重新授权 X”“重新登录：X · 设备”，操作为“打开连接器”（到该连接器的页签）、完成、忽略。
   - 未做：Issue 等待验收（Issue 状态里没有明确的“等你验收”，推导需要 Issue 规则，暂不猜）；定时工作连续失败（只记录单次运行状态，需另行设计）；Worker 更新需要允许（现由 Agent 自行更新）。
5. 从回答正文识别（P2，Server + Web + 协议）
   - 契约 `SessionSource` 新增 `triage`；Go `store/session_classes.go` 与协议 `session-classes.ts` 把它列为工具会话、只有提示词（`audit-contract` 保持两边一致）；派发不带会话令牌（同 digest）；聊天列表、助理会话列表、Web `isChatSession` 都不算它。
   - `store/pending_items.go`：来源 `answer`；`PendingTriageSettings` 与读写接口；`sqlitestore/pending_items.go` 新表 `pending_triage_settings(user_id, payload_json, updated_at)`（随 Server 启动迁移，只新增表）。
   - `httpapi/pending_triage.go`：调度/取消（`time.AfterFunc` + Server 的工作组）、选工作区（对话本身在所选设备上就用它，否则用本人在该设备上 id 最小的工作区）、提示词、解析与校验、记项与关闭、设置接口与校验；`pending_items.go` 在会话完成时调度、本人发消息时取消、`triage` 会话完成时收结果；`pendingChat` 只认顶层对话。
   - Web：`api/pending.ts` 设置接口；`features/pending/triage-settings.tsx`（标题按钮 + 对话框，shadcn Dialog、SelectMenu、Checkbox、FieldHint）；模型列表复用 `components/workspace/agent-default-fields.tsx` 的 `useProfileModels`（原为文件内的 `useModels`，改为导出）；`active-view.tsx` 把设备与连接传给「待处理」页；中英文案。

## 自验证据

- Web 单测：`session-turn-folds.test.mjs`（定时器/后台回合折叠、按来源计数、未回答提问不折叠、只看我的对话隐藏最新但不隐藏运行中、转录带 `continuation`）；`pending-items.test.mjs`（置顶条只列本会话未处理项、展开、无项不显示；账号/登录项分组、文案、无回复与“打开对话”、打开连接器页签）；`chat-needs-me.test.mjs`。
- Server 单测：`TestPendingItemsForAccountsAndExpiredSignIns`（只属于所有者、同一周期只记一次、忽略保持、修复后被取代、新周期新开一项）；`TestPendingItems*`、`TestChatQueue*`、`TestNeedsHands*` 通过。
- `scripts/check-changed.sh`：步骤 1–3 的 27 个文件（tsc、72 个 Web 测试文件、audit:ui 15 项）与步骤 4 的 12 个文件（gofmt、go test httpapi/sqlitestore/store、audit:contract/modules）全部通过。
- 真实浏览器（scratch 栈，线上 DB 副本，`FOUNDRY_INTEGRATIONS=off`；本人账号密码只在副本中重置，栈已删除）：截图中的编排会话 `sess_1793764358364457763` 显示“17 个由其他会话发起的回合”等折叠行，最新回合完整；打开“只看我的对话”后只剩本人与 Agent 的问答（“已隐藏 23 个回合”），刷新后保持。“等我处理 · 1”只列一个对话，打开后输入框顶部“等你处理 · 1”，展开为回合失败项。深色 390：开关只剩图标且有按下底色，置顶条无横向溢出。账号/登录：副本中真实数据无过期项（正确为空）；在副本里把 byte-dev 的 bytedcli 登录改为一小时前过期，「待处理」出现“你的账号和设备 · 重新登录：bytedcli · byte-dev”，“打开连接器”到 `/connectors/bytedcli`；改回未过期后该项变为“已被取代”；再次过期开新项。截图：`.foundry/attachments/20261105/dev125/`（不入库）。
- 线上：部署后 e2e-alice 调 `GET /api/pending-items` 200（无项），匿名 403；会话已登出。
- P2 单测：`TestTriageKeepsWhatTheAnswerAsks`（提示词带头部；引文须在回答中；`same` 计次；`closes` 只关本对话；提议与编造引文丢弃）、`TestPendingChatIsOnlyThePersonsOwn`、`TestTriageSettingsAreThePersonsChoice`（未选为关闭；别人的设备 403；Claude 没有的 effort 400；保存与关闭保留选择；按人隔离）、`TestTriageNamesTheAnswerAsTheTranscriptDoes`；Web `pending-items.test.mjs` 11 项（标题按钮显示所选、对话框列出连接、关闭后保存的内容、按钮变为“未开启”）。`check-changed.sh` 对 P2 的 26 个文件：prettier、gofmt、协议构建与测试、tsc worker、go test sqlitestore/httpapi/store、audit:contract/openapi/modules 通过；首轮 tsc web（`isChatSession` 的穷举 switch 未列 `triage`）与 hint 审计（对话框里的 `<small>`）失败，修复后 tsc、audit:ui、23 项相关 Web 测试通过。
- P2 端到端（scratch 栈 `dev125e`，线上 DB 副本，`FOUNDRY_INTEGRATIONS=off`，Worker 用本人 HOME，my-cpa `gemini-3.8-flash-high` · low）：保存设置后发一个要求 Agent 给两个方案并问我选哪个的对话；回答 8 秒结束，约 20 秒后 `triage` 会话运行，「待处理」出现“回答里的请求 · 决定：Which renaming approach would you like to take?”，选项两项、推荐项正确，引文是回答原句。首轮发现项没有消息 id（Claude 的回答事件没有消息对象），改为与转录相同的事件 id 后重跑，项带 `evt_…_response_stream`，“打开原消息”可定位。在该对话回复“Go with the alias for one release”后，该项变为“已回复”，简短确认的回答没有新增项。
- P2 真实浏览器（同一 scratch 栈，本人账号）：标题右侧“Reading answers: gemini-3.8-flash-high · Low ›”；键盘聚焦后 Enter 打开对话框，设备 VM-4-8-debian、连接 my-cpa、模型、强度 Low 都回显；强度菜单列出“The model's default”与 Low…Max；取消勾选后四个选择都禁用；浅色、深色、390 宽度无溢出。截图发现保存与取消同样式，保存改为 primary。

## 部署

- 步骤 1–3（Web）：2026-11-05 15:0x UTC+8，持 `/tmp/fdy-deploy.lock`，以 HEAD 为基、`foundry-int` 为本方、主工作区为对方逐文件三方合并进 `foundry-int`；冲突全在相邻改动（DEV-119 已在两边、他人在 `foundry-int` 的“重试/Try again”与加载图标改动保留），逐块处理后无冲突标记；在该树 typecheck、54 个测试、7 项审计通过后发布 Web `825b39b46e32c9bc`（原 `f7a9c6c97c638ba0`，回滚 `releases/dev125/previous-20261105T070441Z`）。中途两次因 prettier 发现残留冲突标记而中止，未发布任何半成品。
- 步骤 4（Server + Web）：15:2x 同法合并；合并脚本一处错误删掉了 `foundry-int` 的 `pending-items.test.mjs`，已从合并前备份恢复并重新合并，与主工作区一致。Go 测试、Web 测试 22 项、typecheck 通过后：Server `e55cc3ed3c3261e0`（原 `101be7c0cd0ac603`，回滚 `releases/dev023-candidate/foundry-server.pre-dev125`，换回后 SIGHUP），新子进程接管，`/healthz` 200；Web `86c41e696d230e8a`（原 `825b39b46e32c9bc`，回滚 `releases/dev125/previous-20261105T072409Z`）。数据库无结构变化。Worker 不涉及。

## 验收步骤

1. 打开一个编排会话（例如 `sess_1793764358364457763`）。预期：其他会话、定时器、后台任务发起的回合折叠成一行行“N 个……回合”，写明来源；最新回合完整显示；标题栏有“只看我的对话”。
2. 点“只看我的对话”。预期：按钮按下并写明已隐藏回合数，正文只剩你和 Agent 的问答；刷新后仍是打开状态；再点恢复为折叠。
3. 在任一有待处理项的对话里。预期：输入框顶部“等你处理 · N”和第一项标题；点开可回复、打开原消息、完成、忽略。
4. 对话列表搜索框下点“等我处理 · N”。预期：只列有待处理项的对话，项数多的在前；再点恢复全部。
5. 某个已连接账号需要重新授权，或某台设备上的连接器登录过期时，打开「待处理」。预期：“你的账号和设备”一组，“重新授权 …”或“重新登录：… · 设备”，“打开连接器”到对应页签；修好后该项自动变为已解决。
6. 打开「待处理」，点标题右侧“识别回答：未开启 ›”。预期：对话框写明用途；勾选“阅读回答，识别需要我做的事”，设备选一台在线的（如 VM-4-8-debian），连接选 my-cpa，模型 `gemini-3.8-flash-high`，强度 Low，保存。标题按钮变为“识别回答：gemini-3.8-flash-high · 低”。
7. 在任一对话里让 Agent 回答时以问句结尾请你选择（例如“给两个方案，推荐一个，问我选哪个，先别改文件”）。预期：回答结束约半分钟内，「待处理」出现“回答里的请求”一项，标题是问题，下面是回答原句，带选项与推荐；“打开原消息”跳到那条回答；侧栏与该对话输入框顶部的计数加一。
8. 在该对话里回答它的问题。预期：下一次回答结束后约半分钟，该项变为已回复（「已解决 · 7 天」里可见）。
9. 再打开对话框取消勾选并保存。预期：按钮变为“未开启”，之后的回答不再识别；再次打开时设备、连接、模型、强度仍是之前的选择。
