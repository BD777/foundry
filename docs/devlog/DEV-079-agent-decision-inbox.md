# DEV-079 Agent 待交互事项：「待处理」页（P1：结构化来源）

## 当前状态

| 环节            | 状态    | 说明                                                                                                                                     |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 问题理解 / 调研 | 已完成  | [调研与设计备忘](../research/agent-decision-inbox-20261029.md)（第三稿）；本人决定只做 P1                                                |
| 代码            | P1 完成 | Server 识别与 API、Web「待处理」页、对话计数与对话框、消息深链接；不调用任何模型，不改 Agent 提示词或行为（P0 已回滚，见下）             |
| dev Server/Web  | 已部署  | Server `27983baa5bba2000…`（SIGHUP，`/healthz` 200）；Web `46b5231938184e6e`（含 DEV-081 及其他会话已确认可发布的改动）                  |
| Worker 更新     | 不涉及  | P1 无 Worker 改动；Worker 仍为 P0 回滚版 `.1793259553`                                                                                   |
| Agent 自验      | 已完成  | 单测、changed-file 全部检查、dev 上真实浏览器 E2E（e2e-alice 合成工作区，三种来源实时产生；light/dark × 1280/390、键盘、悬停稳定），见下 |
| 人工验收        | 待确认  | 见文末验收步骤                                                                                                                           |

## 问题

用户 2026-10-29：Agent 常给我 TODO / 确认项，我还没来得及看就被别的内容刷走；回来时每项只剩一句话，没有上下文，没法决定。能否把这些待办抽到一个面板里？先调研业界做法，判断是否值得设计。编排会话 `sess_1793063405185071529`，负责会话 `sess_1793257481936705189`。

## 流水

| 时间（UTC+8）      | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 剩余动作                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 2026-10-29（初稿） | 读取 DEV-063（问题卡片）、DEV-057（会话收件箱）、DEV-071（提示分类）、Issue `ask_person`（`issue_questions.go`，`Issue.Question` 一次一个）、Personal Agent（`list_tasks` 的 `asking` 状态靠 `endsWithQuestion` 文本判断；`update_list` 只记录用户原话）、Feishu 群线程转发（`feishuReactions`）和聊天列表状态。只读查看编排会话 `Response stream`：当天 32 条回复含“需要你……”，同一批事项在多条长回复里被重复列成一句话                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 初稿按“提问收件箱”设计          |
| 2026-10-29（重写） | 用户经编排会话转达方向修正：人应在回路之外，不要引导 Agent 多问，多数决定直接按 Agent 推荐执行即可。备忘重写为“决定记录”：T0 已决定（默认）、T1 将按默认执行（lazy consensus）、T2 需要你动手（仅限只有人能做的事），并定义六个剩余类别和“先变成可撤销的”规则；业界调研改为以自主优先的做法为主（Claude Code auto mode、Codex 审批策略、Apache lazy consensus、Renovate Dashboard、GitHub auto-merge、ADR），以提问为中心的产品作为对照                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 用户就待决问题做决定；P0 可先行 |
| 2026-10-29 15:27   | P0 上线：编排会话转达本人方向（人在回路之外），未有异议，待决问题按备忘推荐作为默认。Skill 修订 12、会话注入提示、`ask_person` 说明；Server SIGHUP，Worker `.1793258788` 在 dev 服务器设备安全更新                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | P1（工具、页面、到期生效）      |
| 2026-10-29 15:35   | 用户否决 P0：不要加 “Decide; do not ask”，不要影响 Agent 的行为；真正想要的是把需要交互的内容识别、抽取出来。P0 完全回滚并重新部署（见回滚记录）；备忘重写为第三稿：零改动 Agent，结构化来源加回合结束的文本抽取（经 Agent 会话运行），每项带原文摘录、选项、深链接和来源，面板回复走 DEV-057                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 用户就 4 个待决问题做决定；P1   |
| 2026-10-29 17:40   | 本人决定：文本抽取（P2）因模型成本暂不做，以后可能由 Foundry 系统内的低成本模型承担；旧对话补抽（P3）不要，只看新活动。只做 P1：结构化来源 + 「待处理」页，不调用模型，不改 Agent。P1 上线：Server `a70e1aa0…` → 规则与标题修正后 `27983baa…`；Web `4fafd2f5…` → 深链接修正后 `30b5ca0b…`；e2e-alice 合成工作区实时验证三种来源                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 人工验收                        |
| 2026-10-29 18:20   | 编排会话验收功能后指出四处视觉问题，已修：① 每项只显示一次原文——标题由来源推导（问题即问题本身；权限错误为“权限被拒绝：<路径>”；失败为错误首行），摘录块只在比标题多出内容（多行或更长）时显示；② 推荐选项去掉 Agent 自带的 “(Recommended)/（推荐）”，只保留一个“推荐”标签；③ 页面说明缩成一句；④ 卡片收紧为“标题行 + 一行选项/操作”，上下文改为操作行里的切换，1280 下典型一项约 77 px（原约 240 px），一屏可见 5 项。回复框改用 `Textarea tone="boxed"`。在本地构建 + 真实 dev API（待处理列表用与实测相同形状的样例）上复拍 light/dark × 1280/390（`.foundry/attachments/20261029/dev079/v2/`）；Web 部署等其他会话确认共享树可发布后进行。与 DEV-082/084/086/088 确认共享树可发布、全量 tsc 通过后统一构建一次：Web `46b5231938184e6e`（上一版 `30b5ca0b…` 保存在 `releases/dev079-web/previous-*`）；线上复拍 light/dark × 1280/390（`.foundry/attachments/20261029/dev079/live/`，待处理列表用样例），与本地预览一致，悬停不移位；Server 未重启 | 人工验收                        |

