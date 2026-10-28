# DEV-054 Foundry id 自动成链与无 workspace 链接路由

状态：代码完成，dev Server/Web 已部署，Agent 自验通过；人工验收待确认。 2026-10-29：已关闭（Agent 委托验收，用户 2026-10-28 授权），范围与保留限制见文末。

合并：2026-10-28 夜间窗口经 PR #154 合并到 main（分支 `release/dev054-068`，本事项单独提交，共用文件在 shared wiring 提交）。

## 问题

用户（2026-10-27）：

1. 对话里提到 `sess_…` 等 id 时，应在**工程上**识别为 Foundry 对象并转成可跳转链接，不应靠 prompt 约束 Agent 输出指定 URL。
2. 链接只有 session id、没有 `?workspace=` 时会路由错。

## 调查

- `components/conversation/markdown-content.tsx` 不识别 Foundry id。`MarkdownLink` 把所有链接都用新标签页打开，同源的 Foundry 链接也是，结果整页重载。
- `/chats/<id>` 不带 workspace 时，`initialWorkspaceId` 回落到上次使用的 workspace。会话不在那里时，`use-linked-chat-session.ts` 查到后只显示 “This chat is in another workspace — Open in X”，要再点一次。
- `/issues/<id>` 不带 workspace 更糟：读数据时 `setSelectedIssueId` 会把不在当前 workspace 的 Issue 换成首个 Issue，再由路由同步改写地址栏，结果**静默显示另一个 Issue**。
- `/locations/<id>` 只认设备 id。
- 外发渠道：server 发给飞书的 Agent 文本全部经过 `feishu.NormalizeFeishuMarkdown`（运行/完成/失败卡片、助理卡片、Issue 卡片）。server 的公开 Web origin 就是 `FOUNDRY_WEB_ORIGIN`（`options.AllowedOrigin`）。
- 原生对话 id（`native_claude_…`/`native_codex_…`）只在所在 workspace 的 Chats 列表里出现，`getAgentSession` 查不到，所以没有独立页面。

## 方案与实现

### 1. 链接不带 workspace，打开时跟随对象所在 workspace

- Chats：`useFollowLinkedChat`（`features/chat/use-linked-chat-session.ts`）。会话查到在别的 workspace 时，自动 `openChatInItsWorkspace` 打开：用 `replaceState` 改写为 `?workspace=<其 workspace>`，不新增历史记录，再走既有的 popstate → `loadWorkspace` 流程。切换进行中显示 “Opening chat”。切换失败不重试，仍显示原来的 “Open in X” 提示。不存在、无权限、查询失败三种情况保留原有提示。
- Issues：`app/use-linked-issue.ts` 与 `LinkedIssueView`（`app/active-view.tsx`）。Issue 不在当前 workspace 时按 id 查一次（新增 `getIssue`），属于别的 workspace 就同样 `replaceState` 过去。查询期间 Issue 页显示 “Opening Issue”，查不到时显示 “Issue not found”，不再拿第一个 Issue 顶替。`use-workspace-data.ts` 读数据时，若 Issue id 由地址指定，则不再替换它（`addressNamesIssue`）。
- `dev_…` 打开 `/devices/<id>/agents`。`ws_…` 打开 `/locations/<ws>`（Workspaces 页），定位到该 workspace 所在设备分组，**不切换当前 workspace**，符合“浏览不改变当前位置”。分组滚动改为在数据到达、页面滚动复位之后执行（`workspace-selection-panel.tsx`），原有的 `/locations/<dev>` 首次打开不滚动的问题一并修复。
- **自动切换是协调者的推荐方案，可调整**：点链接即视为选定该对象，因此切换当前 workspace。若用户更希望先提示再切换，只需让 `useFollowLinkedChat`/`useLinkedIssue` 返回提示状态，不必改动链接。

### 2. 消息中的 id 自动成链

