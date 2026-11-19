# DEV-318 通道在有别人在场时的回复：阻塞或失败只点表情，细节走 needs_you

状态：已实现并通过目标测试；已部署 dev（train 100，Server+Worker，2026-11-19 约 08:35Z）；通道内实测待下一次通道运行；待本人验收。未发送任何真实会话消息。补丁：`/tmp/DEV-318.patch`（单个补丁，含 Foundry 改动与 `extensions/open-lark` 描述符；OpenLark 上游仓库不改，见下）。工作树：`~/workspace/foundry-dev318`，分支 `feat/channel-react`，基于 `origin/main`（aa552d8c）。

## 决定（本人，2026-11-19，约束）

助理处理本人的 `/ai` 请求时，若会话里还有别人（私聊对象或群），遇到阻塞（需要本人决定、确认或补充信息）或失败，**不在会话里发任何文字**：用表情标记触发消息（例如 ⏳），细节（发现了什么、选项、原因）只通过 `needs_you` 发给本人。已完成工作的结果、以及本人在该会话里提出的问题的答案，照常在会话里回复。本人原话：「这句也不要回，没有信息量而且打扰人。比较好的效果是直接飞书发给我就好」「用表情」。

## OpenLark 提供什么（已核对，只读）

在 byte-dev（`res_309405e6874f83ccd87c`，共享计算租约 `lease_a7d8796993f378e336d3`，只读命令）上执行：

- `olk --version` → `{"version":"0.3.0"}`，路径 `~/.foundry-tools/bin/olk`。
- `olk im --help` 列出：`react          Add an emoji reaction to a message (write; needs --yes)`。
- `olk im react --help`：`Usage: olk im react messageId key [flags]`，`key` 为「Reaction key, e.g. THUMBSUP」，`--yes` 才执行写入，`--dry-run` 只打印请求。
- `olk im react 7400000000000000001 OnIt --dry-run` 的请求：`POST /messages/7400000000000000001/reactions`，body `{"key":"OnIt"}`。路由见 `catalog/ROUTES.md:289`。
- `skills/olk/SKILL.md:89`：不带 `--yes` 的写入在非交互终端下以退出码 6 拒绝且不发送。

**没有找到的**：OpenLark 的 CLI 与文档都不列出飞书表情 key 的全集，也没有 ⏳ 与 key 的对应。下面的 key 是待确认项（见「未验证」）。

## 设计

1. **描述符新增 `react`**（`serverHeld.events.react`，字符串命令模板）。与 `reply` 一样，只允许 `{message.id}`、`{conversation.id}`、`{thread.id}` 占位符；表情 key 写在模板里，Foundry 不认识任何表情。校验与 `reply.kinds` 共用 `checkCommandTemplate`。
2. **Foundry 只渲染事实**：`NoticeWithFacts` 在有 `reply:` 的同一位置写 `react:` 行，且只在描述符有 `react` 时写（`fillHint` 用最后一条消息的 id，与 `reply:` 相同）。
3. **通道角色指引**（`prompt.ChannelClaudeFile()`，`apps/server/internal/personalagent/prompt/prompt.go`）。通道工作区的 `CLAUDE.md` 每次运行前由 Foundry 整份重写：`assistant/instructions.go` 的 `RunFor` 对通道会话返回 `ChannelClaudeFile()`，`httpapi/session_dispatch.go` 对非托管文件整份写入。Claude Code 的通道会话只加载 `CLAUDE.md`（`packages/worker/src/session/session-launch-options.ts` 的 `personalAgentChannelInstructionFileSettings`，`claude-md`），它再用 `@AGENTS.md` 导入本人的规则。助理的技能只链接到首页，通道会话读不到，所以不用技能。新增「有别人在场时的回复」一节，描述每种情况里会话回复应包含什么，不写关键词规则：
   - 「有别人在场」= 会话里除本人还有其他人（群聊，或与别人的私聊）；本人自聊不算。
   - 阻塞或失败：会话里不发文字；有 `react` 时只用它点表情；细节用 `needs_you`。
   - 结果，以及本人在该会话里提出的问题的答案：照常用 `reply`。
   - 结果与阻塞的判断归助理，拿不准按阻塞处理。
4. **Key 与 ack 分开**：通道在回合开始时给消息加 `ack`（OpenLark 为 `OnIt`），回合结束时删除同一个 key（`DELETE .../reactions/OnIt`）。如果 `react` 也用 `OnIt`，回合结束时标记会被删掉，所以 OpenLark 描述符用了另一个 key。

## 改动文件（Foundry 补丁）

