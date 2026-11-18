# DEV-310 恢复用例进入脚本（C10、C19、C20）

[事项索引](README.md) · [实机回归](../live-regression.md) · 路线图 CHAT-3

状态：**已实机通过**（2026-11-18，sg-chaos 上的 L-iso 栈，Worker 运行 Server 托管的 Claude 档案 `prof_2c4c55cc-e65e-4c76-bbed-4495af2b7617`，Tencent TokenHub (Claude)）。CI 不运行这三个用例（见「CI 决定」）。

## 问题

实机回归表中 C10、C20 仍是手工步骤，C19 脚本会杀掉当前状态根所指设备的 Worker（只在 `--kill-worker` 时运行）。要求：三个用例在隔离栈上自动执行，只杀自己启动的进程，永不触及 dev Server 或真实设备的 Worker。

## 变更

- `scripts/live-recovery-regression.mjs`（新）：每个用例自建一个 L-iso 栈，全部回环：独立 Server 与数据库、独立 Worker（HOME、状态根、工作区）。
  - 只杀自己 `spawn` 出来的进程及其子进程；杀 Worker 前检查 `daemon.lock` 的 pid 等于自己启动的进程，不符则拒绝。
  - 子进程环境由脚本构造，不继承调用者的 `FOUNDRY_*`。
  - 每个用例开始前等待 MemAvailable ≥ 800 MB（另一个 eval 与之共享主机）。
  - 默认清理栈目录；`--keep` 保留以便查日志。
- `scripts/live-session-regression.mjs`：删除 `worker-restart`（C19）及 `--kill-worker`、`--restart-worker`。该用例已搬到新脚本。
- `docs/live-regression.md`：C10、C19、C20 的方式列、§3、§4.4 与运行记录。「最近一次全部通过」**未改动**（那一行是整套回归的记录）。

## 档案种子

隔离库是新库，但它的 Server 用 dev 的密钥文件（`~/.foundry/server/foundry-secret.key`，经 `FOUNDRY_SECRET_KEY_PATH` 原位引用，未复制、未输出）解开种子的密钥：

1. 新库首次启动（建表、写入密钥元数据），创建 owner，停止 Server。
2. 从 dev 库（`mode=ro`）复制三类行，只复制两边 schema 都有的列：`profiles` 中该档案一行；`secret_records` 中 `agent-profile:<id>` 一行（封存的凭据，未读取明文）；`secret_store_meta` 全部行（DEK 包裹所需）。`owner_user_id` 改为隔离库的 owner。
3. 重新启动 Server，配对、`init` 工作区、`connect`；owner 登录后 `PUT /api/devices/{id}/profiles` 绑定该档案；等待 `/api/agent-profiles` 显示它在本设备上 `healthy`。
4. 每个会话用 `provider: claude, profileId` 发起，不再使用 `claude_local`。

为何不用 `limen_default`：它是 external 档案（connector `limen`，配置在设备的 Limen connector 与 `extension-model-providers.json` 中，状态根内的数据），不在服务器的 `profiles` 表里，无法种子到隔离库。改用 TokenHub，这是 brief 中列出的备选。

PA-1 工作树（`~/workspace/foundry-pa1`）中没有可复用的种子脚本：它的 `Stack` 类假定 `data/foundry.db` 已准备好，而准备步骤不在仓库里。因此种子逻辑是本脚本的 `seedProfile`，PA-1 的 eval 不受影响。

## 运行

```bash
cd ~/workspace/foundry-chat3 && node scripts/live-recovery-regression.mjs
```

使用的二进制：Server `~/.foundry/server/releases/dev023-candidate/foundry-server`（预构建，未重新构建）；Worker `~/.foundry/runtime/current/node_modules/@bd777/foundry-worker/dist/cli.js`（版本 `0.5.7-dev.369.g08a08911`）。本次运行的输出（`/tmp/chat3-final-run.log`）：

```
isolated stacks run profile prof_2c4c55cc-e65e-4c76-bbed-4495af2b7617; cases: worker-restart, orphan-input, server-down-marker
✔ worker-restart (77s): input lost 17s after the kill; the next message resumed with PEAR-4
✔ orphan-input (61s): second input ended canceled (cancel accepted), not NOTED; the next input answered PEAR-4
✔ server-down-marker (63s): the Worker wrote the marker with the Server down; after both restarts the input completed with DONE-C20
```

退出码 0；运行中没有内存暂停；日志经检查不含凭据形态的字符串；栈目录已删除。

此前的尝试（同一脚本，便于复核）：

- 第一次：设备尚未出现在 `/api/devices` 就绑定，失败；改为连接后再绑定。
- C19 单独运行一次通过（lost 3 s after the kill）。
- C20 与 C10 同次运行通过；但 C10 的取消在 Worker 重连期间被 Server 以 `409 reconnecting` 拒绝，取消那一段未执行。于是 `cancelOrphan` 改为在重连期间重试，直到被接受或输入已结束；随后 C10 单独运行通过，取消被接受（`canceled`）。

