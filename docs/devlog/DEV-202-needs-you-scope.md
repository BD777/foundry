# DEV-202 「等你处理」按助理划分可见范围

## 状态

已实现、验证并部署 dev Server 与 Web（2026-11-13）。等待人工验收，未提交。

## 问题

`pending_items` 中只有助理派出的 helper 产生的条目带 `assistant_id`。其他条目原先对所有助理可见：助理页卡片直接复用全局列表，而每轮上下文和 MCP `needs_you list` 只排除了别的助理拥有的条目，没有按工作区和连接器账号权限包过滤。

## 方案

- 全局「等你处理」页保持完整列表；每张卡片标注来源助理、对话或项目，并增加「全部 / 各助理 / 不属于任何助理」筛选。
- Server 的 `assistant.Service.PendingFor` 是助理可见范围的唯一入口。它让助理看到：
  - `assistant_id` 是自己的条目；
  - 无助理归属、工作区被权限包允许的条目；
  - 无助理归属、连接器账号未被权限包关闭的账号事项；
  - 无工作区也无所属账号的事项只给默认助理。
- 助理页概览、每轮上下文注入和 MCP `needs_you` 都调用这个入口。助理页卡片继续只列交给本人处理的条目，助理自己正在处理的条目仍保留在上下文和工具列表。

## 检查

- `go test ./internal/httpapi -run '^(TestNeedsYouVisibilityFollowsAssistantScope|TestNeedsYouOneListWithTwoHandlers)$' -count=1` 通过。
- `go build ./...`，以及 `go vet ./internal/httpapi ./internal/personalagent/assistant ./internal/store` 通过。
- `node --import ./test/register-bundler-resolve.mjs --test test/pending-items.test.mjs`：17 通过、1 跳过、0 失败。
- Web `tsc --noEmit` 通过。
- `audit-hints`、`audit-component-system`、`audit-state-layout`、`audit-feedback` 全部通过。
- 回归覆盖两个助理的专属条目、自己权限内的工作区无主条目、无权限工作区、可用的账号事项、被关闭的设备连接器，以及只给默认助理的无工作区/无账号条目；概览与上下文使用同一过滤结果。

## 部署

- 三方合并进 dev 检出，无冲突。
- Server 回滚副本：`~/.foundry/server/releases/dev023-candidate/foundry-server.pre-needs-you-scope`，SHA-256 `db5b2a5d08cf7817daecb72645e53a91b22a22be140c302e02d1a50329ed37f6`。
- 新 Server SHA-256 `44d9abbe792e25ed44a08963fc78905e0bda8c7cb0bee76f3d7d529abb6de9ae`；PM2 online，restart 计数 `75`，`unstable restarts` 为 `0`，本机 `/healthz` 返回 200。
- Web 发布到 `~/.foundry/server/web-releases/needs-you-scope`；build `d687a0baf31094e6`。部署脚本确认入口资源逐字节一致、同源 API 返回 JSON。该 build ID 与部署前相同，因为另一会话刚用同一未提交树发布过；线上 bundle 已核对包含新的筛选和来源文案。

## 浏览器证据

e2e-alice，1280×900，浅色，中文界面。浏览器内仅拦截 `GET /api/pending-items` 注入三条合成数据，未写服务器数据；页面显示两个助理筛选和三种来源：

- `助理 · Work assistant`
- `助理 · Home assistant`
- `对话 · Weekend trip`

截图：`~/workspace/foundry/.foundry/attachments/20261112/needs-you-scope.png`

验收后已登出、清 cookie、删除临时 auth profile 并关闭浏览器。

## 验收步骤

1. 用至少两个助理的账号打开「等你处理」。预期全局列表仍显示全部条目，每条的来源是助理、对话或项目；顶部可按全部、任一助理或“不属于任何助理”筛选。
2. 打开一个非默认助理的首页。预期右侧卡片只出现本人处理且该助理有权看到的条目。
3. 让该助理开始一轮对话。预期注入上下文只包含自己的条目、权限内工作区的无主条目和可用账号事项。
4. 构造既无工作区、也无账号归属的事项。预期只有默认助理的卡片和上下文能看到。
5. 从全局页或助理页回复，预期仍送回原会话或 Issue。
