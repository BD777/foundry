# 存储瘦身 spike：先删冗余，再谈压缩（工作底稿）

日期：2026-11-02。对象：线上库 `~/.foundry/server/foundry.db` 的只读副本（SQLite backup API 从 `mode=ro` 源拷出，1,354 MB）。所有测量都在副本和 `/tmp` 下的重建库上完成，结束后已删除；仓库只新增本文件。工具：Python `sqlite3`（dbstat）、Go 1.26 + `modernc.org/sqlite` v1.40.1 + `github.com/klauspost/compress` v1.20.3（`zstd`、`dict.BuildZstdDict`）。没有调用任何模型。

## 状态（2026-11-02）：步骤 1–5 已实现，待部署

按 owner 的决定（删冗余而不是压缩；回填之后不兼容旧服务端、旧 worker 和旧数据格式；每个会话转录渲染出来必须和现在完全一样；确定不影响显示的旧数据可以删），步骤 1–5 在一次提交里完成，没有按 §4 先单独上线读侧。步骤 6（备份压缩）属于运维，未做。

**实现**

- 读写（R1、R2）：`apps/server/internal/sqlitestore/session_event_payload.go` 是唯一的编解码。写入省略 `id`、`sessionId`、`level`（行里已有）、等于 `created_at` 的 `at`、等于 `message.text`（无消息时等于 `""`）的 `detail`；`detail` 键是否存在就是标记，空 `detail` 而 `text` 非空的行仍存 `"detail":""`。所有读事件的地方（整会话、线程、窗口、catch-up、状态事件、帧、`eventsNewestFirst`、完成时的回答、重复事件判断）都经 `decodeSessionEvent` 用列值补回；旧的完整 payload 照常解码。定时器快照的子查询改为只取 `$.metadata.timerSnapshot`。没有字段搬家，`json_extract` 查询和索引不变。
- 压实（R3、R4）：规则在 `session_event_compaction_plan.go`，逐条对照 Web 的 `transcript-adapters.ts`、`transcript-projection.ts`、`chat-process-display.ts` 和 `chat-context-model.ts`，判断不了的一律保留；执行在 `session_event_compaction.go`。只处理空闲（非 queued/running/blocked）且 2 分钟内没有新事件的会话，从水位线（新表 `agent_session_event_compactions`）之后开始，一个回合（一个输入及其后的事件）一个短事务，事务内先核对行数和 payload 没变，变了就跳过、下次再来。
  - R3：同一 `message.id` 的前一快照 E 与下一快照 N 之间只有转录不读的事件（面板快照、上下文报告、记录的文件、子任务进度等），Web 会把两者合成一行（同一 `callId` 且这个 call 只属于一个 item，或两者都有 `status`；commentary 要求 N 含有 E 的全部字段），标签相同或 E 是进行中标签，`level` 相同，E 没有 state key，E 若是过程组的第一步则组的开始时间不能因此改变；E 的 `requestUsage` 并到 N（同一请求取最大值；N 没有且之后不会有无主的用量报告落到 N 时直接给 N）。
  - R4 用量报告：按 `applyRequestUsage` 把 `Model request usage` 的用量并进它会落到的步骤（点名的步骤取最大值；没有点名、上一个是没有用量的过程步骤时给这一步），然后删除报告。点名回答的报告和回合内最新的一条保留（面板的 `requestTokens`）。
  - R4 上下文报告：保留回合内最新的、最新带 `contextWindow` 的、最新带 `configuredWindow` 的、回合开头和每次压缩后第一条带 `inputTokens` 的（压缩分隔线可能从它取 `postTokens`），其余删除。
  - 后台任务快照：每个会话只留最新一条和最新一条非空的（会话的第一条事件也不删）。
  - 用量回填（从 agent 日志补用量）还没跑过、又有缺 `turnUsage` 的回合的会话只做 R1/R2：回填会给没有用量的步骤补数。现库有 5 个这样的会话，共 440 行。
- 运行方式：沿用服务端后台任务（`httpapi/background.go`）。新任务 `session-event-compaction` 在启动 1 分钟后开始，每 10 分钟一轮、每轮 50 个会话，还有剩余时 5 秒后接着跑；升级后的历史数据也由它分批回填，不阻塞启动。运维命令 `foundry-server db compact` 立即全部跑完（短事务，可以和在线服务同时跑）；`foundry-server db vacuum` 先跑完压实再执行 `VACUUM`，`FOUNDRY_HOST:PORT` 上有服务应答就拒绝执行（必须先停服务），空闲磁盘不到已用大小的两倍也拒绝。

