# DEV-051 · 会话图片与文件加载、下载恢复

状态：第一轮恢复/重试、文件下载与内联路径修复已发布，但真实请求仍慢，性能问题重新打开。第二轮预览/缓存/优先传输已部署并通过所述自验，真实用户弱链路请求仍待复验；代码未提交，真实用户端到端及人工验收仍待确认。涉及临时 Git commit 的既有测试按已确认窗口由协调者复验。

用户报告：2026-10-27，`sess_1793071783626149651` 中 Agent 发出的 Meego 截图不可见。协调会话 `sess_1793063405185071529` 指派本项；实施会话 `sess_1793085973927054373`。

## 调查结论

文件不是丢失：byte-dev 上 `<workspace>/.foundry/attachments/meego-login-retry-20261027.png` 为 190,467 字节 PNG。工作区路径含 `/home/<user>` → `/data00/home/<user>` 的软链；设备读取时两侧均解析软链，边界检查成立。

Server 在 15:04:52、15:05:44、15:11:05、15:15:31、15:22:40 的图片 GET 分别约 30 秒结束，命中 `localImageChunkTimeout`；并非 Web 不支持 `<image path="…">`。更正最初日志位置：本机慢请求记录在 `~/.pm2/logs/foundry-server-error.log`，不是 out.log。

byte-dev 的旧 daemon 为 dev.57、执行宿主为 dev.53。15:14 的连接报告显示：

| 观测             | 数值与含义                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 最大事件循环延迟 | 835 ms，不能解释 30 秒超时                                                                                             |
| 最长发送停滞     | 117 秒，共享连接暂时没有发送进展                                                                                       |
| 队列峰值         | 40 个事件、socket 约 74 KB                                                                                             |
| 连接结束         | Server 在 70 秒无设备数据后断开                                                                                        |
| 重连前后图片 GET | 15:22:59 为 23.949 秒；15:23:04 为 1.749 秒、15:23:19 为 1.160 秒，间歇性链路问题                                      |
| 重连首 180 秒    | skills_scanned 合计 616 KB，9 个 workspace_ready 合计 119 KB，hello 合计 27 KB；这些是逻辑消息统计，不能当作物理帧大小 |

旧版与当前版的 `socket.on("message", ...)` 都独立启动异步 dispatch；文件 handler 不等待其他异步 handler。技能 inventory 等直接 RPC 已通过 `reply_chunk` 分片，每片默认 16,384 个 UTF-16 单元；会话可靠 outbox 的 `write()` 仍直接发送整个 JSON，存在另一条可产生大帧的路径。保存在 Server 的该连接时间段事件样本最大 11,341 字节（不含外层 envelope，且不代表所有曾发送的累积快照），不能据此认定某一大帧就是本次停滞的唯一来源。

因此，本项确认的是“共享传输无进展 → 首块超时 → 无恢复 UI”；没有证据把事故归因于 daemon handler 排队。下述传输改动消除可复现的大快照阻塞风险，但不能承诺消除底层网络停顿。

## 修改

- Worker 可靠会话事件同样采用有界分片，与 RPC reply 轮流发送；保持可靠事件先后顺序、ACK、断线重放与未发送快照合并。部分已发送的快照先完成，避免在 Server 留下无结尾的分片组。旧 Server 未协商 `reply_chunks` 时沿用完整消息兼容路径。
- 图片读取块由 1 MiB 降为 64 KiB；上传及普通工作区文件读取仍保留 1 MiB。大图片可在每个有界 round trip 后继续流式传输，190,467 字节示例分为三块。
- Server 保留每块 30 秒、整图 3 分钟的边界；所有图片响应（包括失败）禁止缓存，离线/超时返回 `Retry-After: 1`。自动重试集中在浏览器，避免 Server 与 Web 重试相乘。
- Agent Markdown 图片与预览弹层共用 `LocalImage`：加载状态、短原因（设备离线/设备慢/找不到/读取失败）、一次瞬时失败自动重试及可见键盘重试。404 不盲目自动重试；手动重试重新分配一次自动恢复机会。完整读取后通过 blob URL 解码，不展示原生破图图标；卸载时中止请求、回收 URL。中英文均已补齐。

## 自验与证据

证据目录 `.foundry/attachments/20261027/dev051/`。

生产默认分片尺寸的合成量测 `wire-metrics.json`：同时发送 524,288 字节会话快照正文、630,784 字节技能说明（对应日志 616 KiB inventory 量级）和 65,536 字节图片块，实际序列化为 78 个 WebSocket message，最大 16,467 字节、socket 待发送峰值 71,421 字节；图片在第 27 个 message 完成，快照第 62 个完成，快照仍正确等待 ACK。这是未压缩、受控慢 socket 的量测，不能当作故障时真实网络的抓包或吞吐率。

真实 Chromium 的 `light/dark × 1280/390` 矩阵均通过：一次自动重试后图片恢复，慢/离线读各恰好两次后显示原因，404 一次后显示原因；每种组合 `overflow=false`、`broken=false`、三个可见失败面板。`matrix-*.json`、`{light,dark}-{1280,390}.png`。加载、Tab 焦点、Enter 重试、预览成功/离线与 Escape 关闭分别记录在 `loading-390.png`、`retry-focus-390.png`、`keyboard-retry.json`、`preview*.png/json`；键盘手动重试后 slow 读次数为 3 并成功。Fixture 使用实际 Markdown/LocalImage/预览组件，只有图片传输为合成，不写用户会话。

