# DEV-146 Workspace 跨设备迁移

## 需求（2026-11-06，用户确认）

把一台设备上的 Workspace 迁到另一台设备的某个目录下：干净、彻底、不丢数据。

- 保留原 workspace id，历史（会话、Issue、成员、技能、飞书路由……）原地不动。
- 先复制、校验，再切换；切换前源端一个字节不改，取消/失败只删目标端 staging。
- 可再生目录（node_modules、.venv、构建产物）默认全部复制。
- 有活跃会话、进行中的 Issue run、applying 的 PA patch：拒绝并列出。
- 源副本保留；另提供“删除旧副本”，连同文件夹外的本地状态一起删干净，只删 manifest 里记录且目标端已校验过的内容。
- 数据经 Server 中转（每次迁移一条独立的数据 WebSocket，Server 只转发不落盘），不做设备直连。

## 设计

### 状态机（服务端，`workspace_migrations` 表，照 `knowledge_migrations` 的 revision + lease + 驱动循环）

`preflight → copying → verifying → activating → retiring → complete`；`canceled`、`failed` 终态。
`frozen` 不是单独状态：job 处于 `copying|verifying|activating` 时 workspace 视为冻结。

- **preflight**：Server 检查（两台设备在线、源≠目标、目标路径非其他 workspace、无活跃会话/Issue run/PA applying、workspace 非 PA home 以外的限制见下）；源端 `workspace_migration_scan` 报告文件数、字节数、警告（指向外部的软链接、大小写冲突、超长路径）；目标端 `workspace_migration_check` 报告路径是否可用（不存在或空目录、父目录可写）与可用空间。不满足 → `failed`，原因可读。满足 → 写入冻结，进入 `copying`。
- **copying**：Server 建两条 stream（source/target 各一个 streamId），向两端发 `workspace_migration_transfer`；两端各自外连 `GET /api/daemon/migration-streams/{streamId}`，Server 把两条连接双向对接（`io.Copy` 两向）。Worker 之间在这条管道上跑下文的传输协议。完成后目标端回报 `workspace_migration_progress {phase:"received"}`；断线/重连 → 驱动循环重新建 stream，已收文件跳过（文件级续传）。
- **verifying**：目标端 `workspace_migration_verify`（重算 staging 内全部 sha256 与 manifest 比对）；源端 `workspace_migration_rescan`（重扫，与首次 manifest 比 digest）。源端有变化（Foundry 之外改了文件）→ 回到 `copying`（只补差）。
- **activating**：目标端 `workspace_migration_activate`：staging 原子 rename 为目标路径；以原 id 写 `.foundry/workspace.json`（复用 relink 写法）；安装 Claude 会话（按 B 上 `claudeProjectDirectoryName(目标路径)`）、Codex rollout（B 的 codex home）、`~/.foundry/workspaces/<wsId>/`（execution 注册、Issue 环境、evidence-store），`git worktree repair`，`relocateExecutionRegistration`，重建 `.agents/skills` 链接，登记进 `workspaces.json`；回 registration（同 relink）。Server 收到后在一个事务里改写所有存设备/路径的行（下表），然后 `syncRegistration`，派发排队会话。
- **retiring**：源端 `workspace_migration_retire`：从本机 workspaces.json 移除并记入 forgotten（带 `migratedTo`），不删任何文件；保存 manifest 供日后删除旧副本。源离线则等待，期间源上线 hello 带上该 workspace 会被认领检查拒绝（device_id 已改）。
- **complete**：Workspaces 页在源设备组下显示“旧副本”，可删除。
- **cancel**：`copying|verifying` 可取消：目标端 `workspace_migration_abort` 删 staging，解除冻结 → `canceled`。`activating` 之后不可取消。

### 传输协议（两台 Worker 之间，经 Server 中转的双工字节流）

帧：`u32 length (BE) + u8 kind + payload`，单帧 ≤ 1 MiB。

1. 目标 → 源 `HELLO {jobId, role:"target"}`；源 → 目标 `HELLO {jobId, role:"source"}`。
2. 源 → 目标 `MANIFEST` 若干帧（NDJSON 条目）+ `MANIFEST_END {digest, entries, bytes}`。条目：`{root, path, type:"file"|"dir"|"symlink", size, mode, mtimeMs, sha256?, target?}`。`root` ∈ `folder | claude:<home-key> | codex:<home-key> | execution`；`path` 为 root 内相对 POSIX 路径。
3. 目标 → 源 `NEED` 若干帧（条目索引列表）+ `NEED_END`。已在 staging 收全且 hash 一致的不再要。
4. 源 → 目标 每个文件：`FILE_BEGIN {index}`、`DATA`×n、`FILE_END {sha256}`；目标写 `.part`，hash 一致才 rename 并追加到 staging 的 `received.jsonl`。
5. 源 → 目标 `DONE`；目标 → 源 `ACK {received, bytes}`；两端关闭。
   背压：Node stream / WebSocket 天然背压，不在内存缓冲整个文件。