## 决定（2026-10-29，本人经编排会话）

- 只做 P1：结构化来源 + 「待处理」页。不调用任何模型；不改 Agent 的提示词、Skill、工具说明或行为。
- P2（自由文本抽取）暂不做：模型成本高，以后可能由 Foundry 系统内的低成本模型承担。P3（旧对话补抽）不要：只看新活动，上线前的记录不回填。

## P1 交付（2026-10-29）

**来源**（只读、确定性，都在 Server 的会话观察者里识别，`httpapi/pending_items.go`）：

| 来源               | 识别                                                                                                                                                                                                                                   | 自动解决                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 问题卡片           | 事件消息带 `questions`（DEV-063），每个问题一项，原样带选项；选项里标了 “(Recommended)/推荐” 的记为推荐                                                                                                                                | 本人之后在该对话发消息（含 steer）→ 已回复         |
| Issue `ask_person` | `issueUpdated` 时 `Issue.Question` 存在 → 一项（类型 input/permission）                                                                                                                                                                | 问题被回答或 Issue 结束 → 已被取代                 |
| 回合失败           | `Session failed`（error）事件；同一对话的重复失败合并为一项，计出现次数；取消不算                                                                                                                                                      | 之后有回合成功完成 → 已被取代；本人发消息 → 已回复 |
| 需要你操作         | 工具失败输出（只看输出，不看命令）逐行匹配：`sudo:` 要密码、`Foundry gateway:`、Docker socket 权限、token/登录过期、非本机的 HTTP 401/403、工作区外路径的权限拒绝（EACCES / Errno 13 / coreutils）；Claude 的 `Permission denied` 事件 | 本人发消息 → 已回复；或手动                        |

- 只为本人发起的普通对话（`source` 为 chat、无 role、未归档）生成；Agent 派出的子会话、命名/摘要/验证等工具会话不生成（它们向派出者汇报）。会话的 `blocked` 只表示限流重试，不生成。
- 保守规则的依据：上周 994 条失败工具输出中，宽泛模式（任意 401/403、任意 “Permission denied”）大多是代码片段或有意的鉴权探测；收窄后工作区外权限规则只命中 3 条，均为真实的人工权限问题。
- 去重：按来源身份（问题 = 消息 id + 序号；失败 = 对话；需要操作 = 对话 + 规则；Issue = 问题 id）。同一事件重复上报不增加次数；已解决后同一事件再报不会重新打开。