- Worker：`chat-image-transport.test.mjs` 覆盖长异步 handler 期间真实文件读取、64 KiB 分块重组、大可靠快照与图片交错、事件顺序/ACK、发送中快照合并、重连分片从零开始。连同原有 transport/attachment 回归，25 项通过（含生产尺寸分片量测）；最终检查另覆盖 7 个 Worker 测试文件。
- Web：`local-image.test.mjs` 4 项通过，覆盖加载/解码/预览、504 一次自动重试后显示原因、手动恢复、409/404 分辨与翻译、截短 body 重试、卸载中止。
- Server：local image deadlines、失败缓存头、reply chunk 相关测试通过。`server-tests.txt`。
- `scripts/check-changed.sh --files …` 最终全部通过：格式、Web typecheck、3 个 Web 测试文件、Worker 编译与 7 个测试文件、2 个 Server 图片测试、11 项 UI audit 与 contract audit。`check-changed.txt`。单独 `pnpm audit:ui` 同样通过；布局审计沿用原有 3 条债务，无新增债务。

## 部署与更新

Web 首先随 DEV-049 冻结快照发布 `3b449cf945b20c61`（七个 DEV-051 Web 源文件逐一 SHA256 相同），随后 DEV-052 候选发布为 `f0af1c5d7df5517d`。部署后复用 e2e-alice 登录真实 dev，浏览器加载的 meta build 与公网 version.json 均为 `f0af1c5d7df5517d`（`web-deployed-smoke.json`）。实际主 bundle 包含 LocalImage，`deployed-bundle.json` 记录 asset 与 SHA256。

Server 于 16:19:12 恢复健康，PID `1492872`；本机 `http://127.0.0.1:31982/healthz` 的 `startedAt=2026-10-27T08:19:12Z`。候选 artifact 与 `/proc/1492872/exe` 的 SHA256 均为 `315645e9da1e43d665ad5190c91492e1d388e91eb22aad12e8ad0c3e6827bcd7`。合并 DEV-050 读取快照护栏与 DEV-052 连接器 metadata additive migration，复用 DEV-052 当前在线备份 `~/.foundry/server/releases/dev052-device-connectors/previous/foundry-20261027-155245.db`（992,100,352 字节，quick_check=ok）及上一 binary，不再复制数据库。只读 Go 计划显示重编译 httpapi/sqlitestore/main 三包、链接一次；候选约 51 MiB，以原子硬链接替换已有 PM2 target，避免额外复制 binary。未清缓存或安装依赖；最终空闲 `10,630,418,432` 字节，约 9.9 GiB。`server-{artifact,loaded,health,build-budget}.json`。

更正证据：公网 `/healthz` 回退到 SPA HTML，保存为 `frontend-health-route.html`，不能作为 Server 健康 JSON；公网 API 可达性另由 `/api/worker/release` 的 200 application/json 验证（`server-public-api.json`）。e2e-alice 浏览器真实 GET 已验证：既有合成工作区设备离线时返回 409、no-store、Retry-After:1（31.5 ms）；未知工作区图片返回 404、no-store（11.4 ms）。`deployed-image-errors.json`。这些请求没有创建或更改用户会话。

Worker `0.5.7-dev.81.gac22cc1.local.1793088606` 已发布，包含 DEV-051 与稳定的 DEV-052 Worker/Protocol 变更。protocol 92,556 字节、Worker 556,523 字节；包内四个相关 JS 文件与编译输出逐一相同，公网逐包 SHA256 验证通过（`worker-artifact.json`、`worker-public.json`）。包暂存约 0.62 MiB，旧 tarballs 与 manifest 留存。

协调会话在 2026-10-27 明确批准 byte-dev 的安全自更新，保留活动执行宿主。因 session token 不允许设备更新路由、没有 owner 浏览器身份，按批准通过 compute lease 调用已安装 runtime 的 `startSelfUpdate`（Devices handler 的同一入口）。这两次没有 Server-side update tracking，以成功状态、PID、实际宿主路径与 Server 注册版本共同核验（`device-update-receipts.json`、`registered-worker-versions.json`）。

| 设备                           | daemon / installed         | 实际执行宿主              | 结果                                    |
| ------------------------------ | -------------------------- | ------------------------- | --------------------------------------- |
| byte-dev                       | `.1793088606`，PID 3003453 | dev.53，PID 1193234       | daemon 已加载；忙碌宿主保留旧版，未强停 |
| byte-dev-sg                    | `.1793088606`，PID 816740  | `.1793088606`，PID 816763 | 两层均已加载                            |
| sg-chaos                       | 保留既有版本               | 保留忙碌宿主              | 系统盘约 9.9 GiB，本轮不安装 runtime    |
| Mac mini / cottoncpp / macbook | 未更新                     | 未更新                    | 系统盘使用率/剩余空间触及约束，跳过     |

byte-dev 更新后，通过新 Worker 代码只读原始 `meego-login-retry-20261027.png`：190,467 字节、image/png、三块 `[65536,65536,59395]`，设备端耗时 1.426 ms，SHA256 `82600f1e8340056c74090908ab6b2506680e4371d629c56d819fde9991611e8d`。这验证文件与新分块读取，不冒充经过公网传输的 HTTP 时间。byte-dev 的图片读取由新 daemon 处理，旧执行宿主保留不阻止该修复生效。两台 compute leases 均已释放。

## 人工验收与限制

