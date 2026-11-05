# DEV-127 Limen 模型服务在设备上时有时无

## 问题

2026-11-05，byte-dev 上 ccm-omh-integration 工作区的编排对话 [`sess_1793764358364457763`](https://dev.foundryapp.app/chats/sess_1793764358364457763) 用「Limen · default」。上午（11:45 后）和下午（17:20 前后）两次出现：输入框账号显示「Select」、模型显示「No models」，发送键灰掉且没有原因；第二次发出的消息直接失败：`Agent profile "limen_default" is not configured on this device and was not dispatched with the session.` 而 Limen 在 byte-dev 上一直是登录状态。

## 调查

- dev 数据库（只读）：byte-dev 03:49:36Z 和 09:20:50Z 上报的 profile 里都没有 `limen_default`，同时 Limen 连接器状态是 `ready`、登录名 `default`（03:33、09:12 检查）；03:45 和 08:36 之前 Limen 会话都正常跑。另外 5 台设备的 `limen_default` 一直都在。
- Worker 每 5 分钟重新列一次连接器提供的模型服务（`connectors/extensions/model-access.ts`），结果整份覆盖 `~/.foundry/extension-model-providers.json`，设备的 profile 由它生成。只有扩展抛错时才保留上次的列表。
- 声明式扩展（DEV-115，`declarative.ts` 的 `listModels`）遇到三种情况会返回空列表而不是抛错：`limen status` 报告问题（客户端服务没运行）、找不到会话助手 `bun`、运行 `connection.js <profile> … --describe` 读身份失败或超时。空列表照样覆盖，profile 就从设备上消失，直到下一次 5 分钟检查成功。
- `--describe` 不只是读本地配置：它要求 Limen 客户端服务在运行，并经代理向网关做一次实时检查（`chooseLaunchKey` → `clientPreflight`，5 秒超时）。所以网关慢一下、代理抖一下，profile 就会被删掉。sg-chaos 上连续运行 3 次各 1.2–2 秒，都成功：平时没问题，偶尔一次失败就会把它删掉。
- byte-dev 上具体是哪一步失败没有确认：按合规要求没有在 byte-dev 上运行诊断，旧代码这条路径也不写日志。
- Web：恢复对话的 agent 不在列表里时，`selectedAgent` 为空，`use-chat-feature.tsx` 禁用发送；设备在线时 `sendDisabledReason` 是 `undefined`，所以按钮灰了却不说原因。不可用的 agent 也只显示「在此设备上不可用」，看不到 Worker 给的原因。

## 修复

- 原则：profile 还在不在，只看连接器自己的列表（`limen status` 里的 profile）。此刻用不了不等于没有。
- 协议 `ExtensionModelProfile` 加可选 `problem`：已加入但此刻用不了时，扩展写自己的一句原因，`identity` 可以为空。
- `declarative.ts`：status 读成功后，每个列出的 profile 都返回。status 报问题、找不到 `bun`、读身份失败或超时，都写成 `problem`（如 `Limen · default could not confirm its identity: bun did not answer in 30s`），不再整份返回空。status 本身读不出来照旧抛错，保留上次的列表。
- `model-access.ts`：带 `problem` 的 profile 沿用上次验证的连接（helper、参数、身份），所以检查指纹、验证结果和对话数据目录都不变；从未验证过的则身份为空，不能启动会话。只有连接器的回答里不再有它，才从设备上删除。
- `profiles.ts`：这样的 profile 状态为 `unavailable`，`statusDetail` 是那句原因。
- `connectors/index.ts`：有 profile 带问题时，每 1 分钟重新列一次，不再等 5 分钟。
- Web：设备在线、对话原来的账号已不在这台设备上时，输入框写明「这条对话使用的账号已不在这台设备上，换一个账号后再发送。」；账号不可用且 Worker 给了原因时，显示「在此设备上暂不可用：<原因>」。`useChatRuntime` 返回 `selectedAgentMissing`。
- 文档：`docs/connector-extensions.md`「模型接入」补充以上规则。

## 部署

- 在 `foundry-int` 构建（持有 `/tmp/fdy-deploy.lock`）。构建前核对过：`foundry-int` 的 worker dist 与线上包 `…1793871893` 一致，之后 src 没有改动。本项文件直接复制进去，`declarative.ts` 和 `connector-extensions.test.mjs` 用 `git apply --3way` 合入，两者都没有冲突。
- Worker `0.5.7-dev.269.g97415a6e.local.1793872470`：与线上包相比只有 `declarative.js`、`model-access.js`、`connectors/index.js`、`harness/profiles.js` 和 `package.json` 不同。回滚副本在 `~/.foundry/server/worker-packages-rollback/before-dev127-limen-flap/`，另存了 `release.before-dev127.json`。随后 DEV-121 会话在其上加自己的改动，发布了 `…1793872794`（已含本项）。
- Worker 更新（18:00–18:13，通过 compute lease 后台运行 `foundry-worker update`）：byte-dev、CanWendeMac-mini、sg-chaos、cottoncpp、byte-dev-sg、limen-canada 都报告 `…1793872470`。macbook 的 Worker 在 `~/.foundry-stacks/dev/bin/`，用那个路径更新后报告 `…1793872794`。之后 byte-dev 被 DEV-121 会话更新到 `…1793872794`。
- Web `7072d87c25e09110`（之前 `ea8038c615236943`，备份在 `~/.foundry/server/web-releases/dev127-limen/`）。
- Server 不涉及。

## 验证

- 新增或扩展的测试：
  - `connector-declarative.test.mjs`：服务没运行、helper 读身份失败时，profile 仍列出并带原因。
  - `connector-extensions.test.mjs` 的新测试 `a provider that cannot be used now stays, unavailable with the reason`：
    - 网关没回应时 profile 保留，身份和指纹不变，状态是不可用并带原因，并在 1 分钟后重试；
    - 恢复后变回可用；
    - 退出登录后才删除；
    - 从未验证过的 profile 列出但不能启动会话。
  - `chat-runtime-selection.test.mjs`：`selectedAgentMissing`。
- `foundry-int`：connector-declarative 3、connector-extensions 13、external-connection 22、external-connection-setup 6、external-connection-registry 8、model-access-boundary 4、provider-check-state 3，以及 Web chat-runtime-selection 11、chat-runtime-choice 3、agent-picker 15、i18n 3，全部通过。Worker 和 Web 构建、Web typecheck 都通过。
- 主工作区的 `scripts/check-changed.sh`：prettier 一开始失败，已修正；worker 构建与 `sessions get the device's login…` 测试失败，原因是另一会话正在改的 `device-held.ts`（`sessionCheck`，protocol 还没导出），不是本项。
- 线上：byte-dev 更新后 09:56:43Z 起重新上报 `limen_default`（healthy）。10:08Z 时 `ws_56c549f3` 的 Limen agent 是 healthy。sg-chaos 上 `extension-model-providers.json` 里有 `limen_default`，身份完整。

## 限制

- 「检查失败但 profile 保留」这条路径没有在真实设备上演示：需要让 Limen 客户端服务或网关故障，而本会话自己就在用 Limen，停服务会断掉正在运行的会话。这条路径由单元测试覆盖。
- 输入框的两条新提示没有在真实浏览器里看过（本人的账号不在本会话可用范围内，合成账号上也没有对应场景），由单元测试覆盖。
- profile 暂时不可用时（最多约 1 分钟）仍然不能发送，但会显示原因，不会再被删除。

## 验收步骤

1. 打开 byte-dev 上 ccm-omh-integration 的那条编排对话：输入框应显示「Limen · default」，发送键可用，发一条消息能正常回复。
2. 之后几小时里，这个账号不应再变成「Select」/「No models」。如果 Limen 网关真的出问题，输入框应显示「在此设备上暂不可用：…」加原因，恢复后约 1 分钟内自动变回可用。
3. 设备页 byte-dev 的模型服务里，「Limen · default」应该一直在。

## 时间线

- 2026-11-05 18:13 Worker `…1793872470` 和 Web `7072d87c25e09110` 已部署；7 台设备都运行含本项的 Worker；byte-dev 的 `limen_default` 已恢复。未提交；待人工验收。