**存储与 API**：`pending_items` 表（`sqlitestore/pending_items.go`，随工作区/会话/Issue 删除级联）；`GET /api/pending-items`（本人的未处理项 + 7 天内已解决项，附会话标题、工作区名、每个对话的计数；已归档或已删除对话的项不返回）；`POST /api/pending-items/{id}/state`（done / dismissed / open）。两者都是 `personOnly`，会话 token 和设备凭据拿不到。

**Web**：侧栏「助理」组新增「待处理 / Pending」（全局视图，徽标为未处理数）；`/pending` 页按对话分组，筛选「未处理 / 已解决 · 7 天」；每项显示来源、规则、原文摘录（长的可展开）、上下文（问题所在回答的结尾 / 失败的命令）、选项与推荐、发现时间、出现次数；操作：回复、打开原消息、标记完成、忽略、重新打开。对话列表每行显示未处理数；打开的对话标题栏有「待处理 · N」按钮，打开对话框（`Dialog`）列出该对话的项。回复经对话队列以 `steer` 发出（运行中则进入当前回合，空闲则作为下一条消息），正文先引用摘录再接本人回复；Issue 的问题改走 Issue 的回答接口。「打开原消息」带 `?message=` 打开对话，消息载入后滚动到该行并短暂高亮，然后从地址移除参数。不新增任何通知。数据每 20 s（页面可见时）、切回页面、对话回合结束时刷新。

**改动文件**：Server `store/pending_items.go`、`sqlitestore/pending_items.go`、`sqlitestore/migrations.go`、`sqlitestore/workspace_deletions.go`、`httpapi/pending_items.go`、`httpapi/routes.go`、`httpapi/server.go`，测试 `httpapi/pending_items_test.go`、`httpapi/events_sessions_test.go`；Web `api/pending.ts`、`api.ts`、`features/pending/*`、`app/{navigation,use-document-title,view-error-policy,active-view,app-sidebar,use-chat-view}.ts(x)`、`App.tsx`、`components/ui/page-surface.tsx`（新变体）、`components/conversation/{conversation,chat-transcript-stage}.tsx`（消息定位）、`features/chat/{chat-surface,chat-surface-types,chat-list-row,use-chat-feature}`（标题栏插槽、行计数）、`lib/in-app-navigation.ts`、`i18n`（新 `pending` 命名空间与 `shell`/`chat` 的键，中英）、`styles/77-pending.css` 与 `20-chat-list.css`、`20-chat-transcript.css` 各一小段，测试 `test/pending-items.test.mjs`、`test/fixtures/sidebar-scope.tsx`。

**检查**：

- Server：`go test ./internal/...` 全量（sqlitestore 通过；httpapi 一次在并发负载下出现 `TestAssistantOperationAdoptsExistingOwnerWithoutDuplicateTasks` 失败，单独连跑 3 次通过，随后 changed-file 跑 httpapi 整包通过，判断为负载下的时序抖动）。新增测试覆盖规则（14 种输出，含命令里提到错误但输出无错不算）、问题去重与重放、失败合并与被取代、他人会话消息不算回复、本人消息算回复、手动状态与越权 404、未登录拒绝、子会话不生成、Issue 问题生成与回答后取代。
- `scripts/check-changed.sh`（45 个文件）：prettier、gofmt、tsc、Web 测试 111 个文件、go test httpapi/store/sqlitestore、audit:ui（12 项）、audit:contract、audit:modules 全部 PASS；之后改动的 5 个文件另跑一次：prettier、gofmt、tsc、Web 测试、go test 通过；audit:ui 只报他人正在改的 `features/devices/device-settings.tsx`，audit:modules 只报他人新增的 Worker 文件 `external-connection-setup`、`slot-wait`，本项文件全部通过，audit:contract 重跑通过。
- 部署：Server 每次部署前确认共享树中比线上新的 Server 源文件只有本项；最终 `27983baa5bba2000…`，回滚副本 `foundry-server.pre-dev079p1`（P1 前的回滚版）。Web 每次部署前确认他人改动（DEV-081 已协调合并发布；另一会话新增的两个未使用的文案键一并发布）；最终 `30b5ca0b8ef7c12b`，前一版保存在发布目录 `releases/dev079-web/previous-*`。

**真实浏览器 E2E**（dev，e2e-alice，DEV-048 合成设备与工作区 `ws_d4da0f57-…`，详见 test-environment.md）：

