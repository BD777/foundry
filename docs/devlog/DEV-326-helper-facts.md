# DEV-326 帮手看得到本人原话、读得到父会话，回报带本回合的事实

事项 `pai_48f44cc5f939421f9b1edb213bc23067` 的 S2、S3（全局助理可信度审计 §5；本人决定 D3「本人在助理对话里说的授权转给帮手算数，帮手能看到原话与链接，限本轮明确说出的动作」）。分支 `feat/helper-facts`（从 main `7affa523`）。

## 问题与证据

- 11-19 13:13（审计 §2 第 18 行）：助理 `sess_1795058295835254279`（ws_0349…，ByteWork 消息通道）派的帮手 `sess_1795058337567790670`（ws_56c5…，ccm-omh-integration）两次 `read_context` 父会话都返回 `no session or chat … that you can read`（dev 库只读查到的事件 `evt_sess_1795058337567790670_1795058518169_…`、`…_1795065297698_…`）。原因：`canReadSession` 只看工作区；帮手按助理的权限包取工作区，包里没有助理自己的工作区。
- 11-19 11:18（第 17 行）：帮手不认助理转述的「approve上面的mr」。助理转述时帮手只能看到助理的话，看不到本人原话出处。
- 11-18（第 9 行）：帮手回报只带最终答复前 1500 字，没有它实际做了什么的事实。

## 改动

- **S2-2 读父链**：`agentScope`（`access.go`）算出会话自己的父链（`agentLineage`：父、祖父……，只要是同一个人开的，最多 8 层，Issue 里的会话不算），`canReadSession`（`policy.go`）在工作区读权限之外再认这条父链。只开读：控制、文件外读、后台输出仍按原规则。
- **S2-1 原话**：`create_session`、`send_message`、`dispatch_item` 新增 `personQuote`。Foundry 用 `assistant.PersonQuoteSource`（与 update_list 的 quote 同一套 `PersonWords` + `QuoteGrounded`；记忆事实的 `personFactSource` 也改用它）在发送方会话里找本人的那条消息；找到就在消息末尾附上
  `[Foundry checked: the person's own words]`、谁、UTC 时间、会话 id 与链接、原话；找不到就拒绝。回答等待中的审批（Approve/Deny）时不能带。帮手认不认由帮手判断，不加任何引导。
- **S3 回报带证据**：`childTurnFacts`（`child_report_facts.go`）给 turn_end 回报追加「From Foundry's log of this turn」：本回合工具写过的文件（按 inputId，排除只被答复提到的）、工具调用总数/失败数及失败的与最新的几条（状态、时长、工具、摘要）、本回合启动的后台命令及退出码；每项都写明 `read_context` 哪个 scope 能看全。答复超过 1500 字时写明 `read_context scope=thread limit=1 maxChars=<全长>` 读全文。
- 工具说明（`mcp_tools.json`）与 foundry Skill（两份逐字相同）只补充上述事实。

## 检查

- 定向测试先在基线（main `7affa523` + 只加测试）失败，改后通过：`TestHelperReadsItsOwnParentChain`（基线报 `no session or chat … that you can read`，与 11-19 相同）、`TestPersonQuoteTravelsAsACheckedFact`、`TestChildReportStatesWhatTheTurnDid`（CanWendeMac-mini remote-check）。
- 整包 `internal/httpapi -timeout 30m`：唯一失败是 `TestMCPGenericToolDescriptionsStateContractsWithoutWorkflowPolicy` 的描述总长预算（5644 > 5500），已压短 `create_session` 描述到 5500（main 为 5489），重跑 `TestMCP*` 等定向测试。
- `internal/personalagent/assistant` 整包、Worker `foundry-skill.test.mjs`（pass 5）、gofmt、go vet、prettier --check 通过。

## dev 验收步骤

1. 部署后，在一个有权限包限制的助理（如 ByteWork）对话里让它派一个帮手到包内的另一个工作区；在帮手里调 `read_context` 父会话 → 能读到；调另一条不相关的助理对话 → 仍是 not found。
2. 在 e2e-alice 的工作区会话里说一句授权（如「可以部署到 dev」），让它 `create_session` 带 `personQuote: "可以部署到 dev"` → 帮手首条消息末尾有 `[Foundry checked: the person's own words]`、时间、链接与原话；带一句没说过的话 → 调用被拒，提示 `personQuote is not in any one of the person's own messages`。
3. 让一个帮手改一个文件、跑一条会失败的命令后结束回合 → 父会话收到的 turn_end 里有 `Files its tools wrote`、`Tool calls: N, M failed`、失败那条的时长；答复超过 1500 字时有 `read_context scope=thread limit=1 maxChars=…`。

## 限制

- 前台命令的退出码 Worker 没有上报到 Server（只有完成/失败）；回报里只有后台命令带退出码。
- 原话须出自一条消息；跨两条消息的省略引用会被拒。
- 发往正在等审批的会话时带 `personQuote` 会被拒（审批答复只认 Approve）；这条分支没有单独的测试。
- 事实只读帮手最新 2000 个事件；回合更长时标明「its newest 2000 events」。
- 编号 DEV-326 写于 2026-11-23，合入前确认未被占用；`docs/devlog/README.md` 的行由合入方补。