1. 用户刷新 dev 并重开原聊天：图片应加载成功；加载期间显示状态。
2. 设备离线或链路中断时，应看到原因与“重试图片”；设备恢复后按该按钮或键盘 Enter，应恢复图片，可打开预览。
3. 390px 与桌面、明暗主题下均应可阅读、操作，无水平溢出或遮挡。

真实附件的用户侧端到端 GET 待用户重新打开聊天确认；本会话不冒充用户登录、不读取登录 Cookie、不改动其真实会话。设备端文件读取与合成浏览器证据分别记录，不将其描述为用户已验收。用户上传缩略图的 AttachmentList 不是本项 Agent 回复图片的改动范围。

## 时间线

- 2026-10-27：接手排查，读取 byte-dev daemon 日志、版本与磁盘，compute leases 均按阶段释放；初步排除异步 handler 串行猜测，定位发送停滞与缺恢复 UI；完成首轮实现与回归检查。

- 2026-10-27 16:12–16:24：Worker 发布并在两台 byte 设备核验实际加载；合并 Server 发布健康；真实浏览器核验最终 Web build 与图片错误 HTTP 响应。未做 Git 历史写入，真实原图端到端与人工验收留待用户确认。

## 2026-10-27 补充：文件下载与内联路径

用户追加报告 `autorun启动配置与示例说明`：JSON 引用打开文件面板时显示设备 15 秒未回复，且长路径在灰底代码块中居中。原文件面板只发一次预览请求，失败没有恢复入口；也没有独立的完整文件下载动作。原始 JSON 的会话为 `sess_1793084665248834806`，设备只读确认账本允许读取、15,915 字节、未截断、1.240 ms；SHA256 `73695c75c20cf2dac0262295ac7459d48e7ee3672ece1f3aff5b1b70fd7f4f72`，不复制实际业务配置内容。

新增 GET `/api/agent-sessions/{id}/files/download` 与 `/api/workspace-files/download`，沿用现有会话账本、工作区边界、Git 私有目录和角色规则。会话工具写出的文件/工作区内文件仍可由 Viewer 读取；仅在回答中引用的工作区外文件需要 Member。Worker 新 `file_download_v1` 能力协商，原 read_file/read_session_file 消息仅增加可选 download 请求，旧设备不会误把截断预览作为完整文件。每块至多 64 KiB，文件上限 100 MiB，每块 30 秒、整体 10 分钟；后续块绑定 inode/size/mtime revision，变化时结束读取，由浏览器重新获取完整文件。

会话文件、工作区浏览文件预览与下载均有一次瞬时失败自动重试、短原因和可见重试。预览和下载各自独立计次；文件切换/关闭中止旧请求。下载按钮在读取元数据后出现，完整 body 成功后才触发浏览器下载，绝不将截断预览保存为完整文件。错误保存结构化原因，切换语言时同时更新说明。图片分片与可靠 outbox 修改覆盖这些 RPC 的共享传输。

内联文件引用已使用 Button 的 link/inline API；修正其拥有的 inline 样式为自然行内排版、start 对齐和 anywhere 换行，SVG 与首行对齐；删除引用消费者将 SVG 居中对齐的规则。其余 12 个 inline Button 消费者仍保留原生 hover/focus/disabled 行为，Popover 样式保持其他事项的最终版本。

补充测试：Worker 的完整文本/二进制、截断边界、账本/私有路径/软链/Git 边界、revision 与大小/offset 校验，连同既有 session/workspace 文件回归 27 项通过；Server 四组下载测试覆盖完整字节/文件名、Viewer/Member、旧能力拒绝、首块超时与中途失败短 body；Web 五组测试覆盖两种预览路径、取消、瞬时/永久错误、实际 Blob 字节与语言切换。`file-{worker-tests,server-rerun,web-rerun}.txt`。类型检查和全部 UI 审计通过（`file-web-audit-rerun.txt`）。补充浏览器矩阵与发布证据继续追加。

### 补充验证记录

真实 Chromium 的文件面板矩阵 `light/dark × 1280/390` 均通过离线原因、一次自动重试、设备恢复后手动重试与完整预览；无水平溢出，长路径 start 对齐且图标贴首行。`files-{theme}-{width}.json` 与 `files-{error,ready}-*.png`。键盘 Tab/Enter 重试通过。会话与工作区下载各 980,949 字节，与合成原始 JSON 逐字节一致、SHA256 均为 `e215dceee7e68e492d46217653ba40b41dfdc8c9334d9ef75ac91074a0d8695e`（`browser-file-hashes.json`）；测试数据大于预览上限，证明下载不是保存截断预览。下载忙碌时按钮禁用，关闭面板后请求中止且无迟到下载（`download-cancelled.json`、`download-busy-dark-390.png`）。

47 文件综合 `check-changed` 的前 46 文件运行于 17:08:21–17:19:31：格式、Protocol build/tests、Web tsc/58 个测试文件、Worker build/23 个测试文件、11 UI audits 与 contract 全通过。新增 `file-downloads` 未登记模块导致的 module audit 已补登记并单独通过。HTTP 全包检查主动终止，不能称综合检查全绿；随后只选文件/图片/reply chunk 的无 Git 用例，25.141 秒通过（`file-server-safe-final.txt`）。

本次检查前未识别既有临时 Git fixture 的副作用：16:49 的 session-files 回归，以及 17:08 综合检查（Worker 约 17:13–17:14、HTTP 约 17:14–17:19）已执行或启动部分临时仓库 commit 用例。main HEAD 未变；发现后终止自己的 HTTP 测试进程，未再次执行相关用例。协调者要求这些用例仅在允许窗口重跑，故它们的最终复验仍待协调者完成；不能用之前通过替代该 gate。精确文件/用例清单保存在 `deferred-git-fixtures.json`，包括 personal-agent 的 clone、session-files 的 Git workspace/snapshot、workspace-bootstrap 的初始化/acceptance，以及六个 HTTP skill repository/bundle 用例。这里只记录未完成验证，不改变产品语义或测试。

