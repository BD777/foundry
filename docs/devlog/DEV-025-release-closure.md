# DEV-025 · 已验证迭代的统一归档与集成

本项是 DEV-006/007、008、022、024 的集成收尾，以及 DEV-009 核查、DEV-023 调研交付的状态校准，不是新产品功能。已验证交付按用户显式委托归档；统一源码集成由 [PR #136](https://github.com/BD777/foundry/pull/136) 承载，最终检查与合入回执以该 PR 为准。

## 准出授权与边界

2026-10-20 01:07（UTC+8），用户在[统筹会话](https://dev.foundryapp.app/chats/sess_1792388089518795992)明确委托：“你验证OK了的，你都先确认归档吧”，并授权“你验证过OK就合入”。本轮由[唯一集成 owner](https://dev.foundryapp.app/chats/sess_1792429694976881614)核验后准出；不是用户本人逐项操作验收。AGENTS 的默认人工验收流程增加显式委托例外，历史未通过记录保留。

- DEV-006/007：引用[统一交付记录](DEV-006-007-isolation-drafts.md)的真实草稿试验、宿主升级、无文件差异和新增文件两类 Issue 的完整 Verify → Accept → integrated 证据。没有重复昂贵原生推理，也没有削弱准确版本、证据和授权检查。
- DEV-008：结合[原始清理报告](../research/codex-writer-cleanup-20261019.md)、DEV-006/007 整合后的真实锁/子进程/立即重试回归，以及 DEV-024 后续退出/同线程重试回归核验。原 linux-dev-3 业务线程未代发输入；机制回归和新宿主证据不能冒充原事故现场重演。
- DEV-009：按当时只读核查的实际范围归档，不扩大为底层 OMH 任务审计。
- DEV-022：保留原生任务能力、共享服务控制及视觉修订证据，本轮补 only-ended 标题、间距与浏览器回归。
- DEV-023：仅研究交付归档，[方案](DEV-023-personal-agent.md)仍待讨论，不标记产品实现。
- DEV-024：完成恢复/input fencing/实时补答与 Skill 下载重试取消按[专项记录](DEV-024-stalled-response.md)核验。最初误拒收诱因和原冷缓存网络 cause 未定；继续保留定向观察，不能声称已根治。
- DEV-010–021 未开工、暂停及待办状态保留。DEV-016 macOS 真实 Keychain 专项不被 Linux 自验覆盖。

## 归属与集成审查

起点 main 为 `c2e46c6`。先核对会话清单：其他专项 owner 均已结束，统筹会话不写业务源码。对当前 198 个源码、测试和文档文件建立明确清单，并在仓库外 `/tmp/dev025-evidence/pre-closure-dirty.tar.gz` 备份；未使用全树盲暂存。三个 `.playwright-cli/` 快照是本地浏览器材料，保留在本机并加入 `.gitignore`；忽略目录中的附件、Skill 草稿、依赖、配置和认证状态不收入版本。

PR #135 的 `f832e75` 是早期基础批次。其全部 48 个变更文件均在当前整合清单中；现有 main 已包含后续三方整合、真实验收修复及其他专项改动。最终采用新集成分支和 PR，完成后明确关联并关闭被替代的旧草稿，不在旧 worktree 上覆盖文件，也不强推共享 main。

审查重点：原生 writer 退出确认先于资源释放；共享准备及私有凭据生命周期；不可变 Skill 包/路径/摘要校验与隔离试验的干净历史；原生能力不足时不提供控制；只列一度子会话；共享服务不被会话批量操作停止；服务关联 revision；完成补报在事务中绑定 input；取消与下载失败收束。历史失败、中断和条件 skip 均保留，不作为通过。

## 本轮 UI 修正

Work / 工作为稳定区块标题，既适用于活跃工作也适用于已结束记录。Ended / 已结束保留轻量折叠行；空清单且无错误/待确认回执时整个区块隐藏。区块上下均为 16px，子块以统一 8px gap 排列，移除折叠行额外上边距与标题下双重留白。沿用共享 Button、FinishedFold 公开 API、双语文案和现有颜色 tokens；不恢复逐行线、右侧状态点或子会话箭头。

## linux-dev 实际加载核验

2026-10-20 01:10，只读检查确认 daemon PID `3025723`，actual execution host PID `3056792`，entry 指向 `0.5.7-dev.39.gc2e46c6.local.1792427546`；旧 host PID `2941885` 已退出。三个加载文件与已验发布包 SHA-256 一致：

| 文件                          | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `skill-package-fetch.js`      | `b49888ef8d489b0515dae54b0e9590a86c8fa170bbf618cac521be4b1b7b2b78` |
| `skill-materializer.js`       | `7e0e41c3bb50cc08c3fec7713c0d2bfe044e8cf0552e498911eb71d756e9cce2` |
| `daemon/session-execution.js` | `bfbbec73f597b462b4b8a2dee5e48721e83476133b93560e8ee546eabc91855b` |

宿主由已有 idle-upgrade 自然接管，本轮没有切换/取消业务，也没有重放原 prompt。两个 dev-server 合成验收服务继续保留。原一次性计划已有 remove verified，本轮没有重建计划或批量停止服务。

## 本轮浏览器与部署证据

独立 `TestSessionWorkBrowserFixture` 提供真实 HTTP/API 和 UI，不连接 Worker、不运行模型或服务。增加 only-ended 6 个子会话与零项会话；复用既有混合状态 fixture。浏览器使用与公开站点同一份完整产物 `5c363c9b29f8b22e`。开发默认 build 的 API 指向本地 31982，首次 fixture 页面因此不能加载；改用实际部署产物后重新验证全部场景，未把首次加载失败当成功。

| 场景          | 结果                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| only-ended    | 稳定标题 Work / 工作；Ended (6) / 已结束（6）；Enter 展开、Space 收起，6 → 0 行且焦点保留        |
| 间距          | 上下 padding 均 16px；子块 gap 8px；标题下 margin 和 fold 上 margin 均 0                         |
| 零项          | 正文和工作清单加载后 `.fdy-chat-work` 数量 0，完全隐藏                                           |
| 活跃 + 已结束 | 8 条活跃工作、3 条历史；展开后数量准确，子会话链接无箭头；批量菜单只列 3 个可控制目标            |
| 窄屏          | 390px viewport/body；面板 clientWidth/scrollWidth 均 318px；可打开详情和折叠行                   |
| 主题/无障碍   | 亮/暗主题分别 axe 20 pass、0 violations、0 incomplete；实际页面截图检查                          |
| 日常 dev      | 既有独立 e2e-alice 账号登录 smoke；公开 version.json、浏览器 meta 与部署目录一致，无新增业务对象 |

截图归档 `.foundry/attachments/dev025/`：`ended-collapsed-light.png`、`ended-expanded-light.png`、`ended-collapsed-dark.png`、`ended-expanded-dark.png`、`ended-expanded-dark-390.png`、`ended-expanded-light-390.png`、`ended-chinese.png`、`mixed-light.png`、`empty-light.png`、`live-deployment.png`。机器读数在 `/tmp/dev025-evidence/browser/summary.json`。两个本轮浏览器已关闭，临时认证项已删除。

交互式 fixture 的外层 shell 最终回执为 143，日志只有 RUN、没有 PASS，因此不将该命令记作测试通过。此前的真实浏览器请求、交互、读数与截图独立留存；fixture 进程已退出，没有遗留服务。自动化测试的通过以完整检查的正式结果为准。

## 最终检查、部署与合入回执

| 检查/交付    | 回执与边界                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本机格式     | `pnpm format` exit 0；排除本地浏览器生成记录后全树通过                                                                                                                          |
| 定向范围检查 | 首轮 46 个 Web 文件发现一条旧标题断言；其余格式、16 个 HTTPAPI 用例、合约审计通过；修订后的 `check-changed` 对 1 个 Web + 3 个 Worker 文件全通过，Worker 16/16                  |
| 完整发布检查 | [PR #136 的 Verify](https://github.com/BD777/foundry/pull/136/checks) 执行完整 `pnpm verify` 与格式检查；按仓库保护规则，成功后才允许合入。此前本机和远端失败尝试在下文逐项保留 |
| 源码提交     | `fc8eff8a5380422ecf701da5bd07a764afe534d5`，独立 main 基线集成；后续文档提交共同进入 PR #136                                                                                    |
| 远端合入     | [PR #136](https://github.com/BD777/foundry/pull/136) 保留准确 merge SHA 和检查状态；以平台回执为准，不根据本文件中的计划宣称已合入                                              |
| 旧 PR        | [PR #135](https://github.com/BD777/foundry/pull/135) 被完整集成 PR #136 替代；关闭时附替代链接，原分支/worktree 保留                                                            |
| dev Web      | `5c363c9b29f8b22e`，公开 version.json、页面 meta 与磁盘产物一致                                                                                                                 |
| 运行时       | dev-server `1792399633` 已验证隔离/原生工作基线；linux-dev 实际 host `1792427546` 已加载全部恢复/下载补丁；不是仅安装包的声明                                                   |
| 本地保留     | 生成截图、日志、浏览器状态及未发布 Skill 草稿保留在忽略目录或仓库外，不作为未归属源码一起提交；两项既有合成服务和 DB 保留                                                       |

原始运行输出在 `/tmp/dev025-evidence/`。最终回执另随集成 owner 的完成报告交付；不将运行中、中断、失败或条件跳过混称为全量通过。

### 集成检查发现并修正的测试问题

- 首轮本机完整检查在 Worker 测试失败后停止，未运行到 Go/audits/vet，不能称为完整通过。daemon dispatch 的精确消息集合遗漏新加的两个草稿消息；补全 `refreshWorkspaceSkills` / `exportDraftSkill`，精确总数为 53。
- 继承环境中显式的空 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 代表原生默认凭据位置；旧登录同步及登录状态夹具只改配置目录，导致三个测试读错来源。夹具现显式设置并恢复自己的合成命名空间，保留原同步、单向隔离、refresh token 不复制与续期避让断言。相关三文件 16/16 通过，失败日志中的凭据片段已脱敏，原状态文件未修改。
- only-ended 旧测试还断言不出现 h3，与本次用户要求冲突；改为要求 Work 标题存在，继续断言条目、活动分组与操作入口在折叠历史中不可见。首轮 check-changed 的其余格式、16 个 HTTPAPI 用例和合约审计通过；修订后重新验证该测试。
- 首次全树格式检查只被本地 `.playwright-cli/` 临时快照阻断；将此生成目录加入 `.gitignore` 后 `pnpm format` exit 0，材料本身保留。
- linux-dev 独立 checkout 首次完整检查因缺少 bubblewrap，保护性测试启动器拒绝执行（exit 2），未用无保护模式跳过。复用 dev-server 已安装的 bubblewrap 0.8.0 到该临时目录，确认 OS namespace 隔离可用后重新跑完整检查；没有改系统配置或业务目录。

远端补充尝试没有通过：产品沙箱仅探测 `/usr/bin/bwrap` / `/bin/bwrap`，临时 PATH 的 helper 只能满足外层测试启动器；相关沙箱用例仍被保护性拒绝。linux-dev 已安装的 bytedcli 也抢先于旧测试的假程序，造成 4 个连接器测试失败。两类是该验证设备的环境条件，不将该次全量检查当通过、不修改生产安装位置、不关闭隔离、不放宽断言。已释放 compute lease，回到具备标准环境的本机完整重跑及 GitHub Verify。远端完整日志保留在该设备 Foundry compute 的 `dev025-release/verify-final.log`。

源码与测试已整理为 `fc8eff8a5380422ecf701da5bd07a764afe534d5`。最终发布清单共 203 个文件（178 个源码/测试、25 个文档/规则），没有未归属文件。重新构建的 266 个 Worker JavaScript 文件与已发布 `1792427546` 包逐一一致，无需重发同一运行时代码。dev `/healthz` 为 ok，startedAt 仍 `2026-10-19T15:32:36Z`。

### GitHub 完整检查与 WebSocket 退出竞态

最终集成内容 `45f24c0` 的 [PR Verify run 39295443355](https://github.com/BD777/foundry/actions/runs/39295443355) 已完整通过格式、`pnpm verify`（含所有测试/审计/Go vet）。同一内容的 push run 39295434390 在 `TestDaemonWebSocketHelloMustNameCredentialDevice` 的 TempDir 清理出现 `directory not empty`；授权拒绝/正确设备注册断言本身通过，但 WebSocket handler 的退出写入仍在发生，因此不能忽略该失败。

沿用仓库已有 `workspace_lifecycle_test.go` 的排空方式，在该测试退出时等待 `Server.Shutdown`，随后才关闭 store/删除临时目录。保留错误设备必须拒绝、正确设备必须注册的断言，并显式断言排空无错误。只改测试，不改变产品权限逻辑或部署内容。此修订在 linux-dev 独立 checkout 上重复 30 次全部通过（`go test ./internal/httpapi -run '^TestDaemonWebSocketHelloMustNameCredentialDevice$' -count=30 -timeout=5m`，exit 0，10.333s），作为独立测试提交加入同一个 PR；最终准出仍以最新 SHA 的 Verify 为准，旧提交的成功不替代新提交检查。
