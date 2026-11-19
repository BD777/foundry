# DEV-314 Worker 命令行：以 `-` 开头的值

[事项索引](README.md) · 分支 `fix/cli-dash-values`（基于 `origin/main` aa552d8c，工作树 `~/workspace/foundry-dev314`）

状态：**已部署（Worker，train 96，2026-11-19 约 08:35Z）；远端 Mac 验证通过；待本人验收**。

## 问题

- `foundry-worker setup --token -abc…` 报 `ERROR [E1002] MISSING_VALUE: --token`；`--token=-abc…` 可以解析。
- 配对令牌是 base64url，约六十四分之一以 `-` 开头。Web 设备页（`apps/web/src/features/devices/add-device-dialog.tsx`）和 Worker 报错提示都给出 `--token <value>` 的写法，因此这部分真实配对会失败。
- 根因在 `packages/worker/src/daemon/cli-contract.ts` 的 `parseCliInvocation`：分离形式的值只要以 `-` 开头就被当作缺失值拒绝。

## 变更

- `parseCliInvocation`：值选项取下一个参数作为值，即使它以 `-` 开头。唯一被拒绝的分离值是 `--`，或本命令接受的标志（含 `-h`、`--help`、`--schema`、`--man`）。`--token --no-service` 仍报 E1002，说明是漏写了值。
- `--flag=<value>` 行为不变，包括值以 `-` 开头的情况。布尔标志不变。
- 39 个值选项（`--token`、`--server`、`--workspace`、`--lines`、`--no-proxy`、`--arg`、`--message` 等，覆盖所有命令）统一经过同一段代码，不是 `--token` 的特例。
- 新增 `packages/worker/test/cli-value-parsing.test.mjs`（13 项）。
- 未改动 `scripts/ci-worker-restart.mjs`、`scripts/live-recovery-regression.mjs`。两者通过 `execFileSync` 以 argv 传 `--token <token>`，不经 shell，修复后无需改动。
- 未改动 Web 与 Server 的配对命令模板。Web 生成的是未加引号的 `--token <token>`。base64url 字符只有字母、数字、`-`、`_`，没有 shell 元字符，所以这行命令是安全的。

## 行为决定

