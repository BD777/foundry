# DEV-274 账号不可用（402 欠费 / 配额耗尽 / 账号停用）时熔断并备用切换

状态：已实现并通过远端定向测试；已部署 dev（2026-11-17）；待本人验收；已合入 main（PR #274）。

## 问题与证据

- 2026-11-17 约 10:03Z，承载 deepseek 成员的 TokenHub 账号返回 `402 The account associated with the API Key is in arrears and the accessed service ID has been isolated…`（欠费）。
- 两个执行组会话直接失败，没有重试也没有切换：`sess_1794909018420889521`、`sess_1794902656109130134`。
- 组的域视图仍显示 `healthy`。
- 根因（代码）：DEV-261 的熔断器只从限流（429 / "Rate limited, waiting to retry"）学习。`httpapi/session_retries.go` 对 `modelpool.QuotaExhausted` 直接返回，而 402 / 欠费不在任何分类器中，因此既不开路也不切换。

## 改动

- `modelpool.AccountUnusableReason(code, text)`：账号不可用的分类，返回 `402`（欠费 / `payment_required` / `account_arrears` 等）、`account disabled`（停用 / 暂停）或 `quota exhausted`（复用 `QuotaExhausted`）；其它返回 `""`。
- 熔断器（`modelpool/health.go`）：
  - `ObserveUnusable(key, at, cooldown, reason)` 立即开路；冷却期后半开，只放一个探测（沿用 DEV-261 的 `Reserve`）。
  - 冷却 = 供应商给出的重置时间，否则 1 小时；有重置时间时上限 24 小时（`UnusableCooldownFor`）。
  - reason 保持到一次探测成功为止，干净时间不会清除它（否则一小时冷却会在边界处自动关闭，跳过探测）。
  - 域状态 `DomainStatus.Reason`；视图里写作 `402`。
- `httpapi/session_retries.go`：
  - 账号不可用的失败先开路；组内会话若设备支持重试且存在同 runtime 且有余量的更高 tier 成员，则切到该成员，并沿用限流切换的续写机制（同一 `retryContinuationPrompt`），等待约 3 秒。
  - 没有备用，或不在组内：保持原有失败与待处理项（行为不变，只多记录了域的开路）。
  - 限流路径的逻辑未变，只把排程抽成 `schedule`。
- 域视图：`WorkerGroupDomain.reason`，取值为原因种类 `402` / `quota exhausted` / `account disabled`（`contracts/models/profiles.yaml`，由 `pnpm generate:contracts` 生成）。
- 重启回放（第二个补丁）：每次账号不可用开路时，写入 `account_unusable_observations`（运行时、账号、会话、原因、观察时间、冷却结束时间）。启动时（与 DEV-261 的限流回放同一位置）回放观察时间在 24 小时内、或仍在冷却中的记录，按时间顺序重建熔断器；冷却结束时间是绝对时间，已恢复的账号不会因回放被误封。
- Web 状态行（第二个补丁）：域为不可用时显示原因文本，中英文各一套（欠费 402 / 配额用完 / 账号停用 / 其它原因）；其余状态文案不变。
- 准入顺序（`modelpool.Admit`）：
  1. 主力 tier 中 `healthy` 且有余量（或持有唯一探测位）的成员；
  2. 更低 tier 中、最低 tier 的 `healthy` 或 `recovering` 且有余量的成员（只溢出到熔断闭合的域，绝不溢出到探测位）；
  3. 主力中 `recovering` 且有余量的成员；
  4. 仅当主力全部 `limited` 时，更低 tier 的探测位（否则半开域永远没有人探测）；
  5. 否则排队在主力中负载最低的成员，优先不是 `limited` 的主力；仍然不拒绝。
- 回到主力（`settledTurnMember`）：目标成员的域若为 `limited`，不移动；待手动切换与重试切换同样不会落到 `limited` 域。
- 设计判断（请编排者确认）：第 4 条让半开的低 tier 域有机会探测；否则备用账号冷却结束后，只要主力有余量就永远不会被探测。

## 验收步骤与期望

1. 在组内模拟 402 欠费失败（定向测试 `TestArrearsFailureOpensBreakerAndFailsOver`）：期望重试排到备用 `model-b`，主力域为 `limited`，reason `402`，会话事件含「备用 model-b」。
2. 备用也受限时（`TestArrearsFailureWithoutFallbackFailsAsBefore`）：期望不重试，重试记录为 exhausted。
3. 准入（`TestAdmissionSkipsAnUnusableAccountAndShowsTheReason`）：期望选中备用成员，组视图显示 `limited` 与 `402`。
4. 冷却后探测（`TestAccountUnusableRecoversByProbeAfterCooldown`）：冷却后为 `probing`，探测成功后为 `healthy` 且 reason 清空。
5. 非组会话（`TestNonGroupArrearsFailureIsUnchanged`）：不排程重试，行为与之前相同。
6. 模型层：`TestAccountUnusableReasonClassifiesArrearsAndDisabledAccounts`、`TestUnusableCooldownHonoursResetCappedAtADay`、`TestAccountUnusableOpensForCooldownThenProbesOnce`、`TestFailedAccountProbeReopensForAnotherCooldown`。

## 检查

- 本地：`gofmt -l` 与 `go vet ./internal/modelpool` 无输出；`go test ./internal/modelpool` 通过。
- 远端（byte-dev，CanWendeMac-mini 未响应；`--sh` 显式运行 `go test`）：`go test ./internal/modelpool` 通过；`go test ./internal/httpapi -run 'Unusable|Arrears|AdmissionSkips|NonGroupArrears|SettledSession|BreakerOpen|IsolatedRateLimit|AutomaticRetry|QuotaExhaustion|RetryPrompt|ManualSwitch|RestartReplays|Failover|WorkerGroup|ExecutionDefault'` 共 23 个测试全部 PASS。
- 远端 worker `tsc` 报 `SessionInputAnnotation` 未定义：来自实时树中他人未提交的注解改动，与本改动无关，未处理。
- 未运行 Web 构建（本改动不涉及 Web 代码）。

## 限制

- 回放只覆盖 24 小时内的观察，以及仍在冷却中的观察；更早且已过冷却的观察不回放（过冷却后的账号本来就是半开探测）。
- 部署前的实时服务进程不知道 402：在本版本部署并重启之前，首次 402 之后熔断器才会开路。
- 已部署 dev（2026-11-17）；待本人验收；已合入 main（PR #274）。

2026-11-17 夜（提交前全量测试）：新表没有登记为会话拥有的数据（`workspaceOwnedRows`），删除设备会留下它的行（`TestRemovedDeviceLeavesNothingBehind` / `TestEveryTableNamingAnOwnerIsOwned` 失败）。已补登记；同批把这次新增的存储方法从 `store.Store` 移到模块接口（`audit:modules`），随 Server train 40 部署。
