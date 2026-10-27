# DEV-056 链接按钮与上方文字左对齐

状态：实现、自验与 dev Web 部署已完成（首次部署引发 12 分钟 API 故障，已回滚并加上防护，见“部署事故”）；人工验收待确认。实施来源为协调会话 `sess_1793063405185071529` 转达的用户反馈（2026-10-28），实施会话 `sess_1793116917234800649`。不涉及 Server/Worker，无 Git 历史写入（提交由协调会话负责）。

| 环节          | 状态   | 说明                                                                                     |
| ------------- | ------ | ---------------------------------------------------------------------------------------- |
| 问题理解/调研 | 已完成 | 共享 `link` 变体沿用尺寸类的左右内边距与 1px 透明边框                                    |
| 代码          | 已完成 | 共享样式修正 + 5 处依赖内边距当作间距的调用改用公共 API；事故后加 API 同源默认与发布脚本 |
| dev Web 部署  | 已完成 | `f90e5a18c022a3d3`（经 `scripts/deploy-web-dev.sh`；`bf02cf6e76e0debc` 有故障，已回滚）  |
| Worker 更新   | 不涉及 | —                                                                                        |
| Agent 自验    | 已完成 | 合成 fixture 中 light/dark × 1280/390 前后对比、键盘焦点；dev 公网 asset 哈希一致        |
| 人工验收      | 待确认 | 见下方验收步骤                                                                           |

## 问题

截图 `.foundry/attachments/20261027/att_dmfpibsx2ir2_0_image.png`：归档 Toast“Archived 1 chat. Codex/Claude copies follow on each device.”下方的“Undo”比上方文字向右缩进。

## 原因

`toast.tsx` 以 `<Button variant="link" size="sm">` 渲染操作。`.fdy-button-link` 只改背景和颜色，`.fdy-button-sm` 的 `padding: 0 10px` 与 `.fdy-button` 的 1px 透明边框仍在，文字因此右移 11px（md 尺寸为 15px）。所有 `variant="link"`（32 处）都有此偏移，例如归档列表标题比下方元信息右移 15px，“Manage workspace service”比同列说明右移 11px。

## 修复

- `apps/web/src/styles/00-foundation.css`：`.fdy-button-link` 设 `padding-inline: 0; border-width: 0; border-radius: 4px`。尺寸类保留高度（命中区域），焦点环仍为共享的 box-shadow，贴着文字外侧显示。`size="inline"` 仍在其后，保持 1px 内边距。
- 原先有 5 处把这段内边距当作与前文的间距，改用公共 API，不在调用方补 hack：
  - 句中链接改为 `size="inline"` 并补空格：`chat-context-work.tsx`（共享服务说明、工作清单错误 Alert）、`workspace-services.tsx`（控制失败 Toast 的重试）、`chat-archive-banner.tsx`（原生副本失败的重试）、`chat-archive-dialog.tsx`（已有空格，统一为 inline）。
  - 相邻的会话链接列表：新增 `.fdy-work-session-links`（flex-wrap，`gap: 0 12px`，位于 `20-chat-work.css`），用于 `chat-context-work.tsx` 的相关会话 `dd` 和 `workspace-services.tsx` 的详情。
- 其余调用逐一检查：16 处已用 `size="inline"`，不受影响；flex 行/列中的 sm/md 链接（channels、feishu、assistant、settings、archived 标题等）由容器 gap 控制间距，去掉内边距后只是左缘与同列文字对齐。`markdown-content.tsx` 属 DEV-054/055 范围，未修改；它已用 `size="inline"`。

## 自验

合成 fixture（真实 `Button`/`ToastProvider`/`Alert` + 调用处同款 markup 与 class；`?legacy=1` 渲染旧 markup）由 Vite 本地提供，Chromium headless 测量文字左缘（Range rect）：

| 场景                          | 修复前（标题/链接） | 修复后    |
| ----------------------------- | ------------------- | --------- |
| 归档 Toast 标题 vs Undo，1280 | 915 / 926           | 915 / 915 |
| 归档 Toast，390               | 49 / 60             | 49 / 49   |
| 服务管理链接 vs 说明          | 63 / 52             | 52 / 52   |
| 归档列表标题 vs 元信息        | 39 / 24             | 24 / 24   |

light/dark × 1280/390 四组结果一致。Shift+Tab→Tab 焦点回到 Undo，焦点环完整可见、未被 Toast 的 `overflow-y: auto` 裁切（`after-focus-*.png`）。句中链接与前文保持一个空格；相关会话链接列表在 390 宽度换行，间距 12px。Undo 盒子 30.7×30px，高度不变。

检查：`scripts/check-changed.sh --files <6 个文件>`：prettier、Web tsc、56 个 Web 测试文件、11 项 audit:ui 全部 PASS；`pnpm audit:ui` 单独复跑通过。

## 部署

工作区中有其他会话未提交的改动，因此从冻结快照构建：`git archive HEAD`（`a24bc6a`）+ 本项 6 个文件，位于 `~/.foundry/server/releases/dev056-link-buttons/snapshot`，复用现有 node_modules。tsc + Vite 构建成功（仅有原有的大 chunk 提示）。北京时间 2026-10-28 约 00:18 发布到 `/var/www/foundryapp-dev`：先增量拷贝 assets（旧 assets 保留），再原子替换 index.html/version.json；前一版 index/version 存于同目录 `previous/`。公网 `version.json` 为 `bf02cf6e76e0debc`，入口 JS/CSS 的 SHA256 与候选一致，公网 CSS 含新规则（`web-deployment.json`）。e2e-alice 在真实 dev 只读打开归档页，加载该 build，light 1280 / dark 390 无横向溢出。该账号没有已归档聊天，本次未为制造 Toast 而归档数据。