| 情况                                                      | 结果                                | 理由                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--token -abc`                                            | 取 `-abc` 为值                      | 修复目标                                                                                                                   |
| `--token=-abc`                                            | 取 `-abc` 为值                      | 原本就可以                                                                                                                 |
| `--token`（末尾，无值）                                   | E1002 MISSING_VALUE                 | 不变                                                                                                                       |
| `--token --no-service`、`--token --token=x`、`--token --` | E1002 MISSING_VALUE                 | 本命令接受的标志（或 `--`）更可能是漏写值，不应吞掉，否则错误被推迟到服务端                                                |
| `--token --abc`（不是本命令的标志）                       | 取 `--abc` 为值                     | base64url 令牌可以以 `--` 开头（约 1/4096）；拒绝所有 `--` 开头会让这类令牌无法用分离形式配对。想拒绝的值可以用 `--flag=…` |
| `--no-service -abc`（布尔标志后）                         | E1003 UNKNOWN_OPTION                | 布尔标志不取值，与原行为相同                                                                                               |
| `--lines -5`、`--server -x`                               | E1004 INVALID_VALUE（不再是 E1002） | 值已被正确取到，由类型校验拒绝                                                                                             |

只有本命令自己接受的标志会阻止它取值，不包括其他命令的标志。例如 `setup --token --json` 会把 `--json` 当作令牌。这是有意的取舍：跨命令检查会让每个值都要和全部命令的标志表比对，而且这种写法在实际中很少见。

## 检查

| 检查                                                                                       | 结果                                                      |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `pnpm build`（远端，`remote-check --worker build`，即 `rm dist` + `tsc -p tsconfig.json`） | 通过                                                      |
| `pnpm run typecheck`（远端，`--sh`，先构建 protocol）                                      | 通过                                                      |
| `prettier --check` 两个改动文件（本机）                                                    | 通过                                                      |
| `remote-check --worker test` 六个 CLI 相关文件（远端 CanWendeMac-mini）                    | 新增 13 项全部通过；其余 CLI 相关用例通过；2 项失败，见下 |

远端测试覆盖的文件：`cli-value-parsing.test.mjs`（新）、`cli-help.test.mjs`、`external-connection-setup.test.mjs`、`worker-install.test.mjs`、`device-pairing.test.mjs`、`server-proxy.test.mjs`。

新增测试（全部 PASS）：

- `setup --token -abc` 解析；`setup --token=-abc` 解析。
- 同一个 `-5` 值，分离形式与内联形式的 E1004 都报 `--lines=-5`，说明值被正确取到。
- `proxy set --no-proxy -abc <url>` 的位置参数只剩 url。
- 值选项在末尾 → E1002 MISSING_VALUE，trigger 为 `--token`。
- 值选项后跟本命令接受的标志（`--no-service`、`--token=abc`、`--workspace`、`--`）→ E1002。
- `--token --abc`（非标志）→ 取为值。
- 布尔标志后跟 `-abc` → E1003；`--no-service=yes` → E1004。
- 对全部命令的全部值选项做遍历：分离形式与内联形式的 `-x` 都只会得到 INVALID_VALUE 或通过，从不报 MISSING_VALUE 或 UNKNOWN_OPTION；末尾缺值报 MISSING_VALUE；后跟本命令标志报 MISSING_VALUE。

## 验证证据

- 远端 lease：`res_c5f59206bda2897c47c7`（CanWendeMac-mini，compute）。日志：`/tmp/dev314-worker-test.log`、`/tmp/dev314-build.log`、`/tmp/dev314-typecheck.log`。
- 基线：在未修改的 `main`（aa552d8c，同一 lease）上运行 `device-pairing.test.mjs` 与 `server-proxy.test.mjs`，同样的 2 项失败。日志：`/tmp/dev314-main-baseline.log`。这两项与本改动无关，是 macOS 运行器上既有的失败。

## 限制

- 2 项既有失败（在 `main` 上复现，未修复）：
  - `device-pairing.test.mjs`：「only one daemon holds the state root; stale locks are reclaimed」。
  - `server-proxy.test.mjs`：「HTTPS proxy + HTTPS target retain certificate validation; SOCKS5h WSS uses remote DNS」，代理报 `ERR_INVALID_ARG_VALUE`。
- 本次只跑了 CLI 相关的 6 个测试文件，未跑整个 Worker 测试套件。整包 `pnpm test` 留给合并批次检查。
- 帮助文本（`connection add --arg` 说明）仍写着「以 `-` 开头的值用 `--arg=<value>`」。这个写法仍然有效，但不再必需，未改动。
- 上面「行为决定」中的取舍：拼写错误的 `--xxx` 作为值时会被接受（例如 `--workspace --wrkspace` 得到路径 `--wrkspace`），此前会报 E1002。
- `dist/` 未纳入版本管理（远端构建产物不回传）。

## 验收步骤

1. 在 `~/workspace/foundry-dev314/packages/worker` 运行 `pnpm build` 后，`node scripts/run-worker-tests.mjs -- cli-value-parsing.test.mjs`，预期 13 项 PASS。
2. 用一个以 `-` 开头的令牌（或任意 `-` 开头的字符串）执行 `foundry-worker setup --token -abc`，预期不再报 E1002；加上 `--workspace` 等参数后仍进入配对流程。不要在真实 Worker 状态目录上执行（参见 `where-things-live.md`，使用 `FOUNDRY_STATE_ROOT` 指向临时目录）。
3. `foundry-worker setup --token --no-service`，预期 `ERROR [E1002] MISSING_VALUE: --token requires a string value.`。

## 部署后检查

- 2026-11-19，部署后由 conductor（sess_1794766761859841092）在 dev 上检查，编排者转述：`foundry-worker setup --token -abc` 解析通过；无效令牌报 E5001。原始输出未记入本文件。
