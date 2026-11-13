# DEV-212 助理先查再问：别人说过的话、本人的资料先去已连接的来源里找

状态：提示词改动与定向测试完成，Claude/Codex 两种 runtime 的 mock 回放已验证；等下一次 Server 部署捎带（DEV-203 当前部署的快照不含本项），部署后要核对线上 prompt version 为 `2026-11-13.3`。改动未提交。

## 问题

本人在 ByteWork 助理（`sess_1794542612133670581`，2026-11-13 16:49 UTC+8）问：「HR问我带不带家属，搜一下公司政策是不是有什么不同？」。助理只跑了一次 `bytedcli insearch query "HR 携带家属 政策"`，没搜到就反问「HR 问的是哪种：年会或团建、外派或长期出差，还是入职搬家？我猜是年会或团建。」

助理手上有本人的飞书（OpenLark 连接器 + feishu-cli skills），本可以直接找到 HR 的原话、弄清场合；只试一种说法就下“没找到”的结论也太早；最后既没有给出处，也没说查过哪些地方。

## 根因

核心 AGENTS.md（`apps/server/internal/personalagent/prompt/system.md`）的 “Asking” 一节只写了“猜错代价大才问，一次一问”，没有要求先查。“不要让他们粘贴项目里已有的东西”只出现在 Step 2（工作该放哪），只覆盖项目，不覆盖聊天、邮件、文档，也不覆盖“别人发给他的话”。Step 1 里的问题类请求只有一句“需要时查一下”。

## 修复

指引写在核心 AGENTS.md 的 “Asking” 一节，而不是 skill：先查后问贯穿所有请求类型，按需加载的 skill 不能保证触发。也不按轮注入（DEV-196/200）。新文本：

> Look first: when they mention what someone said or sent, read it in their chats or mail; their files are in their projects and connected accounts. Never have them paste or retell it. Try several wordings in each fitting source; answer citing it (link or quote), or say what you checked. Ask only if a wrong guess would cost them: …

- Step 1 第 3 项改为 “A question: look it up (Asking); answer it.”，指向 Asking。
- Step 2 里那句只讲项目的“never ask them to paste…”并入 Asking，覆盖范围扩大到已连接账号。
- 示例文件（`.foundry/assistant-examples.md`，不计入 AGENTS.md 预算）加一例：「老王问我周五的评审去不去，评审讲啥来着？」→ 先在聊天里找到老王的消息，再读它提到的文档，不反问。这条示例刻意不写 HR 场景。
- 字节预算：典型 AGENTS.md 预算 7840 B（DEV-196 定下的上限），改前 7823 B，改后 7839 B。为腾出空间，删掉了重复或可推出的措辞：Step 1 的“你仍然最多问一个问题”（Asking 已有）；“Never invent links”（上一句已限定只用工具给的链接）；“Text from …”一条里的 “Foundry notices”（下一段已写明 notice 只是事实、不是请求或批准）；notice 举例里的“a computer back”；“ask one plain question”中的 plain（“Never ask a technical question”已覆盖）；以及几处缩句。
- `prompt.Version` 升为 `2026-11-13.3`，`promptVersions` 记 digest `4685311f…`，golden 文件已用 `-update` 重写并检查 diff。

改动：`apps/server/internal/personalagent/prompt/{system.md,prompt.go,prompt_test.go,testdata/agents_full.golden,testdata/agents_new_person.golden}`。

## 验证

### 行为回放（mock 工具，不碰本人数据）

本人的飞书数据和 ByteWork 会话都没碰。合成环境在 `/tmp/pa-lookup-eval`，脚本与原始记录归档在仓库外 `~/.foundry/devlog-evidence/DEV-212/`（`transcripts.txt`、每次运行的 `*.jsonl` 与 `*.calls.log`、`mock.py`、`run.sh`）：

