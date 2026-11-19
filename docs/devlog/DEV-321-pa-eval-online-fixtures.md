# DEV-321 PA 路由评测：在线夹具设备、工具级派发评分、重复与续跑

[事项索引](README.md) · 承接 [DEV-311](DEV-311-pa-eval-harness.md) · 脚本与报告，不涉及部署

状态：**脚本已完成，待合入 main；未部署（脚本不随部署发布）**。补丁 `/tmp/PA-1f.patch`（取代此前的 PA-1d 评测补丁，二者只合入一个）。基线统计不完整，见「限制」。

## 问题

PA-1 基线（[pa1-baseline-2026-11-19.md](../../.foundry/reports/pa1-baseline-2026-11-19.md)，`.foundry/` 下，未入库）暴露了评测本身的几处缺陷：

1. 夹具里的项目所在电脑是离线的，助理派发的会话无法真正启动，派发结果只能靠回复文字判断。
2. 只跑一遍，无法区分偶然结论与稳定结论；单次运行中途失败会丢掉已完成的用例。
3. 每个 Worker 各自下载工具链与 npm、Go 构建缓存，多次运行时磁盘与时间都被重复消耗。
4. 磁盘写满时，后续用例在没有明显报错的情况下失败，看起来像模型的问题。

## 改动

- **在线夹具设备**（`scripts/pa-eval-run.mjs`）：夹具电脑在线，Worker 的 Claude 运行时换成假 CLI（`scripts/fixtures/fake-claude-code.cjs`，经 `FOUNDRY_CLAUDE_BIN` 注入，与 `scripts/ci-worker-restart.mjs` 相同）。每台夹具电脑一个 Worker。派发是真实会话，不再是离线占位。假 CLI 复制进评测目录后执行，不从仓库运行。
- **工具级派发评分**（`scripts/pa-eval-score.mjs`）：决定以助理的工具调用为准。`dispatch_item` 计为派发，`needs_you op=ask` 计为提问；回复中提到项目名只作诊断，不计分。`pa-eval-score.test.mjs` 覆盖匹配规则与 judge 输出解析。
- **`--repeat N`、运行日志与 `--resume`**（`scripts/pa-eval-journal.mjs`）：同一批用例在同一个 stack 中跑 N 遍。每个用例结束即追加一行 JSON（`{repeat, row}`）。`--resume FILE` 读回日志并跳过已完成的（重复序号, 用例）。日志末行若被截断（崩溃），忽略该行；中间行损坏则报错，不静默跳过。
- **每个 stack 共享缓存**（`scripts/pa-eval-run.mjs`）：`tools`、`npm-cache`、`xdg-cache`、`go-build` 放在 stack 的共享目录下，各 Worker 的 HOME 指向同一处，避免每台夹具重复下载。
- **磁盘暂停**（`waitForDisk`，默认 4.5 GB）：开始每个用例前检查 stack 所在磁盘的可用空间，低于下限则记录并等待，不在满盘上启动用例。

## 检查

- `node --test scripts/pa-eval-score.test.mjs`：5/5 通过。
- `node --test scripts/pa-eval-journal.test.mjs`：4/4 通过（按重复序号与用例返回；末行截断被忽略；中间损坏报错；日志缺失为空）。
- `node --check` 通过：`scripts/pa-eval-build.mjs`、`pa-eval-journal.mjs`、`pa-eval-run.mjs`、`pa-eval-score.mjs`、`pa-eval-seed.mjs`。
- 评测运行本身：第 1 遍在 stack `base4` 上运行，得到 80 个有效用例（快照 `~/.foundry/pa-eval/reports/pa1f-base4-rep1.db`，其中 35 个遇到 429）。

## 限制

- **3× 基线不完整。** 评测使用的 `hell-tw` 账户额度于 2026-11-19 07:31Z 用完，第 2、3 遍未完成；额度预计 2026-11-20 约 04:00Z 重置。目前只有第 1 遍的 80 个有效用例，不能据此给出稳定率。
- 第 1 遍中 35 个用例遇到 429（来自编排者记录，本次未核对每条的处理方式）。
- 评测经 `hell-tw` 账户运行，并非生产的 `limen_default`（haiku/high）。数字只代表该设置。
- 脚本不随部署发布；效果数字不作为产品结论。

## 验收步骤

1. 在仓库根目录运行 `node --test scripts/pa-eval-score.test.mjs scripts/pa-eval-journal.test.mjs`，预期 9 项全部通过。
2. 对每个改动的脚本运行 `node --check <file>`，预期无输出。
3. 续跑：对一次中断的运行，以 `--resume <journal>` 启动，预期跳过日志中已有的（重复序号, 用例）并只跑剩余部分。
4. 不要在生产 stack 或真实账户上运行；评测只在隔离的 stack 上进行。