**副本实测**（`~/.foundry/server/foundry.db` 用 backup API 从 `mode=ro` 源拷出；先用改动前的二进制在副本上读样本，再用新二进制 `db vacuum`，再用新服务读同一批样本）

| 项目                                                                         | 之前                  | 之后                                                    |
| ---------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------- |
| 数据库文件                                                                   | 1,310.5 MiB           | 675.2 MiB（−48%）                                       |
| 事件行 / payload                                                             | 727,699 行 / 737.2 MB | 440,485 行 / 270.0 MB（删 287,214 行，改写 444,339 行） |
| 压实耗时（离线，928 个会话）                                                 | —                     | 1 分 25 秒                                              |
| `VACUUM` 耗时                                                                | —                     | 11.8 秒（共享机器，前两次试跑 20–30 秒）                |
| 最大会话（61,475 → 38,473 条事件）聊天页窗口读取（线程接口，200 条），中位数 | 热 136 ms，冷 716 ms  | 热 55 ms，冷 431 ms                                     |
| 同一会话整会话读取（44.3 MB → 25.9 MB JSON）                                 | 热 2.77 s，冷 3.26 s  | 热 0.58 s，冷 0.89 s                                    |

冷读前用 `posix_fadvise(DONTNEED)` 清掉数据库文件的页缓存；机器有其他负载，同一测量在第二次试跑中是窗口热读 121 → 88 ms、冷读 655 → 488 ms。`VACUUM` 期间库文件加 WAL 最多 1,946 MiB（比原来多约 635 MiB），另有同样大小的临时文件，所以需要约 2 × 压实后大小（约 1.3 GiB）的空闲磁盘。

**渲染等价**：样本 112 个空闲会话（事件最多的 12 个，含最大的；随机 90 个 ≥ 50 条事件的；随机 10 个小会话），其中 111 个本账号可读（共 330,533 条事件，压实后 200,012 条）。对每个会话用 Web 自己的代码（`chatMessagesForThread`，再按 `ProcessDisclosure` 的做法算 `processDisplayRows` 和摘要；`chatSessionStatus`、`chatContextCardForSessions`、`chatSessionFiles`、`latestScreen`）渲染：按窗口翻页拼起来的全部事件、整会话读取各一次，再比较 `/conversation` 接口的文本。111 个会话三项全部一致。比较时只去掉过程组的 `id`（以第一步命名的 React key）和 `text`（有行时不显示）。试跑中一次不一致（commentary 合并后带的是最后一个快照的时间，改变了下一个过程组的开始时间）促成了"组首步"规则。

**测试**：`sqlitestore/session_event_payload_test.go`（编解码等价、各读路径还原、旧格式行、重复事件判断）、`session_event_compaction_plan_test.go`（每条保留/删除规则）、`httpapi/session_event_compaction_test.go`（经 Web 用的接口读取：窗口翻页 = 整会话读取，压实后删掉的正好是预期的行，对话文本不变，再跑一次无事可做；并写出 `apps/web/test/fixtures/session-event-compaction.json`），`apps/web/test/session-event-compaction.test.mjs` 用 Web 的投影证明这份前后数据渲染一致。

**部署**

1. 照常部署新服务端。启动没有额外耗时；后台任务在之后几分钟内把历史数据回填完（离线实测约 1.5 分钟 CPU）。想立刻完成可以运行 `FOUNDRY_DB_PATH=~/.foundry/server/foundry.db foundry-server db compact`（服务在跑也可以）。
2. 回收空间需要一次维护窗口：先按现有方式备份数据库，停服务，运行 `FOUNDRY_DB_PATH=~/.foundry/server/foundry.db foundry-server db vacuum`（压实已完成时约 15–30 秒，没完成会先压实约 1.5 分钟），再启动服务。需要约 1.3 GiB 空闲磁盘。

**风险和限制**

