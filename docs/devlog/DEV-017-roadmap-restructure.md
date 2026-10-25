# DEV-017 Roadmap 按模块重组

状态：文档已完成并自查，经 [PR #145](https://github.com/BD777/foundry/pull/145) 提交；合入提交以 PR 页面与 Git 历史为准。只改文档与模块图，不涉及 Server、Web、Worker 的构建或部署。人工验收待确认。

## 问题

Roadmap 与待办分散在四处，且互相不一致：

- README 的 Roadmap 表（“现在能做 / 下一步”），以及 `docs/README.en.md` 的英文副本；
- 各模块文档的“后续”小节，部分写着“下一步 / 探索”等状态；
- Devlog 的“待启动、暂停及历史待核实事项”表（DEV-010–DEV-021）；
- `docs/README.md` 规定“不保留开发日志”，与 `AGENTS.md` 要求维护 `docs/devlog/` 矛盾。

内容也已落后于 main：模块图仍标 Personal Agent“未开始”（实际已建成、测试中）；README 与 `connectors.md` 只写飞书一种 Server 持有型（main 上还有 Cloudflare，#141）和附加授权组（DEV-029）；Chats 文档仍写 Codex SDK（main 上 Codex 经 `codex app-server`，`packages/worker/package.json` 已无 Codex SDK 依赖）。

## 做法

- **唯一入口 `docs/roadmap.md`**：以模块图为目录，每个模块写“负责 / 现在 / 待办表（ID、状态、依赖、完成标准、详情）/ 设计文档”。编号按模块前缀（Issues 用 `ISU-`，避免与真实 Issue 记录的 `ISS-NNN` 混淆）；DEV-010–021 全部映射到新编号。
- **README 与英文 README** 只保留模块图和每个模块一句现状，链接到 Roadmap 小节与设计文档。
- **模块文档**的“后续”改为链接到对应 Roadmap 小节，只保留设计要点，去掉与 Roadmap 竞争的状态标签；Personal Agent 的工作包清单标为已完成的历史分工。
- **Devlog** 首页说明它是执行记录、不是第二份 Roadmap；待启动表换成到 Roadmap 映射表的链接（原表在 Git 历史中）。`docs/README.md` 的“文档归属”规则改为与 `AGENTS.md` 一致。
- **连接器抽象**（`connectors.md`）：类型 → 持有方式 → 身份 → 登录方式 → Profile → 附加授权组 → Workspace 绑定 → 会话使用，逐项标明 main 上是否已实现；补 Cloudflare 小节。
- **Chats 跟随原生 Agent 演进**（`chat-experience.md`）：先用原生、差异放适配层、版本跟随官方 stable（`agent-runtime/update-controller.ts`）、新能力接入顺序。
- **工作流平台拆分设计**（新增 `docs/workflow-platform.md`，提案未实现）：结论是拆分成立，先把候选 Workspace、合入队列、证据与判定从 Issue 中抽成平台能力，再让 Issue 成为内置工作流，不建动态插件框架；附耦合点源码证据、接口、WF-1–WF-5 迁移步骤与兼容和归属。
- **模块图**：Personal Agent 改为已建成样式并标“测试中”；新增虚线的“工作流平台（规划）”一行；连接器框写明两种持有方式。用仓库里的 Mermaid 11.17.2 在本机 Chromium 渲染，并以 XMLSerializer 输出合法 XML。

## 检查

- 链接与锚点：自写的 GitHub 标题 slug 检查器扫描仓库全部已跟踪的 Markdown 及新文件，无断链；用故意写错的锚点确认检查器能报错。
- 模块图：`architecture.svg` 可被 XML 解析器解析；作为 `<img>` 嵌入时在 Chromium 中正常显示（截图 `.foundry/attachments/20261024/docs-roadmap/architecture-as-img.png`、`architecture-render.png`）。第一次渲染直接取 `innerHTML`，含 17 个未闭合的 `<br>`，作为图片时显示为破图，已改用 XMLSerializer。
- 代码事实逐项对照 main：连接器目录（`catalog.json` 四种）、Cloudflare 的 zone 范围与只读 scope、合入锁与 journal（`workspace-acceptance.ts`）、`IssueEnvironment` 字段、daemon 消息名、Codex 传输方式。
- `scripts/check-changed.sh` 与 PR 的 CI 结果见下方时间线。

## 限制

- 只校准了 Roadmap、连接器与 Chats 文档；其他模块文档的“实现边界”日期多为 2026-10-14/15，未逐项重新核对（Roadmap DOC-1）。
- 工作流平台是设计提案，没有原型；接口字段在实现时可调整。
- 部分模块的 `DEV-NNN` 交付记录只在会话链接中（DEV-028、DEV-031），没有独立文件。

## 验收步骤

1. 打开 README 的 Roadmap 小节：看到模块图（含虚线“工作流平台”一行、Personal Agent 标“测试中”）与每个模块一行现状，点模块名进入 `docs/roadmap.md` 对应小节。
2. 在 `docs/roadmap.md` 任选一个模块：能看到负责范围、现状、带完成标准的待办表，以及设计文档链接；“已迁入的历史清单”能找到 DEV-010–021 的去向。
3. 打开 `docs/connectors.md#连接器抽象`、`docs/chat-experience.md#跟随原生-agent-演进`、`docs/workflow-platform.md`：分别是连接器统一抽象、Chats 跟随原生的做法、Issue 与平台能力拆分的结论与步骤。
4. 在任一模块文档的“后续”小节：只有设计要点和指向 Roadmap 的链接，没有另一份待办清单。

## 时间线

| 时间（UTC+8）    | 变化与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 剩余动作            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| 2026-10-24 23:50 | 文档、模块图与本记录完成；链接检查通过；模块图渲染与 `<img>` 显示检查通过。分支 `docs/module-roadmap`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 提交、PR、CI 与合入 |
| 2026-10-24 23:50 | 提交 `29be31a`（DEV-040 记录）与 `cd9d5df`（本次文档），开 [PR #145](https://github.com/BD777/foundry/pull/145)；`scripts/check-changed.sh` 32 个文件 prettier 通过                                                                                                                                                                                                                                                                                                                                                                                                                                    | 等 CI，通过后合入   |
| 2026-10-24 23:59 | PR #145 两项 `verify` 通过后以 `122222b` 合入 main                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | —                   |
| 2026-10-26 02:10 | 本人确认新的分层：基础能力是核心（执行、隔离与合入、验证、能力供给、信任），工作流是基础能力的组合（Chats 直接写 Workspace、由人把关；Issues；自定义工作流为规划中的插件），全部围绕 Workspace 演进；Personal Agent 在工作流之上；渠道既是入口也是基础能力；候选基于 Git worktree。据此重画架构图（改为 `architecture.mjs` 生成的手绘 SVG，删除 Mermaid 源文件），README 首节改为“Foundry 是什么”，Roadmap 按层重组（编号不变），新增 WS-3 非代码项目；同步英文 README、文档索引、模块架构 §3.2、总纲与理念、`CONTEXT.md`。链接检查通过；SVG 可解析，在 900px 宽度与 GitHub 渲染的 README 中检查过显示 | 提交、PR、CI 与合入 |