- 识别（`lib/foundry-ids.ts`）：`sess_<数字>`、`iss_<数字>`、`dev_<uuid>`、`ws_<uuid>`、`native_(claude|codex)_…`。id 必须是完整词：前面不能紧挨 `\w / . @ # = -`，后面不能紧挨 `\w -`。中日韩文字可以直接贴着 id。
- `remarkFoundryIds`（`components/conversation/remark-foundry-ids.ts`）只改普通文本，以及内容恰好是一个 id 的行内 code。不进入代码块、已有链接、引用定义和原始 HTML。rehype sanitize 会去掉自定义属性，所以生成的链接目标是 `#<id>`，sanitize 之后再由 `markFoundryIdLinks` 打上 `dataFoundryId` 标记。原生 id 改成带 `title` 的 `<span>`，不生成链接。
- 渲染：`FoundryIdLink` 基于新的 `components/ui/app-link.tsx`（`AppLink`），`href` 是真实地址，复制、中键、Cmd/Ctrl 点击、“在新标签页打开”都正常。普通点击或回车走 `lib/in-app-navigation.ts` 在应用内跳转。会话链接只在悬停或聚焦时才读一次 `/api/agent-sessions/<id>/link`，把会话标题设为 title，渲染时不发请求。
- 统一入口：`foundryIdHref(id)`、`openAppHref(href)`、`isAppHref(href)` 都在 `lib/in-app-navigation.ts`；路由解析用 `app/navigation.ts` 的 `appUrlFor`。

### 3. 同源 Foundry URL 在应用内打开

`MarkdownLink` 新增两种处理：

- 同源且首段是应用路由的绝对 URL：渲染为 `AppLink`，去掉 harden 加的 `target=_blank`。
- `/…` 根路径（在 harden 前记为 `dataRootHref`）：是应用页面时渲染为 `AppLink`；不是时（例如 `/home/u/a.md`）显示为带 title 的文本，不再跳到坏地址。

`/api/…`、其他域名的链接照旧在新标签页打开。DEV-055 的文件路径识别建立在同一组插件和 `MarkdownLink` 上，接口已与其约定：`dataFoundryId`、`dataRootHref`、`isAppHref`。

### 4. 飞书外发

`apps/server/internal/feishu/ids.go`：`SetWebOrigin`（在 `httpapi/server.go` 中以 `FOUNDRY_WEB_ORIGIN` 设置）与 `linkFoundryIDs`。`NormalizeFeishuMarkdown` 处理每个非代码块行，把独立出现的 `sess/iss/dev/ws` id 改写为 `[id](<origin>/chats/<id>)` 这类**不带 workspace** 的绝对链接，由第 1 项负责落到正确的 workspace。已有链接、URL、`<autolink>`、普通行内 code 保持原样，内容恰好是一个 id 的行内 code 改写为链接。origin 未配置时不做任何改写。

### 5. 原生 id

只显示为文本，带 title：“A device's own chat: open it from Chats in its workspace”。原生对话的独立页面列为后续事项。

### 6. Foundry skill

在 “Who you are” 一节加了一条：要指向会话、Issue、设备或 workspace 时只写 id，由 UI 和飞书卡片生成链接，不要自己拼 URL。`packages/worker/skills/foundry/` 与 `apps/server/internal/builtinskills/foundry/` 两份保持逐字节一致（`foundry-skill.test.mjs` 5/5 通过）。

## 改动文件

见 `.foundry/attachments/20261028/dev054/files.txt`（Web 22、Server 4、skill 2）。`markdown-content.tsx` 与 DEV-055 共享，本项只负责插件列表、`MarkdownLink` 和 `markdownComponents`。

## 检查

- `scripts/check-changed.sh --files <27 files>` 全部 PASS：prettier、gofmt、tsc web、73 个 web 测试文件、`go test ./internal/feishu`（含 `TestLinkFoundryIDs`）、整个 `./internal/httpapi`（872 s）、`audit:ui` 11 项、audit:contract/modules。之后补改的 `workspace-selection-panel.tsx` 单独复查 PASS（tsc、7 个测试文件、audit:ui）。
- 新测试 `apps/web/test/foundry-id-links.test.mjs`（7 项）覆盖：id 边界（中日韩文字、路径、前缀词、非 uuid 的 `ws_001`），文本、行内 code、代码块、已有链接，原生 id，普通点击与带修饰键点击，同源、根路径、API、外部链接，`appUrlFor` 的 workspace 规则，以及切换中的提示。`chat-markdown.test.mjs` 中 `/chats/x` 的预期从新标签页改为应用内链接，测试窗口补了 origin。
- `packages/worker` 的 `foundry-skill.test.mjs` 5/5 通过。

