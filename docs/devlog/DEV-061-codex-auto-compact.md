# DEV-061 Codex 会话没有自动 compact，撞满上下文后卡死

合并：2026-10-28 夜间窗口经 PR #154 合并到 main（分支 `release/dev054-068`，本事项单独提交，共用文件在 shared wiring 提交）。

## 状态

| 环节                | 状态   | 说明                                                                                                                                   |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 问题理解/调研       | 已完成 | 只读：原生 rollout、端点 `/models` 目录、Codex 0.164 源码                                                                              |
| 代码                | 已完成 | 仅 Worker（`packages/worker`）；Server/Web 未改                                                                                        |
| dev Server/Web 部署 | 不涉及 | 无 Server/Web 改动；Web 上下文计量已用 Codex 自报的窗口                                                                                |
| Worker 更新         | 进行中 | 联合 Worker `0.5.7-dev.104.g4d184b2.local.1793172116` 已发布；用户 Linux 开发机 daemon 已加载，执行宿主仍为旧 dev.53（忙，空闲后切换） |
| Agent 自验          | 已完成 | 单元测试 + 真实 Codex 0.163 app-server 对本地 mock 端点的端到端测试                                                                    |
| 人工验收            | 待确认 |                                                                                                                                        |

## 问题

用户 2026-10-28：“sess_1793108134561127918 看看这个，他没有自动compact吗？”该会话（Codex，兼容端点 profile，模型 `flux/gpt-6-astra`）从 2026-10-28 03:49 起连续 5 个回合失败，错误均为 “Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.”

## 调查

### 数字对比

| 来源                                                                  | 值                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 端点 `/models` 目录行                                                 | `context_window` 1,048,576，`max_context_window` 1,048,576，`max_input_tokens` 996,147       |
| Foundry 解析的窗口（来源 `endpoint`）                                 | 1,048,576 → 写入 `model_context_window` 和托管模型目录 `context_window`/`max_context_window` |
| Codex 自报 `model_context_window`（95% 可用，即硬上限）               | 996,147；Web 侧栏显示的 “1M” 就是这个数                                                      |
| Codex 自动 compact 阈值（`auto_compact_token_limit()` = 窗口 × 9/10） | 943,718                                                                                      |
| Codex 自带目录中 `gpt-6-astra`                                        | `context_window` 272,000，`max_context_window` 872,000                                       |
| 最后一次成功请求                                                      | 输入 921,372，合计 923,493                                                                   |
| 第一次被拒的请求                                                      | 上一项 + 一次 45 秒 sleep 工具的极小输出，约 923.5K                                          |
| 同一端点目录里的 `GPT-6.1-Sol`                                        | `context_window` 921,600                                                                     |

端点实际接受的输入在 921,372 到约 923.5K 之间截止，与 921,600（= 1,048,576 − 126,976）吻合：端点报告的是总窗口（输入 + 预留输出），不是输入上限。未发送任何推理请求验证，结论来自目录元数据和 rollout。

### 根因

1. **阈值高于真实上限。** Codex 按 “窗口就是输入上限” 计算，在 943,718 才 compact；端点在约 922K 就拒绝。会话每回合约 575K 起步、逐步增长，到 921K 时还没到阈值，下一次请求直接被拒。rollout 中没有任何 `compacted` 记录。
2. **被拒后 Codex 永远不再 compact（Codex 0.164 缺陷）。** 普通回合遇到 `ContextWindowExceeded` 时，Codex 只调用 `set_total_tokens_full` 后结束回合，不 compact，也不重试（`core/src/session/turn.rs`；只有 guardian 预算模式才 compact）。`fill_to_context_window` 把 `last_token_usage.total_tokens` 设为 `max(0, 窗口 − 累计总量)`；本线程累计 179,653,422，结果为 0（rollout 中失败后的 `token_count` 即为 last 0 / total 996,147）。下一回合的预检 `get_total_token_usage()` 以 last 为基数，估出的活跃上下文约等于 0，`token_limit_reached` 为假，不触发预检 compact，整段历史再次发出、再次被拒。之后 4 次重试都在 10–15 秒内以同一错误失败。
3. 兼容端点（自定义 provider）不支持远端 compact，走本地 inline compact；它在溢出时会从最早的条目开始逐条裁剪后重试（`core/src/compact.rs`），所以手动 compact 能在已超限的历史上完成。

### Codex 自动 compact 的触发方式（0.164）

