# DEV-097 · 过程列表里只有最新一步显示运行中效果

状态：已部署 dev（随 DEV-096 的 Web `992d80038c6faa45` 一起上线），Agent 自验通过（单元测试、tsc、UI 审计；线上 bundle 核对）。无 Server、Worker 改动。未做真实浏览器中正在运行轮次的目视检查。人工验收待确认。未提交。

## 问题

本人截图：一个正在运行的回合展开过程列表后，许多条 “Requesting the model”“Thinking” 都带着运行中的扫光效果。预期只有折叠头和列表里最新的一条有这个效果。

## 原因

- `ProcessDisclosure` 对每一行单独判断 `streaming && isProcessRowRunning(row)`，满足就加 `data-active="true"`，CSS 据此加扫光。
- 带类型状态的步骤（工具调用，`status` + `callId`）有完成事件，完成后不再是 running。
- 状态心跳（Requesting the model）和旧式标签（Thinking 等）没有 `status`，只能按标题判断；它们没有自己的完成事件，所以整个回合运行期间每一条都算 running。截图中 “Finished thinking · Claude is thinking.” 的详情与前一条 Thinking 不同，按标题+详情也配不上对。

## 修复

`apps/web/src/components/conversation/chat-process-display.ts` 的 `processDisplayRows`：运行中的回合里，没有 `status` 且后面已有更新步骤的行视为已结束——输出 `status: "completed"`，标题与标签改为完成态（Thinking → Finished thinking；Requesting the model 无完成态，文字不变但不再闪）。带类型 `status: "running"` 的行不变，并行工具调用仍都显示运行中。折叠头本来只看最后一行，不受影响。

## 自验

- `apps/web/test/chat-process-display.test.mjs` 新增用例，按截图的事件序列构造：只有最新的 Thinking 与仍在运行的类型化工具调用是 running。相关 4 个测试文件 39/39 通过。
- `scripts/check-changed.sh`：prettier、tsc web、web tests、12 项 UI 审计通过。
- 线上核对：`https://dev.foundryapp.app/version.json` 为 `992d80038c6faa45`，入口 `assets/index-DiSzKfoa.js` 含新逻辑（`!o.status&&c<n.length-1` → `status:"completed"`）；上一版 `index-CrMTE0Yf.js` 不含。

## 限制

- 没有类型状态的旧式工具标签（无 `callId` 的 “正在使用工具”）如果真的并行运行，较早的一条也会显示为已结束；只按最新一条显示运行中。

## 验收步骤（给用户）

1. 打开一个正在运行的会话，展开过程列表。
2. 预期：只有折叠头和最后一条（以及仍在运行的工具调用）有扫光；更早的 “Requesting the model” 静止显示，更早的 “Thinking” 显示为 “Finished thinking”。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                | 剩余动作 |
| ---------------- | ------------------------------------------------------------------------- | -------- |
| 2026-10-30 13:35 | 定位原因并修改 `processDisplayRows`；新增回归测试；check-changed 全部通过 | 部署 Web |
| 2026-10-30 13:42 | 用户决定随 DEV-096 一起上线；DEV-096 部署 Web `992d80038c6faa45`          | 核对     |
| 2026-10-30 13:50 | 核对线上入口 bundle 含本修改                                              | 人工验收 |