### 目标端 staging

`<目标父目录>/.<目标名>.foundry-incoming-<jobId>/`，内含 `folder/`、`sidecar/claude/…`、`sidecar/codex/…`、`sidecar/execution/`、`manifest.jsonl`、`received.jsonl`。与目标路径同一文件系统，激活时 rename 原子。

### 服务端激活事务要改写的行

| 表                                                                                         | 改写                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `workspaces`                                                                               | `device_id`、`local_path`、payload `deviceId/localPath`，清 `unavailableOnDevice`           |
| `agent_sessions`                                                                           | `device_id`；payload 附件 `path` 旧前缀 → 新前缀；源设备专属 `profileId` 置空（报告里列出） |
| `agent_session_native_ids`                                                                 | `device_id`                                                                                 |
| `native_archive_targets`                                                                   | `device_id`、payload `workspacePath`                                                        |
| `native_account_dispatches`                                                                | `device_id`                                                                                 |
| `session_work`                                                                             | `device_id`、`spec.cwd`、scope `workspacePath`                                              |
| `chat_queue_items`、`session_inbox`                                                        | `attachments_json` 路径前缀                                                                 |
| `issues`                                                                                   | run payload `executionCwd`（execution root 前缀）                                           |
| `evidence_records`                                                                         | material `storageDeviceId`                                                                  |
| `knowledge_vaults`                                                                         | `device_id`                                                                                 |
| `pa_maintenance`、`pending_items`                                                          | payload `deviceId`/`path`                                                                   |
| `personal_agents`                                                                          | `home_device_id`（如为 PA home）                                                            |
| `workspace_draft_skills/_revisions`                                                        | 清快照，由目标端重新上报                                                                    |
| `device_connector_bindings`、`service_tunnels`、`resource_leases`、`feishu_gateway_grants` | 不迁移，preflight 报告列出（需在新设备重新配置）                                            |
| `agents`、`workspace_files`、`assets`                                                      | 目标注册时重报                                                                              |

守卫测试：沿用 `workspace_owned_rows_test` 写法，任何带 `device_id` 或路径的列未出现在迁移清单（改写或明确不迁）即失败。

### 删除旧副本

`POST /api/workspaces/{id}/migrations/{migrationId}/purge-source`：仅 `complete` 且目标在线；目标端先确认文件仍在（大小一致），源端按保存的 manifest 比对：迁移后被改/新增的文件默认拒绝并列出；确认后删除源文件夹、Claude slug 目录、Codex rollout、`~/.foundry/workspaces/<wsId>/`（之后 `git worktree prune`）、session-work 条目、chat-uploads 索引、迁移 manifest。结果回执并记审计。

### API

- `POST /api/workspaces/{id}/migrations` `{targetDeviceId, targetPath}` → `WorkspaceMigration`（立即返回，preflight 异步）
- `GET /api/workspaces/{id}/migrations/current`、`GET /api/workspaces/{id}/migrations/{migrationId}`
- `POST /api/workspaces/{id}/migrations/{migrationId}/cancel`
- `POST /api/workspaces/{id}/migrations/{migrationId}/purge-source`
- workspace 投影新增 `migration?: {id, state, targetDeviceId, ...}` 摘要，供列表与冻结判断。
- 权限：workspace owner（与 remove 同级）且对目标设备有添加 workspace 的权限。

