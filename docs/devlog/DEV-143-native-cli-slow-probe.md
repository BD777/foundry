# DEV-143 启动慢的 Claude Code 被报成“未安装”

## 问题

2026-11-06 本人：会话 `sess_1793895611867661522`（CanWendeMac-mini，AsterGate · kiro/claude-opus-5-5）输入框提示 “Unavailable on this device: Claude Code is not installed on this device.”。该会话当天一直在跑。

## 调查

- dev 数据库：Mac mini 的 `claude_local` 为 `unavailable`，`statusDetail` 是“Claude Code is not installed on this device…”（04:48 UTC 的读数）；同机的 `limen_default`、`codex_local` 正常。
- 通过 compute 租约在 Mac mini 上实测：Foundry 管理的 `2.1.311`（`~/.foundry-tools/agent-runtimes/claude/2.1.311-sdk-0.3.318`，276 MB 的 `claude.exe`）和 `~/.local/bin/claude`（2.1.294）都能输出版本。首次 `--version` 用了 8.5 s 和 4.2 s，第二次 0.04 s 和 0.8 s；当时负载 9–10。
- 根因：`resolveDeviceCommand`（`packages/worker/src/harness/native/native-cli.ts`）对每个候选程序跑 `--version`，10 s 超时；超时与“程序不存在”一样处理。机器忙时冷启动超过 10 s，所有候选都超时，设备就报“未安装”，所有用该运行时的 profile 都变为不可用，直到下一次探测恰好够快。

## 修复

- 程序启动了但没在时限内回答，算“在、只是慢”，不算未安装：先按已安装返回，版本由后台探测补上（后台时限为首次的 6 倍，60 s）。
- 后台探测仍超时时保留之前的结果；只有程序真的不存在（启动失败、退出码非 0）才报未安装。
- 测试：`native-cli.test.mjs` 新增“回答慢的程序仍是已安装，版本随后读到”“不存在的程序仍是未安装”，9/9 通过。

## 验收步骤

1. Worker 更新后打开该会话。预期：输入框不再出现“Claude Code is not installed”，可以发送。
2. 设备页 CanWendeMac-mini → Claude Code。预期：显示已安装及版本。

## 后续：登录状态检查同样把“慢”当“失败”

### 现象

Worker `0.5.7-dev.303.g1837af21.local.1793945903` 上线到全部 7 台设备后，Mac mini（`dev_d783b240-ed8a-404d-96ba-2f7266363d4b`）的 `claude_local` 仍为 `unavailable`，`statusDetail` 变成 “The native CLI status check did not complete. Retry after checking the device.”。版本探测已正常，问题出在下一步的登录状态检查。

### 调查

- 代码：该文案只在 `packages/worker/src/harness/native/native-login.ts` 的 `loginHealth` 里出现。它用 `spawnSync` 跑 `claude auth status --json`（Codex 为 `codex login status`），`timeout: 5000`；超时时 `result.error.code === "ETIMEDOUT"`，落进 `if (result.error)` 分支，与“启动失败”同样报 `unavailable`。结果缓存 60 s，过期后再同步跑一次，每次最多阻塞 Worker 事件循环 5 s。
- 设备实测（compute 租约，2026-11-06 16:37–16:41 CST，Worker 实际使用的 `~/.foundry-tools/agent-runtimes/claude/2.1.311-sdk-0.3.318/cli/node_modules/.bin/claude`，环境与 `nativeLoginEnvironment("claude")` 相同；负载 11–12，空闲内存约 64 MB）：

  | 命令                                                                                       | 耗时                     |
  | ------------------------------------------------------------------------------------------ | ------------------------ |
  | `claude auth status --json` 首次                                                           | 18.42 s                  |
  | 紧接着第 2、3 次                                                                           | 0.19 s、0.10 s           |
  | 空闲约 2 分钟后                                                                            | 6.18 s                   |
  | 紧接着再一次                                                                               | 1.53 s                   |
  | `claude --version`（已热）                                                                 | 0.01 s                   |
  | Codex（ChatGPT.app 内 `codex-cli 0.163.0-alpha.11`）`--version` / `login status` 首次 / 热 | 0.44 s / 1.27 s / 0.04 s |

  内存紧张时 236–276 MB 的 `claude.exe` 很快被换出，每 60 s 一次的 5 s 检查经常超时，所以状态一直是 `unavailable`。Codex 足够快，未受影响。

