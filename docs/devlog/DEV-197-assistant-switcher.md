# DEV-197 助理切换器：一个助理入口 + 标题下拉

## 状态

已合入 main（PR #265，squash bb3f7fdd）。

第一版的双入口侧栏被本人否决；终版已实现、通过 Web 检查、部署到 dev，并完成真实浏览器截图（2026-11-12）。

## 本人反馈

> 你把assistant跟conversation拆成了两个tab，我觉得这是很糟糕的一个设计……我们的Tab侧边栏基本上还是保持简洁的好

结论：侧边栏一个功能只保留一个入口；同类对象之间的切换放进当前页标题的下拉，不额外增加行或 tab。

## 问题

第一版把助理上下文行与 Conversation 分成两个侧栏入口，虽然记住了上次选择，但牺牲了侧栏应有的简洁。助理切换应该发生在对话页内部，而不是扩充全局导航。

## 终版设计

- 助理分区只保留三个导航项：当前助理、Needs you、Assistant settings。当前助理项使用 Sparkles 图标和助理名称，不再额外显示设备、状态、默认标记或前进箭头。
- 点击助理项或打开旧 `/assistant`：浏览器有有效记忆时直接进入该助理的 `/assistants/{id}`；首次使用、无记忆或记忆中的助理已删除时进入 `/assistants` 列表。
- 当前助理仍按用户保存在 `localStorage` 的 `foundry.activeAssistantId.<user id>`。这与工作区选择的机制一致；Server 没有通用用户 UI preference 接口。
- 对话页标题本身就是切换菜单的触发器：名称旁显示下拉箭头，菜单列出全部助理并勾选当前项，末尾提供“所有助理”和“新建助理”。停止/恢复与设置仍留在页头。
- 菜单使用 `components/ui/dropdown-menu.tsx` 与 `row-menu-parts.tsx` 的 Radix 组件，不新建第二套菜单样式。
- 删除只服务旧助理上下文行的 `compact-assistant-switcher.tsx`；`sidebar-context-entry.tsx` 继续只服务工作区入口，不改变其行为。
- `apps/web/AGENTS.md` 增加侧边栏简洁原则：一个功能一个入口，同类对象切换放在页标题下拉。

## 验证

- `tsc --noEmit`
- `node --import ./test/register-bundler-resolve.mjs --test test/app-navigation.test.mjs`
- `node --import ./test/register-bundler-resolve.mjs --test test/assistants-web.test.mjs`
- `node --import ./test/register-bundler-resolve.mjs --test test/sidebar-scope.test.mjs`
- `audit-hints`
- `audit-component-system`
- `audit-state-layout`
- `audit-feedback`

部署：Web build `06c2bacc215e580a` 已发布到 dev，`/version.json` 回读一致。

真实浏览器（e2e-alice，1280×900，浅色，中文）：

- 侧栏助理分区只有 `DEV197 switcher`、等你处理、助理设置三项，没有额外上下文行或 Conversation tab；折叠入口仍保留单个导航按钮。
- 对话页标题下拉打开后，当前合成助理 `aria-current=true`，菜单同时显示“所有助理”和“新建助理”；页头保留停止助理工作与设置。
- 清除用户的 `foundry.activeAssistantId.<user id>` 后打开 `/assistant`，页面进入 `/assistants`，没有助理行带选中态。
- 合成助理已删除，目录恢复为默认助理；已登出、清 cookie、关闭浏览器并删除临时目录。

截图：

- `~/workspace/foundry/.foundry/attachments/20261112/assistant-switcher-title-menu.png`
- `~/workspace/foundry/.foundry/attachments/20261112/assistant-switcher-list-no-memory.png`

## 验收步骤

1. 已有有效记忆时点击侧栏唯一助理入口，预期直接进入该助理的对话页。
2. 打开 `/assistant`，预期同样使用有效记忆；刷新后仍进入同一助理。
3. 清除该用户的 `foundry.activeAssistantId.<user id>` 后再打开 `/assistant`，预期进入 `/assistants` 列表。
4. 在对话页点击标题下拉，预期当前助理有勾选，并可切换到其他助理、“所有助理”或“新建助理”。
5. 折叠侧栏后，唯一助理入口仍可通过 Sparkles 图标和包含助理名称的 tooltip 使用。
6. 删除记忆中或当前助理后再次进入，预期旧 ID 被清除并显示助理列表。
