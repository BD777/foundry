# 实机回归：环境与用例

[文档索引](README.md) · [会话模型](session-model.md) · [Session 编排](session-orchestration-design.md)

单元测试和 `pnpm verify` 验证代码本身；这里的用例用**真实 Agent、真实 Worker、真实网络**验证
端到端行为。改动会话模型、编排、派发、Worker 执行或 Web 聊天记录时，合并前按下表回归，并把
结果写进 PR（不写进本文件）。

## 1. 环境

| 代号                 | 组成                                                                                               | 用途                                               | 准备                             |
| -------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------- |
| **L-iso** 隔离栈     | 本机新起的 Server（独立 DB）、Worker（独立 `HOME` 与 state root）、Vite（仅回环）                  | 改动未合并时的实测、Web 页面检查、需要杀进程的用例 | 见 §4.1                          |
| **L-dev** dev 服务器 | dev.foundryapp.app + 服务器上的 `e2e-alice` Worker（`FOUNDRY_STACK=e2e-alice`，工作区 `alice-ws`） | 合并部署后的回归；唯一带 Codex 的环境              | Claude 与 Codex 在服务器上已登录 |
| **M-dev** Mac 真机   | 用户 Mac 上的 `dev` stack Worker（`FOUNDRY_STACK=dev`）连 dev.foundryapp.app，profile `cc_relay`   | macOS 行为、跨设备派发、中转 profile               | SSH 隧道与 CC Relay，见 §4.2     |

原则：用例通过设备凭据以**设备所有者**身份调用 Server（`scripts/live-session-regression.mjs`），
不需要任何人的登录密码；模型请求一律经过 Worker 的 Agent 运行时，脚本不直接访问模型服务。

## 2. 用例

`脚本` 列为 `scripts/live-session-regression.mjs` 的 case 名；`手工` 表示需要浏览器或进程控制。

