# DEV-223 助理工作区文件：可浏览、可编辑的文件系统视图

## 状态

已部署 dev（2026-11-13 22:49 UTC+8，conductor sess_1794555762602239151：Server `7fa8a782…`、Web `fe7e3f7b2ed75117`、Worker `0.5.7-dev.357.g8f394c91.local.1794580954`），部署后已用 e2e-alice 在线上验证；等本人验收。没有提交。

来源：编排会话 [sess_1794464313271186377](https://dev.foundryapp.app/chats/sess_1794464313271186377) 转述的本人反馈（2026-11-13）。本人原话：「Assistant的环境的一些信息要让我可读，你就是这样让我可读的？……其实你给我一个file system，就一个file system就可以了。然后我要在Assistant Web里面去update它。而且你只给我channel的信息，那Assistant自己的那个Workspace呢？」；此前还要求「assistant运行的workspace + system prompt的自由编辑权，包括允许assistant自己去update他们」。前置：[DEV-203](DEV-203-message-channels.md) 第二阶段（通道工作区、`write_file`、AGENTS.md 历史）、[DEV-210](DEV-210-workspace-image-preview.md)（工作区图片预览）、[DEV-196](DEV-196-assistant-progressive-disclosure.md) / [DEV-200](DEV-200-assistant-no-injection.md)（AGENTS.md 与 skills 的分工、不注入）。

## 问题

1. 通道卡片里的「运行环境」只是把通道的 AGENTS.md 文本平铺出来，再加几行元数据，看不到工作区里的其他文件。
2. 助理自己的主工作区完全看不到：首页 AGENTS.md 每次对话前都被 Foundry 整份重写（核心提示 + 本人规则 + 记忆 + 指引），本人在任何地方改了都会被覆盖，所以也就没有编辑入口。

## 做法

### 一个入口，一个文件系统视图

- 助理设置「助理」分组新增一节 **「工作区文件」**（`/assistants/{id}/settings/files`），侧栏不变。标题下拉切换「助理主工作区」和每个通道的工作区（「通道 · 名字」），电脑和路径只显示一次。下拉下面写明谁能修改：主工作区是「你和助理自己的对话都可以修改；消息通道的会话不能」，通道工作区是「只有你能修改；通道会话只能读，不能写（由沙箱保证）」。
- 左边是文件树（复用 `components/workspace/workspace-directory-browser.tsx`，即对话里 Workspace files 面板用的那一个），右边是打开的文件：Markdown 渲染、HTML 预览、其余按代码显示（`TextFileView`）；图片沿用 DEV-210 的预览（`WorkspaceImagePreview`），其他二进制文件只提供下载。窄屏上先看到树，点文件后进入文件，再用「全部文件」返回。
- 为了复用，DEV-210 的图片预览、文件读取失败提示、设备文件请求和文本视图从 `features/chat/detail/` 移到 `components/workspace/`（`workspace-image-preview.tsx`、`image-preview-model.ts`、`file-read-feedback.tsx`、`device-file-request.ts`、`workspace-file-view.tsx`），对话页改为从那里引用，行为不变。
- 文本文件：编辑 → 保存时带上读取时的 sha256。文件在别处被改过时（助理自己的对话、其他编辑器），服务端返回 409，页面重新读取后显示「你编辑期间，电脑上的文件被改过了」，并用共享的 `FileDiff` 对比电脑上的内容和你的修改，可以「用我的覆盖」或「放弃我的修改」。另有新建文件（路径里的文件夹会自动创建）、重命名/移动、删除（带确认），均只对文本文件开放。
- 版本历史按「工作区 + 路径」保存（`workspace_file_revisions`，每个文件最多保留 50 个版本）。每次保存都留一个版本；如果保存前文件已在别处被改过，先把那时的内容记为「在别处修改」，第一次保存前的内容记为「第一次修改前」。删除前的内容会留一个「已删除」版本，重命名时版本随文件一起移动。任意版本都可以恢复，恢复后作为一个新版本。DEV-203 的通道 AGENTS.md 历史（`message_channel_instructions`）在启动迁移时复制到新表，旧表保留不删。
- 只有所有者能用：路由在 `/api/personal-agent/files…`（同样挂在 `/api/assistants/{id}/files…` 下），服务端只接受该助理的主工作区和它的通道工作区；读树和下载沿用原有的工作区文件路由。

### 首页 AGENTS.md 归本人所有

- AGENTS.md 分成两部分。顶部是 Foundry 维护的一块（`prompt.ManagedBlock`，用 `<!-- foundry:managed:start … -->` / `<!-- foundry:managed:end -->` 标出），内容是按设置填好的身份（名字、语言、风格）、本人的规则、确认过的记忆和可打开的页面。块下面是说明，归本人：第一次从 `prompt.DefaultInstructions` 种下（即 system.md 去掉开头几行和示例之后的部分），之后 Foundry 不再改写。
- 每次运行前，Server 只把这一块发给 Worker（`personalAgentFiles` 带 `managedBlock: true` 和 `seed`），Worker 用 `withManagedBlock` 只替换文件里的这一块，其余内容原样保留。文件不存在、或者仍是 DEV-223 之前 Foundry 整份写的旧文件（凭只在旧整份文件里出现的两个标题识别）时，写成「块 + 默认说明」，这就是现有助理的迁移：旧文件本来每次都由 Foundry 重新生成，没有本人的内容可丢。如果本人把块删了，下次运行前会把它加回顶部。整份文件的内容也计入 runtime 版本号，所以本人改了说明，下一轮就会换成新的 runtime 去读它。
- 编辑器把这一块显示为「由 Foundry 维护 · 只读」，附说明（这些内容在设置里改），可以展开查看；编辑区只编辑块下面的说明，并显示整份文件的大小，如「7.5 KB / 28 KB」；保存后超过 `AgentsFileMaxBytes` 的会被拒绝（Codex 最多读取 32 KiB 的 AGENTS.md）。
- 新默认版本：记录每个助理的说明是从哪一版默认说明开始的（`assistant_instructions_defaults`，第一次运行或第一次打开时写入）。Foundry 发布了不同的默认说明、且本人的说明和新默认不一样时，显示「Foundry 有新的默认版本」，可以「查看差异」（`FileDiff`），然后「采用」（写入新默认，旧版本留在历史里）或「保留我的」。
- system.md 里「Privacy and your folder」一句随之改为：顶部的块、`.foundry/` 和 skills 由 Foundry 重写，不要改；AGENTS.md 的其余部分归本人，只有本人要求改变工作方式时才改。prompt 版本升到 `2026-11-13.4`；典型 AGENTS.md 8096 B（预算从 7840 调到 8100，多出的是两个标记和归属说明）。
- 仍保持不注入（DEV-200）：块只放事实与本人的规则，每轮输入不变。
- 只读的生成文件：主工作区里的 `.foundry/`（项目索引、示例、助理 skills、Worker 状态），以及 `.claude/skills`、`.agents/skills` 下指向助理 skills 的链接。编辑器会显示「Foundry 每次对话前都会重写这个文件，这里只读」，服务端也拒绝写入、重命名和删除它们。暂不提供把生成的 skill fork 成自己的 skill。
- 旧 Worker：没有 `assistant_instructions_block` 能力的 Worker 仍收到整份文件（`prompt.AgentsFile` = 块 + 默认说明），编辑器把首页 AGENTS.md 标成只读并提示更新 Worker；没有 `workspace_file_manage` 能力的 Worker 不显示重命名/删除。
- 换电脑时，AGENTS.md 和 `cards/`、`notes/`、`log/` 一起复制到新电脑；新建的助理目录直接写入「空块 + 默认说明」。

### 通道

- 通道卡片的「运行环境」面板去掉，换成「工作区文件」按钮，直接打开该通道的工作区；通道工作区还没建好时，按钮禁用并说明原因。旧的 `…/channels/{id}/instructions` 接口及其类型删除。

## 改动范围

- 契约：`contracts/models/assistant_files.yaml`（新），`message_channels.yaml` 删去 instructions 类型；生成的 TS / Go / JSON Schema。
- 协议：`ManageFilePayload` / `FileManagedPayload`（`manage_file` / `file_managed`），`SetupWorkspaceFile.managedBlock` / `seed`。
- Worker：`session/files/workspace-file-write.ts`（`manageWorkspaceFile`：只处理普通文件，不处理文件夹、链接和 `.git`，重命名不覆盖已有文件，带 sha 检查），`daemon/handlers/files.ts`，`session/personal-agent-files.ts`（`withManagedBlock`），新增能力 `workspace_file_manage`、`assistant_instructions_block`。
- Server：`httpapi/assistant_files.go`（新），`sqlitestore/workspace_files.go`（新表与迁移），`store/assistant_files.go`，`prompt/prompt.go`（`ManagedBlock`、`DefaultInstructions`、`SplitAgentsFile`、`JoinAgentsFile`、`InitialAgentsFile`），`session_dispatch.go`（按 Worker 能力发块或整份文件），`assistant/instructions.go`（记录默认说明起点），`assistant/assistant.go`、`assistant/home.go`（新建目录和换电脑），`message_channel_runtime.go`（版本写入新表，删去旧接口），`wire_drift_test.go`（补上 `write_file` / `file_written` / `manage_file` / `file_managed`，以及 DEV-217 漏登记的 `set_worker_proxy` / `worker_proxy_set`）。
- Web：`features/personal-agent/settings-files.tsx`、`settings-file-editor.tsx`、`settings-file-history.tsx`（新），`assistant-settings.tsx`、`settings-channels.tsx`、`lib/assistant-settings-sections.ts`，删去 `settings-channel-environment.tsx`；中英文文案。
- 文档：`docs/personal-agent.md` §2、§12。

## 检查

| 检查                                                                                                                                                                                                                                                          | 结果                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| byte-dev：`remote-check --web typecheck`                                                                                                                                                                                                                      | 通过                                                                                                                                                                                                          |
| byte-dev：`go test ./internal/httpapi ./internal/personalagent/... ./internal/sqlitestore -run 'TestAssistant\|TestMessageChannel\|TestChannel\|TestPersonalAgent\|TestEveryPrompt\|TestAgentsFile\|TestTheDesign\|TestWire\|TestSetup\|TestRoute\|TestMove'` | 全部通过（新增 `assistant_files_test.go` 3 项：首页说明在块下、过期保存 409、超限 400、不能删 AGENTS.md；生成文件只读、新建/重命名/删除并保留版本、他人和非助理工作区 404；旧 Worker 只读、新默认版本的采用） |
| byte-dev：Worker `assistant-workspace-files.test.mjs`（9 项）、`workspace-file-write.test.mjs`                                                                                                                                                                | 通过                                                                                                                                                                                                          |
| byte-dev：Web `personal-agent`、`app-navigation`、`message-channel-model`、`chat-image-file-preview`、`chat-html-file-view`、`file-delivery`                                                                                                                  | 通过                                                                                                                                                                                                          |
| `pnpm audit:ui`（15 项）                                                                                                                                                                                                                                      | 通过                                                                                                                                                                                                          |
| `go test ./internal/personalagent/prompt`（golden 已更新，新 prompt 版本的摘要已登记）                                                                                                                                                                        | 通过                                                                                                                                                                                                          |

## 端到端（scratch 栈，空库，没有用本人账号）

- `scripts/scratch-stack.sh up dev223`：`SCRATCH_SRC` 指向本项的 worktree，`SCRATCH_SOURCE_DB` 是一个空库，以 scratch-admin 登录，`FOUNDRY_INTEGRATIONS=off`。本机配对一个使用本项 Worker 构建的 Worker（独立 state root），新建助理「DEV223 助理」，主目录为 `~/Foundry/personal-agent-13`。另登记合成工作区 `/tmp/dev223-channel`，并直接写入一条合成通道 `mch_dev223synthetic`（已停用）。
- API：新助理的 AGENTS.md 以「空块 + 默认说明」开头；通过 `PUT /files` 在说明顶部加一条合成规则后，又发一条合成收件消息触发一次运行（模型没有登录，回合本身没有跑起来，但 Worker 在启动运行之前已写好文件）。运行后，文件顶部的块已填好身份、规则和记忆（「You are DEV223 助理…」），本人加的规则原样保留在块下面；`.claude/skills` 已链接三个助理 skill。
- 浏览器（Chromium，zh-CN，1440×900 与 390×844，浅色与深色）：打开主工作区的 AGENTS.md，展开只读块，显示「7.5 KB / 28 KB」；编辑过程中由脚本往电脑上的文件末尾追加一行，再点保存，出现冲突提示和差异对比，选择「用我的覆盖」后保存成功；历史里依次是「第一次修改前」「在这里修改」「在别处修改」「在这里修改」「当前」；切到「通道 · DEV223 合成通道」，看到 `.foundry/`、`notes/`、`AGENTS.md`，以及只有本人能写的说明；窄屏下树和文件之间可以来回切换；页面没有报错。
- 截图（正常比例，不入库）：`.foundry/attachments/20261113/dev223/`，包括 `home-agents-{light,dark}-1440.png`、`conflict-*`、`history-*`、`channel-*`、`narrow-tree-*-390.png`、`narrow-file-*-390.png`。
- 清理：见下方时间线。

## 本人验收步骤（部署后）

1. 打开默认助理 → 设置 →「工作区文件」。预期：标题下拉显示「助理主工作区」，下面是电脑名和路径，再下面是谁能修改的说明；左边是文件树。
2. 打开 `AGENTS.md`。预期：顶部是「由 Foundry 维护 · 只读」一块，展开后能看到名字、规则和记忆；下面是「你的说明」，内容就是原来的核心说明，显示大小用量。第一次打开时，现有助理会在下次对话前自动迁移，不丢任何内容。
3. 编辑说明，比如在最前面加一句「回答都以“好的”开头」，然后保存。再和助理说一句话。预期：回复以「好的」开头；历史里多了一个版本，可以恢复。
4. 在助理对话里让它「在 AGENTS.md 里记一条：周报用表格」。预期：它可以写入；回到工作区文件页，历史里出现「在别处修改」，内容里有这一条。
5. 切到 ByteWork 的「通道 · openlark」。预期：看到通道工作区的文件，说明里写明通道会话只读；编辑 AGENTS.md 并保存成功，历史里保留了 DEV-203 时的版本。
6. 消息通道页：通道卡片上原来的「运行环境」换成了「工作区文件」按钮，点击后直接打开该通道的工作区。

## 限制

- 首页 AGENTS.md 只有在 Worker 带 `assistant_instructions_block` 能力后才能编辑，需要发布新 Worker 并更新各台设备；旧 Worker 上编辑器显示只读和原因。
- 生成的助理 skills 只读，还不能 fork 成自己的 skill。
- 换电脑后会建一个新工作区，文件内容会复制过去，但版本历史按工作区保存，不会跟着过去。
- 编辑器是普通文本框，没有语法高亮；单个文件最大 512 KiB，超过 128 KiB 的文件只读显示开头部分。
- 只读块的预览不含记忆发布那一行（那一行要等运行时按会话检查后才写入），因此大小可能比实际少几十个字节。

## 时间线

| 时间（UTC+8）          | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 剩余动作                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 2026-11-13 22:45       | 实现、定向检查与 scratch 栈浏览器验证完成；工作在 worktree `~/workspace/foundry-dev223`（`work/dev223`），补丁交 conductor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 部署、更新 Worker、本人验收                           |
| 2026-11-13 22:49       | conductor 上线（见状态）。迁移：`workspace_file_revisions` 收到 DEV-203 的 1 条通道 AGENTS.md 版本，`assistant_instructions_defaults` 已建；部署前库备份 `backups/foundry-20261113-pre-dev223.db.gz`。Worker 已更新 byte-dev、byte-dev-sg、limen-canada、Mac mini；sg-chaos、cottoncpp 安装中，macbook 离线                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                     |
| 2026-11-13 22:50–22:57 | 线上验证（e2e-alice，没有碰本人账号）：用新发布的 Worker runtime 临时运行 e2e-alice 的合成设备（`dev_a870ddf7-…`，`systemd-run --user` 单元 `dev223-dev148-worker`，DEV-148 的仓库外状态目录）。`files/workspaces` 显示其主工作区在线、`canWrite`/`canManage` 为 true。它的 AGENTS.md 原是 DEV-223 之前 Foundry 整份写的旧文件（第一行 `You are 助理…`，没有块）。发一条合成收件消息后，第一次运行把它迁成「块 + 默认说明」：顶部是块，`# The person's rules` 和 `# What you are for` 各只出现一次，`assistant_instructions_defaults` 写入一行。真实浏览器（Chromium，1440 浅色、390 深色）：打开 AGENTS.md，展开只读块，显示「7.5 KB / 28 KB」；编辑时由脚本往电脑上的文件追加一行，保存后出现冲突提示和差异，选择「用我的覆盖」后保存成功；历史为「第一次修改前」「在这里修改（当前）」；窄屏下树和文件之间可以来回切换。第二条合成消息由 Codex（gpt-6-astra）答「OK」，运行后块仍在顶部，浏览器里加的那行原样保留在块下面。最后用「采用默认」把 e2e-alice 的说明恢复为默认（历史：default/web/seed），登出，删除 cookie，停掉临时 Worker 和它留下的执行宿主。截图：`.foundry/attachments/20261113/dev223/live/`（不入库） | 本人按验收步骤验收；sg-chaos、cottoncpp 装完新 Worker |