- `contracts/models/connectors.yaml`：`ConnectorEventsSpec.react`（string，`x-go-type: string`）。
- 生成物（`node scripts/generate-contracts.mjs` 写入，未手改）：`apps/server/internal/store/connectors_gen.go`、`apps/server/internal/store/contract-schema.json`、`packages/protocol/src/contract.gen.ts`、`packages/protocol/src/contract-schema.json`。
- `apps/server/internal/connectors/descriptor_checks.go`：新增 `checkCommandTemplate`；`reply.kinds` 改用它；校验 `react`。
- `apps/server/internal/channels/source.go`：`LongPoll.React()`。
- `apps/server/internal/channels/runner.go`：端口 `ReactCommand`。
- `apps/server/internal/channels/dispatch.go`、`notice.go`：`NoticeWithFacts` 增加 `reactCommand` 参数，写 `react:` 行。
- `apps/server/internal/channels/skill.go`：`react` 事实说明，指向 CLAUDE.md 里的「有别人在场时的回复」一节。
- `apps/server/internal/personalagent/prompt/prompt.go`：`ChannelClaudeFile()` 的内容加上「有别人在场时的回复」一节（`channelRepliesSection`）。`prompt_test.go` 的 `TestChannelInstructionFilesStayWithTheChannel` 检查该节。
- `apps/server/internal/httpapi/message_channel_runtime.go`：`messageChannelReactCommand`；把 reply 与 react 共用的加载逻辑抽成 `messageChannelFeedSpec`。
- `apps/server/internal/httpapi/message_channels.go`：接入 `ReactCommand` 端口。
- 测试（新增）：`apps/server/internal/channels/react_test.go`、`apps/server/internal/connectors/descriptor_react_test.go`。
- 本文件与 `docs/devlog/README.md`。

## OpenLark 描述符（并入 `/tmp/DEV-318.patch`，`extensions/open-lark/foundry-extension.json`）

安装到 Worker 的描述符来自本仓库 `extensions/open-lark`（官方扩展由 Worker 包携带，`docs/connector-extensions.md`）。上游 `nwverse/open-lark` 没有这个描述文件，所以不另开上游 PR。

在 `serverHeld.events` 的 `reply` 与 `ack` 之间加一行：

```json
"react": "olk im react {message.id} OneSecond --yes",
```

## 测试

- 通过（byte-dev，`scripts/remote-check.sh --go`，同一租约）：
  - `./internal/channels -run 'TestNoticeStatesTheReaction|TestSeedInstructionsSay|TestNotice'`：ok。
  - `./internal/connectors -run 'TestDescriptorChecks|TestDescriptorAck|Ack'`：ok。
  - `./internal/connectors -run 'TestOpenLarkDescriptor|TestDescriptorChecksTheNotify|TestDescriptorChecksTheReaction'`：ok（包含读取 OpenLark 描述符的测试）。
  - `./internal/httpapi -run 'MessageChannel'`：ok。
  - `./internal/httpapi -run 'TestAckTemplatesFillOpenLark'`：ok。
- 本地：`gofmt -l` 无输出；`extensions/open-lark/foundry-extension.json` JSON 合法。
- 生成：`node scripts/generate-contracts.mjs` 成功（Redocly、openapi-typescript、oapi-codegen）。
- 提示词黄金文件：`apps/server/internal/personalagent/prompt/testdata/*.golden` 不包含通道会话指引（`SeedInstructions` 的文本），本次不需要更新。

## 未验证与待确认

1. **表情 key `OneSecond`：文档确认，图像未确认。** 飞书开放平台的表情类型列表（`https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce`，2026-11-19 只读抓取）列有 `OneSecond`，位于 `OnIt` 与 `VRHeadset` 之间。该页只给图片、不给文字说明，抓取摘要无法确认它是否像 ⏳。未向任何会话写入，也没有使用凭据。**剩余检查：** 第一次真实阻塞案例出现时，确认表情显示的是等待类图标；如果不是，改描述符里的 key 即可（OpenLark 侧的 `react` 模板，见补丁）。
2. **`--yes` 与现有 `reply` 模板不一致**：`react` 模板带 `--yes`，因为非交互运行没有它会以退出码 6 拒绝。现有 `olk im reply {message.id}` 模板没有 `--yes`，按 SKILL.md:89 它也会被拒绝。这是现有问题，本次没有修改，需要本人确认通道会话的 `olk` 环境如何处理写入确认。
3. 没有端到端验证：没有在真实或自聊会话里运行助理，也没有发送表情（按要求不向真实会话发消息）。
4. **Codex 通道会话读不到这一节（未解决，需要决定）。** 通道会话的运行时跟随助理：`apps/server/internal/personalagent/assistant/assistant.go:157`（`fillHelperRun`）和 `inbox.go:309` 按 `snapshot.Runtime == "codex"` 分支，代码里没有把通道会话固定为 Claude。Codex 只读 `AGENTS.md`，不读 `CLAUDE.md`。托管块的做法被 Worker 的一条明确边界挡住：`packages/worker/src/session/personal-agent-files.ts` 的 `writePersonalAgentFiles` 对只读的通道工作区只写 `foundryFactPath` 匹配的文件（`CLAUDE.md`、`.foundry/` 事实），文档注释写明「never the person's AGENTS.md」。要覆盖 Codex，二选一：(a) 放宽这条边界，允许 `AGENTS.md` 的托管块写入只读通道工作区（改变了「本人的 AGENTS.md 不被 Foundry 写」的安全边界，需要本人决定）；(b) 把指引放进每轮输入，这与 DEV-200「每轮输入不变」冲突。本次没有改任何一个。
5. 已存在的通道工作区不需要迁移：`CLAUDE.md` 属于 `foundryFactPath`，每次运行前由 Worker 重写（见上），下一次运行就有这一节。种子 `AGENTS.md` 没有改，DEV-223 的「新默认版本」提示不触发。

## 部署

已部署 dev（train 100，2026-11-19 约 08:35Z）。OpenLark 描述符随扩展发布。`react` 缺失时行为与改动前一致（不写 `react:` 行，指引中的「没有 `react` 时也不发文字」仍然适用）。
