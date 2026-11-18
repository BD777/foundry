# DEV-296 等你处理的选项按钮无障碍名称错误

状态：根因已用代码确认；修复与 Mac mini 检查见下文「验证」；补丁 `/tmp/DEV-296.patch`；已部署 dev（2026-11-18）；待本人验收；已合入 main（PR #278）。

## 问题

2026-11-18 dev 验证（DEV-293）：「等你处理」里的 `assistant_question` 条目把选项显示为药丸按钮（如「a.txt」「b.txt」）。鼠标点击可用，但 `getByRole('button', { name: 'a.txt', exact: true })` 找不到它。屏幕阅读器读到的名字不是选项文字，键盘与读屏用户无法可靠地选择答案。截图：`.foundry/attachments/20261118/verify-293/s1-pending-light-desktop.png`。

## 根因

选项已经是项目的 `Button`（`pending-item-card.tsx` 的 `primary === "options"` 分支），不是 `<div>`。问题在它的 `aria-label`：

- 每个选项写了 `aria-label={t("item.useOption", { option: label })}`，即「用“a.txt”回复」/「Reply with “a.txt”」。
- `aria-label` 覆盖按钮的文本内容，所以无障碍名称变成这句模板，而不是选项本身。
- 推荐选项的名称还带上「（推荐）」，而可见文字是「a.txt · 推荐」。

`agent-question-card.tsx`（聊天里的问题卡片）并不用按钮，它用 `<label>` 包住 radio/checkbox，名称就是选项文字；所以本修复不是照搬它，而是去掉覆盖名称的 `aria-label`，保留 `Button`。

## 修复

- 去掉选项按钮的 `aria-label`：名称即选项文字（`pendingOptionLabel` 去掉「(Recommended)」后的标签）。
- 推荐标记仍可见（「· 推荐」），但在按钮内用 `aria-hidden="true"` 排除出名称；屏幕阅读器通过 `aria-describedby` 读到「推荐」，指向一个 `sr-only` 的兄弟元素。视觉外观不变（同一 `Button` 变体、同一类名）。
- 删除不再使用的 i18n 键 `item.useOption` / `item.useRecommended`（en、zh-CN 同步）。
- 同一代码路径服务所有选项药丸（DEV-292/293/295 的问题条目与带选项的条目），所以一处修复覆盖整页。其他卡片（连接器写入、消息通道、通知）没有选项药丸，无需改动。
- Enter：原生 `<button>` 在焦点上按 Enter 即触发 click，键盘可达性由元素本身保证（未加 `tabindex`）。

## 测试

`apps/web/test/pending-items.test.mjs`：

- 新增「an option is a button named by its label…（DEV-296）」：断言 `BUTTON`、`type="button"`、无 `aria-label`、无 `tabindex`；无障碍名称（`aria-label` 或去掉 `aria-hidden` 后的文本）精确等于 `a.txt`/`b.txt`；推荐项的 `aria-describedby` 解析为「Recommended」；点击（Enter 在原生按钮上触发的同一个 click）后走 `POST /api/pending-items/pnd_1/answer`，正文为 `b.txt`。
- 原有测试里按 `aria-label` 选择选项的两处改为按名称选择。

限制：happy-dom 不模拟键盘激活，测试中 Enter 行为由原生按钮语义保证，未在测试内直接模拟按键；真实浏览器中的 Enter 验证需要在 dev 部署后做。

## 验证

- `pnpm audit:ui`（apps/web，本机）：全部通过。
- prettier --check：四个改动文件通过（pending-item-card.tsx 修正一处换行）。
- 远端（CanWendeMac-mini，`scripts/remote-check.sh --web test test/pending-items.test.mjs`）：38 个用例，37 通过、0 失败、1 跳过；跳过的两处 `t.skip` 为既有的 feature flag 条件跳过（HEAD 中即存在）。
- 远端 `pnpm typecheck`（`--web typecheck`）：通过。
- 远端生产构建（`--sh 'cd apps/web && pnpm build'`）：通过；仅有既有的 chunk 体积提示，无错误。

## 验收步骤（dev 部署后）

1. 用一个会话让助理提问两个选项（如 `a.txt`、`b.txt`），打开「等你处理」。
2. 在无障碍树或测试中按名称查找：`getByRole('button', { name: 'a.txt', exact: true })` 找到一个按钮；推荐项名称同样是纯选项文字，描述为「推荐」。
3. Tab 聚焦到选项，按 Enter：该选项被发送，条目进入已回答状态（`/api/pending-items/<id>/answer`）。
4. 视觉上与改动前一致（推荐项填充、「· 推荐」可见，浅色/深色、窄屏各看一眼）。

预期：第 2 步名称精确等于选项；第 3 步一次 Enter 即回答；第 4 步无视觉差异。