- 实时产生三种来源：Codex 用 request_user_input 提问 → 问题项（选项与推荐正确）；`cat /etc/shadow` 与 Python 读取 → 需要你操作 / 权限（两次合并为一项）；不存在的模型 → 回合失败（两条失败事件合并）。另一条 `sudo -n true` 在本机成功（免密 sudo），正确地没有生成项。
- 页面：1280/390 × light/dark 均无横向溢出（截图 `.foundry/attachments/20261029/dev079/pending-*.png`）；侧栏徽标随数量变化；悬停和聚焦「回复」时卡片位置尺寸不变；Tab 可达各操作。
- 对话：列表行显示计数；标题栏「待处理 · 1」打开对话框，Escape 关闭且焦点回到按钮（`chat-dialog.png`）；「打开原消息」打开对话、滚动并高亮该问题，随后高亮和 `message` 参数都清除（`chat-deep-link.png`）。
- 操作：点选项「Alpha (Recommended)」填入回复框，Ctrl+Enter 发出；会话收到 `> 问题原文` + 回复作为输入并开始新回合，问题项自动变为已回复。标记完成、忽略、在已解决里重新打开，计数和徽标随之变化（`pending-reply-draft.png`、`pending-resolved.png`、`pending-after-actions.png`）。
- 验后归档 4 条合成对话，其项随即从列表消失；登出并删除 cookie；合成 Worker 已停止。

## P0 回滚记录（2026-10-29）

- 原因：用户的原则是不约束 Agent、不改变其平常做法；P0 恰恰改了 Agent 的行为指引。
- 回滚范围：两份 `SKILL.md`、`delegation-instructions.ts` 中的 `decisionInstructions` 及其在 `session-policy.ts`、`runner/codex-options.ts` 中的注入、`runner-skills.test.mjs`、`mcp_tools.json` 中的 `ask_person` 说明，均恢复为 HEAD 原文。
- 修订号：已下发过的修订 12 不能复用，因此改为修订 13，内容与修订 11 相同，校验和同为 `92444a92…`，设备会重新拉取原文。`builtinskills_test.go` 记录 13 和 12 两个修订。`git diff HEAD` 对上述文件只剩 `builtinskills.go` 的修订号和测试里的两行记录。
- 检查：`check-changed`（prettier、gofmt、worker build、17 个 worker 测试文件、go builtinskills、audit:contract）全部 PASS。
- Server：`4fb48bb5e4efbde1…`，SIGHUP 交接，新进程的 `/proc/<pid>/exe` 校验和一致，`/healthz` 200；二进制中已无 “Decide; do not ask”，并含原句 “If you are blocked, end with”。P0 版的回滚副本 `foundry-server.pre-dev079` 即 DEV-076 的 `f704734c…`，仍保留。
- Worker：`.1793259553` 已发布；P0 版的包备份在服务器发布目录 `releases/dev079-revert/previous-worker-packages/`。与 P0 前的 `.1793256296` 逐文件比较，只有 `package.json` 不同；包内 `SKILL.md` 与 HEAD 字节一致。dev 服务器设备经独立 `systemd-run --user` 单元执行 `foundry-worker update`（`.1793258788 → .1793259553`），daemon 已在新版本运行。其他设备未动。
- 残留：dev 服务器设备上有两个按内容寻址的 skill-set 快照仍含 P0 文本，属于 P0 期间启动的会话，未删除，避免影响它们；新会话会按修订 13 生成快照。期间忙碌的执行宿主一直保留 P0 前的 `.1793256296`，因此注入提示没有进入它运行的会话。

## P0 交付（2026-10-29，已回滚，仅存档）

改动（仅文字与对应测试，无产品逻辑）：