- 阈值：`model_auto_compact_token_limit`（可配置，但会被钳到 ≤ 窗口 × 90%），默认窗口 × 90%；范围默认 `Total`。
- 硬上限：窗口 × `effective_context_window_percent`（95%）。
- 触发点：回合开始前（预检）和每次模型响应后（回合内）；被端点拒绝时不触发。
- 手动：app-server `thread/compact/start`，以普通回合的形式运行（`turn/started` … `turn/completed`）。

Foundry 原来只传 `model_context_window`（兼容端点另带托管模型目录，`auto_compact_token_limit: null`），没有设置 compact 阈值。

### Claude 运行时

Claude Code 在接近窗口时自动 compact，阈值已扣除输出预留和缓冲（`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 只是窗口，compact 点由 CLI 自己留余量），不存在 “总窗口当输入上限” 的同类问题；本次未改。若端点报告的窗口本身大于实际值，仍可通过个人窗口设置纠正。

## 修复（Worker）

1. `context-window.ts` / `runner/codex-options.ts`：兼容端点连接额外写入 `model_auto_compact_token_limit` = 窗口 × 80%（1,048,576 → 838,860，低于 921,600）。官方登录不变，沿用 Codex 自带目录的阈值。
2. `runner/codex-app-server.ts`：回合以 `contextWindowExceeded`（或同义错误文本）失败时，Worker 不立即报失败，而是：
   - 发一条 commentary 告诉用户 “上下文已满，正在用 Codex 自己的 compact 压缩并继续一次”；
   - 调用 `thread/compact/start`，等这次 compact 回合完成；
   - 发起一次续接回合，输入为固定续接提示（附带工作上下文）。用户原消息在失败前已记入线程并在 compact 中保留，不再重复发送；
   - 只恢复一次：compact 失败、无法启动、或续接后再次溢出，都以可见错误结束，不循环，不丢历史。

## 验证

- `node scripts/run-worker-tests.mjs -- codex-app-server.test.mjs`：16 通过，其中新增 4 个 fake app-server 用例（compact 后续接、续接再溢出、compact 失败、compact 被拒）。
- 真实 Codex 0.163 app-server 对本地 mock Responses 端点（不接触任何 provider）：第 1 次请求以流式 `response.failed`/`context_length_exceeded` 拒绝 → Worker 调 `thread/compact/start` → 第 2 次请求为 compact 摘要 → 第 3 次请求是续接，包含摘要和续接提示，原请求在历史中只出现一次 → `turn.completed`。用 `TEST_CODEX_CONTEXT_BIN=$(which codex)` 启用该门控用例。同一用例的线程配置带 `model_auto_compact_token_limit`，Codex 正常接受。
- `context-window.test.mjs`：兼容端点得到 `model_auto_compact_token_limit` 697,600（872,000 × 80%）。
- `scripts/check-changed.sh --files …`：prettier、worker build、13 个 worker 测试文件全部通过。

## 限制

- 端到端测试用的是本机 Codex 0.163；0.164 的行为只做了源码核对（触发逻辑相同）。
- 80% 是经验余量：覆盖 “总窗口 ≈ 输入 + 约 12% 输出预留” 加回合内单次工具输出的增长。若某端点余量更小，可用个人窗口设置调低。
- 已溢出的线程在 inline compact 时会先发出接近满窗口的请求，再从最早条目逐条裁剪重试，第一次恢复可能需要几次大请求。
- Worker 尚未发布：发布要求磁盘 ≥ 10 GiB。

## 恢复 sess_1793108134561127918

推荐方案 A。理由：续接用的是 Codex 自己对完整线程（约 3,500 个事件）做的摘要，比从外部写的 handoff 摘要更完整；原生线程和会话身份不变；同时在真实会话上验证本修复。方案 A 需要 用户 Linux 开发机 的执行宿主切到新 Worker（宿主只在空闲时切换），短期内切不过去时用方案 B。

方案 A（新 Worker 生效后）：

1. 确认 用户 Linux 开发机 的执行宿主已加载新版本：看宿主进程 `/proc/<pid>/exe` 和 `/proc/<pid>/cwd` 指向的 Worker 版本目录，不能只看安装的 symlink。
2. 给该会话发一条简短消息，例如 “继续上次的任务”，或者用户真实的下一个问题。
3. 预期：第一次请求被端点拒绝；会话里出现 commentary “The model's context window is full. Foundry is compacting this thread with Codex's own compaction and will continue once.”，随后是一个上下文压缩项和续接回答。原生 rollout 新增 `compacted` 记录，之后的 `token_count` 大幅下降；后续回合按 80% 阈值（838,860）提前 compact。
4. 代价：线程已超限，inline compact 会先从最早条目逐条裁剪再重试，预计 1–3 次接近满窗口（约 92 万 token）的请求，再加一次摘要请求。
5. 若以 “compacting the thread did not complete” 或再次 “ran out of room” 结束，改用方案 B，不要反复重试。

方案 B（立即可用）：用 `handoff_session` 把该会话交给新会话，prompt 中写明未完成的任务、关键文件和决定；新会话从新的原生线程开始。不推荐原生 `/compact`：它要求设备上的 Codex 配有该线程所用的 Foundry 托管 provider。

本条目未操作该会话，由编排会话向用户提出。

## 与 DEV-057 的代码边界

`packages/worker/src/runner/codex-app-server.ts` 中属于 DEV-061 的部分：

- `CodexAppServerThread` 类之前的新导出 `codexContextWindowExceeded`、`codexCompactionNotice`、`codexCompactionContinuation`；
- `runStreamed` 中 `lastCompactRefresh` 之后的 `recovery` 状态和 `fail` 辅助函数；
- compact 通知分支开头的 `if (recovery === "compacting") return;`；
- `turn/completed` 分支中、`active.terminal = true` 之前的两段恢复逻辑（开始 compact、compact 后续接）。

`session-control.ts` 未改。测试：`test/codex-app-server.test.mjs` fake app-server 中的 `overflow*` 模式和文件末尾的 5 个用例。

## 流水

- 2026-10-28：调查完成（rollout、目录、Codex 0.164 源码）；Worker 修复与测试完成；Worker 发布因磁盘不足推迟。
- 2026-10-28 10:46：编排会话已把磁盘清到 11 GiB 并要求发布。Server 在 10:45 重启后本会话的 Foundry 工具断连（502），无法与 DEV-055（`sess_1793116876771359572`）协调；共享工作树里含 DEV-055 尚未完成的 Phase 2 Worker 代码（`device-files.ts` 等），单方面打包会把它一起发布，且无法操作 用户 Linux 开发机。未发布，未改 用户 Linux 开发机。补充恢复步骤和 DEV-057 代码边界。
- 2026-10-28 11:15：DEV-055 已于 10:48 发布 Worker `0.5.7-dev.104.g4d184b2.local.1793154141`（从共享工作树打包）。核对发布包：含 `model_auto_compact_token_limit`（80% 阈值），不含 `thread/compact/start` 恢复逻辑。部分发布本身安全，但救不回已卡住的会话（被拒后 Codex 的估算为 0，阈值不会触发）。完整修复随与 DEV-057 的下一次联合发布上线，由 DEV-061 发布；DEV-055 确认不再发布。
- 2026-10-28 11:50：DEV-057 报告就绪，DEV-055 同意由 DEV-061 联合发布。共享工作树的 `daemon-dispatch.test.mjs` 失败只是 DEV-055 未把 `readDeviceFile` 加进测试固定列表（处理器已随 .1793154141 发布），已告知 DEV-055，不阻塞发布。磁盘剩余 9.8–10.0 GiB，低于编排会话设定的 10 GiB 门槛，按要求暂停打包；向编排会话的消息均被拒（DEV-057 正在修的 steer 问题）。
- 2026-10-28 15:3x：磁盘 10.25 GiB。备份原 manifest 与 tgz 到 `~/.foundry/server/releases/dev061-worker/previous-*`。共享工作树检查：Worker build、61 个 Worker 测试文件、protocol build/测试通过；prettier（DEV-057/DEV-062 文件）、Web tsc（`apps/web/src/api/http.ts`）、module audit（DEV-057 新增 `codex-boundary`）失败，均不在 Worker 包内。从共享工作树发布联合 Worker `0.5.7-dev.104.g4d184b2.local.1793172116`（DEV-061 阈值与恢复、DEV-057 `input_consumed`/`codex-boundary`、DEV-062 `reconnectDelayMs`、DEV-055 `device-files`，已在包内核对），发布后磁盘 10.23 GiB。用户 Linux 开发机 经同一安全自更新入口（独立 systemd user unit 运行 `foundry-worker update`）完成：日志为 `.1793154141 → .1793172116`；`/proc` 核实 daemon PID 906482 加载 `runtime/0.5.7-dev.104.g4d184b2.local.1793172116/…/dist/cli.js`，安装目录含恢复逻辑；执行宿主 PID 1193234 仍加载 `runtime/0.5.7-dev.53.g8c85186.local.1792641207/…/execution-host/main.js`（已运行约 6 天，未强停）；`doctor` 正常，Codex 0.165.0。方案 A 需等该宿主空闲切换后再执行。