<details>
<summary>待允许窗口复验的准确用例</summary>

`packages/worker/test/personal-agent.test.mjs`：

- `a clone lands inside the managed root`

`packages/worker/test/session-files.test.mjs`：

- `only the session's own successful writes are attributed`
- `files under the workspace's attachments are outputs; Foundry's own state is not`
- `a file named before it exists links as pending and opens once written`
- `a turn's diff runs from before its first write to after its last`
- `a recorded file is named by its absolute or its workspace path`
- `another process editing the same file between writes is labelled`
- `Codex diffs come from a turn-start snapshot; the user's index is untouched`
- `a Codex snapshot works while Foundry's session folders are git-ignored`
- `a Codex snapshot covers only the workspace inside a larger repository`
- `an unreadable file does not cost the Codex snapshot`
- `a session whose snapshot ran out of time takes no more`

`packages/worker/test/workspace-bootstrap.test.mjs`：

- `uninitialized submodules in unrelated repositories do not block root workspace initialization`
- `arbitrary Workspace assets enter candidate and accept without untracked blockers`
- `an empty Git root gets one recoverable baseline and retains its branch name`
- `an existing user index is preserved and missing assets are visible`
- `initialization resumes its own staged journal after interruption`
- `a workspace excluding every file still obtains a valid empty-content baseline`
- `registering a committed workspace again changes none of its tracked files`
- `registering an existing repository writes only under .foundry/, commits nothing and leaves it clean`
- `registering leaves the person's own AGENTS.md and staged files exactly as they were`
- `files an earlier worker left under .foundry/ stay untouched and out of the way`
- `setting up Git for a large folder commits every file and never stalls the worker`
- `Foundry's session files stay out of a fresh repository, its worktrees and nested workspaces, through local excludes only`

`apps/server/internal/httpapi/skill_device_fetch_test.go`：

- `TestSkillRepositoryReadThroughDevice`

`apps/server/internal/httpapi/skill_repositories_test.go`：

- `TestSkillRepositoryLifecycle`
- `TestPickedSkillsFromBeforeFollowVersions`

`apps/server/internal/httpapi/skill_tool_declaration_test.go`：

- `TestBundleDeclaresUvTool`

`apps/server/internal/httpapi/skill_bundles_test.go`：

- `TestSkillBundleLifecycle`

`apps/server/internal/httpapi/skill_repository_mode_test.go`：

- `TestPickedRepositoryBecomesABundle`

`packages/worker/test/workspace-bootstrap.test.mjs`：

- `confirmed Git setup initializes, keeps Foundry's files out and commits the folder's files`

</details>

### 文件分支发布与设备核验

17:26:01 Server 恢复健康：PID `1534805`，本机 health `startedAt=2026-10-27T09:26:01Z`，候选与实际 `/proc/1534805/exe` SHA256 均为 `b6cea97ff29db760d78eef255f43aeecf7d769d56f6c7b355c000fc8b82d910a`。本次启动约一分钟，未将早期未就绪读误记为健康；随后 health 与实际运行哈希一致。候选 `~/.foundry/server/releases/dev051-chat-images/foundry-server-files`，上一 binary 硬链接保存在该目录的 `files-previous/foundry-server`，仍复用既有在线数据库备份，无新增迁移或数据库副本。`file-server-deployment.json`。

Web 发布 `72eeef927ba62eb0`，前一版本 `069a4d3a7c0f6c77`，保留 DEV-049 最终 Popover 与 DEV-052 连接器实现。旧 assets 保留，前一 index/version 保存在 `files-previous/`；公网每个 JS/CSS 与候选 SHA256 相同（`file-web-deployment.json`）。e2e-alice 的真实浏览器加载此 build，既有合成离线工作区的预览/下载分别返回 409、no-store，64.4/30.4 ms；下载另有 `device_offline` 与 Retry-After:1。`file-deployed-smoke.json`。没有创建用户数据或模型请求。

Worker 发布 `0.5.7-dev.81.gac22cc1.local.1793093010`：Protocol 92,678 字节、SHA256 `324f4dc34750b90560de553ae8a11c5fda2781965c88d5d089f2ab4d80519158`；Worker 557,296 字节、SHA256 `56864f17df79c0e089f7e351cedd1c8eba2d4c93013d60989c96085d919367d2`。公网 manifest 与包哈希通过，旧包与 manifest 仍保留（`file-worker-{artifact,public}.json`）。两台 byte 设备磁盘分别 root 86/99 GiB、home 1.3 TiB/449 GiB，批准的同一 self-update 入口成功。Server 中两台设备实际注册该版本和 `file_download_v1`，byte-dev daemon PID `3444700`；byte-dev-sg 的 execution host PID `838685` 已切新版本，byte-dev 忙碌 host PID `1193234` 保留 dev.53，未强停。该下载和图片读取由新 daemon 处理，旧 host 不阻断功能；新会话 connector instruction 等依赖执行宿主的改动不能冒称已在旧 host 加载。更新仍无 Server-side update tracking，按此前批准以设备状态、实际 PID/路径和注册版本核验。`file-device-updates.json`、`file-registered-versions.json`。

