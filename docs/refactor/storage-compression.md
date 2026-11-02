# 存储瘦身 spike：先删冗余，再谈压缩（工作底稿）

日期：2026-11-02。对象：线上库 `~/.foundry/server/foundry.db` 的只读副本（SQLite backup API 从 `mode=ro` 源拷出，1,354 MB）。所有测量都在副本和 `/tmp` 下的重建库上完成，结束后已删除；仓库只新增本文件。工具：Python `sqlite3`（dbstat）、Go 1.26 + `modernc.org/sqlite` v1.40.1 + `github.com/klauspost/compress` v1.20.3（`zstd`、`dict.BuildZstdDict`）。没有调用任何模型。

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
