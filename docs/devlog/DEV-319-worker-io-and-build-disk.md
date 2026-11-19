# DEV-319 Worker 每轮巡检的文件系统开销；remote-build 遗留作业占满 Mac 磁盘

## 问题

2026-11-19，本人在 [sess_1795087790379100314](https://dev.foundryapp.app/chats/sess_1795087790379100314) 排查极空间 NAS 硬盘持续读写。该会话用 `fs_usage` 抓到 CanWendeMac-mini 上的 Foundry worker 守护进程（pid 36327）每 10 秒对 NAS 上的工作区目录发出约 1 万次 stat/access，并怀疑 worker 有低效 bug。本人同时说“磁盘都被你弄的快爆炸了”。

## 调查（Worker 代码 + 本人抓包原文件 `/tmp/fs_usage_sata11.out`，32 秒）

- **NAS 读盘的主因不是 worker。** 是 syspolicyd 在校验 NAS 上的一个 ad-hoc 签名游戏包，约 2.7 MB/s（见原会话）。worker 在 NAS 上只做元数据查询，32 秒里只有 3 次 open 读了文件。
- **约 1 万次调用/轮的来源：** `workspaceRound`（10 秒一次）里，native chat 扫描对每个工作区遍历最近的 Claude/Codex 日志，每 2500×2 个日志都调用一次 `samePath(日志目录, 工作区)`。日志目录字符串不同的时候，`samePath` 会对两边做 `existsSync + realpathSync + statSync`，每个日志约 6–8 次系统调用，5 个工作区每轮约 1 万次。这些调用几乎都命中 macOS SMB 缓存（约 3 µs），但都是多余的：日志只指向十几个不同的目录。
- **真正走到 NAS 的：** `checkContextFiles` 每轮用 `refresh=true` 计算 `workspaceInstructionRevision`，对 6 个文件名逐个 lstat，存在的文件再整份读出来（≤256 KiB）并做 sha256。不存在的名字（README.txt 等）每次都要 SMB 往返约 40 ms，而且在 daemon 主线程上同步执行。32 秒里主线程累计阻塞 1.22 秒，约每轮 0.4 秒。
- **顺带发现的 bug：** `readResourceSignals` 在 macOS 上执行 `run("vm.swapusage", [])`，把 sysctl 键名当成了命令名。swap 空闲量从来没读到过，而且每次采样都会沿 PATH 逐个目录查找；PATH 里的 `~/workspace/scripts/bin` 在 NAS 上。
- **Mac 本地磁盘：** 数据卷 92% 已用，只剩 17 GiB。`~/.foundry/compute` 占 22.7 GB，其中 `foundry-remote` 19 GB：8 个 remote-build 作业（11-17、11-18，各约 780 MB，含 repo 和 node_modules）共 6.6 GB，共享缓存 `.cache` 11.6 GB（主要是 go-build）。根因：`remote-build.sh` 写死了 `export REMOTE_KEEP_JOB=1`（为了 `--fetch-only`），成功拉回产物后作业也不删，只能靠会话记得跑 `remote-clean.sh`。

## 修复

- `session/chat/native-chat.ts`：每次扫描为工作区建一个 `sameFolderAs` 记忆表，同一个目录字符串只比较一次。
- `workspace/workspace-context-revision.ts`：去掉 `refresh`，改成 stat 戳缓存加 git 的 racy 规则：文件变化（ctime/mtime）超过 2 秒才信任缓存，所以“同大小改动并保留 mtime”仍能检出。每轮只 `readdir` 一次工作区根目录，只看列出来的说明文件名，和注册时（`workspaceFilesForWorkspace`）读到的名字一致。
- `concurrency/resource-signals.ts`：改用 `/usr/bin/vm_stat` 和 `/usr/sbin/sysctl -n vm.swapusage`。
- `scripts/remote-build.sh`：产物在本地校验通过后设 `rc_keep_job=0`，退出时删除设备上的作业；只有传输失败才保留给 `--fetch-only`。`scripts/lib/remote-compute.sh` 的 slot 获取会删掉超过一天、且没有存活 slot 引用的作业。
- 清理：已删除 CanWendeMac-mini 上上述 8 个已完成会话的 remote-build 作业（约 6.6 GB）。

## 检查

- Worker `tsc` 构建通过。
- 定向测试 59/59 通过：`workspace-context-revision`、`resource-signals`、`platform-paths`、`native-archive`、`native-chat-history`、`native-chat-sync`、`native-chat-transcript`。新增两条测试：macOS 采样调用的命令；上下文修订只覆盖列出的说明文件。
- 作业清理片段在临时目录里模拟过：过期且无 slot 引用的作业被删；过期但有 slot 引用的、新的作业都保留。

## 验收步骤

1. 新 Worker 装到 CanWendeMac-mini 后，在 Mac 上执行 `sudo fs_usage -w -f filesys <worker pid> | grep sata11`，看 30 秒。预期：每 10 秒一轮的调用从约 1 万次降到几百次以内；没有对 README.txt、README.markdown 等不存在文件的反复 lstat；没有 `posix_spawn …/scripts/bin/vm.swapusage`。
2. 设备页的资源信号里，macOS 设备出现 swap 空闲量。
3. 在 Mac 上跑一次 `scripts/remote-build.sh`，成功后 `~/.foundry/compute/foundry-remote/jobs` 里不再留下这次的作业。

## 限制

- `.cache`（go-build 等，11.6 GB）是共享构建缓存，这次没有动。Go 会自动清理 5 天没用过的缓存条目。
- 早期的命名 scratch 目录（`foundry` 0.9 GB、`isolation-drafts` 0.6 GB、`foundry-adaptive-concurrency` 0.4 GB、`dsh-ab` 1.6 GB）里有当时共享树未提交改动的副本或评测结果，没有核实能否删除，所以保留。
- NAS 上的游戏包导致的 syspolicyd 读盘不属于 Foundry，按原会话的建议处理。

## 部署与验证（train 101）

- Worker `0.5.7-dev.374.gaa552d8c.local.1795091012`，7 台设备全部更新成功（byte-dev、Mac mini、byte-dev-sg、cottoncpp、limen-canada、macbook、sg-chaos）。Mac mini 上只有一个执行宿主，版本即该版本。
- Worker 门禁：`tsc` 构建通过；定向测试 58/59 通过，`native-archive` 的「installed Codex archives…」在基线 `aa552d8c` 上同样失败（ENOENT，既有环境问题，与本项无关）。
- Mac mini 的真实工作区探针（新运行时，两个工作区，统计 `lstat/readdir/open`）：首轮每工作区 1 次 lstat、1 次 readdir、1 次 open，共 2/2/2；第二轮 2/2/0，内容未变时不再读文件。旧实现每轮约 1 万次，现为个位数。
- 资源信号：设备记录里 Mac mini 出现 `swapFreeBytes`（778,829,824），说明 `sysctl -n vm.swapusage` 路径生效。
- `fs_usage` 需要管理员密码，计算沙箱里不可用（`sudo -n` 失败）；以上探针作为替代证据。
- 本次构建用的就是新的 `scripts/remote-build.sh`：Mac mini 上 `~/.foundry/compute/foundry-remote/jobs` 构建后为 0 项。