通过 byte-dev 已安装新版的真实 daemon handler 调用（socket 为内存接收器，仅校验设备读取，无公网请求）验证原始 JSON：`read_file` 与 `read_session_file` 均返回完整 15,915 字节、同一 SHA256 `73695c75c20cf2dac0262295ac7459d48e7ee3672ece1f3aff5b1b70fd7f4f72`，设备端分别 0.941/1.041 ms。原 PNG 三块合计 190,467 字节，0.951 ms，哈希与前次相同。`file-real-device-reads.json`。首次校验脚本将图片相对路径传给只接收绝对路径的 helper，得到 not_found；改成 API 使用的绝对路径后通过，不是原图丢失。所有 compute lease 已释放。

新增人工验收：刷新后打开“autorun启动配置与示例说明”的 JSON 引用，应看到左对齐的可换行路径；文件面板读取成功后有“下载文件”，保存的 JSON 应完整可读。设备短时无响应时自动恢复一次，再失败显示中文短原因与“重试文件”；设备恢复后可用键盘进入重试。真实用户原图和 JSON 的端到端 GET/下载仍待用户本人重开确认，由协调会话跟踪 Server 日志；未把设备内存 socket 或合成下载冒称为用户侧验收。

## 17:36 后真实慢请求：性能问题重新打开

第一轮发布不能作为性能完成证据。nginx `foundry_timed` 显示 byte-dev 图片仍为：19,634 B 在 17:36/17:39 分别 9.892/11.788 秒；114,996 B 分别 25.326/18.800 秒；另一工作区的 993,079 B 在 18:02:54 耗时 80.033 秒。Meego 两个 17:37:21 的 499 均为约 1.730 秒，同时浏览器切换到其他聊天并请求归档列表；组件没有该时长的超时，卸载时才中止，不能据此归咎于自动重试。证据 `image-499-navigation.txt`。

### 实测瓶颈与目标调整

滚动 daemon 入站指标只记录类型、数量、字节和耗时，不记录消息内容：1 MB 图片的 16 个 RPC 中位 5,043 ms、最大 8,566 ms；末 60 秒 image logical reply 887,822 B/11 条、session_event 44,208 B/86 条；wire reply_chunk 865,318 B/59 条。图片占约九成，单靠给图片排队优先级无法消除传输时间。

byte-dev 通过 compute lease 的原始 HTTPS 测量：下行 1,581,015 B / 3.749 s（约 422 KB/s），connect 255 ms、TLS 524 ms；curl 上行 128,072 B / 15.006 s（约 8.5 KB/s），另一 1 MB 探针 45 秒仅上传 458,751 B（约 10.2 KB/s）。RTT 有 245–1,760 ms 波动。上传走不存在工作区且被严格字段校验拒绝的 endpoint，不写业务对象。Node 的超大请求超过 1 MiB decoder 上限且超时，不能当成有效单流测速。证据 `raw-link-probe.json`、`curl-upload-probe.json`。

这说明持续上行受限；不另加一条 HTTP 文件回复通道来声称消除物理带宽瓶颈。协调者据此将目标调整为：≤2 KB 小图尽早显示（链路正常时约 <1 秒），≤40 KiB 预览在冷缓存约 4 秒量级，提前推送/重复打开接近即时；原图按实际大小传输并显示进度。RTT、重连和链路抖动仍会影响冷请求，不能将该目标写成无条件 SLA。

### 第二轮实现

- Worker sender 把文件 RPC 回复排到 bulk outbox/同步之前；bulk 帧按实际序列化 UTF-8 字节限制至 4 KiB，并通过协商的逐片 ACK 保持一个 bulk credit，避免一串小消息也填满内核队列。旧连接的 ACK 不推进新连接。可靠 outbox 保留原有顺序/确认/重放语义。
- Server 文件与原图使用有界四路流水线。原图首块及后续块为 4 KiB，尽早发元数据、每块 flush、禁用 nginx buffering；用户关闭原图后取消设备读取。只有完整成功的原图才进缓存，中途失败保留短 body 失败语义。
- Server 内存 LRU 上限 64 MiB/128 个对象，alias 五分钟；身份含 device、canonical path、inode/size/mtime revision，原图/预览/小图分别缓存。并发合并同一预览读取，限制并发数量。每次进入 Server 的 GET 在查缓存前校验工作区权限；HTTP `private, max-age=300, must-revalidate`、ETag、`Vary: Cookie, Authorization`，错误 `no-store`。显式重试绕过缓存。
- Worker 利用已安装 ffmpeg（macOS 可用 sips 回退），不安装工具：长边从 1000 px 逐步缩小，WebP quality 70 或 JPEG 回退，≤40 KiB；小于预算的源图原样返回，不放大。小图 ≤2 KiB。渲染最多两路、有界等待/内存和子进程时限，原文件不变，读取/render 后复核 revision。无法生成时预览允许回退原图，小图失败不传整张原图。
- byte-dev 已安装 `/opt/tiger/ss_bin/ffmpeg` 无 WebP encoder，实际 JPEG：114,996 B 图片缩到 27,974 B、小图 1,061 B；993,079 B 图片缩到 36,639 B、小图 1,049 B，转换约 32–127 ms。第一档 1000px/138KB 不能满足上行预算，已放弃。证据 `preview-size-probe.json`。
- daemon 在用户上传完成、Agent outbox 的 `<image path>`/附件路径出现后，按注册 workspace 范围排队预推送小图及预览。队列最多 32、单上传、去重及有限重试，只传衍生图，交互读取消上传并延后十秒。`POST /api/daemon/attachment-previews` 使用设备凭据，校验该设备的工作区、附件边界、MIME、gzip 解压后大小与两档预算。软链目录通过只读 realpath 映射回已注册工作区路径，不调用会改 workspace identity 的 `readWorkspace`。
- Web 先尝试小图，最多给它 400 ms head start，然后请求预览；两者不互相超时中止。预览标识及键盘入口可打开原图，原图/文件下载流式显示已接收/总字节；原图完整到达后下载按钮才可用，保存的是完整原始 Blob。保留一次自动重试、短原因、可见键盘重试和卸载取消。