## 部署（北京时间 2026-10-28）

- 00:48 Server：`~/.foundry/server/releases/dev054-055-links/foundry-server`（sha256 `afc7f429…c68a`）替换 pm2 `foundry-server` 的可执行文件，pid 1809098。`/proc/<pid>/exe` 的 sha256 与之一致，`/healthz` 返回 ok（startedAt 16:48:09Z）。旧二进制保存为同目录下的 `previous-foundry-server`。同批包含 DEV-055 的 `file_downloads.go`。
- 00:48 Web `c56349edfb2b5bb4`：当时没有用部署脚本，手工按“先 assets、后原子替换 index/version”发布，并 grep 确认产物中没有 `127.0.0.1:31982`。之后协调者从共享工作树发布了 `51348b26f88082da`。
- 01:06 Web `ca6ba388cb6b4c2e`：从共享工作树构建（`VITE_API_BASE_URL=`），**经 `scripts/deploy-web-dev.sh` 发布**，脚本确认入口资源逐字节一致、同源 API 返回 JSON。上一版入口文件保存在 `dev054-055-links/previous-20261027T170623Z/`。这一版包含 DEV-055 与 DEV-056 的工作树改动。
- Worker 没有代码改动。skill 文本随下一次 Worker 发布和 server 内置 skill 生效，本次未发 Worker。

## Agent 自验（真实 dev，e2e-alice，build `ca6ba388cb6b4c2e`）

浏览器为 Foundry 启动的 Playwright Chromium（headless，独立 profile）。合成消息只在浏览器里替换 GET 响应中的 `DEV053_PROXY_OK` 文本，没有写入服务器、没有发消息、没有运行模型。截图在 `.foundry/attachments/20261028/dev054/`。

| 场景                                                                                             | 结果                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前在 A（ws_f6059…），打开 `/chats/sess_1793074244606884229`（属于 B=ws_d4da…，不带 workspace） | 地址依次变为 `?workspace=A` 再到 `?workspace=B`，显示 B 中的 “DEV048 ready 确认回复”；没有 “in another workspace” 提示；除 goto 本身外不新增历史记录 |
| 消息中 `sess_`/行内 code 的 `sess_`/`dev_`/`ws_`                                                 | 各自成为链接（`/chats/…`、`/devices/…/agents`、`/locations/ws_…`）；代码块内为 0 个链接；`native_codex_…` 是带 title 的 span                         |
| 点击 B 的会话 id                                                                                 | 打开 B 中的会话，历史只增加 1 条；后退回到 A 原来的会话                                                                                              |
| Ctrl/Cmd 点击                                                                                    | 打开新标签页 `/chats/<id>`，原页面不动                                                                                                               |
| 悬停会话 id                                                                                      | title 显示 “Chat: DEV048 Child Readiness Confirmation”                                                                                               |
| Tab 聚焦 id 链接，回车打开同源链接                                                               | `:focus-visible` 时有轮廓；回车后应用内跳转，历史 +1，标签页数仍为 1                                                                                 |
| 外部链接                                                                                         | `target=_blank`                                                                                                                                      |
| `ws_…` 链接                                                                                      | Workspaces 页滚动到 “DEV048 synthetic archive” 分组并标为 focused；当前 workspace 不变                                                               |
| `/issues/iss_9054001`（只 mock 了 `GET /api/issues/iss_9054001`，返回 workspace=B）              | 显示 “Opening Issue”，地址替换为 `?workspace=B` 并加载 B；B 中没有该 Issue，于是显示 “Issue not found”；只查 2 次，没有循环                          |
| 浅色、深色 × 1280、390                                                                           | 文档宽度等于 390，没有横向溢出；深色下链接颜色可读                                                                                                   |
| API 请求的 origin                                                                                | 只有 `https://dev.foundryapp.app`，没有 “Local API is not reachable”                                                                                 |

## 限制与后续