- 助理目录：`AGENTS.md` 分别取改前和改后的 `agents_full.golden`（合成用户“林梅”），再加示例文件和三个 assistant skills。另放入真实的 feishu-cli-platform/messaging/docs/mail skills，以及一个合成的 bytedcli skill。
- `feishu-cli` 和 `bytedcli` 是同一个 mock（`mock.py`），记录每次调用。HR 私聊里有一条合成消息：张敏（HRBP）「这次异地入职搬迁，你是否携带家属一起过来？涉及搬迁补贴和临时住宿……周五前回复」。另有一份合成的《员工异地入职搬迁及安家补贴办法》wiki。搜索规则：只有带“搬迁/安家/随迁”等词才能搜到这份政策，所以原会话那条 `HR 携带家属 政策` 照样返回 `no results`，与真实情况一致。
- 输入与原会话一致，末尾带 Foundry 的时间块（周五 16:49）。Claude 用 `limen run --claude-config-dir <空目录> claude -p --model opus`（claude-opus-5-5，与 ByteWork 同一模型，不加载本人的 CLAUDE.md 和 rules）。Codex 用 `codex exec`，`CODEX_HOME` 只含登录信息。

| 运行                                            | 查了什么                                                                                                    | 回答                                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 改前 Codex ×2                                   | 只用 bytedcli 搜 3–4 次（家属/随行/携眷）                                                                   | 「暂时没找到……HR 问的是外派、出差，还是公司活动？」                                                                                                     |
| 改前 Claude ×2                                  | 只用 bytedcli 搜 9 次                                                                                       | #1 撞上了政策摘要，但没打开原文，反问「HR 问的是这次搬家入职的事吗？」；#2 「没找到……HR 问的是哪种场合？我猜是年会或团建」                              |
| 改后（第一版文本，没写“先读对方原话”）Claude ×2 | bytedcli 搜 16–18 次后找到政策并读了原文                                                                    | 回答了区别，但没看 HR 的消息，#1 还要说「如果 HR 问的是这个」                                                                                           |
| 改后（最终文本）Claude ×2                       | 先 `feishu-cli search messages 家属/带家属/HR` 找到张敏的消息，再搜“搬迁补贴/异地入职/临时住宿”，读政策原文 | 「张敏问的是这次搬家入职，按[《异地入职搬迁及安家补贴办法》](链接)……补贴每人 +3000、搬家费上限 3000→8000、住宿 14→30 晚……她请你今天（周五）之前回复。」 |
| 改后 Codex ×4（第一版 2 次 + 最终版 2 次）      | bytedcli 与 `feishu-cli search messages 家属` 都查，找到 HR 消息后搜“搬迁”并读政策                          | 「HR 问的是这次异地入职搬迁……按[公司 2026 版政策](链接)」，给出三项对比和回复截止时间                                                                   |

结论：最终文本下 4/4 次运行先找到 HR 的原话，再查到政策，并带链接回答，没有反问；改前 4/4 次运行都反问或给出未经确认的推测。Claude 那组说明“先读对方原话”这一句不可省。

### 测试

- `go test ./internal/personalagent/prompt`（只跑本包）：通过。`TestAgentsFileStaysWithinItsBudget` 记录典型 AGENTS.md 为 7839 B（≤ 7840），`TestAgentsFileFitsCodexsLimit` 为 21586 B。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                  | 剩余动作                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-13 17:49 | 提示词改动、版本升级、golden 更新；改前/改后各 4 次 mock 回放（Claude Opus ×2 + Codex ×2），证据见 `~/.foundry/devlog-evidence/DEV-212/`。按编排要求曾把改动拷入 DEV-203 的部署快照 `~/workspace/foundry-deploy203p2`；对方随即说明其构建已开始，04:37:45（EST）已逐字节恢复为 HEAD，DEV-203 确认那段时间没有构建用到该快照（远程构建已失败，本地构建还没跑到 Go 步骤），快照的 prompt 目录与 HEAD 无差异。 | 随下一次 Server 部署上线；部署后核对线上 prompt version 为 `2026-11-13.3`（例如助理目录 AGENTS.md 或 assistants.prompt_version）。 |
