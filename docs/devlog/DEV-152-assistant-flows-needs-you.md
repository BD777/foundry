# DEV-152 助理按流程选模型，“等你处理”合成一条管道

状态：已实现；Go / Web 测试与真实模型 E2E（dev，e2e-alice 合成数据）、真实浏览器自验通过；已部署 dev（Server、Web）；待本人验收。设计：[助理编排 §f–§h](../assistant-orchestration.md)。

## 问题（本人 2026-11-09，经编排会话 `sess_1794143153454726480`）

- §f-2：不要“后台整理一律用帮手模型”，改为“各个事情分别可配”（“记忆整理这种可能需要聪明模型……我倾向贵模型”），并在设置里列出助理的全部流程、触发时机与拓扑。
- §f-4：续用已有会话时沿用它自己的模型，不再等待（`owner_configuration_differs`）。
- §f-5：彻底删掉回答识别（P2）：代码、设置界面、存储与历史 `answer` 项（“历史的 pending 我也不看了”）。
- §f-6：不要“10 分钟后再进待处理”；一条管道、只用结构化信号，每项记录由助理还是本人处理；本人只看一个“等你处理”列表。
- 编排会话补充：家电脑离线时交给本人的项，电脑回来后不能从本人列表里消失，直到任一方解决。

## 调查

- 助理用到模型的流程（子 Agent 按代码列举，见 §g）：对话与安排（收件箱；监督、电脑上线、提醒、每日摘要、提议决定这些通知都续在对话里）、交出去的工作（`dispatch_item`）、项目概括（原来借用 coordinator）、记忆整理、项目整理。会话命名是通用功能，不算助理的。
- 结构化提问在帮手上的现状：Claude 帮手有 `AskUserQuestion`（DEV-148 转达给助理）；Codex 帮手在默认模式下没有 `request_user_input`（Codex 0.167 的 `default_mode_request_user_input` 未开），且 Foundry 给帮手的审批策略是 `never`，所以 Codex 帮手只会在回答正文里提问。另一会话的数据：本人对话里 Claude 用提问卡片 1/129 个回合，只在正文里提问约 32 个回合。正文提问由助理经监督通知（“以提问结束”）看到，需要本人时用 `needs_you` 交出，这是“等你处理”对正文提问的唯一来源（P2 删除后）。

## 修复

**按流程选模型**

