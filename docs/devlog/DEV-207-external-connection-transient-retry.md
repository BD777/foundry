# DEV-207 网关短暂重置导致整个回合失败

## 状态

已修复、验证并部署 dev（2026-11-13）。根因是 Limen helper 的 5 秒预检 deadline，不是 Foundry Server、DEV-205 或 Foundry edge tunnel 的重启。Limen 预检改为 15 秒并返回可重试的 `client_preflight_timeout`（PR #381，commit `7a36f19`）；PR 已 ready、correctness CI 通过，等待非作者账号 `wasd96040501` 的 review 后合并。Worker 的身份探测和连接准备都会对短暂 helper 失败重试、保留最后一次可用状态。Worker `0.5.7-dev.357.g8f394c91.local.1794558943` 已更新 7 台设备，byte-dev 的连接检查通过。Foundry 改动未提交（提交时间窗）。

## 问题

2026-11-13T04:06:40Z，byte-dev 上的会话 `sess_1794541720567021279`（profile「Limen · default」）在启动 7 秒后失败：

```text
External connection preparation failed (client_connection_failed). Check the helper on the device.
```

同一会话的前几轮正常，失败后 3 分钟的新回合又正常开始。失败生成了一个「等你处理」条目。

## 证据

- 会话事件：04:06:35Z 已加载工作区并启动 Claude Agent SDK；04:06:40Z 记录 `Session failed`。04:09:10Z 同一 profile 的新回合正常启动并进入模型请求。
- byte-dev 的 Limen 隧道日志：04:06:35.378Z 建立隧道，04:06:40.379Z 以 `client_error` / `ECONNRESET` 关闭，持续 5000 ms；同一账号另有几条旧隧道在 04:07–04:08Z 被 `ECONNRESET` 关闭。
- 同一会话在 04:27:21.605Z 再次建立隧道，04:27:26.606Z 又以 `client_error` / `ECONNRESET` 关闭，仍是 5001 ms；04:32Z 的下一轮正常完成，确认错误是重复出现的短暂重置，不是持续的认证或配置故障。
- Limen helper 的 `clientPreflight` 对已保存派生 key 的网关检查固定 5000 ms；它把检查期间的 fetch 失败统一转成 `client_connection_failed`。两次隧道关闭时间与该 5 秒 deadline 完全吻合，说明是预检在时限内没有拿到完整结果，而不是 key 被拒绝。
- Worker 的失败 stderr 只保留同一 helper 错误码，没有凭据或网关诊断；`connection check` 的历史结果在 03:32Z 已通过，`provider-checks.json` 保存的状态也是 passed。
- 修复前 byte-dev 的当前连接检查在 04:39:50Z 通过；会话的原任务在 04:32Z 正常完成，因此现在可直接重试失败输入。
- 新 Worker bundle 安装后的 04:50:05Z，byte-dev 的连接检查再次通过（`limen_default`，fingerprint 未变）。
- DEV-205 改的是设置面板读取连接状态；每个回合的连接准备仍走 `foundry.connection.v1`，不经过该读取路径。因此这不是 DEV-205 的连接查找回归。

### 失败发生在哪一跳

实际路径是：

```text
helper → 本机 Limen adapter 127.0.0.1:12263 → 公司 egress proxy 10.251.248.226:17890
       → Limen gateway 15.175.112.222:49152
```

这条路径只经本机、公司代理和 Limen gateway，不经过 Foundry Server、Foundry edge access 或 Foundry connector gateway。Foundry 只负责启动 helper 并读它的一行 `foundry.connection.v1` 回复。

