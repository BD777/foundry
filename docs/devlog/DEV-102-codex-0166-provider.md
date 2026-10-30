# DEV-102 · Codex 0.166 拒绝兼容网关会话：进程级 provider、换 provider 时 fork、Codex 升级前兼容性门禁

状态：Worker `0.5.7-dev.168.ga0ba354a.local.1793349927` 已发布（= DEV-101 的 `.1793349062` + 本项）。受影响设备 该 Linux 开发设备（`dev_ab623721-12b2-4b36-9a23-ae28e2f99854`）的 Worker 更新由本人在其空闲时执行。Agent 自验通过；人工验收待确认；未提交。来源：本人截图，会话 `sess_1793346216295934858`（该 Linux 开发设备，profile `codex_provider_llm_gateway`，模型 `flux/gpt-6-astra`）首轮即失败。

## 问题

- 报错 `This chat uses foundry_codex_provider_llm_gateway, but your current provider is openai. Switch to foundry_codex_provider_llm_gateway to continue.`，原生 Codex 线程从未落盘。
- 这句报错由 Codex 二进制本身产生：0.166.0 的二进制里有这段文字，0.163–0.165 没有。该 Linux 开发设备 的托管 Codex 在 10-29 自动升到 0.166.0。
- 影响 0.166 设备上所有走兼容端点（`openai_compatible`）的 Codex 会话；官方登录（`openai`）不受影响。

## 原因

- Foundry 只把 provider（`model_provider` + `[model_providers.<id>]`）放在 `thread/start` / `thread/resume` 的 `config` 里，app-server 进程本身仍是默认的 `openai`。0.166 在 `turn/start` 比较“线程记录的 provider”和“进程的 provider”，不一致就返回 `-32600`，`data.type = modelProviderMismatch`。
- 同一机制让 0.166 把线程固定在创建它的 provider 上：会话中途换到另一个 provider 的 profile 时（服务器 `compatibleAgentSessionProfile` 会保留原生会话），`thread/resume` 返回 `modelProviderNotConfigured` 或 `modelProviderMismatch`。即使新进程里也定义了旧 provider，resume 照样被拒。
- 更深一层的原因：运行时升级时只校验了 `model/list` 握手，没有跑 Foundry 自己的会话流程，所以协议语义变了也照样激活。

本地用真实 0.166.0 和回环假端点复现：`thread/start` 成功（`modelProvider: foundry_x`），`turn/start` 被拒，报错与截图一致。

## 修复（`packages/worker`）

1. 进程级 provider（`runner/codex-app-server.ts` `codexProviderArguments`）：启动 app-server 时用 `-c model_provider=…`、`-c model_providers.<id>={…}` 声明同一个 provider。命令行对本机其他用户可见，所以只放非凭据字段（白名单：name、base_url 去掉 userinfo 和 query、wire_api、env_key、requires_openai_auth、websocket 和重试设置），不放 http_headers、query_params、experimental_bearer_token、auth。完整定义仍只走 stdin 的线程 `config`；实测 0.165 和 0.166 发请求都以线程 config 为准（URL、header、query 都来自线程 config）。
2. 换 provider 时 fork（`codexProviderChanged`）：resume 被拒且 `data.type` 是 `modelProviderMismatch` / `modelProviderNotConfigured` 时，用当前 provider 执行 `thread/fork`，带着历史继续，并在会话里写一条说明。新线程 id 经 `thread.started` 上报。实测 0.166 的 fork 会带上全部历史。`agent-runtime/codex-client.ts` 新增 `CodexRequestError`，保留原生错误的 `data.type`。
3. 升级门禁（`runner/codex-compatibility.ts`，接在 `agent-runtime/adapters.ts` 的安装校验里）：激活新 Codex 前，用会话用的同一个 `CodexAppServerThread` 对回环 Responses 端点依次跑三种线程：新线程、同一 provider 的 resume、换到另一端点的 resume。每次都是独立进程。三项检查：请求打到所选端点；只放在线程 config 里的 header 送达；换端点后历史还在。任何一步失败，更新就失败，当前运行时保持不变（与已有 `model/list` 失败的处理相同）。这一步没有账号、provider 或模型推理参与。持有维护锁时，`runtimeGateHeld` 让探测跳过运行时租约。

