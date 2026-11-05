# DEV-122 外部连接准备超时：时限、重试与报错

## 问题

2026-11-05 09:24，CanWendeMac-mini 上的会话 [`sess_1793797223612066177`](https://dev.foundryapp.app/chats/sess_1793797223612066177)（open-lark-updater，profile「Limen · default」）发出「这里进展如何」后，16 秒就失败：`Run failed — External connection preparation timed out.` 失败前还有一条警告「Foundry tools unavailable」，内容是同一句超时。

## 调查

- 每次启动 Claude 前，Worker 会运行 profile 的外部连接 helper（Limen：`bun ~/.local/share/limen/host-connection-v1/connection.js default ~/.config/limen/client`），等它回一行 JSON（`foundry.connection.v1`）。原来的时限是固定 15 秒，超时后整轮失败，不重试（`packages/worker/src/harness/external-connection.ts`）。
- 会话事件：01:24:26Z 启动 helper，01:24:42Z 判定超时。Limen client 的隧道日志（`~/.config/limen/client/tunnels/events-*.jsonl`）里，这 16 秒内没有任何隧道记录：helper 还没连到网关就被判超时。
- 不是 key 失效：`profiles/default/derived-key.json` 从 10-26 起没有变化，没有重新申请 key。
- 复现：在 Mac mini 上连续运行 helper `--describe` 三次，第一次（冷启动）10.1 秒，后两次各 1.2 秒；冷启动那次，约 9 秒花在第一条隧道建立之前。前一晚 00:20 那轮成功时，helper 启动后不到 1 秒就有隧道记录。
- 当时机器负载高（load 约 6.5，两个 Edge 渲染进程各占满一个 CPU）。同一轮里，Worker 自己在「Skills ready」和「Workspace draft skills」之间停了 31 秒。
- helper 自身的时限比 15 秒宽：检查 key 5 秒，必要时申请新 key 最长 30 秒（`chooseLaunchKey` / `clientPreflight`）。
- 警告标签有误：`claude-sdk.ts` 的包装层里，查询的每个方法都要等启动完成（`ready`）。连接准备失败时，`startClaudeFoundryTools` 调 `setMcpServers` 拿到同一个错误，又把它当成「Foundry tools unavailable」报了一次。
- 报错没有原因：Worker 为防泄露凭据而丢弃 helper 的 stderr，但 Limen helper 失败时输出的是固定格式的错误码（`Limen connection failed (client_auth_failed).`），不含凭据。

## 修复

- `external-connection.ts`：每次尝试的时限从 15 秒改为 45 秒。超时后会关掉 helper，再用一个新的 helper 重试一次；两次都超时才失败，报错写明「the helper did not answer within 45 seconds in 2 attempts」。只有超时才重试，身份变化、返回内容无效、helper 退出等情况直接失败。
- `helperErrorCode`：只保留 stderr 最后 4 KB，从最后一行末尾的括号里取错误码，错误码只能由小写字母和下划线组成。helper 退出时，报错改为 `External connection preparation failed (client_auth_failed). …`。带数字、路径或其他字符的内容一律不透出。
- `claude-sdk.ts` 标记启动失败（`claudeQueryStartFailed`）；`foundry-tools.ts` 遇到启动失败时把错误原样抛给调用方（由调用方关闭 runtime，会话照常报失败），不再报「Foundry tools unavailable」。真正的 MCP 连接错误仍按原样报警告。

## 部署

- Worker 包：`0.5.7-dev.296.g6689b6e3.local.1793852079`。在干净的 worktree 里构建：基线是已部署但还没合入 main 的 `fix/dev107-review`（6689b6e3），只加本修复的 5 个文件，不带主工作区里其他会话未完成的 worker 改动（Claude 提问功能）。和此前线上包 `…269.g97415a6e.local.1793815663` 逐文件对比，worker 只差 `claude-sdk.js`、`external-connection.js`、`foundry-tools.js` 和 `package.json`；protocol 包只少了旧 dist 里残留的 `evidence.gen.*` / `evidence-schema.json`，没有任何地方引用它们。
- 发布到 `~/.foundry/server/worker-packages`，`GET /api/worker/release` 返回新版本。回滚副本在 `~/.foundry/server/worker-packages-rollback/before-dev122-external-connection/`（旧的 release.json 和两个 tgz），另存了 `release.before-dev122.json`。
- Server、Web 不涉及。
- Worker 更新（12:15–12:20，通过 compute lease 后台运行 `foundry-worker update`）：7 台在线设备的 daemon 都报告 `…296.g6689b6e3.local.1793852079`。CanWendeMac-mini、macbook、byte-dev-sg、cottoncpp、limen-canada 的执行宿主已切到新版本（Mac mini 上的执行宿主进程从 `runtime/0.5.7-dev.296…` 启动）。byte-dev（旧宿主 `…269`）和 sg-chaos（旧宿主 `…226`、`…269`，其中一个承载本调查会话）还有回合在旧宿主上运行，等它们结束后再切换，未强停。

## 验证

- 新增测试：helper 一直不回应时重试一次并释放（`hung preparation is bounded, retried once and released`）；冷 helper 第一次错过时限后，第二个 helper 成功（`a cold helper that misses one deadline is retried on a fresh helper`）；helper 失败时只透出错误码，类似密钥的内容不透出（`a failed helper reports only its error code`）；启动失败不再报成 Foundry 工具不可用（`a query that fails to start is not reported as missing Foundry tools`）。
- 主工作区：`external-connection`、`claude-sdk-runtime`、`claude-launch-secrets` 共 31 个测试通过；`scripts/check-changed.sh`：worker build、67 个 worker 测试文件、audit:modules 通过，prettier 已修正。发布用的 worktree：再加上 connector 两个测试文件，共 52 个测试通过。

- 端到端（真实 Limen）：在 CanWendeMac-mini 的 workspace 工作区用「Limen · default」开测试会话 `sess_1793852246395509436`（haiku，只回复 OK）。04:17:27Z 启动 SDK，Limen 隧道日志 04:17:30Z 出现第一条隧道，04:17:48Z 完成，回答「OK」，0 个错误、0 个警告。测试会话已归档。
- 冷启动后的超时与重试没有在真实设备上复现（需要长时间闲置），由单元测试覆盖。真实 helper 的 stderr 格式与源码一致：`Limen connection failed (${code}).`。

## 限制

- 冷启动的 9 秒具体耗在 Limen 的哪一步（helper 进程、本地 client adapter，还是到网关的连接），没有逐步计时，定不了位；这属于 Limen 侧。
- 最坏情况下，一轮会在准备连接上等 90 秒才失败。

## 验收步骤

1. 打开 `sess_1793797223612066177`，重新发送「这里进展如何」。预期：正常开始回答，不出现「External connection preparation timed out」。
2. Mac mini 长时间闲置（例如过夜）后，在 Limen profile 的会话里发第一条消息。预期：可能比平时多等十几秒，但能正常回答。
3. 如果再次失败，报错里会写明「within 45 seconds in 2 attempts」，或带上 helper 的错误码（例如 `(client_auth_failed)`）；事件里不再出现「Foundry tools unavailable」。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                                     | 剩余动作                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 2026-11-05 10:10 | 调查 `sess_1793797223612066177` 的失败：Limen helper 冷启动超过 15 秒（复现 10.1 秒对 1.2 秒），本人同意按建议修复并自行部署。 | 实现、验证、部署                              |
| 2026-11-05 12:15 | 实现与测试完成；Worker `0.5.7-dev.296.g6689b6e3.local.1793852079` 已发布，7 台设备的 daemon 已更新；5 台的执行宿主已切换。     | byte-dev、sg-chaos 的执行宿主等回合结束后切换 |
| 2026-11-05 12:18 | Mac mini 上的 Limen 冒烟会话 `sess_1793852246395509436` 成功（回答 OK，无错误、无警告）。                                      | 人工验收（见验收步骤）                        |