- byte-dev 的 adapter 日志把当前连接写成 `egress http://10.251.248.226:17890 (environment)`；历史 tunnel 事件里两次异常也都是 `egress=http`、`connect_status=200`、`t_egress_ms` 分别为 169 / 158 ms，说明到代理的 CONNECT 已经成功、隧道已建立。
- 04:06:40.379Z 的事件持续正好 5000 ms；04:27:26.606Z 的事件持续 5001 ms；两次都是 `reason=client_error`、`error_code=ECONNRESET`。这与 helper 的 5 秒预检 deadline 逐毫秒吻合，是客户端主动 abort，不是 gateway 主动拒绝。
- Foundry Server 的启动标记在 03:27:53Z、03:28:37Z、03:29:16Z，下一次是 08:28Z 左右；04:00–04:30Z 没有 Server 重启。即使有，Server 也不在这条路径上。
- byte-dev 的 Worker daemon 日志在 04:05–04:07Z 没有 reconnect/disconnect 记录；两次失败都由本机 adapter 在自己的 tunnel 记录里主动关闭。没有 Foundry device reconnect 或 edge tunnel reconnect 与失败对齐。
- `gateway_closed` 事件在同期有 45 次，但 `last_rx_age_ms=0`，表示收到 gateway 的关闭后才记录；两次 5 秒事件不是这一类。

### 失败后的稳定性测量

- 08:17–08:25Z：对 `10.251.248.226:17890` 做 60 次 TCP/CONNECT 探测，TCP 60/60 可达，连接建立 0.070–0.084 s；探测不带代理凭据，所以 CONNECT 得到预期的 HTTP 403，响应耗时 0.61–6.90 s。这只能证明代理端口可达，不能证明 gateway 身份。
- 08:31–08:38Z：对真实 helper 做 30 次 `--describe` 端到端探测（同一个 profile、同一凭证、同一 adapter）：30/30 成功，耗时 p50 2.381 s、p95 7.385 s、max 7.444 s；其中 3 次超过 5 s，0 次超过 15 s。旧 5 秒 deadline 在这段健康窗口里也会误杀 10% 的探测，15 秒是有数据支撑的。
- 新 Worker 和 helper 安装后，byte-dev 的 `foundry-worker connection check limen_default` 于 08:39:47Z 通过，fingerprint `3785206778eec4523bd90d159a499ff4e2fae4c5e4b63fab0b4e6288fcebf10b`。

### composer 的 identity 错误

“could not confirm its identity (the helper exited with code 1)”来自一次实验性的 current-main helper：它以 `client_state_unsafe` 拒绝了 byte-dev 的非规范 home 路径。随后换回备份 helper，再做本次 deadline 补丁，`--describe` 和 `connection check` 都通过。它不是 Foundry 的模型身份缓存或 Server 重启问题；但暴露了 Foundry 对单次 identity probe 失败过于敏感，本次一并加固。

## 根因

根因在 Limen helper 的预检路径：到代理的 CONNECT 和 TLS 隧道已经建立，但已保存派生 key 的 5 秒 `clientPreflight` 没能在时限内拿到完整响应，fetch 被 abort 后统一映射为 `client_connection_failed`。Limen 客户端 adapter 把 abort 记录成 `ECONNRESET`。这是冷隧道/首包慢导致的 deadline 超时，不是认证拒绝、gateway 重连，也不是 DEV-205 的连接查找回归。

Foundry 有两个脆弱点：连接准备只把「helper 超时」当作可重试错误，helper 以 `client_connection_failed` 退出时直接结束整个回合；identity probe 每次失败一次就把 provider 标成不可用，一次 `--describe` 的抖动就会让 composer/picker 显示 “Unavailable”。两者都会把短暂故障放大成用户可见的失败。

## 修复

- `packages/worker/src/harness/external-connection.ts`：保留超时的两次尝试；对 helper 的非终态退出最多尝试 3 次，间隔 1 秒和 4 秒，每次都用新的 helper 进程。
- 没有给协议 v1 增加字段。helper 的 stderr 错误码是唯一稳定信号：鉴权/权限、身份、无效输入、额度/限流、配置等终态错误立即失败；其他错误（包括 `client_connection_failed`、`client_gateway_busy` 和没有可识别错误码的退出）重试。
- 最终错误只保留错误码和尝试次数，不转发 stderr；不再把一次连接失败直接写成「Check the helper on the device」。
- 协议文档补充重试和终态错误规则。
- Limen `src/client/preflight.ts`：默认 deadline 从 5 秒改为 15 秒；controller abort 时返回 `client_preflight_timeout`（retryable），真正的传输失败仍是 `client_connection_failed`。测试覆盖 silently hanging CONNECT proxy、真实 connection refused 和 15 秒常量。
- `packages/worker/src/connectors/extensions/declarative.ts`：identity `--describe` 对可重试退出最多尝试 3 次，间隔 1 秒和 4 秒；成功返回身份，三次都失败才返回真实错误码。
- `packages/worker/src/connectors/extensions/model-access.ts`：单个 provider 的 identity 失败不再立刻覆盖最后可用状态。连续 2 次 refresh 失败仍保留最后一次通过的 provider/fingerprint；第 3 次才标 unavailable，并显示真实原因和 `last confirmed … ago`。成功一次即清空失败计数。
- `packages/worker/src/harness/connector-model-providers.ts`：保存 `lastConfirmedAt`，供不可用状态显示最后一次确认的时间。
- Limen helper 的正常分发路径不是 Foundry extension：`extensions/limen/foundry-extension.json` 只调用 `~/.local/share/limen/host-connection-v1/connection.js`；helper 源码在 Limen 检出里是未跟踪的 `tools/host/connection.ts`，没有随 Limen 客户端 release 自动更新。本次对已安装文件做与 commit 等价的三处原子替换，并在每台设备上跑 `--describe`。