磁盘：构建前后 `/` 均为 12 GiB 可用（89%）。

## 部署事故（2026-10-27 16:22–16:34 UTC，北京时间 10-28 00:22–00:34）

影响：首次发布的 `bf02cf6e76e0debc` 在约 12 分钟内让所有 dev 用户浏览器把 API 请求发到自己的 `http://127.0.0.1:31982`。表现为 ERR_CONNECTION_REFUSED、“Local API is not reachable”，聊天、会话记录与归档报 “Failed to fetch”。用户已遇到。

原因：快照用 `git archive HEAD` 生成，被 `.gitignore` 忽略的 `apps/web/.env.production`（`VITE_API_BASE_URL=`）没有进入快照。`api-base-url.ts` 在变量缺失时默认用本机地址，生产 bundle `index-E-czzV_l.js` 因此为 `bc={}, on=bc.VITE_API_BASE_URL ?? "http://127.0.0.1:31982"`。本会话部署后的只读截图其实已显示 “Local API is not reachable”，但被误判为未选工作区所致，没有拦下。

处置：

- 16:34Z DEV-055 会话（`sess_1793116876771359572`）发现后，本会话恢复 `previous/` 的 index.html/version.json，公网回到 `1792b54a13066032`。
- 根因防护（代码）：`apps/web/src/lib/api-base-url.ts` 改为只有 Vite 开发服务器与 Node 测试（`import.meta.env?.DEV !== false`）默认用本机地址。生产构建中 Vite 把 `DEV` 折叠为 false，本机地址字面量被删除，缺少 `.env.production` 时也走同源。先用最小 Vite 工程确认：生产构建中 `import.meta.env` 只是 `{}`，若写成 `env.PROD` 会得到 undefined，仍会回落到本机地址；`DEV` 的形式可以被折叠。实测：不带 `.env.production` 构建本快照，所有 JS 中都不含 `127.0.0.1:31982`。`test/api-base-url.test.mjs` 覆盖生产默认同源、开发/Node 默认本机、显式值优先（含空串）三种情况。
- 发布防护：新增 `scripts/deploy-web-dev.sh <dist> <release-dir>`。bundle 中只要含 `127.0.0.1:31982` 就拒绝，且在写入前退出（已用坏 bundle 验证）。之后的步骤：保存当前 index/version 到 `previous-<时间>`，增量拷贝 assets，原子替换入口，再核对公网 build id、入口 JS/CSS 字节与同源 `/api/worker/release` 返回 JSON，失败则自动回滚。用法写入 `docs/development.md`“Deploying the dev Web”。
- 16:46:15Z 用该脚本重新发布 `f90e5a18c022a3d3`（快照 = HEAD + 本项 6 个文件 + `api-base-url.ts`，并显式带 `.env.production`）。脚本核对全部通过；回滚副本 `releases/dev056-link-buttons/previous-20261027T164615Z`。
- 真实浏览器（e2e-alice，light 1280 `/chats`、dark 390 `/chats/archived`）：页面 build 为 `f90e5a18c022a3d3`，没有 “Local API” 提示。两页各 9 个 `/api/` 请求全部发往 `https://dev.foundryapp.app`，没有其他源请求，也没有失败请求。`/api/agent-profiles/models` 返回 409，原因是所选合成设备离线（界面显示 “Models unavailable”），与本次无关。见 `redeployed-browser.json`、`redeployed-*.png`。

## 证据

`.foundry/attachments/20261028/dev056/`：`before-*.png` / `after-*.png`（light/dark × 1280/390）、`after-focus-*.png`、`deployed-archived-*.png`、`web-deployment.json`、`dev056-link-fixture.tsx`（fixture 副本，已从仓库删除）、`shot.mjs`、`live.mjs`、`files.txt`。

## 限制

- 真实 dev 上的归档 Toast（需归档再 Undo）未由 Agent 触发，留给人工验收。
- 若 DEV-054/055 之后从各自的快照发布 Web，需要包含本项 6 个样式/调用文件和 `api-base-url.ts`，否则会覆盖本修复；发布请用 `scripts/deploy-web-dev.sh`。

## 验收步骤

1. 刷新 dev（version.json 为 `f90e5a18c022a3d3` 或更新版本），聊天列表正常加载、没有“Local API is not reachable”。
2. 归档任意一个测试聊天。预期：Toast 中“Undo”的首字母与上方文字左缘对齐。点击 Undo，聊天恢复。
3. 打开“已归档聊天”，预期：每行标题与下方 provider/设备元信息左对齐。
4. 用 Tab 聚焦 Undo 或归档标题，预期：焦点环完整可见、不被裁切。
5. 浅色/深色、窄屏（约 390px）各看一次。

## 流水

| 时间（UTC+8）    | 变化与证据                                                                                                    | 剩余动作                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 2026-10-28 00:23 | 共享样式修复与 5 处调用改用公共 API；检查全绿；dev Web `bf02cf6e76e0debc` 已部署                              | 人工验收；协调会话负责提交 |
| 2026-10-28 00:34 | 该 build 缺少 `VITE_API_BASE_URL=`，API 指向用户本机；DEV-055 报告后回滚到 `1792b54a13066032`                 | 根因与发布防护             |
| 2026-10-28 00:46 | 生产默认同源 + 单测；`scripts/deploy-web-dev.sh` 与文档；经脚本发布 `f90e5a18c022a3d3`，真实浏览器 API 均同源 | 人工验收；协调会话负责提交 |
