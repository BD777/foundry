# DEV-024：回复截断且会话持续 running

状态：2026-10-20 按用户显式委托，对完成恢复及 Skill 下载准备的已验证修复准出归档。01:10 fresh 只读核实 byte-dev daemon 与 actual execution host 均已加载 `1792427546`，关键文件 hash 与发布包一致。最初误拒收诱因、原冷缓存底层网络 cause 仍未取得，见文末残余观察；源码合入见 [DEV-025](DEV-025-release-closure.md)。

## 现象与已证实结论

目标 `sess_1792419078514514568` 位于 byte-dev。Web 显示一段未结束的回复和 Stop，Server 同样保留部分正文与 running。业务正文不复制到本报告。

- 本轮 input：`f6c1622e-eedc-4c60-8af6-327e44bb09c5`。
- 原生 thread：`01a15480-d627-71b1-8aff-ccbc2ec4f011`。
- 远端原生适配器事件共 81 条，末尾依次为 `item.completed`（529 字符）与 `turn.completed`。
- 远端 `completion.json` 为 completed，时间 `2026-10-19T14:30:29.624Z`；`result.md` 为 1148 字节。执行 host claim 同一 input 为 completed；只读进程检查没有该 Foundry session 的原生进程。
- 因此本例不是模型/网关持续等待、工具调用卡住或 native 清理卡住。此前另一轮的飞书错误不能解释本例。
- Server 在北京时间 22:30:28–31 将尾部 session_event 与 session_completed 判为 `message targets work of another device`，并按永久拒收发送 ACK。host outbox 已空，不能靠等待重新投递。
- 完成 envelope：`session_1792420229625_0000004693_9403423e-7529-4363-9313-2441b2f6ee69`，生成毫秒时间与远端 completion 一致。
- Server 当前 input 与上述 input 完全一致，DB 的 device_id 和 payload.deviceId 都是 `dev_ab623721-12b2-4b36-9a23-ae28e2f99854`。没有 chat_deletions；live Server 所有 DB/WAL fd 与磁盘文件 inode 一致。

## 时间线（UTC，括号为北京时间）

| 时间                         | 证据                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| 14:24:07（22:24:07）         | 本轮 started，复用原生 thread                                    |
| 14:30:28（22:30:28）         | Server 最后持久化部分 Response stream                            |
| 14:30:29.624（22:30:29.624） | 远端 completion.json 完成；原生 turn.completed                   |
| 14:30:31（22:30:31）         | Server 日志永久拒收 session_completed 并 ACK                     |
| 14:48–14:49（22:48–22:49）   | compute lease 只读确认实际 PID、entry、claims、本轮产物及 outbox |
| 14:51（22:51）               | Server 日志确认拒收链路；两台设备均有间歇拒收记录                |
| 14:55:39（22:55:39）         | 一致 SQLite 备份 quick_check=ok，保留重启前日志及二进制          |

## 版本与证据位置

- byte-dev daemon PID `2115785`；execution host PID `2118901`，实际 entry：`/data00/home/dengcanwen/.foundry/runtime/0.5.7-dev.39.gc2e46c6.local.1792369800/node_modules/@bd777/foundry-worker/dist/execution-host/main.js`。这是进程与 identity.json 的交叉核验，不只依赖 scheduler 心跳。
- 远端产物：目标 Workspace 的 `.foundry/sessions/<session>/inputs/<input>/{codex-sdk.events.jsonl,completion.json,result.md}`。保留在原设备，不把私有业务内容加入仓库。
- 远端 `~/.foundry/execution-host/{identity.json,claims.json,outbox/}`。
- Server 原始日志：`/home/windeng/.pm2/logs/foundry-server-error.log`，原记录约 6555–6569 行。
- 一致备份：`/home/windeng/.foundry/server-backups/dev024-consistent-20261019T145531Z/`，647839744 字节，quick_check=ok。先前未完成的 `dev024-20261019T145437Z` 不是有效恢复依据。
- 仅本地诊断材料：`/tmp/dev024-evidence/`；提交不包含该目录、备份、密钥或业务内容。
- 本地 HEAD `c2e46c6`，保留已有 DEV-006/007、DEV-008、DEV-022 dirty 修改。

## 原因边界与局部修改

确定的损坏链路：服务端权限检查拒收 → 永久 ACK → 远端移除待投递事件 → Server 留在部分正文/running。