- `personalagent.RunRoles` = coordinator、executor、digest（新）、memory、governance；`RunPreference`：有覆盖用覆盖；coordinator 用 `runDefault`（再旧字段）；executor 沿用 DEV-150；digest、memory、governance 默认用助理的选择（`roleOverrides.coordinator` → `runDefault` → 旧字段，去掉设备）。
- 项目概括改用 `digest` 角色（`workspace_digests.go`）。
- 设置“用哪个模型”：先画拓扑（见下），再按流程各一组：触发时机、做什么、与助理相同 / 各电脑的默认 / 指定一个（来源按 id 合并各电脑）、用不了时等待或改用电脑的默认。旧的“后台角色编辑器”（执行设备、预算、超时、显式备用的表单）删去，已存的预算与备用随选择保留。运行记录列表显示流程名。
- 拓扑图（编排会话要求查清根因）：第一版用 Streamdown 在设置页画 Mermaid，图一直停在 Streamdown 的 Suspense 占位上。查到的原因：
  - 直接原因：React 的重试 lane（Suspense 等到 chunk 后重新渲染用的）比 transition lane 优先级低，而且不会过期。设置页上一直有 transition 工作，重试永远轮不到。实测：根节点 `pendingLanes` 长期含 `0x400000|0x800000`（重试），回调优先级是 transition；每秒约 30–60 次 commit。同一段 Markdown 单独渲染（不挂 App）2 秒内出图。
  - 根因：App 级常驻的聊天功能（`useChatFeature`）里的 `useDeferredValue(threadSessions)` 每次都拿到新数组，所以每次渲染都排一次延后渲染，延后渲染又产生新数组，无限循环。新数组的源头是 `useChatArchive`：不在“对话”页时它不读归档，`data.workspaceId` 与当前工作区不同，于是每次渲染都返回新的 `{ chats: [], sessions: [] }`，`archiveSessions → sessions → threads → selectedThread.sessions` 一路都变成新的。在“对话”页时归档读到了当前工作区，数组稳定，所以转录里的图没事。实测修复前 `threadSessions` 8 秒换了 211 次，修复后 3 次（跟着实时数据）。
  - 修复：`useChatArchive` 在不匹配时返回模块级的同一个空列表和空集合（`noArchive`、`noneRestored`）。测试 `chat-archive-stable.test.mjs`：去掉修复会失败。这个循环在除“对话”以外的每个页面都在空转 CPU，不只影响这张图。
  - 修复后 Streamdown 能出图，但它把图包在 flex 容器里，SVG 的 `width:100%` 按 300px 默认宽度算，848 px 宽的图被缩到 299 px，字只有约 9 px。所以设置页不用 Streamdown 的代码块，改由 `renderMermaidSvg`（`markdown-mermaid.tsx`，经 `@streamdown/mermaid` 插件的公开 `getMermaid(config).render`，配置与回答里的图相同：`securityLevel: strict`，跟随主题）画成普通块级 SVG，在 760 px 宽内按原比例显示。流程是实线粗边框，事件是虚线框，连线上写触发方式。
  - 结构化列表保留：宽屏时给读屏（`sm:sr-only`，图本身 `aria-hidden`）；窄屏（< 640 px，图里的字太小）、图还没画好或画不出来时，直接显示列表。

**续用会话沿用自己的模型（§f-4）**：`run.Resolver.PinSession`：续用已有会话时快照记会话自己的账号、模型、强度（`selectionReason = continued_session`），只检查电脑、项目、权限；`owner_configuration_differs` 不再出现。

**删除 P2**：`pending_triage.go`、路由、Server 字段、`triage` 会话来源（契约、协议、Go）、Web 识别设置对话框与文案；迁移 `DROP TABLE pending_triage_settings`、删除 `answer` 项与 `triage` 会话。

**一条“等你处理”管道**

- `pending_items` 增加 `handler` 列（默认 `person`），载荷增加 `note`、`handedReason`、`handedAt`；来源增加 `helper_stuck`。
- 记录：本人顶层对话（含助理对话）→ `person`；助理派出的帮手（`pa_tasks` 有它或父会话是助理对话）→ 助理在运行且家电脑在线时 `assistant`，否则 `person`。帮手卡住（连不上模型服务、超过“可能卡住”时长）由监督记 `helper_stuck` 项。
- 解决：帮手收到本人或助理的新输入，其提问 / 失败 / 需要动手 / 卡住项标为已回复；回合完成作废失败与卡住项；会话取消作废全部。
- 助理：新 MCP 工具 `needs_you`（只给 `personal_agent`）：`list`（两类未结项）、`hand_over`（附一句话交给本人；按会话 id 且没有未结项时新建一项，用于正文提问）、`resolve`（关闭在别处处理掉的项）；只能处理自己帮手的项。转达给助理的帮手提问附上 `hand_over` 的用法；每轮上下文附“等你处理”计数与本人前五项标题；提示词版本 `2026-11-09.1`。
- 停下：停止开关把 `assistant` 项全部交给本人（`assistant_stopped`），停下期间不再把帮手提问转达到助理收件箱。离线：本人读列表时把 `assistant` 项交给本人（`assistant_offline`），电脑回来后仍留在本人列表，直到任一方解决。
- Web：「待处理」改名“等你处理”，只列本人要处理的项；助理交来的项显示“助理：……”或停下 / 离线的原因；页尾折叠“助理在处理 · N”只读；计数只算本人的；助理首页右栏“等你处理 · N”列前三项并可打开列表。

## 检查

