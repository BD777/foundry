# DEV-320 Worker：native chat 扫描的 CPU 和读盘量；不再留下没有用的文件

## 问题

DEV-319（train 101）之后，本人要求继续降低 worker 的操作数和硬盘读写量，并约束 worker 不要留下确定没有用的文件。

## 调查（sg-chaos，Worker `0.5.7-dev.374…1795091012`，真实数据）

- 空闲时整个进程占 12–16% 的单核 CPU，读写调用各约 300 次/秒。按线程看：主线程 0.5%，`native-chat-scan-thread` 10.5%。用 Node inspector 对这个线程做 CPU profile（只开 localhost，采样后立刻关闭），75% 的工作耗在 `fingerprintForCandidate`。
- **根因 1：** 指纹缓存是一个 `WeakMap`，以 candidate 对象为键，但每轮都会用 `{...candidate}` 重新生成这个对象，缓存从不命中。结果每轮把每个聊天连同最多 1 MB 的 transcript 序列化后做 sha256。
- **根因 2：** 每次冷启动（每次更新 worker 都会重启）重新解析和脱敏所有匹配的日志：本机 932 个，读 1.33 GB（1.14 GB 来自硬盘），22.5 秒 CPU。但 foundry 工作区里有 717 个聊天是服务端拒收的（Foundry 会话自己的原生日志），只有 16 个会上传。拒收的聊天服务端只看 provider、nativeSessionId、workspaceId 和 archived（`saveComparedChat` → `observeOwnedNativeArchive`），transcript 读了也白读。正在运行的 Foundry 会话的日志每轮都在变，所以稳态下也在反复重读。
- **根因 3：** 冷启动时为了判断每个日志属于哪个目录，要读所有日志开头的 256 KB（约 2000 个文件）。
- **其他：** 目录遍历每轮对每个日志 stat 一次，只是为了按 mtime 取最新 2500 个；没超过 2500 个时这一步没有意义。`logFolder` 对表头已经完整的日志也先 stat。`foundryStatePath()` 在未设置 `FOUNDRY_STATE_ROOT` 时（即正式安装）每次调用都 `existsSync(<包>/src)`。
- **磁盘：** 一个只读 Explore 子代理清点了 worker 写入的所有位置，确定没有用、却从不删除的有：
  - 会话的 SDK 日志：`<ws>/.foundry/sessions/*/inputs/*/claude-sdk.messages.jsonl`、`codex-sdk.events.jsonl`、`*.stderr.log`。本机 4.2 GB；在 Mac 上每轮对话都写到 NAS。
  - verifier 沙箱：按 7 天规则清理，但只在同一工作区再启动 verifier 时才执行，本机积了 3.3 GB。
  - 命名的 compute scratch 目录。
  - 租约中途 worker 退出时留下的 `.tmp`、`.uploads`。
  - 已删除功能留下的 `skill-revisions`、`skill-isolation`。

## 修复

- `session/chat/native-chat.ts`
  - 指纹缓存改以解析出的 transcript 对象为键。日志不变时这个对象也不变。
  - 服务端拒收的聊天（`summaryOnlyIds`，即 daemon 记录的 `refused`）只用日志表头里的 id、目录和文件 mtime 生成摘要，不解析也不脱敏 transcript。
  - 表头完整的日志不再 stat，并把这类表头的结果写进 state root 的 `native-log-headers.json`（版本 1，只写本进程看过的日志）。重启后不用再读日志开头。
  - 日志总数不超过上限时，遍历目录不再逐个 stat。
- `daemon/workspace-ops.ts`、`native-chat-scan-thread.ts`：把 `uploads.refused` 作为 `summaryOnlyIds` 传给扫描。
- `platform/state-root.ts`：判断是否从源码 checkout 运行的结果只算一次。
- `maintenance/disk-retention.ts`（新增）：连接后 10 分钟跑一次，之后每小时一次。
  - 会话超过 14 天没有新输入、且不在运行（活跃会话和 native work 会话除外）：删除它的 SDK 日志，保留 `result.md`、`completion.json` 和其余文件。删完写一个标记文件 `.sdk-logs-removed`，之后有新输入才会再处理这个会话。
  - 所有工作区里 7 天未用的 verifier 沙箱：异步删除，不阻塞 daemon 主线程。
  - 删除 `skill-revisions/`、`skill-isolation/`。
- `resources/providers/compute.ts`：原有的每小时清理（在租约打开时触发）增加两项：命名 scratch 14 天未用就删（每次操作都会更新目录时间）；不属于在用租约、超过一天的 `.tmp/<lease>` 和 `.uploads/<lease>-…` 也删。
- `apps/server/internal/httpapi/mcp_tools.json`：`operate_resource` 的说明写明 scratch 的保留期（会话自己的 3 天，命名的 14 天）。

## 检查

- 基准（`/tmp/dev319prof/bench-scan.mjs`）：对本机 7 个工作区的真实日志只读跑扫描，state root 指向一个临时目录，里面用符号链接接入只读输入。

  |                            | 冷启动                                      | 稳态每轮                             |
  | -------------------------- | ------------------------------------------- | ------------------------------------ |
  | 修改前                     | 30.5 s，CPU 22.5 s，解析 932 个，读 1.33 GB | CPU 1.07 s，约 2000 次读调用         |
  | 修改后（第一次启动）       | 5.5 s，CPU 5.2 s，解析 71 个，读 447 MB     | CPU 0.12–0.20 s，约 150–200 次读调用 |
  | 修改后（有表头索引的重启） | 2.0 s，CPU 1.7 s，解析 71 个，读 62 MB      | 同上                                 |

  稳态时扫描线程 96% 的时间空闲。