- 不能回滚到旧二进制：旧代码读瘦身后的行会缺 `detail`、`id` 等字段。要回滚就恢复 `VACUUM` 前的备份。
- 删行后，聊天打开时的最新 200 条覆盖更多历史；面板的上下文状态在只加载窗口时按窗口内的事件计算，极少数情况下（例如最新带 `configuredWindow` 的报告由此进入窗口）会多显示一项；把历史全部加载后与现在一致。
- 正在追赶的客户端如果游标指向被删的行，会收到 410 并重读最新窗口（Web 已这样处理）。只在会话空闲且 2 分钟没有新事件后压实，所以只有断线很久的客户端会遇到。
- 已经被压实的步骤快照如果被 worker 重发，会以原时间重新插入（显示不变，只是不再被压实）。
- 给 agent 的 MCP 会话视图逐条列事件，压实后少了重复的中间快照（commentary、进行中的步骤），这是给 agent 看的，不是给人看的。
- 规则是保守的，比 spike 估计少删一些：payload 270 MB（估计 254 MB）。剩下的主要是没有 `status` 的 reasoning 快照（Web 不合并，两行都显示）、并行工具调用之间的快照、以及作为过程组第一步而会改变组开始时间的快照。

## 结论

体积几乎全在 `agent_session_events`，其中**约 60% 是重复数据**：`detail` 照抄 `message.text`、payload 里抄了一遍列值、同一步骤的"进行中"快照在"已完成"出现后仍然保留、旧的状态快照没有清理。只删这些冗余，事件表（含索引）就从 1,086 MB 降到 395 MB，窗口读取反而更快。行级 zstd 字典压缩在此基础上还能再省 150 MB，但要付出类型列、字典版本管理、SQL 原地更新改写、无法直接查库这些代价，**本轮不做**。备份改用文件级 zstd：现在整库压缩后 238 MB，瘦身后估计约 190 MB（事件部分从 119 MB 降到 74 MB）。

## 1. 测量

### 1.1 按表（dbstat，页大小 4 KB，空闲页 0，`auto_vacuum=0`）

| 对象                                     | 大小            | 说明                                                                    |
| ---------------------------------------- | --------------- | ----------------------------------------------------------------------- |
| `agent_session_events`                   | 980 MB          | 717,534 行，1,174 个会话；页内未用 112 MB                               |
| 事件表 3 个索引 + 主键索引               | 119 MB          | `session_created` 52、主键 51、`state` 16                               |
| `chats`                                  | 125 MB          | 518 行；`transcript`（原生日志尾部缓存）占 121 MB，其中已归档聊天 56 MB |
| `promoted_skill_revisions`               | 72 MB           | 360 个修订，内容已是 zip；2 个技能各 5 个修订共 56 MB                   |
| `session_work` / `agent_sessions` / 其余 | 15 / 13 / <5 MB | 不是问题                                                                |

增长：事件 JSON 10 月共 695 MB，最近 20 天每天 3–71 MB，平均约 30 MB/天（文件增长约 42 MB/天）。

### 1.2 事件 payload（770.6 MB JSON）里是什么

| 按 JSON 路径（字符串字节）                    | MB    | 按 label                 | MB    |
| --------------------------------------------- | ----- | ------------------------ | ----- |
| `$.detail`                                    | 230.6 | Ran command              | 167.7 |
| `$.message.text`                              | 202.0 | Used tool                | 94.0  |
| `$.id`                                        | 38.9  | Using tool               | 87.0  |
| `$.message.id`                                | 28.9  | Background tasks updated | 62.5  |
| `$.metadata.backgroundTaskSnapshot[].summary` | 26.7  | Running command          | 53.7  |
| `$.at`                                        | 21.4  | Thought                  | 46.4  |
| `$.sessionId`                                 | 17.2  | Model request usage      | 40.1  |

导入的原生上下文（`Native transcript`）只有 0.6 MB，不是增长来源。真正的来源是工具调用和命令输出，且每一份都存了好几遍。

### 1.3 冗余（可删除，不是压缩）

| #   | 冗余                                                                                              | 行数    | 字节     | 依据                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------- | ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `detail` 与 `message.text` 完全相同                                                               | 400,532 | 204.6 MB | 逐行比较                                                                                                                                      |
| R2  | payload 里的 `id`、`sessionId`、`level`、`at` 与列 `id`、`session_id`、`level`、`created_at` 重复 | 717,534 | 110.5 MB | `at == created_at` 的有 716,991 行                                                                                                            |
| R3  | 被取代的快照：同一会话、同一 `message.id`，较早一行的 text 是最终那行的前缀                       | 246,125 | 202.1 MB | Using→Used tool 80.9、Running→Ran command 55.2、Commentary 28.3、Thinking→Thought 23.2、Thought 10.4。Web 已按 id/callId 合并，只显示最终那条 |
| R4  | 旧的状态快照（`state_key` 为 `background` / `context`），侧栏只取每个会话最新一条                 | 118,431 | 105.6 MB | background 65.9（最新仅 0.4）、context 即 Model request usage 39.7（最新仅 0.3）                                                              |