## 检查

- `external-connection.test.mjs`：新增「短暂连接失败后在新 helper 上恢复」；终态鉴权错误只启动一次；无错误码和 `client_connection_failed` 均最多启动三次并保留最终错误码。
- `connector-extensions.test.mjs` + `connector-declarative.test.mjs`：25/25 通过；覆盖 timeout code 可重试、identity 退避、连续两次失败保留最后好状态、第三次失败显示 last confirmed。
- `scripts/check-changed.sh --files ...`：prettier 5/5、Worker build、module audit 通过。macOS 上的 43 文件 Worker 测试计划只有 `state-root.test.mjs` 两个 sandbox path 断言失败，原因是 macbook 使用 `~/.foundry-stacks/dev` 而非 `~/.foundry`；这两个文件不在本次改动中，Linux 上未复现。
- Limen `make test-linux TEST=tests/client-preflight.test.ts`：6/6 通过。
- Worker 包内核对：`declarative.js` 含 `identityProbeBackoffMs`，`model-access.js` 含 `probeFailureLimit`，`external-connection.js` 含 `helperFailureRetryable`，`github.js` 仍是 DEV-206 的解析器。

## 部署

- 新 Worker bundle `0.5.7-dev.357.g8f394c91.local.1794558943` 已发布到 dev worker-packages；`GET /api/worker/release` 指向该版本，Worker tgz SHA-256 为 `bf45c30a6815af1b764626722241e9f522f3997732cf7258450ec7703a6299e3`。
- 回滚：`~/.foundry/server/worker-packages-rollback/before-dev207-probe`（以及更早的 `before-dev206-hardening`）。
- `update_worker` 于 08:38–08:39Z 将 7 台设备从 `...1794551762` 更新到 `...1794558943`，全部 `state=succeeded`。byte-dev 的 daemon-health 和 execution-host 进程都指向新版本；sg-chaos 的新 execution unit 也以新版本启动。
- Limen helper：byte-dev、sg-chaos、cottoncpp、macbook 已做等价的 15 秒/timeout-code 替换并逐个 `--describe` 通过。byte-dev 的 helper SHA-256 为 `9ff5351d8c152a70a3e05b722b57c94fa680486c2d3781da2f7dc13d1a3629c0`。byte-dev、sg-chaos、cottoncpp、macbook 的备份均为 `connection.js.before-dev207-preflight`；byte-dev-sg、limen-canada 没有安装这个 helper（路径不存在）。

## 限制

