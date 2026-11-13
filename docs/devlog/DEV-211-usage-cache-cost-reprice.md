# DEV-211 用量成本估算重复计价缓存输入

状态：已合入 main（PR #267）。已修复并部署 dev；历史重算与真实页面验收通过，未提交。

## 问题

用量页把缓存输入计了两次。各 runtime 写入 `AgentTurnUsage.inputTokens` 时已经包含 cache read 和 cache write，但 Server 的 `costForTokens` 又把完整 `input_tokens` 按未缓存价格算一次，再单独加上 cache read / cache write。

受影响最明显的 2026-11-10 至 11-13 数据：

| Runtime · provider · model                        | Turns（修复后） |         Input |    Cache read | Cache write |    Output |         修复前成本 |        修复后成本 |
| ------------------------------------------------- | --------------: | ------------: | ------------: | ----------: | --------: | -----------------: | ----------------: |
| codex · LLM Gateway · flux/gpt-6-astra            |             379 | 1,592,421,929 | 1,531,257,920 |  60,536,626 | 4,644,160 |     $18,444.393035 |     $2,526.447575 |
| claude · Limen · claude-opus-5-5                  |             599 | 1,835,158,834 | 1,819,039,058 |  16,108,042 | 3,698,952 |      $2,582.596558 |       $686.056046 |
| codex · TokenHub · deepseek-v4.1-flash-1017       |             233 | 4,127,140,793 | 4,082,792,320 |           0 | 9,889,629 |      $1,325.731862 |        $56.297874 |
| claude · hell-tw · claude-opus-5-5                |             310 |   504,548,655 |   462,252,973 |  42,292,256 |   980,658 |      $1,040.704267 |       $324.994439 |
| codex · TokenHub · deepseek/deepseek-flash        |              38 |   398,597,142 |   391,874,176 |           0 | 1,249,301 |        $123.429549 |         $5.867296 |
| codex · byte-llm-gateway · flux/gpt-6-astra       |               6 |     7,047,437 |     6,757,973 |     289,181 |    17,326 |         $81.713406 |        $11.241865 |
| claude · Limen · claude-sonnet-5-5                |              38 |   151,427,607 |   148,119,437 |   3,305,608 |   873,840 |         $52.637696 |        $36.705810 |
| codex · LLM Gateway · aime/deepseek-v4-flash-0731 |              21 |    41,507,549 |             0 |           0 |   191,096 |         $18.515568 |        $18.515568 |
| codex · Codex Local · gpt-6-astra                 |               8 |       338,035 |       248,448 |           0 |     1,197 |          $3.688648 |         $1.204168 |
| codex · Codex Local · gpt-6.1-sol                 |               8 |     1,312,732 |     1,165,824 |           0 |     5,628 |          $2.798326 |         $0.466678 |
| claude · hell-tw · claude-sonnet-5-5              |               1 |       321,016 |       270,494 |      50,508 |     4,298 |          $0.201801 |         $0.201801 |
| codex · Codex Local · gpt-6.1-terra               |               7 |       155,640 |        85,120 |           0 |     1,251 |          $0.166151 |         $0.081031 |
| **合计**                                          |       **1,719** |               |               |             |           | **$23,676.576867** | **$3,668.080152** |

统计窗口是固定的滚动 72 小时 `2026-11-10T08:00:00Z` 至 `2026-11-13T08:00:00Z`，避免其他活跃会话继续写入后前后口径漂移。修复前备份有 1,714 行；reprice 后又 backfill 了 5 行，表中单模型 turns 使用当前值。用户报告的具体形状 `input=515,202 / cache_read=513,920 / output=1,883` 从 `$0.1659688` 降到 `$0.00572772`。

## 调查

- 契约 [sessions.yaml](../../contracts/models/sessions.yaml) 已明确：`inputTokens` 是模型读到的全部 prompt token，cache read / write 是其中一部分，不是额外 token。
- Claude Agent SDK 的 `result.usage.input_tokens` 不含 cache 字段，Worker 在 [turn-usage.ts](../../packages/worker/src/session/usage/turn-usage.ts) 边界相加；Anthropic Messages 的 `message_start` / `message_delta` 走同一规则。
- Codex Responses、chat `token_count`、app-server `thread/tokenUsage/updated` 和 Codex rollout 的 `input_tokens` 本身包含 cached tokens，Worker 原样记录。
- 真实库共 7,337 个 usage turn，其中 `input_tokens < cache_read_tokens + cache_write_tokens` 的行数为 0；Claude 行包含 cache write，Codex 行同时包含 cache read / write，和代码规则一致。
- 成本没有在读取时计算，而是随 turn 存在 `usage_turns.cost_usd`，并聚合进 `usage_daily.cost_usd`。Server 已有启动与每日执行的 idempotent `Reprice`，会事务性替换非 reported 的成本并保留 SDK reported cost；因此复用这条历史重算路径，不新增 schema 迁移。

