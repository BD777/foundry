# DEV-141 CI 跟随 ubuntu-latest 换到 26.04 后 verify 失败

状态：已修复，ubuntu-26.04 上完整 verify 通过；同一改动中撤销 PR #205 的 24.04 固定。只改 CI 和测试，不改产品代码。

## 问题

GitHub 的 `ubuntu-latest` 从 24.04（镜像 20261025.353.1，main 010cd3dd 的 run 41891466422 通过）换成 26.04（镜像 20261101.186.1）之后，代码未变，main 的 verify 开始失败（main c7257bdc run 42063558365，PR #205 run 42070663710）。

## 根因

1. resource-pool 的 5 项浏览器回收测试（reclaimSessionResources 返回 `[]`）：测试把 `/bin/sleep` 复制成 `chromium-child` 当浏览器子进程。26.04 的 `/bin/sleep` 链接到 uutils coreutils 多调用程序（`/usr/lib/cargo/bin/coreutils/sleep`），它按自身文件名选择工具，以 `chromium-child` 运行时打印 `coreutils: unknown program 'chromium-child'` 后立即退出，所以回收时已经没有可关的进程。`ubuntu:26.04` 容器复现；同一个程序以 `chromium-sleep` 命名（uutils 接受的 `<prefix>-<tool>` 形式）能正常运行，`/proc/<pid>/exe` 和 comm 仍是浏览器式名称。/proc 读取、ptrace 限制都不是原因。
2. verification-response-schema 的 2 项测试（`agent_verifier_isolation_unavailable`）：worker 测试启动器本身就在 bwrap 里运行套件，被测的只读 verifier 沙箱又要在里面再启动一次 bwrap。26.04 加载了 AppArmor 的 `bwrap-userns-restrict` 配置：bwrap 的所有子进程以 `unpriv_bwrap` 堆叠约束（`deny capability`），内层 bwrap 没有 CAP_SYS_ADMIN，无法创建命名空间。dmesg 能看到 `apparmor="DENIED" operation="capable" profile="unpriv_bwrap" comm="bwrap" capname="sys_admin"`。workflow 里已有的 `kernel.apparmor_restrict_unprivileged_userns=0` 只解除了外层限制；单层 bwrap 和产品就绪探针在 runner 上本来都正常，所以 `sandboxReady` 返回 true。产品的探针在嵌套环境里如实失败，不需要修改。
3. connectors-session-environment（测试 248–253）：runner 上有真实的 `/usr/bin/gh`。编排会话已在 1503861c 改为使用测试专用的工具 PATH，本项只是确认。

## 修复

- `packages/worker/test/resource-pool.test.mjs`：假浏览器子进程改名为 `chromium-sleep`，同时适用于 GNU、BSD 和 uutils 的 sleep，附注释说明原因。
- `.github/workflows/verify.yml`：关闭 userns 限制之后，再卸载 `bwrap-userns-restrict`（该配置只在限制开启时用于放行 bwrap）；冒烟检查改成嵌套 bwrap 加完整命名空间，以后再出现同类问题时，在这一步就会明确失败，不会等到具体测试才暴露。`runs-on` 改回 `ubuntu-latest`。

## 验证

- 26.04 诊断运行：42073822241（单层 bwrap 和各命名空间都正常；改名后 resource-pool 0 失败，verifier 仍失败），42074551176（卸载配置前嵌套 bwrap rc=1、verifier 2 项失败；卸载后嵌套 rc=0，三个测试文件 0 失败）。
- 本机 Debian（GNU sleep）：`run-worker-tests.mjs -- resource-pool` 0 失败。
- 26.04 完整 verify：run 42078509325（ubuntu-26.04，镜像 20261028.624，提交 ba2bfb7c）通过；worker 0 失败（85+1135 通过），web 1015 通过，Go 全通过。此前 run 42076006780 只剩 Go builtinskills revision 测试失败，24.04 上同样失败，与 26.04 无关，已由 9edbdcaa 修复。

## 时间线

- 2026-11-06 01:15–01:40 CST：拉取失败日志，在 26.04 容器和两轮 runner 诊断中定位根因，完成修复。
- 2026-11-06 02:05 CST：变基到 9edbdcaa 后，26.04 完整 verify 通过（run 42078509325）。