- 同一模式的其他调用：账户检查 `inspectNativeAccount("claude")`（`native-inspection.ts`）同样跑 `auth status --json`，15 s 超时，冷启动 18 s 也会超时；另外它用 `promisify(execFile)`，退出码非 0 即抛错。实测未登录时 `auth status` 退出码为 1 且照常输出 JSON，所以“未登录”也被报成 “The native account check did not complete.”。
- 另一事实：该 Mac 上 Claude Code 没有官方登录（`auth status` 返回 `loggedIn: false, authMethod: "none"`；`~/.claude.json` 无 `oauthAccount`，钥匙串无 `Claude Code-credentials`）。该机会话走的是 AsterGate 网关（`kiro/claude-opus-5-5`）。所以修复后 `claude_local` 的正确读数是 `missing_auth`（“No official login…”），而不是 `healthy`。

### 修复

- `native-cli.ts`：导出 `probeTimeouts(blocking)` 与 `timedOut(error)`，版本探测与状态检查共用：阻塞的首次探测分别为 10 s / 5 s，后台探测 60 s；测试用 `FOUNDRY_CLI_PROBE_TIMEOUT_MS` 缩短。
- `native-login.ts`：
  - 状态命令启动了但超时（或被信号结束）算“没有回答”，不改变状态：保留该命令上一次的回答，并在后台用 60 s 时限重读；从未回答过时报“still reading its login status”，不再说“did not complete”。
  - 只有真正的结果才改变状态：无法启动（`ENOENT` 报安装提示，其他错误仍为 “did not complete”）、明确的已登录/未登录回答。
  - 缓存过期后先返回旧读数、后台刷新，不再每 60 s 阻塞 5 s；后台结果与之前不同则 `loginRevision` 加一，设备在下一次心跳重新上报。登录/登出触发的清除使进行中的后台结果作废。
- `native-inspection.ts`：Claude 账户检查是异步的，时限改为后台时限 60 s；`auth status` 退出码非 0 但输出了 JSON 时按其回答处理（未登录 → `not_signed_in`）。
- 未改动：Codex 账户检查经 app-server（每步 25 s，非一次性探测，实测 Codex 很快）；运行时更新流程里的 `--version`（15 s，更新校验，失败只影响更新）；飞书 CLI 版本探测（不属于 Claude/Codex）。

### 测试

- `native-cli.test.mjs` 新增“回答慢的登录状态保留上次回答并在后台重读”（从未回答 → still reading → 后台读到 healthy 且 revision 增加；已回答过 → 慢时保持 healthy → 后台读到 missing_auth；快速的明确回答立即生效）和“无法启动的状态命令仍报原因”。
- `native-inspection.test.mjs` 新增“未登录的 Claude 账户读作未登录”。
- 新测试在旧代码上失败 2 项、新代码上通过；`native-cli`、`native-login`、`native-inspection`、`native-sign-in` 30/30 通过；相关的 `diagnostics`、`native-quota`、`connection-reports` 等 11 个文件 87/87 通过（`connector-extensions` 一个用例在并行全跑时偶发失败一次，单独与再次全跑均通过，与本改动无关）。

### 验收步骤

1. Worker 更新后打开设备页 CanWendeMac-mini → Claude Code（本机登录）。预期：不再出现 “The native CLI status check did not complete”；因该机无官方登录，显示未登录（No official login…），而不是不可用。
2. 同机用 AsterGate 网关的会话照常可发送。
3. 在有官方登录的设备上，设备页 Claude Code 仍为已登录并显示账户。

- 2026-11-06 17:05 UTC+8（编排）：后续修复应用到 dev 工作区，工作区内 `native-cli`、`native-login`、`native-inspection`、`native-sign-in` 30/30 通过；打包 Worker `0.5.7-dev.303.g1837af21.local.1793955674`（回滚 `worker-packages-rollback/before-dev143b`），先经计算租约更新 CanWendeMac-mini（`Updated … → …1793955674 and restarted the worker`）。更新后 `list_profiles`：`claude_local` 为 `missing_auth`「No official login in the worker's ~/.claude configuration…」——这台机器确实没有 Claude 官方登录，不再误报为 `unavailable`；同机 AsterGate、Limen 等 profile 仍是 `healthy`。当时负载 10–11，主要来自 6 个已运行 3 天 20 小时的 Microsoft Edge 渲染进程（各 60–87% CPU）。其余 6 台设备与 DEV-144 的 Worker 改动合并为一次更新。
