# DEV-222 原生对话扫描每轮重解析全部日志（Worker 持续占用约半核）

## 状态

已合入 main（PR #267）。

已修复并随车次部署（Worker `…1794567381`），sg-chaos 已验证；定向测试 37/37 通过；改动在 dev 检出中未提交（foundry 提交时间窗）。按 2026-11-13 的部署规定（只有车次 conductor `sess_1794555762602239151` 部署并执行 `update_worker`），本项没有发布，补丁已交给 conductor，随 DEV-214 进入下一班车（conductor 会 rebase 并在该车次的检查里跑 native-chat-sync、native-chat-history、native-archive）：`/tmp/dev222-patch/dev222-native-chat-scan.patch`（sha256 `032af4bf…787d`，可干净应用于 HEAD `8f394c91`；dev 检出里已有同样的改动）。

来源：[sg-chaos 资源排查 session](https://dev.foundryapp.app/chats/sess_1794464313271186377)（sg-chaos 负载约 21、swap 8 GB、空闲内存 172 MB）。

## 现象

- sg-chaos 上 e2e-alice 的合成 Worker（`dev152-synthetic-worker.service`，从 dev 检出 `packages/worker/dist` 运行，状态目录 `~/.foundry/dev148-acceptance/`）运行 14h54m，`ps` 平均 47% CPU；`/proc/<pid>/task` 显示 CPU 几乎全在 MainThread。
- 其 journal 15 小时内有 991 条 `Native chat scan worker failed (native chat scan worker timed out after 60000 ms); scanning on the daemon thread`，每 4 分钟一批 9–10 条（等于它的 9 个工作区）。
- 真实 Worker（`~/.foundry/runtime/current`）的 `~/.foundry/logs/daemon.err.log` 里同一条有 1113 次；更新后的 `…1794563196` 重启几分钟后又开始出现。这是 Worker 的 bug，不是测试栈特有的问题；任何原生历史较多的设备都会触发。

## 根因（证据）

1. 每 10 秒一轮、每个工作区一次的原生对话同步，都会遍历设备上**所有** Claude/Codex 日志（每个根目录取最新 2500 个），并对每个日志做完整解析（头部 256 KB，尾部最多 8 MB），解析完才按 `cwd` 过滤掉其他文件夹的日志。
2. 完整解析的缓存上限是 64 MB / 1000 条，按 `min(文件大小, 8 MB)` 计。sg-chaos 上这部分要 Claude 2264 个日志约 1.38 GB，Codex 787 个约 0.78 GB；绝大多数是 `/tmp/dev125-eval-ws`、pa-eval 等临时文件夹的日志，不属于任何已注册的工作区。按插入顺序淘汰、而每轮顺序扫描又比缓存大，所以命中率为零。实测（`nativeChatSnapshotForWorkspace` 对 foundry 工作区连跑两轮）：第一轮 `parsed=2998 reused=0` 用 236 s 墙钟、31 s CPU；第二轮 `parsed=2999 reused=0` 用 153 s、29 s CPU。7 个工作区相当于每轮约 200 s CPU，所以 Worker 一直在扫描。
3. 扫描线程放大了这个问题：每个请求的 60 s 计时器从入队开始算，N 个工作区同时入队，单线程排队处理，后面的请求必然超时；超时后 `#failAll` 拒绝全部请求并 terminate 线程，丢掉线程里的缓存，下一轮又从冷缓存开始；每个被拒绝的请求再在 daemon 主线程上完整扫描一遍，同一份工作做两遍，而且挤占心跳。

## 修复（Worker）

- [native-chat.ts](../../packages/worker/src/session/chat/native-chat.ts)：新增按路径记录的“日志所属文件夹”索引（`logFolder`），只读日志头部；头部已完整的日志（Codex 已有 `session_meta`，Claude 满 200 行或 256 KB）之后只需 `stat`，不用再读。不属于当前工作区的日志直接跳过，不做完整解析，所以完整解析缓存只装各工作区自己的对话。`nativeChatLogPath` 也先查这个索引。头部解析抽成 `codexHeaderFolder` / `claudeHeaderFolder`，与原解析器语义一致（Claude 取前 200 行里最后一个 `cwd`）。
- 同文件：完整解析缓存原来按 `min(日志大小, 8 MB)` 计费，改为解析完成后按实际保留的内容计（transcript、recentMessages、handoffContext 的 JSON 长度加 1 KB；不是对话的日志，例如 `/resume` 存根，计 256 B），上限从 64 MB 调到 160 MB（每个运行时一份）。实测 foundry 工作区 603 个日志解析出 324 个对话，保留约 71 MB，中位数 185 KB；按旧的计费方式，一个工作区都装不下。
- [native-chat-scan-thread.ts](../../packages/worker/src/session/chat/native-chat-scan-thread.ts)：请求到期时先 ping 扫描线程（线程在扫描步骤之间会让出事件循环），能应答的线程只是忙，不算卡死，继续等待，最长 15 分钟；只有 ping 不应答才拒绝请求并替换线程。冷缓存不再因为“慢”被丢掉，回退到主线程扫描只发生在线程真的卡死或无法启动时。

## 测试

- `native-chat-sync.test.mjs` 新增：「logs of other folders are read once by header, never parsed in full」——1200 个其他文件夹的日志加 1 个本工作区日志，第一轮 `parsedFiles=1`，第二轮 `parsed=0 reused=1`；头部后来改为本文件夹的日志会被识别。「a scan worker that is busy but answers is kept, with its cache」——扫描耗时是超时的 6 倍，但线程会应答 ping，结果是请求成功、线程不被替换。原有的「挂起线程超时拒绝」测试仍然通过。
- 结果：`native-chat-sync` + `native-chat-history` + `native-archive` 共 37/37 通过（隔离副本，在 sg-chaos 上 `flock /tmp/fdy-heavy.lock`）。
- 真实历史实测（sg-chaos，`~/.claude` + `~/.codex`）：

| 场景                                     | 修复前                           | 修复后                                                                    |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| foundry 工作区，热缓存一轮               | parsed 2999 / reused 0，29 s CPU | parsed 2 / reused 601，0.76 s CPU                                         |
| 7 个工作区并发一轮（真实 Worker 的配置） | 约 200 s CPU（按单工作区推算）   | 冷 51 s CPU 只跑一次；之后每轮 parsed 0–18，1.0–1.8 s CPU，heap 约 200 MB |

## 资源清理（sg-chaos，2026-11-13）

- 已停止 `dev152-synthetic-worker.service` 及其执行宿主 `foundry-execution-4fc335272c13f2c4.service`（e2e-alice 合成设备 `dev_a870ddf7-…`）。理由：当时没有子进程、没有运行中的轮次，是 DEV-152/DEV-200 验收时临时起的。需要时用 `systemd-run --user --unit dev152-synthetic-worker -p MemoryMax=3G -p WorkingDirectory=/home/windeng/dev148-synthetic-workspace ~/.foundry/dev148-acceptance/worker.sh daemon` 在当前 dist 上重新启动。
- 未停止旧版本执行宿主 `foundry-execution-7d80274a043176cd`（`…1794540840`，pid 770556）：它没有 claim、也没有子进程，但它是设备 session-work 清单的持有者（`~/.foundry/session-work/inventory.json` 有 5495 项，其中多项是协调 session `sess_1794464313271186377` 的 managed agent 正在运行），`sessionWorkBusy()` 让它按设计保持 draining，不是孤儿进程。采样结果：CPU 约 4%，CDP 采样 97% idle，剩余时间在 session-work 的 `ps` 巡检和 6.8 MB 清单序列化上。
- 没有 scratch stack 实例（`scripts/scratch-stack.sh list` 返回 no instances）。

## 剩余动作

- conductor 应用补丁、发布 Worker 并对在线设备执行 `update_worker`；之后 `daemon.err.log` 不应再出现 `scan worker timed out`，真实 Worker 空闲时的 CPU 应降到个位数百分比。

## 部署与验证

- conductor `sess_1794555762602239151` 随车次发布 Worker `0.5.7-dev.357.g8f394c91.local.1794567381`，11:19Z 更新到 sg-chaos、byte-dev、byte-dev-sg、cottoncpp、limen-canada。
- sg-chaos 验证（11:25–11:38Z）：已装包的 `native-chat.js` / `native-chat-scan-thread.js` 含本修复；daemon 11:19:19Z 重启后 19 分钟内 `~/.foundry/logs/daemon.err.log` 没有新增任何一行（旧版每约 4 分钟一批、每工作区一条 `scan worker timed out`）；冷扫描结束后 daemon CPU 在 20 s / 60 s 窗口里为 10–11% 一核（修复前 28–47%），主机负载 4.4（排查开始时 25）。其他四台只确认了版本，未逐台采样。

## 限制

- Worker 的 `build` 脚本会先删除 `dist` 再编译。直接从 dev 检出 `dist` 运行的进程（合成 Worker、`foundry-cli.js resource operate`）在重建期间加载不到模块，合成 Worker 日志里有 63 次 `Cannot find module …native-chat-scan-thread.js`。本项未修。
- 缓存上限是每个运行时 160 MB，sg-chaos 上实测保留约 71 MB（foundry 工作区）、7 个工作区合计 heap 约 200 MB；原生历史更大的设备上，最旧的对话仍可能被淘汰后重新解析，但只会解析本设备工作区的日志。