## 修复

`costForTokens` 现在按以下公式计价：

```text
uncached = max(0, input - cacheRead - cacheWrite)
cost = uncached * inputPrice
     + cacheRead * (cacheReadPrice ?? inputPrice)
     + cacheWrite * (cacheWritePrice ?? inputPrice)
     + output * outputPrice
```

缓存缺价时回退到 input rate；显式为零的 cache price 仍按零处理；输出缺价仍保持 unknown，不静默漏算。测试覆盖 Claude SDK result、Anthropic stream、Codex Responses、Codex chat/app-server、零缓存、缓存缺价、Anthropic cache write 和异常负 uncached clamp。

修复后真实库又暴露了同一估算链路的 provider 歧义：`deepseek-v4.1-flash-1017` 在 LiteLLM catalogue 中同时有 aiand、Tencent、Together 等条目，原归一化逻辑会按字典序选错 provider。价格查找现在会从 serving profile 的 label / base URL 提取 provider hint，并在该 provider 的索引中允许去掉纯数字 checkpoint 后缀再匹配；因此 TokenHub 使用 `tencent/deepseek-v4.1-flash` 的 USD 0.30 / 0.006 / 1.20 每百万 input / cache-read / output 价格，而不是 aiand 的 cache/output 价格。provider hint 不存在时保留原全局归一化行为。

历史重算前备份：`~/.foundry/server-backups/usage-reprice-20261113T081800Z/foundry.db.gz`，SHA-256 `a951f98fd1f1e0049120912340f184d1b6a32c173d3155b116a14a9a2dabf843`。备份时未压缩库的 `PRAGMA quick_check` 为 `ok`；收尾时已验证 gzip 流完整后只保留 453 MiB 压缩副本。

## 检查

- Mac mini compute lease：`scripts/remote-check.sh ... --go ./internal/usagestats` 通过；usage package 0.538 s，含全部新增 table cases。日志 `/tmp/remote-check-20261113T164528-1440419.log`。
- 同一远程准备的 Worker TypeScript build 通过；lease 在 check 完成后立即释放。
- 第一次 live reprice 后用真实库确认 caching 结果，但也暴露 provider 歧义；train conductor 在 byte-dev 上运行三个定向 usagestats tests 通过，Server build/vet 通过。
- 最终 Server 由 `/tmp/fdy-train` 的已验证源码在本机 shared heavy lock 下交叉编译为 linux/amd64；conductor 核对了它生成于 DEV-203 hotfix 之后，并包含 PinIn、DEV-210 header 与 DEV-214 标记后部署。

## 部署与验收

- Live Server `7a5ea7e4708c6a3f8bd86a32182021916568372e46d02f591e16697ac58e23c9`，`startedAt=2026-11-13T12:14:58Z`，`/healthz` ok；rollback copy 由 conductor 的 `deploy-dev.sh` 保留。
- 启动 reprice 后，固定 72 小时共有 1,719 turns，成本从 `$23,676.576867` 降到 `$3,668.080152`；estimated 889 turns / `$2,956.411365`（80.6%），reported 704 / `$711.668788`（19.4%），unknown 126 / `$0`。全库 `input_tokens < cache_read_tokens + cache_write_tokens` 仍为 0。
- `usage_turns` 与 `usage_daily` 的全库成本总和一致，均为 `$11,375.265451`。
- 真实 Chromium（e2e-alice）打开 `/usage`：费用卡与“其中估算占费用 100%”同时可见；1440×1000 和 390×844 均无横向溢出。API 返回的 19 个 e2e turns 成本 `$1.232281`，包含 estimated sources；全局费用由同一 Server DB 聚合核验。截图 `.foundry/attachments/dev211-usage-after-final.png`。

## 限制

Dev 使用 LiteLLM catalogue 对部分 provider 模型做估算；修复成本公式不会把估算变成 provider 的最终账单，reported cost 保持不变。e2e-alice 的页面验收只能读取该测试账号自身 usage；全局 72 小时数字通过同一 live Server 的只读 DB 查询核验。