- Go：`TestNeedsYouOneListWithTwoHandlers`、`TestNeedsYouOfflineItemsStayWithThePerson`（离线 → 交给本人 → 回来后仍在 → 助理 resolve → 消失）、`TestNeedsYouStoppedAssistantHandsOver`、`TestAssistantContinuedSessionKeepsItsOwnModel`、`TestFlowsFollowTheAssistantUnlessChosen`、`TestPendingTriageStorageIsDropped`；`personalagent/...`、`sqlitestore`、`store` 通过。
- “httpapi 偶发失败”查清了，不是偶发：`scripts/check-changed.sh` 设 `FOUNDRY_REQUIRE_WORKER_BUILD=1`，要求 `packages/worker/dist` 已构建；本 worktree 从未构建 Worker，只改 Server 时脚本也不安排构建，于是 `TestCloudflareCLIContractThroughTheGateway`、`TestFeishuCLIContractThroughTheGateway`、`TestFeishuCLIEventConsumeThroughTheServer`、`TestSessionWorkResidentSupervisorActuallyWakesAnIdleSession` 必然失败。直接 `go test` 时它们跳过，所以之前“单独重跑通过”其实是跳过。为了能看到是哪个测试，`check-changed.sh` 改为失败时保留完整日志并打印路径（原来只给最后 80 行就删掉）。构建 Worker 后这四项通过（41.6 s），完整 `check-changed`（34 个文件，含 httpapi 702.9 s）通过；只有 prettier 指出两处格式，改后 Web 各项重跑通过。
- Web：`personal-agent.test.mjs` 29 项（新：各流程的触发与选择、拓扑、只改一个流程不影响其他、拓扑生成的 Mermaid 图）、`chat-archive-stable.test.mjs`、`pending-items.test.mjs` 14 项（新：一个列表、助理在处理的单独只读、助理的话与离线原因、计数）；`tsc`；`audit:ui`（提示审计）。

## 部署

- 2026-11-09 13:05（UTC+8），持 `/tmp/fdy-deploy.lock`：主仓库里另一会话的 DEV-125 文档改动（已并入本分支）先还原；本分支 diff 以 `git apply --3way` 应用（生成的契约文件与 `sessions.yaml` 除外，`sessions.yaml` 只删 `triage` 一行，再 `pnpm generate:contracts` 与 DEV-153 未提交的契约改动合并）；在线备份 `backups/foundry-20261109-1305-pre-dev152.db`（integrity ok，保留最近 3 份）；Server 替换（旧版 `foundry-server.pre-dev152b`），`pm2 restart`（未用 `--update-env`），`/healthz` ok；Web `61e00a395a8a236b`。13:36、13:43 两次只发 Web（拓扑），Web `30f4fe8a505bdcff`。2026-11-09 15:59（UTC+8）持锁只发 Web（拓扑图与归档空列表修复）：三个文件复制到主仓库后 `vite build`，经 `scripts/deploy-web-dev.sh` 发布 `cfa3f9bd2ff0f1f7`（上一版 `81c9891c7cd1eabe`，入口保存在 `~/.foundry/releases/dev152-web/previous-20261109T075933Z`）。dev 上用真实浏览器检查：浅色和深色在 1440 宽时都显示图（734×379），390 宽显示列表，没有横向溢出和页面错误；空闲页面 3 秒内 0 次 React 提交（修复前每秒约 11 次）。截图 `diagram-{light,dark}-{1440,390}.png`。部署前清理磁盘：删去 17 个旧的 Server 回滚副本（更新的仍在）。Worker 无改动。

## E2E（dev，真实模型，e2e-alice）

合成设备 VM-4-8-debian（`dev_a870ddf7-…`，状态目录 `~/.foundry/dev148-acceptance/`，`dev152-synthetic-worker` 单元临时运行），合成工作区 `ws_68dbe9ca-…`，助理工作区 `ws_4e5616b1-…`。设置：对话与安排 Codex `gpt-6-astra` · high；交出去的工作 `gpt-5.6-luna` · low；项目概括指定 `gpt-6.1-terra` · medium；记忆、项目整理与助理相同。