## 验证

- 门禁对真实二进制：修复后的代码在 0.163.0、0.164.0、0.165.0、0.166.0 上都通过（1.1–2.4 s）。修复前的代码（只去掉进程级参数）在 0.166.0 上失败，第一步就给出与截图相同的报错，说明本次事故会被门禁拦下；0.165.0 上仍通过。
- 换 provider：真实 0.166 下 resume 被拒，`modelProviderNotConfigured` / `modelProviderMismatch`；fork 后回合完成，请求里带着第一轮的输入。
- 单元测试：`codex-app-server.test.mjs` 新增两项，分别覆盖进程参数（含凭据不出现在命令行）和换 provider 时 fork；`agent-runtime-install.test.mjs` 新增候选版本 1.3.0：`model/list` 通过，但回合被拒，结果是不激活。安装测试改用 `test/fake-codex-app-server.mjs`，它按 0.166 的契约模拟 Codex：进程级 provider、线程固定 provider、fork、请求以线程 config 为准。
- Worker 测试：变更检查选出的 24 个文件，200 项：196 通过、0 失败、4 跳过。发布 worktree 中跑相关 8 个文件，80 项：77 通过、0 失败、3 跳过。prettier 与 `tsc` 通过。
- 已知问题：`codex-app-server.test.mjs` 的 `native compaction notification refreshes work context through turn/steer` 在本机会挂起，本次一直用 `--test-skip-pattern` 跳过。该测试不带 provider 配置，本项不向它的进程加参数。是否是已有问题未单独确认，需要另查。

## 发布

- 打包在 `foundry-dev085b` worktree 中进行。它的源码与 DEV-101 的发布包 `.1793349062` 一致；只拷入本项的 6 个改动文件和 2 个新文件（拷入前确认 worktree 与共享树在这些文件上只差本项改动）。共享树里其他会话未发布的改动（如 `claude-runtime-start.ts`、AWS 连接器）没有打包。
- 与 `.1793349062` 相比，新包的 `dist` 只差 `runner/codex-app-server.js`、`agent-runtime/codex-client.js`、`agent-runtime/adapters.js` 三个文件，外加新增的 `runner/codex-compatibility.js`；Skill 字节相同。
- 上一版 `release.json` 备份为 `worker-packages/release.before-codex-provider.json`。`https://dev.foundryapp.app/api/worker/release` 已返回 `.1793349927`。
- 没有更新任何设备，该 Linux 开发设备 由本人操作。

## 验收步骤（本人）

1. 该 Linux 开发设备 空闲后，在设备页更新 Worker 到 `.1793349927`。
2. 在 `ccm-omh-integration` 工作区用 byte-llm-gateway（`flux/gpt-6-astra`）新开会话，或在原会话重发。预期：正常回答，不再报 provider 不匹配。
3. （可选）在一个已有 gateway 历史的会话里切到另一个 Codex profile 后发消息。预期：会话里出现 “This conversation's model provider changed…” 说明，回答能引用之前的内容。
4. 以后 Codex 自动升级时，如果新版本破坏了这条流程，设备页的 Codex 更新状态会显示 “failed Foundry's compatibility check …”，并继续使用旧版本。

## 时间线

| 时间 (UTC-4)     | 事件                                                    | 证据                  |
| ---------------- | ------------------------------------------------------- | --------------------- |
| 2026-10-30 03:44 | `sess_1793346216295934858` 首轮失败                     | 会话事件              |
| 03:50            | 本地用 0.166 复现，定位到 `turn/start` 的 provider 检查 | 回环复现              |
| 04:45            | Worker `.1793349927` 发布                               | `/api/worker/release` |
