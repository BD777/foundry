# DEV-080 Slash 菜单 ↓ 键无法向下移动

状态：已修复并部署 dev（Web `9ea27d5fee4b6258`），Agent 自验通过；待提交（2026-10-29 22:00 窗口）。

## 问题

输入 `/` 唤出技能菜单后按 ↓，高亮停在第一项，看起来"按不动"。

## 根因

不是列表 key 重复。`ComposerInput` 用 `caretTick` 让斜杠检测跟随光标，每次 `keyup` 都会 `syncCaret()` 让它加一；
而"候选集变化时把高亮重置到第一项"的 `useLayoutEffect` 依赖里也包含 `caretTick`。于是 `keydown(ArrowDown)` 把高亮移到第 2 项，
紧随的 `keyup` 又把它重置回第 1 项。

## 修复

`apps/web/src/components/ui/message-composer.tsx`：重置高亮只依赖真正改变候选集的因素——查询词、菜单可见性、当前斜杠 token 的起点；
不再依赖每次按键都会变的 `caretTick`。

## 验证

- 新增 `apps/web/test/composer-slash-keys.test.mjs`：keydown+keyup 的 ↓ 依次到第 2、3 项并回绕到第 1 项，↑ 回绕到最后一项。
  把 `caretTick` 放回依赖时该测试失败，修复后通过；`message-composer`、`composer-slash` 测试通过；Web typecheck 通过。
- 线上（e2e-alice，合成工作区）真实浏览器：输入 `/` 后两次 ↓，高亮依次为第 2、3 项（共 17 项）。截图在附件目录（不入库）。

## 验收步骤

1. 打开 https://dev.foundryapp.app/chats ，在输入框输入 `/` 或 `/z`。
2. 连按 ↓：高亮逐项下移，到底后回到第一项；按 ↑ 反向移动；回车选中当前高亮项。