- 按流程的模型：`run-preview` 五个流程分别为 astra·high / luna·low（configured）/ terra·medium（configured）/ astra·high / astra·high；实际运行快照：对话 astra·high，帮手 luna·low，续用帮手 `continued_session` luna·low；14:03 项目概括按防抖自动运行，快照 `digest` · `gpt-6.1-terra` · medium（`configured`，会话 `sess_1794204232342074310`）。
- 助理自己回答帮手：帮手 `sess_1794200885302464141` 在回答里问“写 alpha 还是 beta？”，助理续用同一帮手回答 alpha（会话沿用自己的模型），文件为 `alpha`；本人列表始终为 0。
- 助理交给本人：帮手 `sess_1794201005308182850` 问“内容用中文还是英文？”，助理 `needs_you hand_over` → 本人列表出现一项（`handedReason=assistant`）；真实浏览器里点“回复”输入“英文”发送，项变为 replied，帮手写出 `English test content.`。
- 结构化项由助理认领再交出：对该帮手发一条不存在的模型使回合失败 → `turn_failed` 项 `handler=assistant`，本人计数 0；助理收到失败通知，读上下文后 `needs_you hand_over`（附说明“请先在原对话中恢复可用设置”）→ 本人列表显示“助理：……”。
- 停下时直接给本人：停止助理后让另一帮手回合失败 → 新项 `handler=person`、没有 `handedReason`，助理未收到通知。
- 本人直接开的对话：失败回合进本人列表；恢复助理后问“现在有哪些等我处理的事？”，助理调 `needs_you list`，列出包括“你自己新开的测试对话”在内的 3 件，并给链接。
- P2 已删：`PUT/GET /api/pending-items/triage` 405；dev 库没有 `pending_triage_settings` 表、`answer` 项为 0，`pending_items` 有 `handler` 列。
- 浏览器（Chromium，alice，中文）：“等你处理”、助理首页、设置“用哪个模型”在浅 / 深 × 1440 / 390 无横向溢出、无页面错误；截图在本人工作区 `.foundry/attachments/20261109-dev152/`。

## 限制

- Codex 帮手没有结构化提问（见“调查”），它们的提问靠助理读回答后交出；正文提问不会自动进列表。
- 离线交给本人发生在本人读列表时（列表、侧栏计数都会读）；从未读过则电脑回来后仍归助理。
- 通知续在原对话里，用对话开始时固定的模型。

## 验收步骤

1. 打开“助理设置 → 用哪个模型”。预期：顶部是流程拓扑图（流程为实线框、事件为虚线框；手机宽度下是逐条列表）；下面五组（对话与安排、交出去的工作、项目概括、记忆整理、项目整理）各写明何时运行；后三组默认“与助理相同”。
2. 把“项目概括”改为指定一个便宜的模型并保存。预期：只有这一组变成“指定一个”，其他组不变。
3. 让助理派一件事，并要求帮手动手前先在回答里问你一个只有你能决定的问题。预期：侧栏“等你处理”出现 1 项，写着助理的话；在那里回复后，帮手按你的回答继续，项变为已回复。
4. 让助理派一件它能自己决定的事（同样先问一句，但你说“你替我选”）。预期：“等你处理”里没有新项，助理回答帮手后完成。
5. 点“停止助理工作”，再让一个帮手出错（或等一个帮手失败）。预期：它直接出现在“等你处理”，写明助理已停下。
6. 在某个项目里自己开一个对话并让它失败；问助理“有哪些等我处理的事”。预期：助理提到这个对话。
7. “等你处理”页没有“识别回答”的入口。

## 时间线

- 2026-11-09 11:47–13:50 UTC+8：设计（§f–§h）、实现、测试、部署 dev、E2E 与浏览器检查（本会话，worktree `../foundry-assistant-flows`，分支 `feat/assistant-flows`）。