| #   | 用例                                  | 验证点（断言）                                                                                                                                                                                                | 覆盖                                                        | 方式                                                                                                     | L-iso | L-dev | M-dev      |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----- | ----- | ---------- |
| C1  | 同一会话两次输入                      | 同一会话 id、同一原生会话、第二次答出第一次的暗号、聊天记录含两条输入                                                                                                                                         | 会话模型、续聊、原生 resume                                 | 脚本 `two-inputs`                                                                                        | ✔     | ✔     | ✔          |
| C2  | 运行中 steer                          | 回答包含 steer 内容；steer 不产生新输入                                                                                                                                                                       | `/messages` 运行中分支、Claude steer                        | 脚本 `steer`                                                                                             | ✔     | ✔     | ✔          |
| C3  | 取消后继续                            | 取消得到 `canceled`；再发消息仍记得上下文                                                                                                                                                                     | 取消只作用于当前输入、取消不回退到 CLI                      | 脚本 `cancel-continue`                                                                                   | ✔     | ✔     | ✔          |
| C4  | 编排：后续输入管理先前派出的子会话    | 子会话记录父会话、沿用父会话 profile；第 2 次输入能取消它；第 3 次输入能 `send_message` 继续它，子会话是一个会话两次输入                                                                                      | 同 Workspace 权限、血缘只作记录、MCP 注入、profile 选择     | 脚本 `orchestration`                                                                                     | ✔     | ✔     | ✔          |
| C5  | handoff 接替者接管                    | 接替者能控制不是自己派出的会话                                                                                                                                                                                | 权限不依赖血缘、`handoff_session`                           | 脚本 `handoff`                                                                                           | ✔     | ✔     | ✔          |
| C6  | 切换 runtime                          | 同一会话换到 Codex、原生会话更换、靠导入上下文作答                                                                                                                                                            | 输入切换 runtime、导入上下文                                | 脚本 `runtime-switch`（需 `--codex-profile`）                                                            | ✔     | ✔     | — 无 Codex |
| C7  | Web：两次问答显示                     | 页面显示两次问答与两个回答；轮次导航计数正确；自动标题只生成一次                                                                                                                                              | 事件构成聊天记录、回答事件按输入命名                        | Web 脚本 `conversation`                                                                                  | ✔     |       |            |
| C8  | Web：排队后 steer                     | 运行中输入进入队列；点「Steer this message」后回答包含它                                                                                                                                                      | Web 队列与 `/messages`                                      | Web 脚本 `queued-steer`                                                                                  | ✔     |       |            |
| C9  | Web：切换 agent 继续                  | 分隔线「Profile 从 … 切换为 …」；新 runtime 答出之前的内容                                                                                                                                                    | Web 导入上下文                                              | Web 脚本 `agent-switch`（需 `--codex`）                                                                  | ✔     |       |            |
| C10 | Worker 崩溃恢复                       | `kill -9` Worker 后，旧输入的完成标记不会结束当前输入；取消孤儿输入不影响下一条；继续仍有原生上下文                                                                                                           | 按输入存放产物、按输入排队取消                              | 手工（需杀进程）                                                                                         | ✔     |       |            |
| C11 | 设备可见性                            | 所有者只看到自己的设备与工作区                                                                                                                                                                                | 访问控制                                                    | 脚本外：`GET /api/devices`、`/api/workspaces`                                                            |       | ✔     | ✔          |
| C12 | macOS 测试套件                        | `pnpm --filter @foundry/worker test`、`pnpm verify` 在 Mac 上通过（含 Seatbelt 沙箱）                                                                                                                         | macOS 平台差异                                              | 在 Mac 上执行                                                                                            |       |       | ✔          |
| C14 | 编排者 steer 运行中的子会话           | 父会话经 `send_message` 给运行中的子会话追加要求，子会话回答包含它、没有变成新输入，父会话经 `wait_session` 观察到                                                                                            | 编排中的 steer 与观察                                       | 脚本 `steer-child`                                                                                       |       | ✔     | ✔          |
| C15 | 只读 verifier                         | `verification=true` 的子会话来源为 `verification`，写文件的尝试失败，工作区中没有探针文件                                                                                                                     | verifier 只读                                               | 脚本 `verifier`（需在工作区所在设备运行）                                                                |       | ✔     | ✔          |
| C13 | Codex 作为编排者                      | C1、C4、C5 以 Codex profile 运行（`--profile codex_local`），子会话沿用 Codex                                                                                                                                 | Codex 工具注入与预先放行                                    | 脚本 `two-inputs,orchestration,handoff`                                                                  | ✔     |       |            |
| C16 | 附件存放在设备上                      | 上传落到工作区所在设备的 `.foundry/attachments`；作为续聊输入的附件发给 Agent，Agent 看得到（纯红图答 `red`）；附件记录在对应输入上；设备与 Server 不同机时经 `/api/local-files/image` 读回的字节一致         | 设备通道分块传输（M3-1）、续聊附件                          | 脚本 `attachment`；读回字节为手工                                                                        |       | ✔     | ✔          |
| C19 | Worker 重启后的孤儿输入               | 运行中 `kill -9` Worker 并重启：输入在重连后数秒内以"结果丢失"失败（不是 30 分钟）；再发消息能续上原生上下文                                                                                                  | `recover_session`、无标记即丢失                             | 脚本 `worker-restart`（需 `--kill-worker`；Worker 由 launchd/systemd/pm2 拉起，或给 `--restart-worker`） | ✔     | ✔     | ✔          |
| C20 | 完成但回报丢失的输入                  | 停掉 Server，输入在 Worker 上跑完写下完成标记，再 `kill -9` Worker；Server 与 Worker 重启后，输入以标记里的回答完成                                                                                           | `recover_session`、按输入的完成标记                         | 手工（需杀进程）                                                                                         | ✔     |       |            |
| C21 | 子 Agent 跨输入读取                   | 第 1 次输入用 Task 工具派出原生子 Agent（答 `MANGO-7`），第 2 次输入之后 `read_context scope=subagents` 仍列出它，带 `taskId` 读出的记录包含它的回答                                                          | 按输入存放产物、子 Agent 记录                               | 脚本 `subagents`（Claude）                                                                               |       | ✔     | ✔          |
| C18 | 跨 Workspace 编排（§5.6 方案 A）      | `list_workspaces` 列出同一人的两个 Workspace；`create_session` 指定另一 Workspace 后子会话记录父会话、落在该 Workspace 的设备上、不进父会话分组、沿用父会话 runtime；父会话下一次输入能 `send_message` 继续它 | Agent 可达范围（`agentScope`）、跨 Workspace 血缘           | 脚本 `cross-workspace`（需 `--other-workspace`、`--other-state-root`，两台设备凭据都在本机）             | ✔     |       |            |
| C22 | 用设备上的浏览器截图给人看（M3 验收） | 提示里不给路径："截图 example.com 给我看"；Agent 用设备已装的浏览器截图，回答里的 `<image path>` 在工作区附件目录中，经设备通道读回的是 PNG                                                                   | Worker 运行时探测浏览器、会话设备说明、默认权限不挡设备软件 | 脚本 `device-browser`                                                                                    |       | ✔     | ✔          |