### 第二轮检查及浏览器证据

Server 聚焦 cache/authz、ETag、push、pipeline、短 body、原图前缀 streaming/取消、文件下载与 daemon chunk 测试通过（`preview-server-release-final.txt`，34.302 秒）。该 artifact 含 DEV-050 storage snapshot 与 DEV-052 connector 修复，无新增迁移。Worker 46 项测试通过后补充了软链 inverse lookup 与路径归一，最终发布检查结果另见 `preview-worker-publish.txt`。Web tsc、11 UI audits、11 个针对图片/文件/流读取测试通过，最终 bundle 另纳入 DEV-053 两行中性代理文案。

真实 Chromium fixture（独立临时 profile、合成 HTTP 流）：light/dark × 1280/390 无 broken image/水平溢出；键盘 Enter 打开原图、Escape 关闭；原图 64 KB / 977 KB 进度可见，下载忙碌禁用；完整下载 1,000,000 B，SHA256 `526660a5d90e9d26a456889d7b434f43050d94866faa47560630a4c6c6c1812c` 与原始合成文件相同。重复挂载使用浏览器 private cache（请求数不增加，先前记录 1.4 ms）；这是合成性能证据，不冒充 byte-dev 真实用户请求。见 `preview-final-*.json`、`preview-ready-*.png`、`preview-original-progress-dark-390.png`、`preview-repeat-cache.json`、`original-download-hash.json`。

扩展 74 文件的 `check-changed --list` 计划见 `preview-check-plan.txt`。不再次整体运行会创建 Git commit 的 fixture；精确 deferred cases 与之前误执行的时间已在本文前节及 `deferred-git-fixtures.json` 记录。18:43 的去除六个 Git HTTP case 的广泛检查在约九分钟后，为释放共享锁给 DEV-053 而主动停止（仅停止自己的 go/test PID），不能称全包通过；聚焦检查随后通过。证据 `preview-safe-suite-stop.json`。module/contract audit 通过，当前 HEAD 保持不变。

### 第二轮已部署部分与安装回退

Server 候选已于北京时间 19:53:33 恢复健康：PID 1621514，安装/实际 `/proc/PID/exe` SHA256 均为 `5038b84cdeb8b9b000307ed5fb645049e1702098c5d012059fa9a6d786145de2`。前一 binary 以硬链接保存在 `~/.foundry/server/releases/dev051-chat-images/preview-previous/foundry-server`，复用 DEV-052 唯一 SQLite 在线备份；没有重复备份/迁移。公网 `/healthz` 仍是 Web SPA，健康结论来自本机 31982 JSON。Web `1792b54a13066032` 已部署，公网版本与六项入口 asset SHA 一致，含 DEV-053 最终中性代理文案。e2e-alice 只读上线 smoke：两档未知附件返回 404 + no-store，页面无横向溢出；不是实际用户附件成功证据。`preview-{server,web}-deployment.json`、`preview-production-smoke.json`。

Worker `.1793102069` 曾发布，十个关键模块的打包内容与 dist 逐字节核对；byte-dev 通过原 Devices self-update entry 安装时，其私有 npm registry 无法解析 DEV-053 新依赖 `socks@^2.8.10`（ETARGET），在 daemon 重启前安全失败。已立即将公网 manifest 原子恢复为 `.1793093010`，新旧 tgz 均保留（旧 manifest 和其两个 tgz 另保存在 `preview-previous/worker-packages`）。DEV-053 正在该设备的 registry 上修正并执行真实 install 验证；不能把候选已打包称为真实设备已加载。该次 compute 触发没有 Server update-tracking receipt，作为已知限制记录。

最终微调后的三组 Worker 专项 11/11 另有退出码 0 的确认（`preview-worker-check-receipt.txt`）；先前 pack wrapper 的143不被当成完整命令成功。软链路径归一的真实本地 HTTP push 测试另为 2/2，通过且不改写工作区身份（`preview-symlink-push-check.txt`）。小图先显示的真实截图与 DOM 观测见 `preview-tiny-placeholder.{png,json}`，主预览尚未 ready 时 tinyVisible=true。

补充回归：在静态核对所选测试未直接执行 commit/Accept/seal 后，排除三个已知 Git fixture 文件的 26 个 Worker 文件共 189/189 通过，退出码 0（`preview-worker-safe-regression.txt`，100.939 秒）。这包括可靠传输、daemon dispatch/link、执行宿主回放、原生聊天同步、workspace roster/软链边界，不能替代已列出的夜间 Git fixture gate。第二轮有 74 文件清单（`files.txt`），其中共享文件仅保留本项最小 hunks；未改动 DEV-053 的 control-connection/proxy 实现、DEV-050 transcript/storage 或 DEV-049 Popover 行为。

### 第二轮安装恢复、真实设备及大图回归