## CI 决定

**2026-11-19 更新：C19 的假模型版本已加入 CI（见下），真实模型的三个用例仍不加入 CI。** 原理由：三个用例需要 dev 库中封存的档案凭据与 dev 密钥（经路径引用），以及真实模型调用；CI 没有这两者。替代方案：在 sg-chaos 上定时运行（或由人在需要时运行），其输出记入本文件。

## 限制

- 运行的模型是 TokenHub 的 `deepseek-v4.1-flash-1017`（通过 Claude runtime 与 anthropic 兼容端点），不是 `limen_default`；C10、C19、C20 验证的是恢复路径，模型档案的选择不改变它们的断言。
- 每个用例各自的栈，一次运行中三个用例串行，未覆盖并发。
- 未在 CanWendeMac-mini 运行（那里的 Claude 也未登录）。
- 进程控制只在 Linux 上运行过。

## 拓扑断言（2026-11-19）

C19 原先假设输入必然以"结果丢失"失败，这只对执行宿主不存在或已死的情形成立。执行宿主设计上独立于 Worker（DEV-286b 收养），在 macOS 上它是 launchd 服务，`kill -9` Worker 之后宿主与其中的 Claude 进程仍在，重启后的 Worker 收养该运行，输入以回答 DONE 完成。两种结果都是正确行为，因此 C19 改为按拓扑断言：

- 宿主存活（`<stack state>/execution-hosts/<key>/identity.json` 记录的 pid 仍在）：输入在重启后以 DONE 完成、不标丢失。
- 宿主不存在或已死：输入在 60 秒内以"结果丢失"失败。
- 两种情形下，下一条消息都续上原生上下文（PEAR-4）。脚本打印走的是哪一支，两支都不成立则失败。

实现：`scripts/lib/execution-host-topology.mjs`（读取本栈宿主、判断存活、拆除时只停本栈的宿主；macOS 上按 pid 找 launchd 标签后 bootout）；`scripts/ci-worker-restart.mjs`（新，假模型，CI）；`scripts/live-recovery-regression.mjs` 的 C19 同样改为拓扑断言，并在拆除时停止本栈的宿主。`scripts/fixtures/fake-claude-code.cjs` 写入 CLAUDE_CONFIG_DIR 下的 JSONL 转录，恢复时由 Worker 检查其存在。

### 运行记录

- sg-chaos（Linux，fake 运行时，`scripts/ci-worker-restart.mjs`，构建产物：Server dev023-candidate、Worker 0.5.7-dev.369）：走"宿主不存在"分支（Worker 未启动宿主，因为环境中没有 XDG_RUNTIME_DIR），输入在 kill 后 5 s 以"结果丢失"失败，随后续上 PEAR-4，退出码 0，拆除后无残留进程。
- CanWendeMac-mini（macOS，fake 运行时，从源码构建 Server 与 Worker，基线 159b8b35）：走"宿主存活"分支，宿主 pid 38290 在 kill 后存活，输入在 kill 后 83 s 以 DONE 完成，随后续上 PEAR-4，退出码 0，拆除后无残留宿主。
- sg-chaos（Linux，真实模型：DEV-310 的 TokenHub 档案，`scripts/live-recovery-regression.mjs --cases worker-restart`，预编译 Server 与 Worker，内存守卫）：走"宿主不存在"分支，输入在 kill 后 9 s 以"结果丢失"失败，随后续上 PEAR-4，退出码 0，用时 47 s，运行后无残留进程。
- 在此之前的两次 mini 运行：第一次（旧断言）的输入以 DONE 完成，原因即宿主存活；第二次（新断言，宿主路径写错为 `execution-host`）误判为"无宿主"，宿主本身仍在运行。两次都已清理（launchd 任务卸载，进程结束），用户的宿主与 Worker 未动。

### CI 增量

- 新增步骤：`pnpm --filter '@bd777/foundry-worker...' build` 加上 `ci-worker-restart.mjs`。
- 实测：Worker 构建在 CanWendeMac-mini 上 3 s（依赖已安装）；sg-chaos 上的用例约 26 s（墙钟，含启动 Server 与 Worker）。
- 估计：GitHub Ubuntu 上增加约 1 分钟（构建冷启动与用例合计）。这是估计，尚未在 GitHub 上运行。

### 限制

- 真实模型的 C19 已在 sg-chaos 上运行（"宿主不存在"分支，见上）。在 macOS 上用真实模型走"宿主存活"分支尚未验证。
- C10、C20 的拆除现在也会停止本栈的宿主；它们在 macOS 上的行为未重新验证。
- CI 只覆盖 Linux 的"宿主不存在"分支；"宿主存活"分支只在 macOS 上运行过。