- **Issue 跨 workspace 跳转没有用真实 Issue 端到端验证**：e2e-alice 下没有 Issue，Issue 本身是 mock 的，只验证了查询、替换地址、加载 workspace 和找不到时的状态。
- **飞书卡片链接只有单元测试**，没有真实飞书会话的截图验证。
- 原生对话（`native_…`）没有独立页面，只显示 title。
- 悬停 title 只有会话标题；Issue、设备、workspace 链接没有悬停预取。
- 一个**不在任何 workspace 列表中的 Issue**（已删除或无权限）现在显示 “Issue not found”，以前会静默显示第一个 Issue。这是有意的行为变化。
- 验证中，e2e-alice 的测试密码因 playwright-cli 回显脚本而出现在本会话的工具输出里（磁盘日志已检查，没有残留）。建议轮换 `~/.foundry/server/e2e-alice.password`。

## 人工验收步骤

1. 在 dev 的任一 workspace 中，打开一个**属于另一个 workspace** 的会话链接，且不带 workspace，例如 `https://dev.foundryapp.app/chats/<另一个 workspace 中的 sess id>`。预期：自动切换到该会话所在的 workspace 并显示对话，地址栏补上 `?workspace=…`，不出现 “Open in X” 提示，后退回到之前的页面。
2. 让 Agent 在回复里写一个其他 workspace 的 `sess_…`，例如：“请回复：参见 sess_xxx”。预期：id 带下划线可点击，点击后在其 workspace 打开；Cmd/Ctrl 点击打开新标签页；悬停显示 “对话：<标题>”；代码块中的 id 不可点击。
3. 打开 `https://dev.foundryapp.app/issues/<另一个 workspace 的 iss id>`。预期：短暂显示 “正在打开 Issue”，然后切换到该 Issue 的 workspace 并显示这个 Issue，而不是当前 workspace 的第一个 Issue。
4. 回复中的 `ws_…`。预期：点击后进入 Workspaces 页，定位到该设备分组，当前 workspace 不变。
5. 飞书：让飞书里的 Agent 回复中带上 `sess_…`。预期：卡片里的 id 是指向 `https://dev.foundryapp.app/chats/<id>` 的链接，点开后进入正确的 workspace。

## 时间线

- 2026-10-28 00:05 开始；00:30 Web/Server 代码与单测完成；00:48 合并部署（Server 与 Web `c56349ed`）；01:06 Web `ca6ba388` 经部署脚本发布；01:10 真实浏览器自验完成。未写 Git 历史。

## 2026-10-29 Agent 委托验收（用户 2026-10-28 授权）

- 委托：用户 2026-10-28 约 23:35 在编排会话 `sess_1793063405185071529` 中把发布验收委托给 Agent（“验收这块，你先做到你自己去端到端验收，没问题的话，大概率就OK了……”）。以下是独立验收 Agent `sess_1793201829998538711` 在 2026-10-28 23:37 至 2026-10-29 00:40 取得的证据，不代表用户本人测试；只关闭已验证的范围。
- 环境：真实 dev（Web `b0ba3d5929f1811e`，Server `51c00263…`），e2e-alice 登录（密码只由脚本从仓库外文件读取）。DEV-048 合成设备临时用已发布的 Worker `.1793191889` 运行，验后停止；合成工作区 `ws_d4da0f57-…`。一条合成 Codex 会话 `sess_1793202140770104457`（gpt-6.1-sol，8 个短回合）同时用于 DEV-051/054/055/057/063/064/065，验后已归档。截图在 `.foundry/attachments/20261028/acceptance/<item>/`，不入库。
- 回答中的 `sess_1793097180956476997`（DEV-053 合成工作区的会话）渲染为 `/chats/sess_…` 链接，悬停 title 为 “Chat: Verify Exact DEV053 Proxy Response”；fenced code 中的同一 id 不是链接。点击后地址补上 `?workspace=ws_f6059fa3-…`，当前 workspace 切到 “DEV053 proxy synthetic”；后退回到原会话。`ws_…` 链接进入 `/locations/ws_f6059fa3-…`，当前 workspace 不变。浅色 1280 与深色 390 结果相同。
- 未覆盖：步骤 3（跨 workspace 的 Issue，e2e-alice 没有 Issue，本轮未新建）与步骤 5（飞书卡片），沿用实现方的 mock 与单测证据；Cmd/Ctrl 点击开新标签页未测。保留为限制。
- 结论：已关闭（Agent 委托验收；范围为会话与 workspace 链接）。