- `packages/worker/skills/foundry/SKILL.md` = `apps/server/internal/builtinskills/foundry/SKILL.md`：新增 “Decide; do not ask” 一节（默认按自己的推荐执行并在最终回答里记一次决定、理由、替代方案、撤销方法；先变成可撤销的；只有六类事项交给人且不阻塞；多数用 “I will do X at <time> unless you object”，默认下一个工作日 10:00 之后、至少 2 小时；只有物理上做不到的才写一条完整的 “needs your hands”；每个待办只写一次，之后引用标题；有合理默认的偏好不问；本人的明确指示优先；Issue 里 `ask_person` 只用于六类）。助理一节的“被阻塞时问一个问题”改为一条完整请求。
- `apps/server/internal/builtinskills/builtinskills.go`：Foundry Skill 修订 11 → 12；`builtinskills_test.go` 记录修订 12 包校验和 `17ee519b…`。
- `packages/worker/src/delegation-instructions.ts` 新增 `decisionInstructions`（“Foundry decisions:” 五条），`session-policy.ts`（Claude）与 `runner/codex-options.ts`（Codex）都接在 delegation 指引之后注入；`test/runner-skills.test.mjs` 断言两运行时都恰好含一次。
- `apps/server/internal/httpapi/mcp_tools.json`：`ask_person` 说明收窄到六类，其余自己决定并在总结里说明。

证据：

- `scripts/check-changed.sh --files <9 个文件>`：prettier、gofmt、worker build、worker tests（17 个文件）、go test builtinskills、audit:contract、audit:modules 全部 PASS；另跑 `go test ./internal/httpapi/ -run 'Foundry|Skill|Tool|MCP|Guidance'` 通过；字节一致测试 `foundry-skill.test.mjs` 通过。仓库没有提示词 golden 文件；修订闸门即上面的修订号与校验和测试。
- Server：部署前确认线上二进制为 DEV-076 的 `f704734c…`，且共享工作树中晚于它的 Server 源文件只有本项文件；构建 `081b2b944424a4f7…`，回滚副本 `foundry-server.pre-dev079`，SIGHUP 后新进程接管（`/proc/<pid>/exe` 校验和一致），`/healthz` 200。
- Worker：同样确认晚于上一版 `.1793256296` 的 Worker 源只有本项文件；旧包备份在服务器发布目录 `releases/dev079-guidance/previous-worker-packages/`。新包与旧包逐文件比较只差 `delegation-instructions.js`、`session-policy.js`、`runner/codex-options.js`、`skills/foundry/SKILL.md` 和 `package.json`。`/api/worker/release` 返回新版本；dev 服务器设备经独立 `systemd-run --user` 单元执行 `foundry-worker update`，daemon 已在新版本运行；忙碌的执行宿主保留旧版，空闲切换后新会话才拿到注入提示。其他设备未动。

## 限制

- 需要你操作的规则刻意收窄：只认上面列出的几类输出；Agent 自己能绕过的错误（404、测试失败、工作区内文件）不算。漏掉的类型可按真实数据再加规则。
- 「打开原消息」只能定位已载入、且作为独立一行显示的消息；工具步骤若被折叠进处理过程、或失败没有对应消息，则只打开对话。
- 列表最多返回 300 项；已解决项保留 7 天可见（数据不删）。Issue 问题按 Issue 分组，不计入对话的计数。
- 未新增浏览器推送事件：数据靠 20 s 轮询、切回页面和回合结束刷新（新增事件类型需要改 protocol 包，当时有其他会话在改）。
- 业界引用沿用调研稿，未逐页核对。

## 验收步骤

1. 打开 dev，侧栏「助理」组下有「待处理」，没有待处理事项时显示“没有等你处理的事项”。
2. 在任一自己的对话里让 Codex 用提问工具问一个带选项的问题（或等一次真实提问）。预期：几秒内侧栏「待处理」出现数字；页面里该项显示问题原文、选项和推荐、来源对话和时间；对话列表那一行显示数字，标题栏出现「待处理 · 1」。
3. 点「打开原消息」。预期：进入该对话并滚动到那条提问，短暂高亮。
4. 回到「待处理」，点一个选项或「回复」，写一句话发送。预期：对话里出现一条以引用开头的你的消息，Agent 继续；该项移到「已解决」并标为已回复。
5. 在对话里直接回复也会把该项标为已回复；「标记完成 / 忽略 / 重新打开」可手动改变状态。
6. 预期没有任何新通知；Agent 的提示词、Skill 和行为没有变化（foundry Skill 修订号仍为 13，内容与 P0 前相同）。
