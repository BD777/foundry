# DEV-311 PA 路由评测：沙箱只读、空库合成用户、评分修正

[事项索引](README.md) · [个人助理评测](../personal-agent.md#13-评测) · 证据报告 `.foundry/reports/pa1-baseline-2026-11-19.md`（§9–§12）

状态：**已通过 CI，待合并**（PR #283，head `c6f0bd86`，2026-11-18 23:19Z 全部检查通过）。`--sandbox-check` 在本机与 sg-chaos（默认 TMPDIR 与 `TMPDIR=/tmp`）均 3/3 通过。无部署。

## 问题

- 评测沙箱用 `--dev-bind / /` 挂载宿主机，可写；2026-11-18 的一次探测确认 `/var/tmp` 可写。
- 评测跑在 dev 数据库的副本上，并且包含重置人员密码的步骤。这违反「不触碰本人登录」的约束。
- 评分器对 `dispatch_item`、`needs_you ask` 以及带或不带引号的项目名判断错误。

## 变更

- `scripts/pa-eval-run.mjs`：沙箱改为 `--ro-bind / /`，私有 `/dev`、`/proc`、`/tmp`，只有运行目录（和登录配置目录）可写；删除密码重置。新增 `--sandbox-check`。
- `scripts/pa-eval-seed.mjs`（新）：在空库里写入合成用户与夹具 Workspace。
- `scripts/pa-eval-score.mjs`、`scripts/pa-eval-score.test.mjs`（新）：评分修正与 39 项检查。
- `scripts/pa-eval-stack.sh`（新）：使用预构建二进制启动评测栈。
- `docs/personal-agent.md` §13「跑法」随之更新。

## 检查

| 检查                                                    | 结果                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `node --check`（四个 `.mjs`）                           | 通过                                                             |
| `node --test scripts/pa-eval-score.test.mjs`            | 39 项 PASS，0 FAIL                                               |
| `bash -n scripts/pa-eval-stack.sh`                      | 通过                                                             |
| `prettier --check` 四个 `.mjs`                          | 通过（先用 `prettier --write` 格式化，格式化后 39 项检查仍通过） |
| `node scripts/pa-eval-run.mjs --sandbox-check`，本机    | 3/3 PASS                                                         |
| 同上，sg-chaos，`TMPDIR` 为默认值（修复前，`4e4fbaed`） | **FAIL**：写入运行目录失败                                       |
| 同上，sg-chaos，`TMPDIR=/tmp`（修复前）                 | 3/3 PASS                                                         |
| 同上，sg-chaos，`TMPDIR` 为默认值，修复后 `c6f0bd86`    | 3/3 PASS                                                         |
| 同上，sg-chaos，`TMPDIR=/tmp`，修复后 `c6f0bd86`        | 3/3 PASS                                                         |

**sg-chaos 失败的根因**：沙箱的运行目录取自 `TMPDIR`（`mkdtemp(resolve(TMPDIR || tmpdir(), ...))`）。sg-chaos 上 `TMPDIR` 是 `$HOME/.foundry/compute/.tmp/lease_*`，位于 `--tmpfs ~/.foundry` 之下。可写绑定原先在 tmpfs 之前加入，被后挂载的 tmpfs 遮住，因此探测目录在沙箱内不存在。修复：可写绑定移到最后，仍绑定在真实路径上；登录目录的位置不变，以免覆盖只读叠加。未强制使用 `/tmp`。

报告的评测运行把运行目录放在 `/tmp/fdy-*` 下（§10 列出的目录），与 sg-chaos 的失败不是同一条路径；报告中的结果数字不因本次修复而改变（修复只改变运行目录的挂载顺序，不改变判分与夹具）。

## 运行结果（非生产，见限制）

117 例全量运行结果见报告 §9：明确样例 top-1 31.9%、错投 5.0%、歧义提问 35.7%、新建精确率 100%（95% 区间下界 70.1%）、召回 64.3%、禁用词 10.3%、每请求提问 0.39。除新建精确率的点估计外，**其余指标均未达门槛**。沙箱审计（§10）未发现评测用户写入宿主机的文件；残留的 50 个 `/tmp/fdy-*` 评测目录（608 KB）留给编排者决定是否删除。

## 验收步骤

1. `node --test scripts/pa-eval-score.test.mjs`，预期 39 项 PASS。
2. 在干净的 Linux 主机上分别以默认 `TMPDIR` 与 `TMPDIR=/tmp` 运行 `node scripts/pa-eval-run.mjs --sandbox-check`，预期每次三项 PASS，且 `/var/tmp`、`$HOME`、`/etc` 的写入失败。

## 限制

- 模型 id `claude-haiku-5-5` 为推断；路由为 hell-tw，不是 Limen 的 `limen_default`，因此这些数字是 stand-in，不是生产指标。
- 单次运行，方差可见（real-0fb4f4d6 在两次运行间翻转）。
- 状态不在用例之间重置：列表项、定时任务和助理自己的文件会延续，约影响 9 例（见报告）。
- 连接器夹具没有扩展凭据；评测中飞书调用失败，生产中可用。
- 全部 117 例已用于诊断，因此哈希顺序的留出集已不干净；改进项的验证需要新采集的真实请求。
- Limen 的修复 (b) 仍由其负责人处理。