现有 `authorizeTarget` 把 `ErrNotFound` 与真正 device mismatch 都返回 `errForeignTarget`，故旧日志无法区分。其他读错误（context cancellation、锁/忙、反序列化等）已有分支直接返回，并不会按该路径被永久 ACK。不能把猜测的并发/缓存问题写成已证实原因。

诊断补丁保留原始错误类别，补充 session/input/actor/actual device 关联；不记录正文或凭据，不放宽跨设备授权。新增表驱动测试验证同设备、异设备、notfound、取消、deadline、busy、无效 JSON 和嵌套事件 session 身份。首次相关测试通过（2.855 秒）；独立同驱动只读查询目标 100 次均返回正确设备，尚未复现 live Server 的间歇拒收。

## 恢复约束与后续验证

- 不强杀、不强切 byte-dev，不重放用户 prompt，不直接改数据库假完成。
- 完整答复已存在，本例不需要重新模型推理；若能通过精确 input 的既有 completion 恢复，应保留 native thread 与正文。
- 已发现恢复限制：worker 的 `onRecoverSession` 对 `sessionExecutions.handled()`（包括 recent completed）直接返回。因此 Server 重连的 recover_session 不一定能恢复已被错误 ACK 的完成报告；需核验，不能把 Server 重启等同恢复成功。
- 后续需核验：真实拒收错误类别；目标正文哈希/长度与原生结果一致；状态终结；input/thread 不变；其他活跃会话不中断；真实浏览器 Stop 消失。

## 接续核验与修复（15:10 UTC 后）

用户在 15:00:53 发送“继续”，对应 input `6a7cab6a-6bb9-484f-9a77-576bd92e96a8`；远端 15:01:20.842 completed，Server 15:01:43 记录 Codex finished。15:08:07 又发送新的业务请求，对应 `ee84368b-afd7-4e2b-952f-30c4c3e94c0b`，15:10 只读核验已有 217 个原生事件而无 turn.completed / completion.json。因此此时 running 是新业务活跃，不再等同原故障。历史 input 不回填覆盖新 input，也不取消或重放当前业务。

Gateway 团队转来的记录称原第 4 轮经历 TLS EOF、300 秒 header timeout，第三次 attempt 成功后耗时约 6 分 21 秒。这与 14:24:07 开始、14:30:29 原生完成相符，可解释出字前等待；它不能取代 Server 在 14:30:31 拒收并 ACK 的直接证据。14:55:59 Server shutdown / 502 为本次诊断部署，不是原故障起点。未改 Gateway 超时、未重启 Gateway、未加自动 cancel watchdog。

新增三个局部修复：

1. Worker 恢复 guard 仅排除**精确 session + input 仍活跃**的执行，recent completed 可按请求重报其磁盘结果。原有 dispatch 去重继续生效；缺失结果走明确失败报告，损坏 JSON 报错，不运行模型或工具。
2. Server 完成写入在同一事务中重新验证 input，避免 handler 读完旧轮后、新轮已经开始的竞态。成功与失败报告都受此约束；旧结果不修改新 input，重复完成不改答案、native thread 或完成时间。
3. Codex 原生工作 inventory 的异步错误回调在 turn 已 terminal 后不再向关闭的队列写诊断。保留进程组退出确认，再释放 writer 与原生工作控制器。

第三项来自真实稳定测试失败：原 `execution-host.test.mjs:326` 两次等待完成超时；隔离复制的 dist 加诊断确认是 `client.close()` 拒绝仍在途的 `thread/backgroundTerminals/list`，`CodexNativeWork.refresh.catch → onUnavailable → queue.push` 触发 `Claude active input queue is closed` 未处理异常，导致测试宿主退出。不是仅仅测试 18 秒不够，也没有通过加 timeout 或削弱 DEV-008 关闭确认处理。该问题独立于本次旧 byte-dev 版本的 Server 拒收，不能混为原故障原因。

修复后原宿主集成、writer cleanup、completion recovery 组合 12/12 通过；新增 inventory-pending 专项及真实文件锁同 thread 重试 7/7 通过。Server 确定性模拟“读取旧轮之后开启新轮”，成功/失败两分支均不覆盖新轮；事务内重复/旧 input fencing 测试通过。更完整范围检查与隔离浏览器验收继续进行。

第四项由真实隔离浏览器验收发现：completion-only 恢复虽然持久化了补答事件、也把 Stop 变为 Send，但未将补答事件推送给已打开的页面，页面仍显示旧 partial。新事务结算返回仅本次持久化的 fallback answer event，handler 用已有事件通道推送；不让前端以可能属于上一轮的 session.response 猜测改写。原失败 snapshot 位于 `/tmp/dev024-evidence/browser/after-live.yaml`；修复后的浏览器使用独立 fixture 复验，不触碰业务账号。