DEV-053 将直接 socks 声明放宽至 `^2.8.3`，在 byte-dev 实际 registry 上通过 prefer-offline 安装及生产 SOCKS 模块测试后，发布 `.1793102942`（打包 manifest 明确核对该范围，十个关键 JS 与 dist 相同，公网两个 tgz SHA 相同）。byte-dev 和 sg-chaos self-update 均 succeeded，Server 注册也实际报告该版本。byte-dev 新 daemon PID477384，忙碌执行宿主仍 PID1193234/dev.53；sg-chaos daemon PID1634587，忙碌宿主仍 PID1413767/.1793079469。没有强停宿主、没有修改真实设备代理配置；之前 9.953 GiB 的 sg-chaos 暂缓，协调者清理可丢弃缓存恢复约 12 GiB 后才更新。`preview-worker-fixed-deployment.json`、`preview-device-updates.json`、`preview-worker-install-recovery.json`。下述 renderer 修正将再发布最终候选，以上是中间版本的历史，不是最终验收。

用已安装 `.1793102942` 的只读 helper 复核真实文件：114,996 B → tiny 1,061 B/69.7 ms、preview 27,974 B/94.4 ms；Meego 190,467 B → 1,349 B/44.7 ms、36,519 B/136.5 ms；993,079 B → 1,049 B/105.1 ms、36,639 B/248.5 ms。三者原图 SHA 均不变，原图首块确为 4,096 B。原业务 JSON 15,915 B 完整读取 0.321 ms，哈希仍为此前记录；这些是设备磁盘/转换时间，不能替代公网 GET 时间。`preview-byte-installed-probe.json`、`preview-byte-final-update.json`。

安装后的预推送 helper 以真实 19,634 B 附件路径构造内存事件（不写用户会话），20:13:05/07 的两个 POST 均 204；分别为小图/预览，nginx request time 为 0.019/0.004 秒。`preview-byte-prepush-{probe.json,nginx.txt}`。这证明上传通路与边界校验，不能假称是用户真实 turn 自动触发的验收。

生产环境复用经 DEV-053 同意的 e2e-alice 合成工作区，只新增 `DEV051-production-preview-synthetic.png`，不运行模型或写真实会话。640×480 高噪声 PNG 为 1,057,794 B；首次完整检查暴露 ffmpeg 反复对同一原生尺寸编码，2.5 秒预算耗尽后错误回退为整张原图：preview GET 在 20:14:50 为 1,057,794 B/10.827 秒。不是性能通过。改为按已编码字节量估算下一档尺寸、读取 PNG 原生尺寸避免重复、限制 ffmpeg 线程；缺失、失败、超时的转换按源 revision/variant 做五分钟有界负缓存；小图失败快速跳过，主预览退回原图并使用既有 Server 缓存，避免同一大图被当作小图和预览传两遍，后续相同 revision 不重复启动失败的转换。新增大噪声与超时回归，build + 13/13 通过（`preview-adaptive-final-checks.txt`）。

刷新合成 daemon/空闲宿主后，真实浏览器通过公网 API 重新校验：

| 读取         |      字节 |            nginx rt | 浏览器完整读取 |
| ------------ | --------: | ------------------: | -------------: |
| 小图冷读     |       886 | 0.793 s（304 验证） |         853 ms |
| 预览强制冷读 |    19,558 |             2.106 s |       2,194 ms |
| 预览重复     |    19,558 |             0.028 s |       126.5 ms |
| 原图强制冷读 | 1,057,794 |             3.969 s |       4,069 ms |
| 原图重复     | 1,057,794 |      0.017 s（304） |       145.2 ms |

原图浏览器第一笔 reader 数据为 8,192 B/72.4 ms（Server 为 4 KiB chunk，浏览器合并，不将它称为单 chunk RTT）。最终原图 SHA `4f37e041f462c277454d7fbc66f9966c42f0a9fc7fee41a768c91d180f91d16a` 与上传源一致，private/ETag/Vary 头均核对。工作区完整文件下载相同 1,057,794 B、相同 SHA，677.6 ms，首 65,536 B/120.6 ms、Content-Disposition 正确、no-store，证明文件下载通路也通。证据 `preview-production-adaptive.json`、`preview-production-original-download.json`、`preview-production-render-before-after-nginx.txt`。这些时延来自 sg-chaos 的合成 Worker，经 DEV-053 本地代理，不冒充 byte-dev 的真实弱上行；byte-dev 用户请求的最终 before/after 仍待协调者/本人重新打开聊天后确认。

### 旧版 ffmpeg 与失败回退补验

在已安装 `.1793103861` 的 byte-dev 上继续实际调用发现 `-filter_threads` 是本机新 ffmpeg 支持、该设备旧 ffmpeg 不支持的选项，准确 stderr 为 `Unrecognized option 'filter_threads'`。移除这一可选参数，保留旧版实际支持的 `-threads 1`；同一旧工具命令已生成 1,061 B 小图。该兼容问题不能由本机新版 ffmpeg 的成功推断，也不能把 `.3861` 描述为最终弱链路验收通过。

协调者进一步要求缺失/任何失败的 ffmpeg 不反复拖慢请求。最终实现对转换失败做有界五分钟负缓存，ENOENT 工具发现也缓存（含 PATH）；源文件 revision 改变后重新计算。失败时小图快速结束，让主预览使用原图和既有 Server 缓存，避免把整张原图传两遍；首次尝试超时仍有原来的有界等待，后续同一 revision 不重复启动该失败转换。原图保持流式进度。补缺工具、超时、非零 encoder 失败回归，通过替换失败进程后检查其未被再次启动验证负缓存；既有高噪声预算/原文件不变测试继续保留。发布前将在 byte-dev 临时目录运行与待发布包逐字节相同的三文件 helper（不安装它、不修改设备运行代码），确认旧 ffmpeg 确实能生成两档，再发布。

