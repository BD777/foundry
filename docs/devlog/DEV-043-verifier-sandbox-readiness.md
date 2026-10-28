# DEV-043 验证会话沙箱就绪检查

2026-10-26 15:17，用户反馈：linux-dev 上的验证会话 `sess_1792999060404452625`（父会话 `sess_1792995636907814138` 发起的只读复核）启动 2 秒即失败，错误为 “requires bubblewrap (bwrap); install it and enable user namespaces”。来源会话：`sess_1792999134370683044`。

## 调查结论

- 验证会话（`create_session` 带 `verification`）在 Linux 上必须运行于 bubblewrap 只读沙箱（`readonly_agent`）。linux-dev（veLinux 2 / Debian 12 系）未安装 `bwrap`，`sandbox/linux.ts` 启动时报错。
- 本应在派发前拦截：Worker 只有在 `sandboxAvailable("readonly_agent")` 为真时才声明 `verification_sessions`，Server `requireVerifierDevice` 据此拒绝。但 `sandboxAvailable` 只按平台静态判断（注释写明 “a backend may still be missing at launch”），不检查 `bwrap` 是否存在、能否创建 user namespace。因此缺 `bwrap` 的设备照常声明该能力，Server 接受，启动时才失败。
- Server 的拒绝文案只提“旧版 Worker”，对缺 `bwrap` 的情形有误导。

## 修复

- 设备：linux-dev 用 apt 安装 `bubblewrap` 0.8.0（该账号有免密 sudo，user namespace 原已可用）。与 Worker 启动时相同的探测命令通过。
- 代码：
  - `sandbox/types.ts`：`SandboxBackend` 增加可选 `ready()`。
  - `sandbox/linux.ts`：探测拆为 `bubblewrapExecutable` / `bubblewrapProbe`；`ready` 要求 `bwrap` 存在且探测通过，结果缓存 60 s（heartbeat 每 25 s 重算能力，能力变化时重新上报），装上 `bwrap` 后无需重启 Worker 即生效。
  - `sandbox/index.ts`：新增 `sandboxReady(kind)`；`sandboxAvailable` 保持静态语义（测试与 evidence 调用方不变）。
  - `workspace-ops.ts`（`verification_sessions` 能力）与 `diagnostics.ts`（`runtime.sandbox` 检查）改用 `sandboxReady`。
  - `apps/server/internal/httpapi/mcp_verification.go`：拒绝文案同时说明“Worker 较旧，或 Linux 上缺 bubblewrap / user namespace 不可用”，并给出 `sudo apt install -y bubblewrap`。

## 验证与部署证据

- 本会话失败的复核已由父会话重新发起为 `sess_1792999264159140615`，在 linux-dev 沙箱中正常完成（No findings）。
- `scripts/check-changed.sh` 对改动文件全部通过：prettier、gofmt、Worker 构建、21 个 Worker 测试文件、httpapi 编译、audit:contract/modules。`go test ./internal/httpapi -run Verif` ok。新增 `sandbox.test.mjs` “Linux readiness requires a bwrap that can create namespaces”（本机有 `bwrap`，断言 ready 与实际探测一致）。缺 `bwrap` 的分支没有自动化覆盖，靠代码审阅。
- 部署（与 DEV-044 external connection 合并发布，由 `sess_1792995418158071510` 执行）：
  - Server：PM2 `foundry-server` PID 752972，加载 `releases/dev023-candidate/foundry-server`（SHA256 `8975a93b…31086`，与 `/proc/752972/exe` 一致），二进制含新拒绝文案；`/healthz` ok（startedAt `2026-10-26T07:31:20Z`）。
  - Worker：发布 `0.5.7-dev.81.gac22cc1.local.1792999441`；包内 `dist/sandbox/index.js`、`workspace-ops.js`、`diagnostics.js` 含 `sandboxReady`，`sandbox/linux.js` 与本地构建逐字节一致。
  - 随后合并发布更新为 Worker `0.5.7-dev.81.gac22cc1.local.1793000734`（dev `release.json`，含本修复与 DEV-044 external connection）；包内 `sandbox/index.js`、`workspace-ops.js` 已复核含 `sandboxReady`。linux-dev-3 daemon 已按标准 updater 更新，其 execution host 因后台进程保留旧版（`sess_1792995418158071510` 告知）。
  - Web：不涉及。
  - 设备 Worker 更新：linux-dev 仍为 daemon `0.5.7-dev.57`、执行宿主 `0.5.7-dev.53`，且有运行中的会话；linux-dev 已装 `bwrap`，本修复对它不再是必需，未为此强制更新。各设备随常规 Worker 更新获得此修复。
- 代码未提交：用户限定 git 操作时段为北京时间 22:00 至次日 9:00，改动留在 `main` 工作树。

## 人工验收

待确认。建议：在一台未安装 `bwrap` 的 Linux 设备（已更新到 `0.5.7-dev.81` 及以上）的工作区发起 `create_session` + `verification`，应在创建时被拒绝并提示安装 bubblewrap；`foundry-worker doctor` 的 `runtime.sandbox` 显示 warn。安装后约 1 分钟内无需重启即可发起验证会话。

## 提交

- 2026-10-27 夜间窗口经 PR #150 合并到 main（merge `60496ca`），本事项一个提交；多事项共用文件随最后改动它的事项提交。CI 首轮暴露的 Node 22 / 无 Claude CLI / 测试竞态问题在同一 PR 内修复。
