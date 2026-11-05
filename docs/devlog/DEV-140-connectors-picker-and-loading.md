# DEV-140 连接器选择器与加载耗时

[Devlog](README.md)

## 问题

2026-11-05 本人：Connectors 页用平铺 tab 切换连接器，连接器越来越多会放不下，需要可搜索的下拉，并区分公开与私有；部分连接器点开后加载很久。

## 调查

- 公开/私有的含义取自代码与 [connector-extensions.md](../connector-extensions.md)：内置在 `apps/server/internal/connectors/catalog.json` 的是公开连接器（飞书、Cloudflare、AWS CLI、GitHub CLI）；描述符带 `extension` 的是设备所有者装在自己设备上的连接器扩展（Limen、bytedcli 等），只对本人可见。
- 加载耗时：dev Server 日志（2026-11-02 至 11-06，`slow request` 与 `connector RPC` 两行）：
  - `GET /api/connectors/devices?refresh=1` 71 次超过 1 s，几乎都在 3.0 s 左右：Server 对过期（> 2 分钟）的设备读数逐设备逐连接器调用设备上的 CLI，并最多等待 `connectorRefreshWait` = 3 s。
  - 设备端状态读取（action=status）p50/p90/max：bytedcli 3.6/11.7/21.5 s，aws 0.3/8.5/20 s，github 0.25/2.2/20 s，limen 0.6/2.7/20 s。
  - 每次点开一个设备持有型连接器都重新挂载并发 `refresh=1`；期间整块区域是骨架屏，已有的上次读数也不显示。
  - Cloudflare 的 zones 读取 1.0–4.6 s（Cloudflare API 本身），属工作区绑定页，未改。
- 根因：首屏等待“刷新过期读数”的请求，而不是先显示 Server 已存的读数；切换连接器时丢掉已读到的数据。

## 修复

- 选择器：新组件 `components/ui/search-select.tsx`（shadcn Combobox：Radix Popover + cmdk Command），按名称、kind、描述、工具命令、扩展名搜索；分“公开 · Foundry 内置”和“私有 · 来自你设备上的连接器扩展，只有你能看到”两组；每项显示状态：已连接、已登录、上次读取时已登录、需要登录、未设置。`connector-picker.tsx` 计算状态：Server 持有型看账号状态；设备持有型只有在线设备 2 分钟内的读数才算“已登录”，更旧或设备已离线的读数显示“上次读取时已登录”（不把缓存当作验证）。过滤按词做子串匹配（cmdk 默认的模糊匹配会让“limen”也命中“AWS CLI”，回车可能选错）。深链 `/connectors/<kind>` 不变，路由未改。
- 加载：设备持有型 tab 先读 `GET /api/connectors/devices`（已存读数，立即返回），再在后台发 `refresh=1`；刷新期间读数过期的在线设备行显示“正在检查 · 上次读取 …”，“全部检查”按钮用共享 Button 的 `busy`（转圈、`aria-busy`、禁用），列表区域 `aria-busy`；按 DEV-139 规则 3，内容保留、不加行、不换骨架屏。页面保存最近一次设备读数，切换连接器时直接绘制，不再出现骨架屏；读数只在页面打开期间保留。

## 验证

- 单测：`device-held-connectors.test.mjs`、`external-accounts.test.mjs` 42/42（新增：先画已存读数、刷新中行标“正在检查”、刷新后恢复；选择器分组、状态、过滤与选择）。web typecheck、`pnpm audit:ui` 15 项、`scripts/check-changed.sh` 通过。
- 真实浏览器（2026-11-06，headless Chromium）：本工作树的 Web 构建在浏览器内替换 dev 静态资源，API 走真实 dev，账号 e2e-alice（只读 GET，未改任何设置）。e2e-alice 的两台设备都离线，所以把 `?refresh=1` 人为延后 3 s，对应 dev 日志里过期读数的典型等待。
  - 深链 `/connectors/aws` 打开即选中 AWS CLI；鼠标打开列表，分组为“公开 · Foundry 内置 / 私有 · 来自你设备上的连接器扩展，只有你能看到”；输入 limen 只剩 Limen，回车跳到 `/connectors/limen`；Escape 关闭且焦点回到触发器；Space 打开、方向键移动、输入 + 回车选择；无匹配显示“没有匹配的连接器。”；刷新中“全部检查”按钮显示“正在检查…”并 `aria-busy`、disabled。
  - 浅色、深色、390 px 窄屏截图（列表宽 336 px，不溢出）。账号语言为中文，英文文案由单测覆盖。
- 耗时（同一浏览器、同一 3 s 刷新等待，从点击到出现设备行）：

  | 连接器     | 之前首次 / 再次 | 之后首次 / 再次 |
  | ---------- | --------------- | --------------- |
  | AWS CLI    | 3410 / 3467 ms  | 47 / 282 ms     |
  | GitHub CLI | 3355 / 3421 ms  | 51 / 261 ms     |
  | Limen      | 3352 / 3467 ms  | 23 / 371 ms     |

  之后的“再次”包含打开选择器、输入和回车的时间。之前每次切换都等 `refresh=1`（dev 日志 71 次约 3.0 s）；之后先画已存读数，`refresh=1` 在后台进行。

## 限制

- 设备端读取本身没有变快（bytedcli `auth status` p50 3.6 s、p90 11.7 s）；变化在于不再阻塞首屏。刷新完成前，过期的行显示“正在检查 · 上次读取 …”。
- Cloudflare zones（工作区绑定页，1.0–4.6 s）和飞书账号列表不在这次范围。
- 只用 e2e-alice 测过：它的设备离线，真实的设备端慢读取没有在浏览器里复现，用的是日志数据和人为延迟。

## 验收

1. 打开 Connectors：顶部是下拉框，不再是 tab 行；下拉框右侧显示当前连接器状态。
2. 点开：分“公开”“私有”两组，每项带状态；输入 bytedcli 或描述里的词，只剩匹配项，回车切换，地址变成 `/connectors/<kind>`。
3. 打开 AWS CLI / GitHub CLI / bytedcli：设备行立即出现；过期的行显示“正在检查 · 上次读取 …”，右上按钮显示“正在检查…”；几秒后变成最新结果。
4. 切到别的连接器再切回：行立即出现，不出现骨架屏。
5. 设备离线时，下拉框里它的旧登录显示“上次读取时已登录”，不是“已登录”。

## 时间线

- 2026-11-06：实现与自验（见上）；工作树 `~/workspace/foundry-connectors-picker`（`feat/connectors-picker`，基于 `3d073ffb`），未提交。
- 2026-11-06：工作树移到 `origin/main` `0c19251c`，`scripts/check-changed.sh` 全部通过。持 `/tmp/fdy-deploy.lock`，`git apply`（README 行手工加入）到 `~/workspace/foundry`；该 checkout 经 `fdy-heavy` 跑 web typecheck 与 `vite build`，`scripts/deploy-web-dev.sh` 发布 Web `35bee92f39807d21`（上一版 `6a2b0cf1610243e3`，入口资源一致、API 同源 JSON）。回滚：`~/.foundry/server/releases/dev140/previous-20261105T204839Z`。部署后用 e2e-alice 在真实 Chromium 复查 dev：浅色、深色下深链 `/connectors/github`，选择器搜索 limen 回车切换，API 都走本站。