最近一次全部通过：2026-09-28（L-iso：C1–C10、C13、C17、C19、C20；L-dev：C1–C6、C11、C14–C16、C19、C21、C22；M-dev：C1–C5、C11、C12、C14–C16、C19、C21、C22）。

## 3. 覆盖缺口（待补）

- **飞书续聊**：改为给同一会话发消息，尚未实测。
- **Issue 沙箱会话在 macOS 实机运行**：沙箱单元测试已在 Mac 通过，端到端 Issue 执行留待 M4。
- **间歇性断线（2026-09-28 00:21 前后，未定位）**：一次全量回归中，dev 服务器上的 Worker
  （本机回环连接）与 Mac（公网）在同一时段各断开一次，正在运行的 `attachment` 输入因
  Claude SDK 空闲超时失败；重跑全部通过。当时 Server 断开设备连接不记原因，现已记录断开
  原因、耗时超过 10 秒的设备消息，以及 Worker 端的关闭码，再出现时据此定位。
- C10、C20 仍是手工步骤（需杀进程或停 Server）；C19 已有脚本用例，但会杀掉该设备的 Worker，只在显式 `--kill-worker` 时运行。

## 4. 准备与运行

### 4.1 L-iso 隔离栈

用临时目录 `S` 存放 DB、`HOME` 与 state root，互不影响正在运行的服务：

```bash
cd apps/server && go build -o $S/foundry-server ./cmd/foundry-server
PORT=42982 FOUNDRY_DB_PATH=$S/data/foundry.db FOUNDRY_WEB_ORIGIN=http://127.0.0.1:42983 $S/foundry-server
VITE_API_BASE_URL=http://127.0.0.1:42982 npx vite --port 42983 --strictPort --host 127.0.0.1   # apps/web
HOME=$S/home FOUNDRY_STATE_ROOT=$S/state FOUNDRY_CLAUDE_BIN=$(readlink -f $(command -v claude)) \
  node packages/worker/dist/cli.js connect --server http://127.0.0.1:42982 --workspace $S/ws
```

C18 需要同一账号的第二台设备：以 `FOUNDRY_STACK=iso2`、独立 state root 与工作区再配对一个 Worker
（同一台机器上不设不同的 `FOUNDRY_STACK` 会得到相同的机器指纹，配对会轮换第一台设备的凭据）。

首次需在 `$S/home` 放入测试用的 Agent 登录（复制本机 `~/.claude/.credentials.json`、
`~/.codex/auth.json`），并配对 Worker。结束后按端口的 PID 停止进程（`pkill -f` 会匹配到发起
命令的 shell 本身）。

### 4.2 M-dev Mac 真机

1. 用户在 Mac 终端粘贴临时隧道命令：以用户身份起一个只监听 `127.0.0.1:2222`、只接受服务器公钥
   的 sshd，并 `ssh -R 2222:127.0.0.1:2222` 连到服务器；Ctrl+C 即全部撤销。不开启系统远程登录。
2. 服务器侧：`ssh -p 2222 <mac 用户>@127.0.0.1`。
3. `dev` stack：`FOUNDRY_STACK=dev foundry-worker setup --token <windeng 的配对令牌> --server https://dev.foundryapp.app --workspace ~/foundry-dev-workspace`。
4. CC Relay profile 写入 `~/.foundry-stacks/dev/agent-profiles.local.json`，取值来自用户 shell 的
   `ccrelay`，不在 Mac 上登录 Claude 或 Codex。访问中转需要用户开着 CorpLink。

### 4.3 运行脚本

Web 用例（C7–C9）用 `scripts/live-web-regression.mjs`，经 agent-browser 操作真实页面：

```bash
FOUNDRY_WEB_URL=http://127.0.0.1:42983 FOUNDRY_WEB_USERNAME=<账号> FOUNDRY_WEB_PASSWORD=<密码> \
  node scripts/live-web-regression.mjs --workspace <id> [--codex]
```

期望的回答都是算出来的 `ANSWER-<n>`，不会出现在问题原文或页面上的 id 里，所以匹配只能
来自 Agent 的回答。

API 用例：

```bash
# L-dev（服务器上）
FOUNDRY_STACK=e2e-alice node scripts/live-session-regression.mjs \
  --profile claude_local --codex-profile codex_local --workspace <alice-ws 的 id>
# M-dev（Mac 上）
FOUNDRY_STACK=dev node scripts/live-session-regression.mjs --profile cc_relay
```

脚本逐个用例输出 ✔/✖ 与证据，全部通过时退出码为 0。它会真实调用模型并执行 `sleep` 等
Bash 命令，每轮约 3–5 分钟。