Web/docs 的 34 文件 `check-changed` 已完成：Web tsc PASS、66 个 Web 测试文件 PASS（324.4 秒）、11 UI audits PASS；只因本记录新增段落未格式化而 prettier FAIL，最终文档格式化后单独复验并保留原失败记录。`preview-web-check-changed.txt`。没有以这次结果声称所有 74 文件综合 gate 通过；涉及 Git fixture 的精确延后范围保持前述记录。

## 最终兼容版发布与待验收范围（20:40）

最终 Worker 为 `0.5.7-dev.81.gac22cc1.local.1793104558`，`socks ^2.8.3`；公网 Worker tgz SHA256 `ebbf89c60213f6b8d5a86da80dbc7df3fdace39cffb0f2c0175aacf2b569855b`，Protocol `aafde628259a24447910064d1e66cf18fd49cb8b442e20ac411434c154dfe629`。12 个关键打包模块与当前 dist 相同；其中 image-previews/workspace-attachments/paths 三文件在发布前复制到 byte-dev 临时目录实际执行，SHA 与待发布 tarball 相同，原图 SHA 全部不变。旧 ffmpeg 真实结果：115 KB 图 tiny 1,061 B/54.8 ms、preview 27,974 B/60.5 ms；Meego 1,349 B/33.4 ms、33,650 B/88.7 ms；993 KB 图 1,049 B/94.6 ms、33,300 B/208.7 ms。缺 ffmpeg 原图回退初次 2.81 ms、重复 0.44 ms；失败 encoder 原图回退初次 7.31 ms、重复 1.23 ms，两次读取的累计 encoder 进程数均为 2，第二次未重试。失败小图跳过，主预览只传原图一次。

`preview-compatible-pack-checks.txt`：build/pack + 15/15 专项 PASS（含大图、no-upscale、超时/缺工具/失败 encoder 负缓存、传输优先/credit/软链推送）。详细证据 `preview-compatible-deployment.json`、`preview-byte-exact-helper-proof.json`、`preview-byte-failed-encoder.json`。发布后 byte-dev 实际安装模块再次 SHA 比对，仍一致；小图/预览为 1,061/27,974 B，转换 24.0/59.9 ms。

| 设备                   | 实际 daemon                | 实际 execution host               | 处理                                    |
| ---------------------- | -------------------------- | --------------------------------- | --------------------------------------- |
| byte-dev               | PID659103 / `.1793104558`  | PID1193234 / dev.53 `.1792641207` | 忙碌宿主保留，空闲时切换                |
| sg-chaos               | PID1651649 / `.1793104558` | PID1413767 / `.1793079469`        | 忙碌宿主保留，空闲时切换                |
| byte-dev-sg（DEV-053） | PID897396 / `.1793104558`  | PID897414 / `.1793104558`         | updater succeeded，doctor HTTP200/67 ms |

前两台的 Server 注册实际报告 `.1793104558`，不只核对安装 symlink；`preview-final-device-updates.json`。第三台由 DEV-053 的 compute receipt、`/proc` immutable entry 与 package version 核对，见 `../dev053/byte-dev-sg-compat-update.json`。所有真实设备代理配置未变；cottoncpp/MacBook/Mac mini 按既定名单跳过。Server 仍为 PID1621514/SHA5038b84c…、本机 health startedAt 11:53:33Z；Web 仍为 `1792b54a13066032`。保留 Server/Web 原入口与二进制；Worker 已知可用 rollback 为 `ultimate-previous/worker-packages` 的 `.2942`（manifest+两个 tgz），更早 `.3010` 也保留。`.3861` 有已发现的旧 ffmpeg 参数不兼容，不推荐回滚到该版。

浏览器/临时 vault 已关闭删除，本地 fixture32051 已确认端口关闭；byte-dev 临时三文件 helper 目录已清理、compute lease 已确认释放。DEV-053 的合成 proxy/daemon/宿主和浏览器也由其所有者确认停止；只保留一个明确标记的 DEV051 合成 PNG，未创建真实会话或运行模型。无需给用户账户另建 owner API 身份。

截至最后检查，真实用户 115 KB/Meego 图片的 nginx GET 仍停留在 17:39 旧请求；**没有把合成 Worker 或设备磁盘耗时冒充最终 byte-dev 公网 before/after**。该项继续等待本人/协调者重新打开真实聊天，记录两档 variant 的冷读与重复读。目标按 10 KB/s 上行现实调整为：小图尽早出现、≤40 KiB 预览约四秒量级（链路抖动另计），缓存/预推送后接近即时；原图完整传输显示进度。缺 renderer 时会用原图，无法承诺同样的预览字节目标。没有人工验收或授权 Agent 替代验收，故不标记问题已关闭。

验收步骤：刷新到当前 Web 后打开原 Meego 聊天及 115 KB 截图所在聊天，应先出现小图再变清晰，失败时有原因/一次自动恢复/可键盘重试；关闭并重开应快速复用缓存（浏览器命中时可能没有新 nginx 请求）；点开原图应显示已收字节，下载保存完整原图；打开 autorun JSON 引用应左对齐自然换行，文件面板显示内容并可完整下载。弱链路首次 GET/重复 GET 的具体时延及用户观感由协调者追加验收，不修改用户会话。
