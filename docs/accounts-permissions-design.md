# 账号与权限：资源归属到人与 Workspace 共享

[项目 Roadmap](../README.md#roadmap) · [文档索引](README.md) ·
上游需求：[账号与权限体系](platform-extensions.md#accounts-and-permissions) ·
[0908 Plan §20](archive/workspace-ai-product-plan-2026-09-08.md) ·
当前行为：[安全边界 · Accounts](security.md#accounts)

**状态**：P1（身份与隔离）与 P2（Workspace 共享）已实现，现行行为以
[安全边界 · Accounts](security.md#accounts) 和代码为准；P3（凭证与生态）与
P4（治理）尚未实现，文中标注 **（P3）**、**（P4）** 的部分是设计。分期见 §9。

## 1. 目标

资源**归属到人**，并以 Workspace 为单位共享：

- Device、Workspace、Server connection（Profile）、执行记录都有明确的归属人；
- 未被授权的账号看不到、用不了别人的资源；
- Workspace 可以共享给其他账号，共享 Workspace 即授权在该 Workspace 所在的
  Device 上执行（二者强关联）；
- 所有入口（Web、Agent MCP/CLI token、Daemon、IM）走同一套授权判断；
- **没有免登录模式**：除登录、首个 Admin 初始化、邀请预览/接受、健康检查外，
  所有接口都要求账号身份（§4.0）。

需求来源：0908 Plan §20.1「权限至少分开考虑：查看、创建与沟通、控制执行、使用
资源与凭证、确认准出条件、接受、放弃、管理 Workspace」「团队成员不能天然都拥有
接受权」；platform-extensions「未授权账号不能读取受限内容、使用执行资源或接受
变更」；IM「群成员身份不会自动授予 Workspace 或 Accept 权限」。

### 1.0 两种配对码（易混淆）

|      | 飞书配对码                                                   | 设备配对 token                                                         |
| ---- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 产生 | Web 账号在某 Workspace 的飞书设置里生成（每 Workspace 一个） | Web **Devices → Add device** 或 `foundry-server devices pairing-token` |
| 用途 | 群里 `@bot /pair CODE`，把该群绑定到该 Workspace             | `foundry-worker pair/setup --token` 换取归属到人的设备凭证             |
| 身份 | Bot 在该群沿用**生成配对码的账号**的权限（§8）               | 设备归属于生成 token 的账号（§4.1）                                    |

## 2. 核心模型

```text
User ──owns──> Device ──hosts──> Workspace ──has──> Issue / Session / Chat / Evidence …
  │                                 ▲
  │                                 └── WorkspaceMember(user, role)   ← 共享
  └──owns──> Connection(Profile) ──granted to──> Workspace            ← 凭证授权
```

- **User**：实例角色为 **Admin / Member**（实例级：管理账号、邀请、全局技能
  目录），与 Workspace 角色区分开，避免两个 "Owner" 混淆。
- **Device**：配对它的那个人就是 **Device owner**。Device 代表"某人的一台机器
  上的一个 OS 用户"，在上面执行的代码都以该 OS 用户身份运行。
- **Workspace**：一定属于一台 Device。创建者为初始 Owner；
  Workspace 的 Owner 必须是其 Device 的 owner（见 §4.3）。
- **Connection（Server profile）**：归属个人，只有本人能查看、编辑和分配到自己
  的设备。授权给 Workspace 供协作者使用是 **（P3）**。
- **执行记录**（Issue、Session、Run、Evidence 决策）：记录 `created_by`，访问
  权跟随 Workspace。

### 2.1 Workspace 角色

| 能力（§20.1 的拆分）                                 | Viewer |        Member         | Maintainer | Owner |
| ---------------------------------------------------- | :----: | :-------------------: | :--------: | :---: |
| 查看 Issue/Chat/证据/文件                            |   ✓    |           ✓           |     ✓      |   ✓   |
| 创建与沟通：发起 Chat、创建与澄清 Issue、上传材料    |        |           ✓           |     ✓      |   ✓   |
| 控制执行：运行、steer、取消**自己发起的** Session    |        |           ✓           |     ✓      |   ✓   |
| 控制执行：steer/取消**他人的** Session               |        |                       |     ✓      |   ✓   |
| 使用资源与凭证：使用本 Workspace 可用的连接/设备登录 |        |           ✓           |     ✓      |   ✓   |
| 确认准出条件（Contract confirm）、Verify             |        | ✓（自己创建的 Issue） |     ✓      |   ✓   |
| 接受 Accept、放弃 Abandon                            |        |                       |     ✓      |   ✓   |
| 管理：技能绑定、飞书 Bot、凭证授权（P3）             |        |                       |     ✓      |   ✓   |
| 管理成员与共享、重命名、删除（转移为 P4）            |        |                       |            |   ✓   |

- Member 起步即可在 Device 上执行代码（Agent 有 shell），所以**授予 Member
  等于允许对方以 Device owner 的 OS 身份执行命令**。共享 UI 明示这一点；
  只想让人看的，给 Viewer。
- Accept 与 Contract confirm 分开：Member 能定义并确认自己 Issue 的完成条件，
  但把变更合入 Workspace 需要 Maintainer/Owner（"团队成员不能天然都拥有接受权"）。

## 3. Device 跟随 Workspace

权限模型里**没有 Device 级的 ACL 或 Device 共享**：所有授权判断只看 Workspace
角色。Device 只保留一个属性——归属于配对它的账号（用于签发/吊销设备凭证、
在其上新建 Workspace、修改设备设置）。其他人对 Device 的一切访问都由
Workspace 派生：

| 对 Device 的操作                                                    | Device owner | 通过 Workspace 获得访问的人 |
| ------------------------------------------------------------------- | :----------: | :-------------------------: |
| 看到设备名称、在线状态、运行时（仅限其有权的 Workspace 所在设备）   |      ✓       |              ✓              |
| 在**该 Workspace** 中调度执行（Chat、Issue run），占用设备并发额度  |      ✓       |     ✓（Member 及以上）      |
| 读取**该 Workspace** 目录内的文件                                   |      ✓       |              ✓              |
| 在该设备上新建 Workspace、浏览任意目录                              |      ✓       |              ✗              |
| 设备设置：运行时配额、技能根、原生账号登录/检查、分配连接、移除设备 |      ✓       |              ✗              |
| 读取设备本地凭证（promote credential）                              |      ✓       |              ✗              |

理由：Device 是一台真实机器；"整机共享"会让协作者在任意路径建 Workspace，
等价于任意文件读写。跟随 Workspace 后，共享的边界就是那个 Workspace 目录
（Issue 执行仍在 worktree + 沙箱里）。

执行隔离是独立的一项（不影响本权限模型，见
[Workspace 与 Sandbox 总纲](workspace-sandbox-overview.md)）：把 Agent 运行时放进
容器，只挂载 Workspace，缩小 Member 执行命令的影响面。注意容器内仍有凭证与网络、
挂载目录可写、禁止挂载 Docker socket；不可信代码需要 gVisor/VM 级隔离。

### 3.1 协作者的执行用谁的凭证（P3）

目前所有执行都用设备的原生登录（`claude auth login` 等）或设备绑定的连接，与
发起人无关。P3 按以下顺序解析，并把实际使用的凭证来源记入 Session：

1. 发起人**自己的连接**，若该连接已对该设备启用（个人连接跟人走）；
2. Workspace 被授予的连接（Owner/Maintainer 在共享设置里勾选，含 Device
   owner 的**原生设备登录**，显示为"使用 {device owner} 的 Claude 登录"）；
3. 都没有 → 拒绝执行，提示"请添加自己的连接或让 Owner 授权"。

协作者使用他人授予的连接时看不到密钥（密钥只下发给 worker、不回传浏览器）。

## 4. 身份与认证

### 4.0 没有免登录模式

- 账号鉴权永远开启，回环地址也一样。公开的只有 `GET /api/auth/state`、登录、
  登出、首个 Admin 初始化（需启动码）、邀请预览/接受，以及 `/healthz` 与前端
  静态资源。
- 本地开发的首次启动走同一个启动码流程（或 `foundry-server users create`）。
- 已退役的 `FOUNDRY_AUTH_MODE`、`FOUNDRY_CONTROL_TOKEN`、`FOUNDRY_PAIRING_CODE`
  一旦设置即拒绝启动，不会被静默忽略。
- `auth_coverage_test.go`：任何非公开的 `/api/` 路由对无凭证请求必须 401。

### 4.1 设备身份与凭证

**唯一性**与**认证**分开：

1. **机器指纹去重**：worker 读取 OS 安装时生成的机器 ID（macOS
   `IOPlatformUUID`，Linux `/etc/machine-id`；容器里没有时退回状态根里的随机
   id），上报 `sha256("foundry-device:" + machine-id)`，不上报原值。不用 MAC
   （macOS Wi-Fi MAC 会随机化，多网卡/虚拟机/Docker 网桥不稳定，且可伪造）。
   服务器约束**一台机器在一个账号下只有一个 Device**：同一机器重新配对复用原
   Device 记录。同机不同 OS 用户视为同一台设备；开发用的多栈
   （[并行开发栈](dev-stacks.md)）把栈名并入指纹，作为开发专用例外。
2. **设备凭证认证**：见下。指纹只用于去重，不作为认证依据。
3. **同时只允许一个在线**：worker 本地加锁，同一状态根的第二个 daemon 直接
   退出。服务器对同一 Device 的新连接**顶替**旧连接（凭证已按设备区分，别人
   无法冒充；顶替让断网/崩溃后的重连可靠）。

- Web：**Devices → Add device** 生成一次性设备配对 token（与邀请链接同构：随机
  256 bit、只存 hash、网页 15 分钟 / CLI 1 小时过期、单次使用），绑定生成它的
  账号；无网页时用 `foundry-server devices pairing-token --username …`。
- Worker：`foundry-worker pair --server … --token …` 用它换取**设备凭证**
  （长期随机密钥，服务器只存 hash，worker 以 0600 保存），同时服务器按机器指纹
  复用或新建 device id，并记录归属账号。
- 之后所有 `/api/daemon/*` 与 WebSocket 用 `X-Foundry-Device-Credential` 头。
  设备只能注册/更新**本设备名下**的 Workspace；已属于其他在线设备的 `ws_` id
  一律拒绝。
- 撤销：在 Devices 页移除设备即吊销凭证，WebSocket 立即断开；重新配对同一台
  机器会轮换凭证并断开旧连接。
- 本机 `foundry` CLI（人在设备终端里运行，非 Agent token）使用设备凭证，身份是
  **Device owner 账号**，范围限定在该设备上的 Workspace——在这台机器终端里的人
  本来就是该设备的 OS 用户。

**后续：设备密钥对认证（未实现）。** 当前设备凭证是服务器签发的随机 bearer
密钥（服务器只存 hash），已能防止冒充他人设备 id。后续升级为非对称方案：配对时
worker 本地生成 Ed25519 密钥对，只把公钥交给服务器；每次连接由服务器下发随机
challenge、worker 用私钥签名证明持有。收益：服务器不保存任何可直接冒用的秘密，
数据库泄露不等于设备凭证泄露，且可抵御重放。传输加密仍由 TLS 负责。

### 4.2 Actor 统一

| Actor      | 来源                 | 权限计算                                                        |
| ---------- | -------------------- | --------------------------------------------------------------- |
| account    | 会话 cookie          | 自身的 Workspace 角色 + 设备归属 + 实例角色                     |
| daemon     | 设备凭证             | 仅本设备及其 Workspace 的 daemon 协议操作                       |
| agent      | Session token        | **发起人账号权限 ∩ 现有 Agent 路由白名单 ∩ 本 Workspace/设备**  |
| device-cli | 设备凭证（本机 CLI） | Device owner 账号权限 ∩ 该设备上的 Workspace                    |
| feishu-bot | 已绑定的群消息       | 绑定该群的账号（生成配对码的人）在该 Workspace 的当前权限（§8） |

Agent token 在创建 Session 时记录发起人，子 Session 继承；每次请求按发起人
**当前**角色计算（上限 Member），发起人被移出 Workspace 或禁用后立即失效。

### 4.3 归属不变量

- Workspace 的 Owner 集合必须包含其 Device owner。Device owner 可以把 Owner
  角色同时授予他人，但不能移除自己的 Owner（要退出就移除设备或迁移 Workspace）。
  这样"Workspace 在谁的机器上，谁就始终能控制它"。
- 每个 Workspace 至少一个 Owner；每台 Device 恰好一个 owner。
- 账号被禁用：其登录会话、Agent token 立即失效，运行中的 Session 被取消，设备
  随之停用。由 Admin 转移或归档其资源是 **（P4）**。

## 5. 授权实现

### 5.1 路由规则表 + 覆盖测试

每条 API 路由在 `apps/server/internal/httpapi/routes.go` 的路由表里声明一条访问
规则：`publicRoute`、`signedIn`、`adminOnly`、`daemonProtocol`、
`workspaceRole(need, resolver)`、`issueCreatorOr(need)`、`deviceOwner`、
`connectionOwner`，以及在 handler 内判断的 `inHandler` / 按调用者过滤的
`filtered`。例如：

```go
fn("POST /api/issues/{id}/accept", s.handleAcceptIssue,
    workspaceRole(maintainer, issueWorkspace("id"))),
```

resolver 把请求里的 id 统一解析到 Workspace（`pathWorkspace`、`queryWorkspace`、
`issueWorkspace`、`sessionWorkspace`、`chatWorkspace` 等）。调用者的可达范围
（各 Workspace 角色 + 拥有的设备）在 `access.go` 计算；Agent token 的路由白名单与
会话控制判断在 `policy.go`。测试强制每条路由都有规则，并对无权账号验证 403/404
（按 id 访问他人资源返回 404，不泄露存在性）。

### 5.2 读路径过滤

- 所有列表默认只含调用者可见的 Workspace；空 `workspaceId` 表示"我可见的全部"。
- `foundry-data`：只返回可见 Workspace；Device 返回"我拥有的 + 我可见 Workspace
  所在的"（后者为精简投影，不含执行设置）；连接只返回自己的。缓存按调用者可见
  范围分开。
- SSE：每个订阅者只收到其可见 Workspace 的事件；没有 Workspace 的事件对账号
  订阅者不下发。成员变更时服务端关闭受影响账号的事件流，客户端重连后按新范围
  计算。
- 附件与本地文件：只接受可见 Workspace 的附件根；daemon hub 不再回落到"任意
  已连接设备"。

### 5.3 创建人与审计

Issue 与 Session 记录 `createdByUserId`（Agent 创建的继承发起人，飞书群触发的
归绑定账号）。成员、共享、凭证授权变更的审计事件与查看界面是 **（P4）**。

## 6. 数据模型

已实现：

| 表 / 列                                                          | 内容                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `device_identities`                                              | device id、归属账号、机器指纹、凭证 hash；`UNIQUE (owner, fingerprint)` |
| `device_pairing_tokens`                                          | 一次性设备配对 token（只存 hash）                                       |
| `workspace_members`                                              | `(workspace_id, user_id)` → `owner/maintainer/member/viewer`            |
| `workspaces.device_id`                                           | 从 payload 提升为真实列                                                 |
| `profiles.owner_user_id`                                         | 连接归属                                                                |
| `workspace_feishu_bots.bound_user_id`、`pairing_code_created_by` | 飞书群绑定的账号；`pairing_code` 只存 hash                              |
| Issue / Session `createdByUserId`                                | 发起人                                                                  |

P3 计划新增 `workspace_connection_grants(workspace_id, source, granted_by, created_at)`，
`source` 为 `profile:<id>` 或 `device-login:<runtime>`。

- 全局技能目录（promoted skills）由 Admin 管理，绑定到 Workspace 后对其成员可见；
  是否做按人归属或组织级共享目录留到 P3。
- `issues.short_id` 全局唯一（展示编号，不泄露内容），不按用户分区。
- 早于账号体系的资源（Device、Workspace、连接、执行记录）归**最早创建的
  Admin**；无账号时注册的资源在创建首个 Admin 时归其所有。

## 7. 界面

已实现：

- **Workspace 设置 → Sharing**：按用户名精确添加成员并选择角色（选择 Member 及
  以上时明示"可在 {device} 上以 {owner} 的 OS 身份执行命令"），调整角色、移除、
  自行退出；Device owner 始终是 Owner。未注册的人由 Admin 生成带 Workspace 角色的
  邀请（只能授予自己是 Owner 的 Workspace）。
- **Devices**：我的设备可管理；共享来的设备只读、只显示 Workspaces。
- **Server connections**：只显示我的连接。
- Workspace 选择器标注共享来的 Workspace 及我的角色。
- 按角色禁用/隐藏操作并写明"你是 X，需要 Y 及以上"；服务端 403 同样写明当前
  角色与所需角色（遵守 AGENTS.md：不靠颜色/悬停表达状态）。

未实现：

- **Workspace 设置 → 可用连接**（P3）：勾选授予本 Workspace 的个人连接与设备
  原生登录；共享来的连接只在运行时选择器中出现，标注"由 {user} 授权"。
- 成员变更审计视图与所有权转移（P4）。

## 8. 飞书：Bot 沿用配对人的权限

飞书配对码由某个 Web 账号在 Workspace 的飞书设置里生成，所以绑定关系天然有
一个 Foundry 身份：

- 生成配对码需要该 Workspace 的 Maintainer 及以上权限；配对码记录
  `created_by_user_id`，单次使用、短时过期，只存 hash。
- 群里 `/pair CODE` 成功后，`workspace_feishu_bots` 记录 `bound_user_id =` 生成
  该码的账号。此后该 Bot 在这个群里对这个 Workspace 的**所有操作都以该账号的
  身份执行**：Session 的 `createdByUserId` 是他，权限按他**当前**在该
  Workspace 的角色（至少 Member）逐条判断；执行凭证按 §3.1 以他为发起人解析
  是 **（P3）**。
- 该账号被移出 Workspace、降为 Viewer、或被禁用后，Bot 在群里停止执行并回复
  原因；重新由有权限的人生成配对码重绑即可换绑身份。
- 设置页明示："绑定后，这个群里任何能 @Bot 的人都将以你的身份在此 Workspace
  操作"。
- 后续（P3）：飞书用户与 Foundry 账号一一绑定，按发送者本人权限执行，群成员
  身份本身不授予权限。

## 9. 分期

| 阶段          | 状态   | 内容                                                                                                                       | 完成标准                                                                                 |
| ------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P1 身份与隔离 | 已实现 | 去掉免登录模式、设备凭证与设备归属、飞书绑定账号、归属列与迁移、路由规则表、列表/foundry-data/SSE/附件按可见集过滤、创建人 | 两个账号互相看不到对方的任何资源（矩阵测试 + 真实浏览器），伪造设备 id/Workspace id 被拒 |
| P2 共享       | 已实现 | `workspace_members` 与四角色、Sharing UI、范围化设备访问、Agent token 继承账号                                             | 被共享者按角色能/不能做 §2.1 表中每一项；移除成员后会话与 Agent token 立即失效           |
| P3 凭证与生态 | 未开始 | 个人连接 + Workspace 授权、执行凭证解析顺序（§3.1）、技能目录归属、飞书身份绑定                                            | 协作者执行记录可追溯到凭证来源；未授权连接不可用；未绑定飞书用户不能触发执行             |
| P4 治理       | 未开始 | 审计视图、所有权转移、Admin 处置被禁用账号的资源；设备密钥对认证（§4.1）                                                   | —                                                                                        |

## 10. 设计决策

1. Device 跟随 Workspace（§3）：无 Device 级 ACL/共享；Device 只记录配对它的
   账号。容器化运行时作为独立的执行隔离项，不影响权限模型。
2. 协作者执行凭证按 §3.1 顺序；设备原生登录需显式授权给 Workspace（共享对话框
   中默认勾选、可取消）。
3. Workspace 四档角色：Viewer / Member / Maintainer / Owner。
4. Admin 默认**不能**查看他人 Workspace；处置被禁用账号的资源走显式转移并审计。
5. 没有免登录模式（§4.0），登录相关接口例外。
6. 既有数据归属最早的 Admin（§6）。
7. 飞书 Bot 沿用生成配对码的账号的权限（§8）；按发送者身份授权后续再做。
8. 设备唯一性用 OS 机器 ID 的哈希，一台机器一个账号下一个 Device；认证用设备
   凭证；同一 Device 同时只允许一个在线（§4.1）。