- 如果预检持续超过 15 秒，或 helper 在三次尝试中持续退出，回合仍会失败；这是有意保留的边界，避免把持续故障伪装成无限重试。
- 错误码是 helper 自报的文本约定，不是结构化协议字段；新 helper 如果使用新的终态错误码，可能被多试两次，但总次数有界。
- helper 不在 Limen 客户端 release 的自动更新路径里；未来 Limen 客户端升级可能覆盖设备上的文件。长期修复应把 `tools/host/connection.ts` 纳入 Limen 的版本化 release/安装器，而不是继续逐台替换。
- CanWendeMac-mini：设备 12:18Z 回来后，于 2026-11-13 12:35Z 补上 helper 补丁（sess_1794562483321326240，DEV-217）。原文件与 sg-chaos 的未改版同为 `aadf270f…`，做同样三处替换后与 sg-chaos 已改版同为 `e4a9a02a5a86c521…`；备份 `connection.js.before-dev207-preflight`。`--describe` 1 s 返回身份（`gatewayAuthenticated: true`）；`foundry-worker connection check limen_default` 结果 `status: passed`，fingerprint `214086798451fd7a…`，用时 27 s。
- `lastConfirmedAt` 在当前成功 refresh 的条目完全不变时不会每分钟重写文件，避免 provider 文件抖动；因此旧条目可能先显示真实原因、暂时没有 age，等下一次条目内容变化后才有最后确认时间。

## 验收步骤

1. 打开 `sess_1794541720567021279`，在下一条消息里继续原任务。预期不再因为 04:06Z 那次短暂重置而失败。
2. 在 byte-dev 上再次检查 `limen_default`。预期 `status=passed`，`--describe` 在 15 秒内返回身份。
3. 人为让 identity `--describe` 短暂失败一次（或等待一次真实抖动）。预期设备页继续保留 provider 和最后状态；连续三次失败后才显示 unavailable，并带真实错误码（若该条目已写入 last confirmed，则同时显示 age）。
4. 真实鉴权失败（例如 `client_auth_failed`）应只启动一次 helper，并立即失败，不应等待重试退避。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                                                  | 剩余动作                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 2026-11-13 12:20 | 确认 04:06Z 的隧道在 5 秒后 `ECONNRESET`，失败后同会话新回合正常；实现非终态 helper 退出的有界重试。                                        | 定向测试、发布、设备更新              |
| 2026-11-13 12:40 | 同一会话 04:27Z 再次以 5 秒 `ECONNRESET` 失败、下一轮正常；连接检查 04:39Z 通过。change-scoped gate 与 23 个定向测试通过。                  | 等待共享 bundle、设备更新             |
| 2026-11-13 12:46 | Worker bundle `...1794544799` 已部署，7 台设备更新成功，逐台新 execution host 已加载；DEV-206/207 合并发布。                                | 人工验收；提交窗口                    |
| 2026-11-13 12:50 | 新 bundle 上 byte-dev 的 `limen_default` 连接检查再次通过。                                                                                 | 人工验收；提交窗口                    |
| 2026-11-13 15:40 | 确认失败路径不经过 Foundry Server；两次异常都正好 5 秒、CONNECT 200、egress 158–169 ms。Limen PR #381 提交 15 秒 deadline 和 timeout code。 | 发布 helper、Worker 加固              |
| 2026-11-13 16:00 | 30 次真实 helper 端到端探测 30/30 成功，p95 7.385 s、max 7.444 s，3 次超过旧 5 秒；证明旧 deadline 会误杀健康连接。                         | 实现 identity 保留策略                |
| 2026-11-13 16:31 | identity probe 增加 3 次退避；provider 连续两次失败保留最后好状态，第三次才 unavailable；25/25 定向测试通过。                               | 打包、更新设备                        |
| 2026-11-13 16:39 | Worker `...1794558943` 更新 7 台设备成功；byte-dev 新 execution host、helper 补丁和 `connection check` 均通过。                             | 人工验收；提交窗口                    |
| 2026-11-13 16:55 | CanWendeMac-mini 收尾时 offline；其 Worker 已升级，但 helper 文件补丁留待设备回来。                                                         | 补 CanWendeMac-mini helper            |
| 2026-11-13 20:35 | CanWendeMac-mini 回来，补上 helper 补丁（hash 与其他设备一致）；`--describe` 和 `connection check` 均通过。                                 | 人工验收；提交窗口                    |
| 2026-11-13 17:02 | 共享服务器高负载时 byte-dev compute 短暂无响应；同版本 Worker 重启后设备恢复在线，compute echo 和 runtime 内的 hardened 标记均通过。        | 收尾验证                              |
| 2026-11-13 17:55 | Limen PR #381 已 ready；`correctness` 4m27s 通过，`release` 按配置跳过；合并被“需要非 last pusher 批准”的仓库规则挡住。                     | 等 `wasd96040501` 批准后 squash merge |
