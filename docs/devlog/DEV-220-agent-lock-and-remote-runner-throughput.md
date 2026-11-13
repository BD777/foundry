# DEV-220 Agent lock visibility and concurrent remote runners

状态：已合入 main（PR #267）。已实现并自验；scripts 与文档改动未提交。

## Problem

2026-11-13 的时间审计显示，子会话可归因时间约 65.5 小时，其中约 19.5 小时在等 `/tmp/fdy-heavy.lock` 或 `/tmp/fdy-deploy.lock`，占 30%。prettier 最长等 heavy 锁 18 分钟；部署锁里还在做 build，最长持有 77 分钟。会话为判断谁持锁执行了 334 次 `ps`/`lsof`/`pgrep`。远程 runner 又只有一个共享 warm checkout，无法让同一设备并发跑多个任务。

## Changes

- `scripts/fdy-lock`：heavy/deploy 共用锁包装器，FIFO ticket、holder sidecar、每 30 秒输出位置/holder、等待与运行时长写入 `~/.foundry/server/lock-log.jsonl`，`status` 显示 holder 与 queue，检测已消失的 holder pid。锁 fd 在命令子进程前关闭。
- `scripts/check-changed.sh`：轻活不取锁；重活改用 `fdy-lock`。远程 job 设置 `FOUNDRY_LOCK_DISABLE=1`，不会拿 sg-chaos 的 heavy 锁。
- `scripts/remote-check.sh` / `remote-build.sh`：支持 `--device mac|byte-dev|byte-dev-sg`、`--resource`、positional lease，离线时按 Mac mini → byte-dev → byte-dev-sg 回退。设备租约默认 `mode: shared`，`REMOTE_LEASE_MODE=exclusive` 才独占。每次调用使用独立 `jobs/<id>/repo`；源码按 base commit 以 tar.gz 缓存在 runner 的 `cache/sources/`，toolchain 和 Go/pnpm/npm cache 共享。无设备级 job 锁，只有 `min(CPUs/2, GiB/4, 16)` 的计数 slot（byte-dev 16、byte-dev-sg 3、Mac mini 4），Go build/test 使用 job 的 CPU 份额。缺 Node≥22、pnpm 或 go.mod 所需 Go 时在 scratch 根内自举。byte-dev 的 `127.0.0.1:12263` relay 会被探测并用于 Go/npm/GitHub；`REMOTE_HTTPS_PROXY` 可显式覆盖。
- `scripts/remote-clean.sh`：默认只删除调用会话的 `jobs/<session>-*`，不碰共享 cache/toolchain 或其他会话；`--root` 才删除整个共享根，并要求没有 live job 或 job slot，另有 cleanup marker 防并发。所有模式都会列出 runner home/tmp 下 Foundry-named 残留；支持 lease、`--device` 和 `--all`。
- `scripts/deploy-dev.sh`：通过 `fdy-lock deploy` 获取部署锁，拒绝 `--build`，锁只覆盖 swap；保留另一会话的 lineage guard，并用 `original_args` 保证锁内 re-exec 参数不丢。`DEPLOY_DRY_RUN=1` 只到锁内 preflight。
- `scripts/lib/remote-fetch.mjs`：非 JSON `device_error` / ping 超时改为退避重试，不与服务器截断的 `Cut` 结果混为一类。
- `scripts/pack-worker-release.mjs`：接受 `WORKER_RELEASE_VERSION`，并增加 `--version-only` / `FOUNDRY_VERSION_ROOT`。`remote-build.sh` 在本地从待构建树算出版本（含 dirty 标记），传入无 `.git` 的远程 job，避免 Worker pack 的 `git describe` 失败。
- 文档：`docs/where-things-live.md`、`docs/agent-orchestration.md`、`.foundry/briefs/worktree-setup.md` 记录分类、测试范围、runner 顺序、并发 slot、sg-chaos-only heavy 锁、部署锁与批次清场。

## Evidence