- Worker `tsc` 通过。相关测试 116/118 通过：`native-*`、`compute`、`resource-pool`、`verification-session`、`state-root`、`checkout-state-root`、`subagent-*`、`session-artifacts`、`workspace-context-revision`、`resource-signals`，以及新增的 `native-chat-scan-cost`、`disk-retention`。唯一失败的是 verification-session 的"bookkeeping unavailable"一例，报 Claude CLI 不在 PATH；在部署中的基线上一样失败，与本改动无关。
- 本机估算：按 14 天规则，244 个闲置会话的 SDK 日志约 2.4 GB 会被删除；7 天未用的 verifier 有 20 个。

## 验收步骤

1. 部署后在 sg-chaos 上执行 `cat /proc/<daemon pid>/io` 和 `/proc/<pid>/task/*/stat`，各隔 30 秒取一次。预期：scan 线程 CPU 从约 10% 降到约 1–2%；稳态的 rchar 不再每 30 秒 5–11 MB。
2. 再重启一次 worker。预期：第一分钟的 rchar 从约 3 GB 降到 100 MB 以内；state root 里出现 `native-log-headers.json`。
3. 连接 10 分钟后，daemon 日志里出现 `Removed … SDK log(s) …`；`<foundry>/.foundry/sessions` 下超过 14 天没有输入的会话不再有 `claude-sdk.messages.jsonl`，`result.md` 和 `completion.json` 还在。
4. Web 的原生对话列表仍显示同样的聊天，标题、预览和归档状态不变。

## 限制

- 拒收聊天的排序时间用的是日志 mtime，不是解析出的最后对话时间。这只影响前 60 条边界附近哪些可上传的聊天被选中，两者通常只差几秒。
- 14 天后，旧会话的 subagent transcript 视图不再可用（它读的就是 `claude-sdk.messages.jsonl`）。
- 没有清理的：`connection-data` 里归档的 transcript（本人数据）、`native-runtime/codex/<id>`（旧版 Codex 目录，可能有历史记录）、`skill-sets`（代码设计上保留所有历史内容）、`read-only-sessions`、Issue 的 `runs/` 和 `clarifications/`、服务日志的轮转。

## 时间线

- 2026-11-19 train 102（Server `2393214e194b`，Worker `…1795093499`，7 台设备）：DEV-320 上线。
- 2026-11-19 部署后在 sg-chaos 实测发现，daemon 第一轮仍用了 27.9 s scan 线程 CPU、读了 2.84 GB。原因：daemon 同时扫描 7 个工作区，表头缓存要等读完才写入，所以同一个日志的表头被并行重复读取。早先的基准是一个工作区接一个工作区跑的，没测出来。并行基准完全复现：25.8 s CPU、2.88 GB。
- 2026-11-19 DEV-320b，train 103（Worker `…1795094247`，7 台设备）：`logHeader` 对同一日志共享进行中的读取。并行基准降到 4.6 s / 447 MB（无索引）和 1.4 s / 62 MB（有索引）。

## 部署后验证（train 103，Agent 自测，2026-11-19）

- **sg-chaos 稳态：**
  - 每 30 秒：进程 CPU 0.55 s（1.8% 单核，之前 12–16%），scan 线程约 1%（之前 10.5%）。
  - 读调用约 55 次/秒（之前约 300），写调用约 12 次/秒（之前约 300），rchar 2.7 MB（之前 5–11 MB），物理读 0。
  - RSS 243 MB（之前 615 MB）。
- **sg-chaos 重启（有表头索引）：** 启动后 3.5 分钟，进程 CPU 共 10 s（scan 线程 4.0 s），rchar 176 MB。之前是第一分钟 40 s CPU、3.09 GB。
- **保留清理第一次运行（13:29:13Z）：**
  - 日志：`Removed 3734 SDK log(s) (2467 MB) of 272 session(s) without input for two weeks.`，可用空间从 9.8 GB 变为 15 GB。
  - 抽查已清理的会话：`inputs/*/` 里只剩 `result.md` 和 `completion.json`。
  - 7 天未用的 verifier 从 20 个变为 0；`skill-revisions/`、`skill-isolation/` 已删除。
- **CanWendeMac-mini：**
  - 空闲 CPU 0.09 s / 15 s（约 0.6%），启动 8 分钟累计 8.8 s，RSS 65 MB（之前 109 MB）。
  - 打开租约时 compute 清理已删除 14 天未用的命名 scratch（`isolation-drafts`、`runtime-isolation-*`、`release-final-audit`、`dev111`、`worker-update` 等），近期用过的保留。
- **错误：** 部署后 `daemon.err.log` 没有新内容（最后写入 12:31Z，在这几次部署之前）。之前的 `native chat scan worker timed out after 60000 ms` 很可能就是这次修掉的冷启动开销造成的。dev `/healthz` 返回 200。
- **还没验证：** 本人在 Web 上看到的原生对话列表（标题、预览、归档状态）是否不变，见验收步骤 4。