15:22 前再次核对：用户“继续”轮的 Server 事件 detail 与 message.text 均为 711 字符，SHA-256 `bdbc41f7617fb5a7cbe1319b0107363a272f4e2040eca2822f41a4102bd15472`，与该 input 的远端 completion.response 一致，native thread 未变。当前业务仍是新 input；这证明继续轮正常完整送达，不能将它说成本次补报恢复了原 input。

最终重点回归 22/22 通过，补答事务与 input race 测试通过，隔离浏览器第二次不刷新验收 `completeVisible=true`、`stopAfter=0`。截图 `.foundry/attachments/20261019/dev024-completion-fixture.png`（全部合成数据；标题“running”是测试 prompt/title，不是状态标志）。未持有用户本人登录素材，未冒充用户生成 cookie；目标业务页面视觉验收不声称完成。

范围检查的 21 个 Worker 测试文件、Store、格式及审计通过。HTTPAPI 整包静默执行 474 秒后为诊断取栈中断了**测试进程**；栈显示当时正在另一个测试的 SQLite 迁移，不是本项死锁，故该次整包没有记作通过。后续改用逐例日志分段覆盖，保留第一次中断记录，不把缺少日志当成功或产品故障。

## 最终交付与限制（2026-10-19 15:36 UTC）

| 项目           | 结果                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 原事故原因     | 原生完成后，Server 永久拒收尾部与完成事件并 ACK；远端因此删除 outbox。最初为何错误判定 missing/foreign 尚无可区分的旧日志，不能声称根治。                                                                                                  |
| 修复           | recent-completed 可按精确 input 补报；成功/失败写入事务内 input fencing；持久化补答实时推送；native inventory/compaction 异步诊断不得写入 terminal queue；拒收日志保留原始错误类别。                                                       |
| 范围验证       | 21 个相关 Worker 测试文件通过；最终收尾/恢复重点 22/22；HTTPAPI 493 项覆盖完整，487 pass、6 条件 skip；Store 与格式/合约/模块审计通过。                                                                                                    |
| 分段异常处理   | 直接测试二进制的源码相对目录检查首次因 cwd 不对失败；正确包目录复跑通过。旧 SSE 断言首次未预期新增补答事件，已更新为显式验证正文先于终态并复跑通过。未遗漏未通过项。                                                                       |
| 浏览器         | 隔离真实 UI 不刷新验证 partial → full、Stop 1 → 0；重复完成幂等。真实 typed partial + legacy persisted answer 适配器另验证仅一个完整答案。无 Web 代码变更，无需额外 Web 发布。                                                             |
| Server         | dev health=ok，startedAt=`2026-10-19T15:32:36Z`，实际 PID `490460`；已检查加载二进制包含新 settlement 和诊断逻辑。                                                                                                                         |
| Worker         | 发布并在 byte-dev 加载 `0.5.7-dev.39.gc2e46c6.local.1792423434`。更新回执 succeeded，daemon PID `2941350`。                                                                                                                                |
| Execution host | 先保留旧 host，随后既有 idle-upgrade 路径在无 active claims 时切换；实际 PID `2941885`、entry 为上述新版本。旧 PID 已退出。三个关键已加载 JS 文件的 SHA-256 与验证过的发布包逐一一致。                                                     |
| 目标当前状态   | input `ee84368b-afd7-4e2b-952f-30c4c3e94c0b` 在部署前已自然完成；远端完成 `15:28:45.940Z`，Server 完成 `15:28:46.460540538Z`。254 字符，双方 SHA-256=`2ca3625cd37fee5d15d83a340dc026b2b3896f9731873c8e3228ca4e14ea430e`；thread 保持原值。 |
| 无重放证据     | 更新前后该 input 的 native events 都是 768，turn.completed 都是 1，completion 时间/正文 hash 不变；没有重新推理或业务工具重放，没有 cancel 或直接 DB 改写。                                                                                |
| 原轮历史       | 原 `f6c1622e...` 结果仍在设备；用户已进入后续 input，未将旧 completion 回填覆盖新轮，也不宣称新轮完成是原轮补报。                                                                                                                          |
| 备份           | `/home/windeng/.foundry/server-backups/dev024-final-20261019T153105Z/`，一致 DB 651550720 字节、quick_check=ok，保留上一版发布包。                                                                                                         |