注意 R4 的 `Model request usage`：Web 的 `applyRequestUsage` 用它按 `requestId` 补全消息上的最终用量（消息里流式写入时 `outputTokens` 还很小）。所以要先把最终用量并进对应消息的 `message.requestUsage`（`session_usage.go` 已有同类回填），再删除。

### 1.4 各方案的实测（把事件表按同样的 schema 和索引重建）

窗口读取 = 50 个会话（最大的 10 个 + 随机 40 个）各读最新 200 条事件，包括解压和 `json.Unmarshal`；冷读前用 `posix_fadvise(DONTNEED)` 清掉页缓存。"整会话"为事件最多的会话（61k 条）。

| 方案                      | payload  | 事件表+索引文件 | 冷窗口均值/最大 | 热窗口均值/最大 | 整会话 冷/热    | 整库 zstd -3 备份 |
| ------------------------- | -------- | --------------- | --------------- | --------------- | --------------- | ----------------- |
| 现状重建（等于 VACUUM）   | 770.6 MB | 1,086 MB        | 18.4 / 93 ms    | 1.98 / 11.0 ms  | 7.35 s / 972 ms | 119 MB            |
| (c) 删除 R1–R4            | 253.6 MB | 395 MB          | 13.0 / 71 ms    | 1.31 / 6.2 ms   | 2.18 s / 270 ms | 74 MB             |
| (c) + 行级 zstd 字典（a） | 105.2 MB | 247 MB          | 8.8 / 41 ms     | 1.65 / 8.9 ms   | 1.62 s / 380 ms | 118 MB            |
| 只做行级 zstd 字典（a）   | 225.8 MB | 514 MB          | 12.7 / 101 ms   | 2.28 / 9.5 ms   | 4.37 s / 1.29 s | —                 |

其他数字：

- zstd 无字典：原始 42.5%，(c) 之后 146.9 MB；有字典：原始 29.3%，(c) 之后 105.2 MB，`SpeedBetterCompression` 100.6 MB（只多省 4%）。
- 字典：112 KB，从 1/20 抽样（约 1.8 万行，每行截 32 KB）训练，约 10 s。10-15 之后的数据用只拿之前数据训练的旧字典压成 91.9 MB，用新字典 84.4 MB：一个月不重训只差约 9%。
- 写入：带字典单行编码 0.17 ms（35 万行 59 s，单线程），对写路径无感，迁移约 1 分钟 CPU。
- 全表按 label 计数：`json_extract` 2.47 s，类型列 1.19 s。
- VACUUM INTO 现库：22 s，1,354 → 1,335 MB（−1.4%）。现库没有空闲页，单独 VACUUM 几乎无用；删除大量行之后必须 VACUUM 一次文件才会变小。
- 备份：现在 `backups/` 是原样拷贝（1.3 GB）。整库文件级 `zstd -3 -T2` 6 s，得 238 MB。**已做行级压缩的库，文件级压缩反而更差**（118 MB vs 74 MB）。

## 2. 方案对比

| 方案                           | 节省（事件表+索引）      | 读路径                                                                     | 写路径与 SQL                                                                                                                                                                                                                                                                                                                                                               | 迁移                                   | 风险                                                    |
| ------------------------------ | ------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| **(c) 不存冗余**               | 1,086 → 395 MB（−64%）   | 更快（冷 −30%，整会话 −70%）；读取时由一个解码函数补回 `detail` 和列值字段 | R1/R2 在 `saveAgentSessionEvent` 省略；R3/R4 在回合结束或会话空闲时压实（写入当下删除会让 catch-up 游标指向已删行，触发 `ErrEventsCursorGone`）；`json_extract` 查询不变                                                                                                                                                                                                   | 分批回填 + 一次 VACUUM（约 22 s 独占） | 须证明 Web 转录和侧栏渲染不变；老二进制读不了瘦身后的行 |
| (a) 行级 zstd + 字典           | 再省 148 MB（395 → 247） | 热窗口 +0.3 ms/200 条，冷读更快                                            | 事件表 SQL 读到的每个 JSON 路径都要变成类型列：`$.label`（5 处）、`$.message` 是否存在（`transcriptEventsFilter`、`session_usage`）、`$.message.id`（`native_history`）、`$.message.requestUsage.*Tokens`、`$.metadata.turnUsage(.*)`（`personal_agent`、`session_usage`）、`$.at`；`session_usage.go` 里两处 `json_set` 原地更新要改成 Go 读-改-写；`dict_id` 列 + 字典表 | 全表重写                               | sqlite3 CLI 无法直接查 payload；字典丢了数据就读不出来  |
| (b) 大正文放内容寻址 blob/文件 | ≤ 20 MB                  | 多一次文件读                                                               | 瘦身后 ≥ 8 KB 的行只有 1,238 行共 19.7 MB（去重后 17.3），≥ 64 KB 的只有 30 行；≥ 1 KB 的重复正文只有 3.8 MB                                                                                                                                                                                                                                                               | 文件和库的一致性、备份要同时覆盖两处   | 收益太小，不做                                          |
| (d) SQLite 层                  | VACUUM −1.4%             | —                                                                          | 页压缩不是标准功能：ZIPVFS、CEROD 是商业扩展，sqlite-zstd 是 C/Rust 可加载扩展，纯 Go 的 modernc 驱动都用不了                                                                                                                                                                                                                                                              | —                                      | 只在删除之后用 VACUUM 回收空间                          |

