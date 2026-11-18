# DEV-304 标签页标记：助理未读与当前对话分开

[Devlog 索引](README.md) · [DEV-278 助理答复送达](DEV-278-assistant-answers-reach-person.md)

状态：**已部署 dev（2026-11-18）；Agent 代验收（2026-11-18，范围见验收记录）；已合入 main（PR #278）。**

## 问题

DEV-278 让助理首页的未读答复复用打开对话的 ✅ 标题与绿点，并且在任何标签页都显示。打开「修复Agent接口发图片」这类对话时，✅ 无法区分是本对话的答复未读，还是助理的答复未读。

## 根因

`apps/web/src/lib/document-title.ts`：

- `tabStatus` 把 `assistantUnread` 与对话自身的 `unread` 映射为同一状态 `unread`（✅ 与绿点）。
- `apply()` 把页面级的 `assistantUnread` 原样带入，因此对话页也被标记。

## 修复

- **对话页只反映该对话自身状态**（等待子会话、运行、未读答复、后台工作）。`apply()` 在有打开对话时忽略 `assistantUnread`。
- **非对话页显示助理未读**：新增状态 `assistant`，标题前缀 💬，图标 `foundry-icon-assistant.png`（蓝色对话气泡，右下角，白色描边，与绿点、蓝点形状不同）。适用于助理页本身、设置、等你处理、列表等不打开对话的页面。
- 侧栏「助理」圆点不变，对话页上它是助理未读的唯一提示。
- 打开助理首页即清除（`useAssistantHomeUnread` 未改动）。

图标由 `apps/web/scripts/generate-tab-status-icons.py` 生成。已有的三个图标重新生成后字节不变，仅新增 `foundry-icon-assistant.png`。

## 改动文件

- `apps/web/src/lib/document-title.ts`：新状态 `assistant`、`tabStatusMarks`、`tabStatus` 顺序、`apply()` 的对话页规则、注释。
- `apps/web/scripts/generate-tab-status-icons.py`：`bubbled()` 与 `assistant` 图标。
- `apps/web/public/foundry-icon-assistant.png`：新图标（新增）。
- `apps/web/test/document-title.test.mjs`：更新 1 条（非对话页助理未读由 ✅ 改为 💬 与新图标），新增 3 条（对话页忽略助理未读；对话自身未读在助理未读同时存在时仍为 ✅；💬 与 ✅ 为不同状态）。
- `docs/devlog/DEV-304-tab-marks-assistant-vs-chat.md`：本文件（新增）。`docs/devlog/README.md` 未改（按委托要求）。

## 验证

- `node --test` 运行 `document-title`、`unread-tab-marker`、`tab-status-background`、`assistant-unread` 四个文件：15 项全部通过。
- `tsc --noEmit`（apps/web）通过。
- `audit:ui` 的 15 个脚本逐个运行全部通过。`pnpm audit:ui` 本身未运行：工作树的 pnpm 会尝试 `pnpm install`（依赖状态检查），因此改用 `node scripts/audit-*.mjs` 直接运行。
- `vite build` 通过。打包时的 chunk 体积 > 500 kB 提示为既有告警，非错误。
- 图标预览：浅色与深色底、64 px 与 16 px 下检查，蓝色气泡在小尺寸下仍可辨认。

## 验收步骤（部署后）

1. 在设备页（或其他非对话页）时，助理首页收到未读答复。预期：标题 `💬 <页面> · <工作区> — Foundry`，标签页图标为蓝色气泡；侧栏「助理」有圆点。
2. 打开一个自身有未读答复的对话。预期：标题 `✅ <对话> · …`，图标为绿点；标题不带 💬。
3. 在打开某对话的情况下，助理首页有未读答复。预期：标题不因助理而变（只随该对话）；侧栏「助理」仍有圆点。
4. 打开助理首页。预期：💬 与侧栏圆点消失。

## 限制

- 已在 dev 上用 e2e-alice 做无头 Chromium 验收（sess_1795003069289975633）。限制：聊天页自身有未读助理答复的情况只有单元测试覆盖，未做浏览器验收。
- 归档页（`archived-chats-view`）沿用对话标题通道，按对话页处理，因此不显示 💬；侧栏「助理」圆点仍在。要改为列表页，需要让归档页不占用对话状态，另行处理。
- DEV-278 文档中「标签页标题带 ✅」的描述已由本条取代；DEV-278 文件未改。

## 2026-11-18 dev 验收记录（Agent 代验收）

- sess_1795003069289975633（e2e-alice，无头 Chromium）：助理答复未读时，对话页标题与图标不变；非对话页显示「💬 …」并使用 `/foundry-icon-assistant.png`；打开助理首页后清除。
- 限制：聊天页自身的未读答复情况未做浏览器验收。
