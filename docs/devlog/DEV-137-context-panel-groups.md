# DEV-137 对话右侧面板分为“活动”和“资料”两组

## 当前状态

| 环节            | 状态   | 说明                                                                                      |
| --------------- | ------ | ----------------------------------------------------------------------------------------- |
| 问题理解 / 调研 | 已完成 | 见“问题”                                                                                  |
| 代码            | 已完成 | 仅 Web：`features/chat/context/` 三个文件、两份 `chat.ts` 文案、`chat-context-folds` 测试 |
| dev Server/Web  | 待确认 | 由编排会话安排部署，部署后补版本                                                          |
| Worker 更新     | 不涉及 | 无 Worker 改动                                                                            |
| Agent 自验      | 已完成 | 单测、`audit:ui`、真实 Chromium 渲染（夹具数据），见“自验”                                |
| 人工验收        | 待确认 | 见文末                                                                                    |

## 问题

2026-11-06 本人反馈（原话）：“把 Background 也挪到上面一点吧，就在 Agents 下面之类的，因为这些都是活动的东西，像 Files Screens 那些是静态的东西。相当于是两大类的东西，你看看在 UI 上怎么样把它们做一个区分，让阅读起来更有逻辑性一点。”

原顺序（`ChatContextCard`）：会话状态、额度、发起会话、定时任务 / Agents、Changes / Files、Screen、Previews、Background、（无工作清单时的）定时任务与子 Agent 兜底、Sources。Background 与 Agents 之间隔着全部文件区。

## 做了什么

- 顺序：会话状态、额度、发起会话不分组，留在顶部；其后是“活动 / Activity”组：定时任务、Agents（或兜底的定时任务、子 Agent）、Background；再后是“资料 / Materials”组：Changes、Files、Screen、Previews、Sources。
- 区分方式：每组顶部一条通栏浅底标签（`bg-panel-soft`，xs 小号文字，不用大写：编排会话 11-06 转达本人不喜欢大写标签），组内各节仍用原来的细线分隔。没有新增卡片或边框，标签不可交互。
- 组是带名字的 `<section aria-labelledby>`，标签是 `h2`（节标题仍是 `h3`），读屏按组导航。
- 空组不显示标签：活动组只在至少一节会渲染时出现。为此把 `WorkKindSection` 的“是否渲染”判断提成 `workKindState`，并导出 `hasSessionWork`，卡片与该节共用同一判断，不另写一份条件。资料组总有 Files 节（空时显示“还没有写入文件”），所以总显示。
- 不变：折叠记忆键（`<chat>:status`、`<chat>:background`、`<chat>:subagents`、`<session>:<kind>-history`）、`reveal` 聚焦、窄屏（≤1360px）关闭按钮的首节右侧留白规则。

## 自验

- `chat-context-folds.test.mjs` 新增用例：活动组在资料组之上、组内节顺序为 Subagents → Background、Files → Screen；`aria-labelledby` 指向组标签；没有活动时只出现“Materials”一组。该文件 4/4 通过；`chat-context-card`、`chat-context-background`、`chat-context-timers`、`chat-session-status`、`chat-context-state-events`、`chat-group-context-menu`、`chat-change-detail`、`session-work` 全部通过。
- `pnpm audit:ui` 通过。
- 真实 Chromium（playwright-core，vite dev 服务，临时夹具页面渲染真实 `ChatContextCard` 与样式，数据为合成：1 个定时任务、1 个运行中 + 1 个结束的 Agent、3 条后台命令、Changes/Files 各 1、Screen、Preview）：
  - 浅色 / 深色、1440 宽 / 1100 宽（窄屏浮层，关闭按钮显示）、中文、无活动、单回合文件筛选，组与节的顺序均符合预期。
  - Tab 顺序与视觉顺序一致：状态 → 定时任务 → Agent → 已结束 Agent 折叠 → 后台命令 → “2 finished · 1 failed” 折叠 → Changes …；在后台折叠上按 Enter 展开，`aria-expanded=true`。
  - 单回合文件筛选条（同为浅底）紧贴“资料”标签下方，读作该组的头部。

## 部署

2026-11-06 03:32–03:38：持 `/tmp/fdy-deploy.lock`，把本分支相对 `origin/main`（`113e56ea`）的 diff `git apply` 到 `~/workspace/foundry`（其余会话的在途改动保留），经 `fdy-heavy` 跑 web `tsc`（通过）与 `vite build`，`scripts/deploy-web-dev.sh` 发布 Web `6921bdbbb8112a76`（原 `d8c1b9352ad92570`，回滚副本 `~/.foundry/server/releases/dev137/previous-20261105T193826Z`），脚本核对入口资源一致、同源 API 返回 JSON。部署前分支上 `scripts/check-changed.sh`（prettier、web tsc、69 个 web 测试文件、`audit:ui`）通过。

部署后复用 e2e-alice（密码只由脚本从仓库外文件读取，未输出；cookie 在 0700 临时目录，验后登出并删除），只读打开其合成对话“DEV-111 Limen connector check (synthetic)”，headless Chromium：浅色 / 深色 × 1440 / 1100。页面 `version.json` 为 `6921bdbbb8112a76`；面板为“活动：定时任务”“资料：文件、来源”，1100 宽时从“显示对话详情”打开浮层，关闭按钮不压内容。未发消息、未运行模型、未新建或修改业务对象。截图在编排工作区 `.foundry/attachments/dev137/`（`live-page-*` 为线上，其余为夹具）。

## 限制

- 子 Agent + 后台命令 + 画面同时出现的情况只在夹具里看过；e2e-alice 在 dev 上没有这样的对话（其合成设备离线、旧会话已归档），线上只验了“活动只有定时任务”的情况。请按下方验收步骤在本人的真实对话上看。
- 线上页面每次加载都有一条 409 控制台错误，来自该对话所在设备离线，与本改动无关。
- 夹具里文件的 `op` 取了不存在的值，文件行状态显示为原始键名，与本改动无关。
- 草稿工作树的 `pnpm typecheck` 借用主 checkout 的 protocol `dist`，其中有其他会话未提交的 `triage` 会话来源，因此报 `chat-session-model.ts:147`（与本改动无关）；本改动的文件无类型错误。部署前在主 checkout 上再跑一次。

## 验收步骤

1. 打开一个正在运行、有子 Agent 且有后台命令（Claude 的 `run_in_background`）的对话，看右侧面板。预期：顶部是会话状态；下面一条浅底“活动”标签，依次是定时任务（如有）、Agents、Background；再下面一条“资料”标签，依次是改动、文件、画面、预览。
2. 切换深色主题。预期：两条标签仍能与普通分隔线区分开。
3. 把窗口缩到 1360px 以下打开面板。预期：右上角关闭按钮不压住内容，分组同上。
4. 打开一个没有任何 Agent、定时任务或后台命令的对话。预期：没有“活动”标签，直接是“资料”。
5. 在后台的“N finished”折叠上点开，切换到别的对话再回来。预期：仍是展开状态（与改动前一致）。