验证材料在 `/tmp/dev024-evidence/`：`api-test-summary.json`、`api-test-manifest.json`、两份 `api-shard-*.jsonl`、`api-final-rerun.jsonl`、`worker-final-focused.log`、`completion-final.log`、`browser-fixed/live-result.log`、`browser-fixed/after.yaml`、`target-final-server.json` 和发布包 `release-final/verification.json`。先前中断的全包检查与隔离失败现场均保留，不当作成功证据。

最终未观察到 14:56 首次诊断重启之后再次出现目标权限误判。这个观察窗口有限；下一次若发生，新增错误会明确记录 session/input、actor/actual device 和原始 notfound 类别。后续应沿此证据定位首次错误读的具体来源；不能用长推理超时、自动 cancel、新会话重放或更换 Gateway 掩盖。现有恢复机制是在精确补报请求到达时恢复真实结果，不是已实现的持续对账 watchdog。

用户验收：在没有新输入运行时刷新目标会话，应看到最新轮的完整答案、无 Stop，仍在同一 thread。业务账号的页面视觉验收由用户完成；本次自验的截图只属于隔离合成环境。请勿以原历史半句仍在而对当前新轮执行取消。

## 独立追加：10 月 20 日 00:14 新轮 `fetch failed`

这不是原 `f6c1622e...` 终态丢失复发。新 input 为 `d42516f4-88ca-4d25-bc36-e4c43982d252`：User message `2026-10-19T16:14:35.869664472Z`，started `16:14:36.270888480Z`，failed `16:14:46.847029063Z`，执行阶段约 **10.576 秒**。事件只有用户输入与 Session failed；该 input 的设备目录、原生 events 与 completion 都不存在。native thread 仍为原 thread，实际 host PID `2941885`、加载版本 `1792423434`。

证据把失败定位到 **Foundry 的 Skill 包准备下载**，没有启动本轮模型推理。`executeAgentSession` 在 `Loaded skills` 之前调用 `materializeSessionSkills`；其模型目录读取的网络错误另有 catch，不会以这次 `fetch failed` 外抛。原生运行目录在后续原生阶段才创建。host journal 同期只保留 Feishu CLI 版本提示；外层错误处理只保留 message，**原始 stack/cause 当时没有保存，现已无法反推其具体网络错误码**。

升级前 `1792369800` 的 materializer 没有归档缓存；新版本为验证所有 Skill 文件，使用校验后的 `skill-archives`，不能相信旧的可变树。这使本轮成为首次冷缓存下载：选中 262 个 bundle 成员、12 个默认/独立 skill 和内置 foundry，共 275 包。远端最终有 273 个归档，全部生成于本次：16:14 分钟 123 个、16:15 分钟 149 个、16:16 分钟 1 个。旧并发实现的某一 lane 失败后，其它 lane 继续派发，故会话已经 failed 后仍下载到 16:16:10。

缺失的选中包只有 `bytedcli` revision 5（5477607 字节）与 `bytedance-ai-dev-pro` revision 1（19426 字节），属于按 skillId 排序的最早一批/紧随其后的请求。实际请求归属为 `https://dev.foundryapp.app/api/skills/catalog/<skillId>/revisions/<revision>/package`，不是 Provider 推理接口。只读重查两包现在均 HTTP 200，字节数及 SHA-256 与服务器发布记录一致；未写缓存、未执行 Skill 方法或业务 prompt。约 10 秒耗时与此前同设备 Node 对 Foundry 地址出现的连接超时相符，但这只是支持性证据，**不能写成本次原始 `UND_ERR_CONNECT_TIMEOUT` 已取得**。

最小修复范围：

- 固定 revision/digest 的 Skill 包 GET 只对明确连接错误码最多重试一次，并显示准备阶段、脱敏 origin/path、skill/revision、attempt 与 cause 分类；原 Error 保留为 cause。HTTP 状态、未知 fetch 错误、abort、校验失败不重试。
- 保持归档 checksum/size 校验及完整快照验证，不降级信任旧树、不改变所选 skill 集合。
- 同批失败或取消后停止派发新包，abort 本批在途请求并 await 全部收束。会话共享不可变磁盘归档，cancelable 网络 promise 仅在本次 preparation 内共享，避免一个会话取消另一个会话的下载。
- 下载阶段注册已有 session cancel 接口，取消会中止下载而不会进入 native runtime；不添加模型重试或新的 watchdog。

