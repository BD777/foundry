# DEV-158 · 对话界面显示等待子会话

## 问题

父会话自己的回合已经结束、但仍在等它启动的子会话时，原界面显示得像普通完成状态。Server 已提供 `waitingChildCount`，并在子会话状态变化时失效父会话工作区的 `agentSessions` projection；Web 尚未显示这一状态。

## 修改

- 对话列表行在状态位置显示紧凑的沙漏和小号数字，完整文案放在 `aria-label`/`title`，父标题保留优先宽度；running 或 completed 的父会话只要 `waitingChildCount > 0` 都显示。
- 浏览器标签页加入 `⌛ Waiting N` / `⌛ 等待 N` 前缀，优先于 running、unread 和 background 标记。
- 打开会话的顶部加入等待状态胶囊；英文桌面为 `Waiting on 2`，中文为 `等待 2 个子会话`，窄屏只留图标和数字，完整文案留在 `aria-label`。点击或用键盘展开现有子会话工作清单，并通过 `lib/in-app-navigation.ts` 打开子会话。
- 共享 Popover 新增 themed panel appearance；子会话浮层跟随 `bg-panel`/`text-ink`，每行显示标题、带图标的状态和前进箭头，并使用共享 `ContextRow` 的 hover/focus/selected 状态。
- 子会话清单复用 `useSessionWork` 已有读取，不新增轮询；计数随 `foundry-data-changed` 的 `agentSessions` 刷新。
- 中英文文案同时补齐。

## 验证

- `node --import ./test/register-bundler-resolve.mjs --test test/document-title.test.mjs test/waiting-children.test.mjs`
- Web TypeScript typecheck
- `audit-component-system`、`audit-feature-architecture`、`audit-state-layout`、`audit-copy`
- Scratch 数据库副本中的合成父会话（completed）和两个 running 子会话，真实 Chromium 验证：
  - 对话行：`Waiting on 2 sub-sessions`
  - 标签标题：`⌛ Waiting 2 · Coordinate the waiting-child visual check · workspace — Foundry`
  - 顶部胶囊可展开两个子会话；浅色浮层为白底深字，每行显示状态；键盘 Enter 打开、Escape 关闭；子会话链接在应用内跳转
  - 2026-11-10 返工：子会话行改为 `minmax(0,1fr) / 状态 / 箭头` 三列网格，标题先截断，状态与 `ChevronRight` 保持可见；[light desktop](/tmp/waiting-children-chevron-light-desktop.png)
  - 中文：`等待 2 个子会话`、`⌛ 等待 2 · …`
  - 截图：[light desktop](/tmp/waiting-children-web-shots-v2/light-desktop.png)、[dark desktop](/tmp/waiting-children-web-shots-v2/dark-desktop.png)、[dark narrow](/tmp/waiting-children-web-shots-v2/dark-narrow.png)、[light narrow](/tmp/waiting-children-web-shots-v2/light-narrow.png)、[Chinese light narrow](/tmp/waiting-children-web-shots-v2/zh-light-narrow.png)

## 限制

本次只实现 Web；已部署 dev，随本提交窗口提交。Scratch 栈使用隔离 DB 副本和合成会话，数据在浏览器验证后随临时栈删除。

## 验收步骤

1. Parent 会话回合完成，且它启动的至少一个子会话仍为 queued/running/blocked，打开 Chats。
2. 列表行应显示 `Waiting on N sub-sessions` / `等待 N 个子会话`，标签标题带等待前缀。
3. 打开 Parent，顶部胶囊应显示相同计数；点击后列出子会话，选择任一项应打开对应会话。
4. 子会话全部结束后，计数和等待状态应随 projection 刷新消失。
