# DEV-191 多助理：权限集、分层记忆、channel（设计草案）

## 状态

已合入 main（PR #264，squash 7e2a354c）。

设计草案，等本人拍板（2026-11-12，[编排会话](https://dev.foundryapp.app/chats/sess_1794464313271186377)）。现状地图见只读调查 [sess_1794474387399464358](https://dev.foundryapp.app/chats/sess_1794474387399464358)，本文中的 path:line 都来自那次调查。

## 目标与边界

- 同一个账号、同一个人下可以有多个助理，用来区分工作和生活，或者区分不同的工作。目的是**分开上下文、用对身份**，不是防着本人。
- 隔离强度是「默认可见与召回范围」加上「Foundry 能管住的入口」（MCP、网关、派发、资源租约）。helper 在设备上仍然能读写它所在的文件系统，不做操作系统级沙箱。

## 现状要点

- **一人一个助理**：`personal_agents` 以 `user_id` 为主键，`workspace_id` 唯一（sqlitestore/personal_agent.go:30-43）。所有 `pa_*` 表都只按 user 分区；API 固定为 `/api/personal-agent/...`；Web 固定为 `/assistant`。
- **权限包（PermissionPackage）**：字段已有 workspaces include/exclude、connectorAccounts off/read/write、directLeaseAllowed、skills（store/personal_agent_gen.go:37-58）；统一判定在 `internal/permission`。下面这些地方**没有接入或可以绕过**：
  - `dispatch_item` 往新会话派发时不检查工作区（assistant/operations.go:24-58）；
  - helper 不继承权限包，用的是项目自己绑定的连接器，资源也走普通规则（permission/permission.go:34-83）；
  - helper 写入时也不会触发风险确认（gateway/pipeline.go:283）；
  - `feishu_events` 订阅不看权限包（httpapi/feishu_events.go:43-53）；
  - skills 和 directLeaseAllowed 字段写了，但没有任何生产代码在用；
  - device-held 连接器的 read 权限实际也能写。
- **Memory**：旧的 `pa_memory` 和新的 knowledge vault 两套并存，都是一个用户一份。每轮常驻上下文里注入的仍然是 `pa_memory`。
- **Upkeep**：memory review 和项目治理按 user 调度；项目摘要按 (user, workspace) 存，任何助理都能读到。
- **Channel**：Web 一个入口；飞书只有单聊能进 `pa_inbox`。连接器扩展的 descriptor 没有事件源字段；飞书事件只保存 24 小时的去重回执，订阅和游标都只在内存里。

## 设计

### 1. 助理对象

- 新增 `assistants(id, owner_user_id, name, home_workspace_id, home_device_id, state, settings_json, permission_package_id, …)`。现有的 `personal_agents` 行迁移成该用户的第一个助理，并标记为 `is_default`。
- 每个助理有自己的 home 工作区（`kind=personal_agent`，一个助理一个），里面放它的 AGENTS.md、channel 程序和工作笔记。
- 所有 `pa_*` 表、`pending_items`（只针对助理负责的那部分）、`pa_inbox`、`pa_maintenance` 都加上 `assistant_id`，回填为默认助理。
- API 改为 `/api/assistants/{id}/...`；`/api/personal-agent/...` 在过渡期作为默认助理的别名，Web 同步切换后删掉。
- MCP 的助理身份从「`personal_agent` 角色加 user」改为「`assistant_id`」，所有工具都按 assistant_id 取数据。
- 停止、继续、用量上限、每日摘要都按助理分别控制。

### 2. 权限集（每个助理一个 PermissionPackage）

| 项                      | 规则                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作区（设备 + 工作区） | include 列表。**新建的助理默认一个都没有，需要显式添加**；迁移过来的默认助理保持现在的「全部」。工作区可以同时授权给多个助理。                                                                                                                                |
| 连接器账号              | off/read/write，沿用现有规则；对外发消息等风险写操作必须先出确认卡片。                                                                                                                                                                                        |
| Skills                  | **跟着工作区走**：工作区绑定的 skills 加上用户级默认 skills，所有助理共享。删掉权限包里的 skills 字段，因为 skill 是能力说明，不携带数据。                                                                                                                    |
| 资源                    | **分两类**：compute、GPU、容器、工具链、磁盘这类不带身份的资源，**跟着设备走**，助理有该设备上的任一工作区就能用；浏览器（带登录态）、屏幕控制、设备 CLI 账号、手机这类带身份的资源，**要按助理显式授权**。把 directLeaseAllowed 扩展成 `identityResources`。 |
| 模型                    | 不属于权限，属于设置：助理自己的运行模型（runDefault），以及它派活时用的执行模型（DEV-188，可以按助理覆盖）。                                                                                                                                                 |

**判定点必须全部接入**（这是多助理成立的前提，单助理时也该修）：

- 助理派出的 helper 一律带上 `assistant_id`，继承权限包；它的连接器、资源、MCP 工具，以及风险确认，都按这个助理判定。
- `dispatch_item` 和 `create_workspace` 要检查权限包。
- `feishu_events` 和以后的事件源订阅要检查权限包。
- 项目摘要和 project upkeep 的产出，只给有该工作区权限的助理看。
- device-held 连接器的 read 实际不能挡住写：这一点要在 UI 上写明，并建议这类连接器只授权给确实需要的助理。

### 3. Memory 分层

- **个人层（全局）**：关于你这个人的内容，比如称呼、偏好、风格、长期事实，所有助理共享。
- **助理层**：这个助理所在领域的上下文，比如工作里的人、项目、约定，只有它自己能读写。每个助理一个 memory vault，`knowledge_vaults` 的唯一键从 user 改为 (user, assistant)。
- 召回范围：个人层 + 自己的助理层。`remember` 默认写入当前助理层；明确是关于你本人的内容，写入个人层。你可以在 UI 里把条目在两层之间移动。
- 同时把旧 `pa_memory` 收拢到 vault，结束两套并存，每轮常驻注入也改为从 vault 读取（有字数上限）。
- 业界做法：ChatGPT Projects 有「只用本项目记忆」的选项，Claude 的 Projects 也是按项目分开记忆。这里是凭知识引用，没有重新核对原文。

### 4. Upkeep

- **调度保持全局**（你提的第 6 点），**数据按范围处理**：
  - memory upkeep 按 vault 逐个运行，个人层和每个助理层各自独立，每次运行只能看到它负责的那个 vault；
  - project upkeep 和项目摘要按工作区运行，结果全局只存一份，读取时按助理的权限包过滤。
- 工作区本来就可以同时授权给多个助理，所以项目层面的维护天然是跨助理共享的。

### 5. Channel

**对话型（你主动找助理）**

- Web：每个助理有自己的聊天页 `/assistants/{id}`。
- 飞书单聊：一个飞书应用绑定一个助理，配对关系落在 channel binding 上。
- 新增 `assistant_channels(id, assistant_id, kind, config)`。inbox 按 channel 找到对应的助理，不再按用户找。

**事件流型（新增：外部消息源进入助理）**

1. **采集（Foundry，通用能力）**
   - 连接器扩展的 descriptor 增加 `events` 能力，用来声明怎么订阅（运行哪条命令或哪个端点）、游标格式和事件 id。
   - 由持有该连接器实例的地方常驻运行：server-held 的在 Server 上运行，device-held 的由对应设备的 Worker 运行。
   - Foundry 负责持久化游标、去重、断线续传、限流和积压告警。
   - Foundry 代码里不出现任何 open-lark 特有的东西；open-lark 只在它自己的扩展里实现 `events`。
2. **过滤（你的程序）**
   - 每个事件源配一个过滤程序，文件放在助理的 home 工作区。Worker 把事件 JSON 从标准输入传进去，程序输出 keep / drop，以及附加的标签和归属的线程键。
   - 这一步是确定性的，不调用模型，用来控制成本。
3. **分诊与响应（助理）**
   - 留下来的事件按时间窗口攒批后，交给助理会话处理，同时附上这个事件源的处理说明（你的 prompt）。
   - 助理可以：忽略、归并到已有线程、更新待办或记忆、生成「等你处理」，或者起草回复。对外发出必须经过确认卡片。
4. **多路之间的关系**
   - 同一来源会话（或者过滤程序给出的线程键）自动归成同一个线程。
   - 不同来源之间是否相关，由助理根据人、项目、话题来判断，可以把它们合并到同一件事里。
   - 每轮上下文里只带有限条「打开中的线程」，其余靠工具按需读取。
5. **护栏**
   - 每个事件源有每小时的事件数上限和模型预算上限，超出后先暂停分诊，再通知你，采集继续进行、不丢数据。
   - 原始事件只保留它的 id、游标和过滤后的摘录，设保留期限，不长期存放全文。

业界做法：Slack Events API（event_id 去重、失败重放），Kafka 消费者的位移，Zapier / n8n 的「触发器 → 过滤 → 动作」。这里也是凭知识引用。

## 越权风险清单

1. helper 不继承权限包：工作助理派出的 helper 会用到全部连接器和资源。必须最先修。
2. `dispatch_item` 可以派活到被排除的工作区。
3. `feishu_events` 或事件源绕过权限包，生活助理可能订阅到工作消息。
4. 项目摘要、「等你处理」、任务按 user 共享，导致跨助理的召回。
5. memory 只有一层，工作和生活的内容会互相召回。
6. channel 路由错误，消息进了错误的助理。
7. 带身份的资源被错误的助理使用，比如工作上的操作用了个人浏览器的登录态。
8. device-held 连接器的 read 实际可以写（已知限制）。
9. 停止或上限误伤：停一个助理时，其他助理也被停掉。
10. 事件流刷屏耗尽额度，或者自动对外回复。

## 实施切片（拍板后再细分）

- **P0**：补齐权限判定，即修复风险清单第 1–3 条。单助理也受益，可以先做。
- **P1**：多助理数据模型，包括迁移、API、MCP 身份、Web（列表 / 新建 / 切换 / 各自设置）、按助理停止和上限。
- **P2**：memory 分层，同时收拢旧 `pa_memory`。
- **P3**：对话型 channel 绑定，包括按助理的 Web 页面和飞书单聊。
- **P4**：事件源 channel。分三步：Foundry 的 descriptor `events` 能力、采集运行器和过滤程序；助理分诊；open-lark 在它自己的扩展里实现 `events`。
- **P5**：upkeep 按 vault 和按权限包过滤。

## 本人决定（2026-11-12）

1. 新建的助理默认没有任何工作区，由本人逐个添加。添加界面要好用：按设备分组、可以搜索和多选，也可以「从已有助理复制」。
2. memory 分两层。**归属上都属于这个人；分层管的是召回时谁能看到。** 全局层只放「换哪个助理都成立、都有用」、与具体领域无关的内容，例如称呼、语言、风格、工具、一般偏好；工作或生活里的具体人、项目、安排留在各自助理的层里。memory upkeep 会自动下沉：内容是关于本人的，并且没有提到任何工作区、项目或具体的人，就移到全局层，同时记日志、可以撤回；拿不准的生成「建议下沉」，由本人确认。
3. 带身份的资源在 Foundry Web 上按助理勾选。这只是 Foundry 内部的授权，连接器账号沿用已经做过的第三方授权，不需要重新授权。
4. 飞书：一个应用对应一个助理。
5. 事件过滤程序：脚本放在助理的 home 工作区，从 stdin 读入事件 JSON，输出处理结果。
6. 隔离不做重：做到上下文和身份分开即可。
7. 可以开始实施。目标是今晚出第一版能用。

补充：沿用编排者 / 执行者的分工。助理本身作为协调者（coordinator 角色），用一个强模型，只负责把事情路由到各个工作区；具体工作交给 helper（executor 角色）。executor 角色改用执行模型配置（DEV-188：默认加可选列表，可以填 group），每个助理可以单独覆盖。现有基础是 `personalagent/run_config.go` 里的 RunRoles 和 RoleOverrides。

## 第一版范围（今晚）

- P0：补齐权限判定（helper 继承权限包、dispatch/create_workspace、feishu_events、带身份的资源）。
- P1：多助理的数据模型、API、MCP 身份和 Web（列表、新建、切换、每个助理独立的聊天页和设置），以及权限集编辑器。
- P2：memory 两层，召回时用全局层加本助理层；自动下沉放到第二版。
- P3：飞书一个应用对应一个助理。
- executor 角色接入执行模型配置。
- 不在第一版：P4 事件流 channel（下一版）、memory 自动下沉、P5 upkeep 按 vault 拆分（第一版先让读取按权限包过滤）。

## A1 交接（P1 Server：多助理数据模型与助理身份，2026-11-12）

### assistant_id 落在哪里

- **`assistants` 表**（`apps/server/internal/sqlitestore/assistants.go`）：`id`（`asst_…`）、`owner_user_id`、`name`、`is_default`（部分唯一索引 `idx_assistants_default`：每人一个默认）、`home_workspace_id`（UNIQUE）、`home_device_id`、`state`、`settings_json`、`permission_package_id`、`prompt_version`、`created_at/updated_at/stopped_at`、`former_workspace_ids`、`digest_sent_on`、`connector_opt_out`。旧 `personal_agents` 每行按原字段复制为该用户的默认助理，然后改名为 `personal_agents_legacy` 保留（只读、不再访问）。迁移每次启动都跑，幂等：已有默认助理的人、已被占用的工作区会跳过；旧表不存在就什么都不做。
- **`assistant_id` 列**（`setupAssistantRecords`，回填为该用户的默认助理）：`pa_proposals`、`pa_tasks`、`pa_actions`、`pa_routing_decisions`、`pa_items`、`pa_inbox`、`pa_operations`、`pa_run_snapshots`、`pa_run_controls`、`pa_maintenance`、`pa_context_patches`、`pa_direct_chats`、`pa_memory`、`pending_items`（只回填 `handler='assistant'` 的；新项凡是某个助理 helper 产生的都会记录）、`knowledge_vaults`（只回填 `kind='memory'` 的）。
- **改成按助理的键**：`pa_items` 的 capture 唯一键改为 `(assistant_id, capture_key)`；收件箱排队（一次只投递一条）、maintenance 并发（同时只跑一个）、每日 maintenance 上限、每日摘要（`assistants.digest_sent_on`）、停止/继续、用量上限，全部按助理计算。
- **刻意保留按人的键**：`pa_inbox UNIQUE(user_id, channel, message_id)`（消息 id 本身就唯一）；`pa_maintenance UNIQUE(user_id, role, workspace_id, event_key)`（项目 upkeep 是全局的，A1 只由默认助理采集，见下）；`pa_direct_chats` 主键 `(user_id, app_id)`（P3 再改）；`workspace_digests` 不加列（P0 在读取时过滤）。
- **会话 → 助理**：`agent_sessions` 不加列。`AssistantForSession(sessionID)` 按 lineage 找：会话所在工作区是某个助理的 home（或 former home）就是那个助理；否则看 `pa_tasks.session_id`，再看 `pa_operations` 中 payload 的 `sessionId`。run control 和 run snapshot 自己带 `assistant_id`。

### 新的 store 与 API

- Store（`apps/server/internal/store/personal_agent.go`）：`GetAssistant(id)`、`ListAssistants(owner)`、`DefaultAssistant(owner)`、`AssistantForWorkspace(ws)`（原 `PersonalAgentForWorkspace`）、`AssistantForSession(session)`、`RenameAssistant`、`DeleteAssistant`、`RunSnapshotForUser(user, id)`（`apps/server/internal/store/personal_agent_runtime.go`）。设置、状态、home、提议、任务、动作、路由决策、清单、收件箱、操作、run snapshot/control、maintenance、context patch 的读写都改为传 `assistantID`；新建这些记录时必须带 `AssistantID`。
- 助理服务（`apps/server/internal/personalagent/assistant`）：`Stop/Resume/ExpireProposals/RefreshTasks/SaveSettings/HandOverAll/CaptureInbox/RetryInbox/MoveHome` 都改为接收助理；新增 `Create`（新建非默认助理，home 工作区的创建流程与 Setup 相同）、`Delete`、`OverviewOf`；`Handler` 会同时返回 helper 所属的助理。
- 权限包：`PermissionListRule.scope`（`all` 或 `listed`，契约见 `contracts/models/personal_agent.yaml`）。新建助理的 `workspaces` 是 `scope: listed` 且 include 为空，即一个工作区都没有；默认助理的包不变。
- HTTP（`apps/server/internal/httpapi/routes.go` 的 `assistantRoutes`、`assistants.go`）：
  - `GET /api/assistants` 返回 `AssistantList`；
  - `POST /api/assistants`，请求体是 `CreateAssistantInput{name, homeDeviceId}`；
  - `GET /api/assistants/{id}` 返回 overview；
  - `PATCH /api/assistants/{id}`，请求体是 `UpdateAssistantInput{name}`；
  - `DELETE /api/assistants/{id}`：默认助理返回 409。删除非默认助理时会先 Stop（取消它的会话和 helper），删掉它自己的 pa_* 记录和权限包，它负责过的「等你处理」交还本人（`assistant_id` 清空），home 工作区归档成普通项目，会话保留；
  - 每条 `/api/personal-agent/<rest>` 都有 `/api/assistants/{id}/<rest>`，两者共用同一个 handler。访问规则 `assistantOwner()`：只有本人能访问，路径里的助理不是本人的就返回 404。会话 token 不能调用这些路由，助理会话只能通过 MCP 访问，范围由 `paScope` 按会话所在的 home 工作区确定。

### 过渡层（以后删除）

- `/api/personal-agent/...` 指向默认助理：`personalAgentOf`/`requestAssistant`（`apps/server/internal/httpapi/personal_agent.go`）没有 `{assistant}` 参数时就用默认助理。Web 全部改用 `/api/assistants/{id}/...` 之后，删掉 `assistantRoutes` 里的复制逻辑和原 `/api/personal-agent` 路由。
- `GetPersonalAgent(userID)` 等于 `DefaultAssistant`，在接口上已标注为过渡用法。剩下的调用点都标了 `Transitional (DEV-191 A1)`：飞书 desk（`personal_agent_feishu.go`、`personal_agent_channel_inbox.go`）、memory publication 的目标（`knowledge/publications.go`）、项目摘要（`workspace_digests.go`）、Setup 的「是否已经有助理」检查。upkeep 的采集（`CaptureMaintenanceEvents`）只对默认助理运行。
- 旧 `pa_memory` 的读写仍然按人，所有助理共享；每条新记录会写上写入它的 `assistant_id`。

### 后续切片怎么用

- **P0 权限判定**：用 `store.AssistantForSession(sessionID)` 找到会话所属的助理（helper 通过 `pa_tasks` 或 `pa_operations` 找到），再用 `GetPermissionPackage(agent.UserID, agent.PermissionPackageID)` 判定。`permission.Resolve` 目前仍然只认助理自己的顶层会话，P0 改成通过 `AssistantForSession` 覆盖 helper。网关风险确认已经带上 `ConfirmationRequest.AssistantID`。
- **P2 memory 分层**：`knowledge_vaults` 已经有 `assistant_id`（默认助理的 memory vault 已回填）。把 `idx_knowledge_primary ON knowledge_vaults(user_id) WHERE kind='memory'` 换成「个人层：`assistant_id=''` 时每人一个」加上「助理层：`(user_id, assistant_id)` 唯一」。`pa_memory.assistant_id` 记录了写入的助理，可以用来拆分。publication 的目标改为按 vault 所属的助理决定。
- **Web**：列表、切换用 `GET /api/assistants`；新建用 `POST /api/assistants`；改名和删除用 `PATCH/DELETE /api/assistants/{id}`；每个助理的聊天页和设置页把现有 `/api/personal-agent/<rest>` 调用换成 `/api/assistants/{id}/<rest>`；权限集编辑器读写 `/api/assistants/{id}/permission-package`（`workspaces.scope: listed`）。类型在 `@bd777/foundry-protocol` 里：`AssistantSummary`、`AssistantList`、`CreateAssistantInput`、`UpdateAssistantInput`、`PermissionListScope`，`PersonalAgent` 新增了 `id/name/isDefault`。
- **P3 飞书**：在 `assistant_channels`（或 settings）上记录 `assistant_id + app_id` 的绑定。`personalAgentDesk` 的 `Route/Stop/Resume/PendingProposals/CaptureInbox` 从 `DefaultAssistant(userID)` 改为按 app 找到助理。`pa_direct_chats` 的主键改为 `(assistant_id, app_id)`，或者保持 `(user_id, app_id)` 并保证一个 app 只对应一个助理。

### A1 部署与验证（2026-11-12）

- 迁移在 10:29:39Z 已由并行会话从共享工作树部署到 dev（当时测试还没改完）。对照最终代码核对过：`assistants` 有 2 行，与 `personal_agents_legacy` 的 2 行逐字段一致（home_workspace_id、home_device_id、state、settings_json、permission_package_id、created_at、former_workspace_ids、digest_sent_on 都没有差异），每人一个默认助理。下列 15 张表都已有 `assistant_id` 列和索引，`idx_pa_items_assistant_capture` 已建，旧的 `idx_pa_items_capture` 已删。回填结果：
  - pa_tasks 9/9、pa_actions 32/32、pa_items 10/10、pa_inbox 21/21、pa_operations 11/11、pa_run_snapshots 215/215、pa_run_controls 148/148、pa_maintenance 114/114、pa_context_patches 1/1、pa_memory 1/1；
  - pa_proposals、pa_routing_decisions、pa_direct_chats 都是 0 行；
  - pending_items 108 行中没有 `handler='assistant'` 的，所以 0 行需要回填；
  - knowledge_vaults 中 memory 类型的 1/1 已回填，domain 类型的 1 行保持为空。
  - 迁移每次启动都会重跑，都是 `IF NOT EXISTS`、忽略 duplicate column 和只更新 `assistant_id=''` 的行，所以在半迁移的库上也能补齐。
- 10:43:13Z 部署最终构建（`releases/dev023-candidate/foundry-server`；上一份二进制保存为 `foundry-server.pre-dev191-a1`，这份已包含早先那次部署的 DEV-191 代码；真正迁移前的二进制是 `foundry-server.pre-dev189`）。`/healthz` 返回 200，pm2 状态 online，restarts 稳定在 64，日志里没有迁移错误。
- 备份：`backups/foundry-20261112-pre-dev191-a1.db`（10:41:50Z，`integrity_check` 结果为 ok）是迁移**之后**的状态。迁移前唯一的库是 `backups/foundry-20261112-0112-pre-guides-groups.db`（06:12Z），保留不删。
- e2e-alice（通过 dev 公网 API）：
  - `GET /api/assistants` 返回 1 个默认助理 `asst_3fc8…`；`GET /api/personal-agent` 和 `GET /api/assistants/{id}` 返回同一个助理。
  - `POST /api/assistants`（名为「DEV191 synthetic」，home 设备是 VM-4-8-debian）返回 201，其权限包为 `workspaces={"scope":"listed","include":[],"exclude":[]}`，默认助理的包保持不变。
  - 删除默认助理返回 409，删除新助理返回 204，之后访问它返回 404。它的 home 工作区 `ws_abb1da38…` 已归档为 project，设备上的目录保留。
  - 最后已登出，临时目录已删除。

### 回退到 personal_agents 结构

1. `pm2 stop foundry-server`。
2. 换回 `releases/dev023-candidate/foundry-server.pre-dev189`（DEV-191 之前的二进制）。
3. 数据有两种做法：
   - 方法 A：保留迁移后新写入的数据。在当前库里执行：
     ```sql
     DROP TABLE IF EXISTS personal_agents;
     ALTER TABLE personal_agents_legacy RENAME TO personal_agents;
     UPDATE personal_agents
       SET settings_json = a.settings_json, state = a.state, home_device_id = a.home_device_id,
           workspace_id = a.home_workspace_id, permission_package_id = a.permission_package_id,
           former_workspace_ids = a.former_workspace_ids, digest_sent_on = a.digest_sent_on,
           stopped_at = a.stopped_at, updated_at = a.updated_at
       FROM assistants a
       WHERE a.owner_user_id = personal_agents.user_id AND a.is_default = 1;
     ```
     执行前先改名备份当前库。旧二进制会忽略 `assistants` 表和各表多出来的 `assistant_id` 列，所有 SQL 都是显式列名，多出的列默认为 `''`。唯一需要处理的是 `pa_items` 的 capture 唯一索引：执行 `DROP INDEX idx_pa_items_assistant_capture`，旧二进制启动时会重建 `idx_pa_items_capture`。另外，旧代码对 `pa_maintenance` 和 `pa_context_patches` 用的是按位置的 `INSERT … VALUES`，表多一列就会写入失败，所以还要执行：`DROP INDEX idx_pa_maintenance_assistant; ALTER TABLE pa_maintenance DROP COLUMN assistant_id; DROP INDEX idx_pa_context_patches_assistant; ALTER TABLE pa_context_patches DROP COLUMN assistant_id;`（需要 SQLite ≥ 3.35）。
   - 方法 B：放弃 06:12Z 之后的所有数据，把当前库改名保留后，用 `foundry-20261112-0112-pre-guides-groups.db` 替换。
4. 执行 `pm2 start foundry-server`，然后检查 `/healthz`。

## P0 交接（权限判定补齐，2026-11-12，worktree `foundry-dev191-p0`，未部署）

- **谁按权限包判定**：`permission.Resolve` 覆盖助理自己的会话（`Access.Home`）和 helper：`AssistantForSession` 找到的会话，以及沿 `ParentSessionID` 最多 8 层找到的、由 helper 再派出的会话；会话创建人必须是助理的主人。其他会话 `Applicable=false`，行为不变。
- **连接器**：helper 只用「工作区绑定 ∩ 权限包不是 off」（`externalaccounts.Policy.Bound`）；`PersonalAgent()` 现在只指助理自己的会话（用本人全部账号）。网关对 helper 同样拒绝 off、`read` 拒绝写、风险写出确认卡片（`AssistantID` 为所属助理）。device-held 的 off 对 helper 生效；read 仍然挡不住写。
- **工作区**：agent token 可达的工作区按权限包过滤，但自己所在的工作区总能到；助理工具的 scope 只收录权限包允许的工作区（原来 key 全收、只把 owner 置 false，`get_workspace`、`find_workspace` 因此能读到被排除的工作区，已修）。`dispatch_item` 捕获时检查；派发执行时（`DeliverOperation`）和 `run.Resolve` 再检查，home 工作区豁免。`create_workspace` 建成后把新工作区加入本助理的 include（理由：助理自己建的项目，不加入就立刻不可见）。
- **项目摘要**：仍按人存一份；`workspaceCandidates(agent)` 按该助理的权限包过滤，提示词里的项目索引和 `find_workspace` 都经过它；`get_workspace` 经 scope 过滤。
- **资源**：`identityResources: {scope: all|listed, allowed: res_…[]}` 替代 `devicesResources.directLeaseAllowed`；带身份的类型见 `permission.IdentityResourceType`。helper 租用：`scope: listed` 时带身份的资源必须在 allowed 里；其余情况（`scope: all`，或不带身份的资源）要求助理在该设备上有被允许的工作区。默认包是 `all`，新建助理是 `listed` 且为空。启动迁移：旧 `directLeaseAllowed` 非空 → `listed` + 这些设备上已知的带身份资源；为空时默认助理 → `all`、其他助理 → `listed`；同时去掉 `skills`、`devicesResources`。浏览器目前不经租约（`$FOUNDRY_BROWSER_BIN` 由 Worker 注入），所以对浏览器只管住了 MCP 租用这条路。
- **性能**：`idx_pa_operations_session` 表达式索引覆盖 `AssistantForSession` 对 `payload_json.$.sessionId` 的查找（`pa_tasks` 已有 `idx_pa_tasks_session`），查询计划由测试锁定。
- **feishu_events**：helper 订阅时，App 必须至少有一个权限包不是 off 的账号，否则 403。

## P2 交接（memory 两层，2026-11-12，worktree dev191-p2，未部署）

- **数据**：`knowledge_vaults` 加 `scope` 列；唯一键 `idx_knowledge_memory_layer(user_id, scope, assistant_id) WHERE kind='memory'` 取代 `idx_knowledge_primary`。个人层 `scope=person, assistant_id=''`，id 仍是原来的 `flow.Key("vault", user, "memory")`；助理层 `scope=assistant`，id `flow.Key("vault", user, "memory", assistantID)`，第一次需要时建在该助理 home 工作区的 `.foundry/memory`（`knowledge.EnsureMemoryLayer`）。迁移只改 `kind='memory' AND scope=''` 的行（改成个人层并清空 A1 回填的 `assistant_id`），每次启动重跑也只命中一次；A1 的 `assistantRecordTables` 不再回填 `knowledge_vaults`。删除助理时它的助理层保持原样（没有别的助理能读到）。
- **为什么现有 vault 当个人层**：它本来就按人建 id、放在独立的「Personal Memory」工作区而不在助理 home 里，`remember` 的描述也一直是「关于这个人的事实」；当个人层不需要改 id、不搬文件，默认助理的召回与之前一样，只是多了一层空的助理层。代价：里面若有具体工作内容，新助理也会看到，需要本人在 Web 移层。
- **召回**：每轮常驻注入（`assistant/recall.go` `turnMemory`，2,000 字上限不变）、`read_memory`（同文件 `ReadMemory`）都读「个人层 + 当前助理层」的当前条目，正文按需从设备读（读不到时用标题）；尚未复制完成的旧 `pa_memory` 已确认条目作为个人层兜底显示。`read_knowledge` 的 `memory_root` publication 只对「个人层或本助理层」有效（`knowledge/publications.go` `CheckPublication`），`listSources` 不列别的助理层。
- **写入**：`remember` 新增 `scope: assistant|person`（默认 assistant）；改、忘按条目所在层；旧 `pa_memory` 条目只允许 forget。Web 旧接口 `POST/PUT /memory` 返回 409。
- **结束双轨**：`knowledge` 的 Drain 把已确认的旧条目逐条复制到个人层（`knowledge_legacy_transfers.status = copying → copied`），没有个人层时用默认助理的 home 设备建「Personal Memory」（失败 10 分钟后再试）；`pa_memory` 原行保留只读，表不删。
- **Upkeep**：memory review 仍一个 vault 一个任务，助理层的任务记在该助理名下，`MaintenancePrompt` 拒绝读别的助理的层。
- **API**（`/api/assistants/{id}/…` 与 `/api/personal-agent/…` 同一 handler）：`GET memory/layers` → `AssistantMemoryLayers`；`POST memory/layers/{scope}/entries` ← `AddMemoryEntryInput`；`POST memory/entries/{entry}/move` ← `MoveMemoryEntryInput` → `MemoryEntryMove`（先写目标层、再忘源条目，按 revision/hash 校验，重放幂等）；`POST knowledge/vaults/{vault}/assistant-access` 按路径里的助理授权。
- **未做**：自动下沉；`system.md` 里关于 remember 的说明没改（改它要升 prompt 版本，留给合并时统一处理）。

## v1 合并与部署（2026-11-12，P0 + P2 + P3 + Web）

### 合并

- 方法：四个 worktree 各自的 `git diff`（基线为各自暂存区）逐文件用 `git merge-file` 三方合并到 dev 检出，生成文件（`contract.gen.ts`、两份 `contract-schema.json`、`store/*_gen.go`）不合并，合并后重新生成。dev 检出里这些切片文件自基线以来都没有被别的改动碰过，所以 DEV-189 S2a、executor 执行模型等后来的改动都原样保留。
- `sqlitestore/assistants.go`：三方自动合并，三者语义都在：P0 新建助理写入 `identityResources: listed + []`；P2 把 `knowledge_vaults` 移出 `assistantRecordTables`（不回填、删助理时不动它的层）；P3 加 `idx_assistants_feishu_app` 唯一索引、`AssistantForFeishuApp` 和 `pa_direct_chats` 主键迁移到 `(assistant_id, app_id)`。
- `contracts/models/personal_agent.yaml`：P0、P2、P3 的定点追加自动合并，重新生成契约并构建 protocol。
- `packages/protocol/src/personal-agent.ts`：手工解决导出冲突，P2 的 memory 类型加 P0 的 `PermissionIdentityResources`（`PermissionDeviceResources` 已随 P0 删除）。
- `apps/web/src/api/personal-agent.ts`：保留 Web 的按 `assistantId` 调用的版本。P3 的入口设置只新增了 `listAssistants()`（列出全部助理，本身不按助理）；按助理的部分是「这个 App 是否已被别的助理占用」：`EntrySection` 现在接收 `assistantId`，按占用者的 id 判断，不再把本助理自己占用的 App 显示成被占用。
- `mcp_tools.json`、`routes.go`：只有 P2 改动，无冲突。
- P3 飞书 `SettingsURL` 改为该助理自己的设置页 `/assistants/{id}/settings`（新增 `personalagent.AssistantSettingsPath`；没有 id 时仍为 `/assistant/settings`）。
- P2 风险 7：`system.md` 的 Memory 一节按新行为改写（两层、`scope person` 的用法、quote 找不到或自己的推断时什么都不写、要先问本人；update/forget 带 revision 和 hash），删掉旧的「Memory Workspace 里 inferred 等确认」说法；prompt 版本升到 `2026-11-12.2`，`prompt_test` 记下新 hash，golden 重新生成。改写后 AGENTS.md 比改写前少 23 字节。
- 批量检查顺带修掉的本批问题：两个 Web 测试还在用旧签名（`setPersonalAgentConnectors(undefined, levels)`、`PlacesSection` 的新 props）；`workspace-access-editor.tsx` 的保存和复制失败改用 `ToastFeedback`（`audit-feedback`）；契约一致性补了 TS 字段 `PersonalAgentMemoryItem.scope` 和 `PersonalAgentOperation.executionChoice`（后者来自 executor 执行模型改动）；本文件的 prettier。

### 检查

- sg-chaos：`go build ./...`、`go vet ./internal/...`、Web `typecheck`、`generate-contracts --check` 通过。
- CanWendeMac-mini `remote-check.sh --files`（本批 123 个文件）：第一轮发现的本批失败都已修复；第二轮在 Web 测试后断开（Mac 重连），`sidebar-scope.test.mjs` 在该轮超时，但第一轮在 Mac 上通过、本机连跑 4 次都通过，判断为负载下的偶发超时。第二轮没跑完的部分在本机补跑：`personalagent/...` Go 测试、protocol 测试（90/90）、全部 Web audit、`audit:contract`、`audit:modules`。第一轮里 connectors、feishu、sqlitestore（含 P2 的 `knowledge_memory_layers_test.go`）、httpapi（含 P0 的 `assistant_permissions_test.go`、P2 的 `personal_agent_memory_layers_test.go`）、permission、gateway、externalaccounts、assistant、knowledge 全部通过；Web 新增的 `assistants-web.test.mjs` 本机通过。
- 剩下的失败都不属于本批：`TestAgentsFileFitsCodexsLimit`（AGENTS.md 29,061 字节，上限 28,672，改前就超）；`connectors-feature.tsx` 和 `server-held-connector.tsx` 的行数审计；`audit-hints` 的 `profiles/model-guide-dialog.tsx:114`、`profiles/unlinked-models.tsx:94`（model guides 的改动）；`audit:modules` 的 `sqlitestore imports jsonempty`（A1 已部署的 `assistants.go`）和 `store.Store 73 → 74`（DEV-189 S2a 的 `SetDeviceStatus`）。

### 部署

- 备份：`backups/foundry-20261112-pre-dev191-v1.db.gz`（11:57Z `VACUUM INTO`，`integrity_check` ok；为让磁盘可用空间保持在 5 GiB 以上，按旧备份惯例压缩，解压后 sha256 `4ee66df2…96cc1`，与压缩前一致）。旧备份一个没删。二进制备份：`releases/dev023-candidate/foundry-server.pre-dev191-v1`。
- Server：11:58:16Z 部署，pm2 online，之后 5 分钟以上 restarts 稳定在 66，本机和公网 `/healthz` 都是 200，日志里没有迁移错误。只读核对：两个默认助理的包都是 `identityResources {scope: all, allowed: []}`，`devicesResources`、`skills` 已去掉；`knowledge_vaults` 有 `scope` 列，`idx_knowledge_memory_layer` 已建，原来的 memory vault 成为个人层（`scope=person, assistant_id=''`）；`pa_direct_chats` 主键为 `(assistant_id, app_id)`；`idx_assistants_feishu_app`、`idx_pa_operations_session` 已建。
- Web：`web-releases/dev191-v1`，build `47a9d998efad669c`（上一版 `a0f257aa3a46bbb8` 存在 `previous-20261112T120015Z`）。
- Worker：不发布。上次 Worker 包之后改动的只有 protocol（`contract-schema.json`、`contract.gen.ts`、`personal-agent.ts`、`personal-agent-operation.ts`、`knowledge-vault.ts`）；Worker 源码不引用这些类型，`contract-schema.json` 变化的 schema 只有助理、权限包、memory 层和执行模型选择，Worker 运行时都不用。

### e2e-alice 验收（公网 dev API + 无头 Chromium）

- `GET /api/assistants` 返回 1 个默认助理。`POST /api/assistants`（「DEV191 v1 synthetic」，home 为 VM-4-8-debian）返回 201；它的权限包是 `workspaces {scope: listed, include: []}`、`identityResources {scope: listed, allowed: []}`。在设置页「在哪里做事」里勾选 `dev023-dependency-source` 并保存，API 读回的 include 就是这个工作区。`GET memory/layers` 返回两层：个人层（已有 1 条）和空的助理层。`DELETE` 返回 204，之后再访问返回 404。最后已登出（401）、浏览器已关闭、临时目录已删除。
- 截图（1280 宽、浅色）：`.foundry/attachments/20261112/dev191-list.png`、`dev191-workspaces.png`（搜索「dev0」，按设备分组，已选 1 个）、`dev191-sidebar-single.png`。
- 附带发现：用 API 直接 PUT 一个本人已看不到的工作区 id（旧的 DEV-048 合成工作区）也会被接受，设置页会忽略它并显示「已选 0 个」。

### 已知限制

- 浏览器启动器（`$FOUNDRY_BROWSER_BIN`）不经租约，所以不受权限包约束，只有 MCP 租用这一条路受管。
- device-held 连接器的 read 挡不住写。
- memory 召回每轮最多读 4 秒，读不到正文时只用标题。
- 保存权限包时 Server 不校验 include 里的工作区是否可达（见上）。
- 除飞书外，提示词里的设置链接和用量上限提示仍然指向默认助理的 `/assistant/settings`。
- 旧 `pa_memory` 迁移：windeng 有 1 条已确认的旧条目，但没有个人层。部署后第一次 drain 没有成功，失败原因不写日志；推测是 Server 刚重启时 Mac 还没重连。10 分钟后重试成功（12:09Z 前）：在默认助理的 home 设备 CanWendeMac-mini 上建了个人层 `vault_13db1699…`（工作区 `ws_49f7642e…`），`knowledge_legacy_transfers` 记录 1 条 `copied`。这会在本人的 Mac 上新建一个私有 memory 工作区，是 P2 的设计行为。建议给 `legacyLayer` 和 `drainLegacyMemory` 的错误补上日志。

## v1b 补充合并与部署（2026-11-12）

- 20:48 CST：web2 的 14 个文件与 srv2 的 11 个文件按暂存基线逐文件 `git merge-file` 三方合并，无冲突；Server 权限包引用校验、每助理设置链接、legacy memory 日志，和 Web 两层 memory、身份资源勾选、默认助理菜单、执行模型继承摘要都进入 dev。检查发现旧的 `TestAssistantLimits` 断言未跟上设置链接迁移，且 prompt 超过 `AGENTS.md` 上限；已将断言改为该助理自己的路径，把测试夹具改为真实 `/assistants/{id}/settings` 路径，将文案压到 28,672 字节内、prompt 升到 `2026-11-12.3` 并重新生成 golden。`go build ./...`、Server 指定正则测试、Web `tsc`、37 个改动测试通过；`audit-hints` 仅剩 `model-guide-dialog.tsx:114` 和 `unlinked-models.tsx:94` 两条已知失败，其余三项审计通过。Server 最终部署为 `5521876828437bbc…`（备份 `foundry-server.pre-dev191-v1b`），PM2 online 且 30 秒内保持 restarts=68，`/healthz` 200；Web 发布 build `d0c667fcd552460a`（前一版 `47a9d998efad669c`）。e2e-alice 截图：`dev191b-memory.png`、`dev191b-identity.png`、`dev191b-default-menu.png`、`dev191b-exec-inherit.png`（1280×900、浅色）。截图后合成助理已删除，浏览器已登出并关闭，临时目录已删除；记忆层页面没有删除入口，已通过同源 knowledge `forget` 请求清理本次产生的一条 `DEV191 synthetic memory` 条目并复核为空。
- 21:25 CST：助理提示词瘦身，`system.md` 从 31,173 字节减到 15,513 字节，版本升到 `2026-11-12.4`；工具机制留在工具描述，golden 重新生成，`AGENTS.md` 从 28,312 字节减到 14,496 字节。Server 部署为 `04ef9a75573711518305e343e9c2693c96c80cdc7e2844f85a355796b4560eff`，PM2 restarts 70 且 30 秒内未变，本地与公网 `/healthz` 均为 200。

## 记忆自动整理（2026-11-12，worktree memory-sort）

起因：P2 把原来唯一的 memory vault 直接当成个人层，里面有默认助理记下的工作内容（例如某位同事是 QA、在维护提测 Workflow），新助理 ByteWork 也能看到。

- **判断与执行分开**：memory review 的输出新增 `placements[]`（`entryId`、`belongs: person|assistant`、`confidence: high|medium|low`、`reason`、`mentions`），只有 memory 角色可以返回。执行在 `knowledge/sorting.go` 的 `SortLayer`：
  - 个人层 → 来源助理的层：`belongs=assistant` 或 `mentions` 非空就自动移。来源从 `sourceRef` 推：`session:` 按 `AssistantForSession`，`legacy-memory:` 按 `pa_memory.assistant_id`，查不到的一律算默认助理。
  - 助理层 → 个人层：`belongs=person`、`mentions` 为空、`confidence=high` 时自动移；`belongs=person`、`mentions` 为空但置信度不是 high 的，生成「建议共享」；`mentions` 非空的一律不动（代码兜底）。
  - 已经被移动过的条目（`sourceRef` 以 `memory-move:` 开头，不管是整理、撤回还是本人手动移的）不再参与整理，避免来回移动，也不覆盖本人的决定。
- **正文**：review 仍然是只读 verifier 会话，提示词只给脱敏后的索引；正文由 review 在本机读条目文件 `<root>/<id>.md`（verifier 本来就能读自己工作区的文件），只在这个会话里使用。日志表只存标题、一句理由、mentions，不存正文；服务器日志里不打印任何条目内容。
- **移动**：复用 `MoveEntry`（先写目标层，再 forget 源条目；重放幂等）。记录表 `memory_sorts`（`setupMemorySorts`，幂等建表），一条记录对应一个源条目（`MemorySortID(vault, entry)`）：move 的状态为 `moving → moved | failed`，撤回后为 `undone`；suggestion 的状态为 `suggested → confirmed | dismissed`。先写 `moving` 再移动；临时失败的会由 knowledge drain 过 1 分钟重放。
- **撤回 / 确认 / 忽略**：`GET memory/sorting` → `MemorySortList`；`POST memory/sorting/{record}/action` ← `MemorySortActionInput{action: undo|confirm|dismiss}`。撤回就是对目标条目反向调用 `MoveEntry`，前提是目标条目已经由设备写好。
- **首次运行**：个人层的 maintenance key 里加了 `memorySortingVersion=1`，部署后每个人的个人层会被重新 review 一次；之后按 key 正常去重（ID 由 key 派生，重复采集不会再排队）。没有任何 active 条目的 vault 不再排队 review。
- **默认助理停用时**：个人层的 review 改由第一个 active 助理来跑；`run.resolve` 对 memory 角色豁免「个人层所在工作区」的权限包检查，因为每个助理本来就能召回个人层。（windeng 的默认助理从 10-25 起一直是 stopped，不这样做的话，他的整理永远不会运行。）
- **Web**：「关于你」分区里新增「建议共享」（共享 / 忽略）和「最近的自动整理」（撤回），中英文文案都有。