- `scripts/test-fdy-lock.sh`：holder → waiter-1 → waiter-2 FIFO、queue position、stale holder、JSONL 记录通过。
- `scripts/test-remote-runner-fallback.sh`：Mac mini offline 时 remote-check 与 remote-build 都选择 byte-dev（`fallback=yes`）。
- `scripts/test-deploy-lock-args.sh`：`deploy-dev.sh` 经 `fdy-lock` re-exec 后仍收到 `--prebuilt`、`--label` 和 `--server`，dry run 到锁内步骤通过。
- `scripts/test-remote-fetch-retry.mjs`：两次非 JSON `device_error` 后第三次成功，3 calls。
- 真实 byte-dev-sg：同一 lease 并发两条 remote-check，槽位 1/2，独立 job checkout，共享 toolchain `Node 22.16.0 / Go 1.24.4 / pnpm 11.7.0`，分别 53 s 和 70 s 总耗时，均 PASS；结束 slots=0。
- 真实 byte-dev-sg remote-build `--server`：源码 archive 上传 10,114,485 B，构建 66 s，transfer 403 s（25,885,575 B，当前 Server 把工具结果截成 7 KB，已记录为既有限制），总 571 s；本地 `SHA256SUMS` 校验通过，`go version -m` 确认 Go 1.24.4。
- 真实 byte-dev-sg remote-build `--worker`：`worker 0.5.7-dev.357.g8f394c91`，构建 26 s、transfer 62 s（1,193,390 B），总 120 s；`release.json.version` 与 build-info 一致，SHA256SUMS 通过。
- 传输诊断：直接向 live `/api/mcp` 请求 4 MiB `get_file`，回包在 11,814 B 处截断且不是完整 JSON；不是 probe 误读。服务器仍按工具结果预算截断，7 KB 是当前能完整返回的最大候选；probe 已从 4 MiB 逐级降到 1 MiB / 256 KiB / 64 KiB / 16 KiB / 7 KB，未来 bypass 生效时会自动使用更大片。
- byte-dev 冷启动：空 scratch 上用 shared lease 运行 remote-check，自动探测 `http://127.0.0.1:12263`，Go/npm/pnpm 经 relay 完成，job 使用 16-slot 池中的 slot 3；135 s 总耗时，PASS。
- byte-dev-sg 在并发检查后第一次清场输出 `scratch_root=/home/dengcanwen/.foundry/compute/foundry-remote exists=no`；home/tmp 列表只剩此前存在的 `fdy-*` 日志，没有本批次源码、依赖、cache 或 toolchain。后续 server/worker build 留下的 job 已再次清场并复核根不存在。
- byte-dev 最终用 shared lease 清场，`scratch_root=/home/dengcanwen/.foundry/compute/foundry-remote exists=no`；home/tmp 列出的是一批此前已有的 `fdy-*` 临时目录/日志和 `/tmp/foundry-*` 文件，没有本批次新增目录。清理先因另一会话的 live job 被正确拒绝，待其 job 结束后重试成功；byte-dev-sg 的 build job 也已在最终清场时删除。
- 新清场语义实测：byte-dev 默认模式输出 `removed_own_jobs=0`、`own_jobs_remaining=0`，保留共享根；随后在没有 active slot 时用 `--root` 清整个根，输出 `exists=no`。有另一会话 live job 时 same-root clean 会拒绝。
- 事故与修正：11:3x 的一次 whole-root clean 把 conductor 正在 `foundry-remote` 里跑的 train-2 build 一并删掉。原因是其 private-copy job 没有当前脚本的 `run/*.pid` 或 slot job marker，旧清理逻辑把 slot 当 stale 后删了根。现在默认清场改为会话级，whole-root 必须显式 `--root`，且任何 live slot 都会拒绝；conductor 的 `foundry-remote-train2` 未被触碰。
- `bash -n`、`node --check` 覆盖全部改动脚本。

## Remaining

- 未提交；shared compute lease 已上线，设备自取默认传 `--mode shared`，显式 `REMOTE_LEASE_MODE=exclusive` 可退回独占。
- byte-dev 到 proxy.golang.org / github.com 的网络当前仍不通，因此暂不适合作为源码/依赖冷启动 runner，但清场不需要网络并已完成。

## Acceptance

1. `scripts/fdy-lock status all` 能看到 holder、session、command、startedAt 和 queue；并发等待时 30 秒输出位置。
2. 在 Mac mini 离线、byte-dev 在线时，`scripts/remote-check.sh --device mac …` 打印 fallback 到 byte-dev 并实际运行。
3. 同一 lease 并发运行两条 remote-check，确认各自 `jobs/<id>` 不同、slot 不同、都结束且 slots 回到 0。
4. `scripts/deploy-dev.sh --prebuilt …` 只在锁内 swap；`--build` 被拒绝。
5. 批次结束执行 remote-clean，scratch root 为 `exists=no`；home/tmp 的 Foundry-named 列表没有新增本批次目录。