## 时间线

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 剩余动作                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 2026-11-06 18:00 | 方案确认；查清证据材料在 `~/.foundry/workspaces/<wsId>/evidence-store`（随 execution sidecar 迁移），draft 快照路径是设备上 skill 缓存的绝对路径（目标端重报）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 实现 Server / Worker / Web，双设备端到端 |
| 2026-11-07 00:00 | 实现完成：协议（`daemon-messages.ts` 19 种消息）、Worker（`daemon/workspace-migration/`：扫描/manifest、分帧传输、staging、校验、激活、退役、删除旧副本）、Server（`workspace_migrations` 表与驱动、数据流中转 `/api/daemon/migration-streams/{id}`、激活事务改写、冻结、路由与契约）、Web（行菜单“迁移到其他设备…”、迁移对话框与进度、暂停状态、上次失败入口、旧副本删除对话框，中英文案）。AsterGate 502 中断后移入独立 worktree `foundry-dev146`（只抽取本项改动）。Go 迁移/relink/wire/归属测试、Worker 18 项、Web 63 项通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 部署 dev、e2e-alice 复验、人工验收       |
| 2026-11-07 00:00 | 双设备真实迁移（scratch 栈 `dev146`，worktree 构建；两台合成 Worker 各自独立 HOME 与状态目录，Codex 登录只做软链接）：源工作区含 git 仓库、node_modules、.venv、3 MiB 二进制、软链接、可执行位、空目录、真实 Codex 会话（记住口令 PELICAN-7319）、合成 Claude 会话与 memory、Issue worktree。A→B 69 个文件 9.56 MB 全部完成：除 `.foundry/workspace.json`（新路径，id 不变）外逐文件 sha256 一致；Claude 会话与 memory 落到 B 上新路径的 slug；Codex rollout 进 B 的 codex home；Issue worktree 在 B 的 execution root，`git worktree list` 双向指向新路径；A 文件保留、forgotten 记录 migratedTo。在 B 上续聊同一 Codex 会话：答出 PELICAN-7319，cwd 为新路径。删除旧副本：预览列出 5 个路径，迁移后改过的 `src/index.js` 默认保留（sourcePurge 记 keptCount=1），勾选后再删，A 上文件夹、Claude slug、Codex rollout、execution root 全部清除，B 不受影响。目标非空目录 → `target_path_unavailable` 失败且无副作用；B→A 回迁到 `~/back-home`（A 上曾 forgotten 的 id 可再接收）成功。浏览器（headless Chromium，真实栈）：行菜单 → 迁移对话框（默认目标 `b-root/back-home`）→ 进度 → 完成；设备分组下“旧副本”→ 删除对话框预览 → 删除结果。截图在 worktree `.foundry/attachments/dev146-live/` | 同上                                     |
| 2026-11-07 09:16 | 部署 dev（`~/workspace/foundry` 上 rebase 到 `ec721cf9` 后构建）：Server 重启前备份 `foundry-server.pre-dev146` 与 DB `backups/foundry-20261107-0916-pre-dev146.db`，`workspace_migrations` 表建立，7 台设备重连、healthz ok；Web `0bb3898aea268fcb`（上一版 `71bb496ba70152fb`，回滚 `releases/dev146/previous-20261107T011806Z`）；Worker `0.5.7-dev.313.gec721cf9.local.1794014301`，经 compute 租约更新 macbook、byte-dev、byte-dev-sg、CanWendeMac-mini、sg-chaos、cottoncpp、limen-canada。e2e-alice 在 dev 上配两台合成设备（独立 HOME 与状态目录，`~/.foundry/dev146-acceptance/bin/two-workers.sh`），A→B 迁移 50 个文件 4.1 MB 完成，文件 sha256、git 历史、workspace id 与 Codex rollout 一致；在 B 上经 dev 续聊同一 Codex 会话，答出口令 HERON-4821，cwd 为新路径。发现：完成后迁移记录的目标名变成主机名 `VM-4-8-debian`（激活时取了 Worker 上报的 hostname，没取设备在 Foundry 的名字）；改为优先用设备显示名，迁移测试加“迁移中改名”回归断言                                                                                                                                                                                                                                   | 部署修复                                 |
| 2026-11-08 21:11 | 修复部署 dev：Server 二进制换入（备份 `foundry-server.pre-dev146b`；无 schema 变化，回滚 DB 仍用 0916 快照），healthz ok，6 台在线设备 30 s 内重连（CX4454F7JQ 重启前已在反复 TLS 断连，非本次引起）。e2e-alice 在 dev 上 B→A 回迁到新目录 `a-back`（`wsmove_abbac4728f78a8c251456adc`）：完成，`targetDeviceLabel` 与 Workspace 分组均为 “DEV146 synthetic A”；35 个文件 sha256 一致，git 历史与 workspace id 不变。合成 Worker 已停止                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 人工验收                                 |

## 验收步骤（dev）

1. Workspaces 页，在某设备的 Workspace 行点 “…” → “迁移到其他设备…”。预期：可选其他在线设备，目标目录默认在该设备已有 Workspace 的父目录下。
2. 选一个不存在的目录，点“迁移”。预期：依次显示检查 → 复制（文件数/字节进度）→ 校验 → 切换 → 完成；迁移期间该 Workspace 行显示“正在迁往 X”，切换按钮与发送消息被禁用并说明原因。
3. 完成后：Workspace 显示在新设备分组下，路径为新目录；打开迁移前的会话继续发消息，预期上下文仍在、在新目录运行；Issue 仍在。
4. 原设备分组下出现“proj 的旧副本”→“删除旧副本…”。预期：列出将删除的路径与大小；迁移后改动过的文件单列并默认保留；确认后显示释放的空间。
5. 有正在运行的会话时发起迁移。预期：失败并列出该会话（可点开），“重试”可再次发起。

## 已知限制

- 传输只能按文件续传：中断时正在传的那个文件要从头重传。Worker 重启后由 Server 发起新一轮传输。
- 删除旧副本时，不清理其他仓库里指向旧路径的 worktree 元数据。
- 设备连接器绑定、服务隧道、资源租约、飞书网关授权、仅源设备有的 profile 不随迁移带走，preflight 的“不随迁移带走”中列出。
- 目标设备 Worker 版本过旧时，只有在发起迁移后才会提示 `worker_outdated`。
- 迁移对话框的目录选择沿用共享的文件夹选择器，其中 “Suggestions” 一词在中文界面未翻译（Add / Locate 同样如此，不属于本项）。