首轮 28 项通过，包括冷缓存一次重试成功/热缓存零请求、持久失败不派第 9 项且无残留、跨会话取消隔离、401/403/500/abort/unknown/校验错误无重试无缓存、真实 HTTP socket 断开，以及经 session cancellation 取消下载而没有原生 input 目录。随后增加实际 HTTP body 不结束时的取消回归。证据：`/tmp/dev024-fetch/`；目标业务保持原 failed 状态，本次未授权且未执行 prompt 重放。

### 00:14 故障补丁验证与发布

- `skill-package-fetch.ts` 把重试限定在固定 revision/digest 包的明确连接错误；不改 Provider 请求、不忽略校验。取消传播到正在读取的实际 HTTP body，真实“body 永不结束”测试可结束连接且不重试。
- 下载准备阶段增加可见事件与既有 cancel 接口；网络 promise 从跨会话共享改为本次准备内部共享，磁盘归档仍按 checksum 共享。批量失败首先 abort 本批，再等待在途收束，无持续后台拉包。
- `check-changed` 的 7 个相关 Worker 测试文件、build、格式检查通过；首次模块审计提示新文件缺归属，已将 helper 加到原 skill 模块清单，复查 0 违规。旧 DEV-024/DEV-008 14 项回归独立复跑全部通过。第一次回归与打包重建 dist 并行，产生 module-not-found，已保留失败日志并在打包结束后独立重跑；不将该次算作成功。
- 发布版本：`0.5.7-dev.39.gc2e46c6.local.1792427546`。三个打包 JS 的 hash 与验证过的本地 dist 一致，记录在 `/tmp/dev024-fetch/release/verification.json`。
- 旧发布包备份：`/home/windeng/.foundry/server-backups/dev024-skill-fetch-20261019T163451Z/`。本次无 Server/Web 代码变更，Server 没有重启，health 的 startedAt 仍 `2026-10-19T15:32:36Z`。
- byte-dev 通过既有 update API 更新，回执 `2026-10-19T16:35:27.394Z succeeded`，daemon PID `3025723`，installed current 已为 `1792427546`。

**业务现场再次变化**：用户在 `16:24:23Z` 自行发送“继续”，新 input `5957e8de-2d20-46d5-9712-cec6074b9d6d` 于 `16:24:24.089678773Z` 开始，`16:24:28Z` 已 Loaded skills。此时仍为旧 host，早于本次补丁发布，故不能把这轮正常启动归功于新补丁。新的运行轮不取消、不重放；原 d425 失败记录不改写。

16:35 更新后实际 host 仍 PID `2941885` / 版本 `1792423434`，因为该新 input 正在运行。三个目标原生进程 `2998702/2998709/2999154` 的 startTicks 分别 `356783010/356783014/356784976`，更新前后不变。daemon 保留原宿主，待自然 idle 再自动切换；**安装完成不等于实际宿主已激活该补丁**。未强停当前业务以完成版本验收。

新增验证材料在 `/tmp/dev024-fetch/`：`focused.log`、`check.log`、`audit-final.log`、`previous-fixes-final.log`、`publication.json` 及 release 验证记录。恢复条件：当前网络只读校验已能取到两个缺失包；下次新宿主接管后，新的请求有明确准备阶段、最多一次连接重试和受控取消。当前用户继续轮仍在运行，不应重复发送同一请求；待该轮结束后，若仍需补做，再由用户在同一会话继续。本代理没有代发输入。若再次失败，应依据新错误中的具体 Skill、revision、脱敏请求路径和 cause code 排查，不能泛称 Gateway 推理故障。

## 2026-10-20 显式委托准出记录

用户于 01:07 明确委托“你验证OK了的，你都先确认归档吧”。本轮按已验证范围由 Agent 准出，未追加用户本人测试的声明；历史未通过/待验条目是对应时点记录，不抹除。最终边界、浏览器/版本/合入证据见 [DEV-025](DEV-025-release-closure.md)。

01:10 核验：实际 host PID `3056792`，entry 为 `0.5.7-dev.39.gc2e46c6.local.1792427546`，旧 PID `2941885` 不存在；daemon PID `3025723`。三个 Skill 下载准备文件哈希与发布包一致（DEV-025 列出完整值）。安装与激活两项现已分别证实，无需强切宿主。

残余观察保留两个方向：若 Server 再次误拒收，利用新增 session/input、actor/actual device 和原始 notfound 分类定位第一次异常读取；若准备阶段再失败，依据 Skill、固定 revision、脱敏 origin/path、attempt 与 cause code 定位网络层。原历史原因仍未知；本项准出仅覆盖已验证的恢复、事务 fencing、实时补答与有界下载重试/取消，不包含持续 watchdog 或业务自动重放。