另外两项属于 (c)，规模较小，另开工单：`chats.transcript` 是设备原生日志的尾部缓存（121 MB，已归档的占 56 MB），可以不为已归档聊天保留，打开时再从设备读取；`promoted_skill_revisions` 中没有被引用的旧修订（约 56 MB 集中在 2 个技能），可按保留策略清理。两项都要先确认引用关系。

## 3. 建议

采用 (c)：把 R1–R4 从存储里去掉，然后执行一次 VACUUM，备份改为文件级 zstd。预计整库从 1.35 GB 降到约 0.65 GB，事件增长降到现在的约 1/3（约 15 MB/天），窗口读取和整会话读取都更快。所有 `json_extract` 查询和索引保持不变。

(a) 暂不做。它在 (c) 之后只多省约 150 MB，却要引入 7 类类型列、改写两处原地更新、管理字典版本，还会让备份的压缩效果变差。如果以后真要做，按以下方式：`dict_id` 写进列，zstd 帧头也带 ID；字典存在 `compression_dicts(id, created_at, bytes)` 表，只增不删，解码器用 `WithDecoderDicts` 加载全部字典；定期用新数据抽样，通过 `dict.BuildZstdDict` 训练新 ID 的字典，旧行不重写。

## 4. 分步计划

每一步单独合入，行为不变，`scripts/check-changed.sh` 通过。

1. **读侧兼容先上线**：给事件加一个统一的解码函数。`detail` 键缺失且有 `message` 时，用 `message.text` 补回；`id`、`sessionId`、`level`、`at` 缺失时用列值补回。所有读事件 payload 的地方（`listJSON`/`getJSON`/窗口/catch-up/状态/`eventsNewestFirst`）都走这个函数。补测试：瘦身行和原样行解码结果相同。至少隔一个版本再进入下一步，保证可以回滚。
2. **写侧省略 R1、R2**：在 `saveAgentSessionEvent` 和 `native_history`/`native_sessions` 的插入里省略这些字段。注意 `detail` 没有 `omitempty`，键是否存在可以作为无歧义的标记。
3. **压实 R3**：新增 store 方法 `CompactSessionEvents(sessionID)`，在回合结束或会话空闲时执行。它在单个事务里删除同一 `message.id` 下 text 为最终行前缀的较早行。用渲染等价测试守住行为：取一批真实会话，比较压实前后 `sessionTranscriptEntries` 和侧栏状态的输出，要求一致。
4. **R4**：先把 `Model request usage` 的最终用量按 `requestId` 并进对应消息的 `message.requestUsage`（取最大值，和 Web 的做法一致），再删除每个会话非最新的 `background`/`context` 快照。确认 `chat-context-model.ts` 不依赖历史快照。
5. **回填历史数据**：按会话分批执行步骤 2–4 的改写，每批一个短事务，不长时间占用写锁。完成后执行一次 `VACUUM`（约 22 s 独占，需要约 1.4 GB 临时空间），可以同时设置 `auto_vacuum=INCREMENTAL`。之前先做一次文件级 zstd 备份。
6. **备份**：`backups/` 改存 `zstd -3` 压缩件（现在 238 MB，瘦身后估计约 190 MB）。
7. 另开工单处理 `chats.transcript`（已归档聊天）和 `promoted_skill_revisions` 的保留策略。完成 (c) 之后再看增长曲线，决定是否需要 (a)。
