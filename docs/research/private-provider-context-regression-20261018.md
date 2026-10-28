# 私有 Provider 上下文降窗排查：Foundry 配置隔离回归

2026-10-18。已定位并在工作区实现修复；尚未部署到生产。未修改生产 Provider、运行配置或定时任务。

## 结论

本次窗口从 921600（95% 可用为 875520）降至 272000（95% 可用为
258400），是 Foundry 升级执行宿主后隔离原生配置、没有向 Codex 启动阶段补齐
私有模型定义的回归。不是已经证实的 catalog 超时，也不是模型改成了 gpt-5.5。

Foundry 的新隔离目录不继承原生 `model_catalog_json`。故障发生时的窗口适配仅向
`thread/start` / `thread/resume` 的 config 传入 `model_context_window`；在受影响的
Codex 0.163.0 中，未知模型仍被限制在 272000。即使 Foundry 成功解析到 921600，
这个传参也不足以使原生窗口达到该值。

## 证据来源

- 原排查会话：`sess_1792166086646208492`。
- 实际受影响会话：`sess_1792201997907970502`，linux-dev，模型
  `flux/GPT-6.1-Sol`，profile `codex_provider_llm_gateway`。
- 原生 thread：`01a14790-4322-7b83-a1a8-7f9cf8000739`。
- rollout：linux-dev 上
  `~/.codex/sessions/2026/10/17/rollout-2026-10-17T09-53-19-01a14790-4322-7b83-a1a8-7f9cf8000739.jsonl`。
- 读取使用 Foundry `read_context` 和 linux-dev compute lease。lease 已释放。

## 时间线

下表为北京时间，括号内为 UTC；只读取 JSON 结构化事件，没有全文 grep 数字。

| 时间                              | 证据                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| 10-17 09:53（01:53Z）             | thread 创建；session_meta 的 CLI 为 0.155.0；早期窗口 121600      |
| 10-17 13:00:48（05:00:48Z）       | `task_started` 窗口变为 875520                                    |
| 10-18 00:25:35（10-17 16:25:35Z） | 最后一个大窗口 `task_started`，该长 turn 持续到约 01:51           |
| 10-18 01:50:39（10-17 17:50:39Z） | 宿主强制升级备份保留旧 dev.28 宿主身份；新宿主为 dev.32           |
| 10-18 01:55:02（10-17 17:55:02Z） | Foundry 事件明确启动受管 Codex 0.163.0，使用隔离配置目录          |
| 10-18 01:55:04（10-17 17:55:04Z） | rollout 第 4667 行首次 `task_started.model_context_window=258400` |
| 10-18 09:12:34（01:12:34Z）       | 人工只读排查 turn 的窗口仍为 258400，尚未恢复                     |

结构化 `task_started` 共计：121600 为 3 次，875520 为 5 次，258400 为 42 次。
首次降窗以后没有新的 875520 `task_started`。不能用全文搜索中消息引用的旧日志、
命令输出或分析文字，证明两个原生窗口在后续交互 turn 中交替生效。

## 配置差异与代码路径

linux-dev 原生 `~/.codex/config.toml` 指定
`model_catalog_json=~/.codex/gateway-models.json`。该 JSON 的目标
模型行具有 `context_window=921600`、`max_context_window=921600`、
`effective_context_window_percent=95`。

首次异常启动实际使用
`~/.foundry/native-runtime/codex/69e1a2fe5a9e3b2d4c7e3e5e`。
该目录的 config 没有 `model_catalog_json`。

相关实现：

- `packages/worker/src/runtime-isolation.ts`：`isolatedCodexEnvironment` 创建独立
  CODEX_HOME，只写 SQLite 存储路径与项目 trust 设置，明确不导入原生模型目录。
  该隔离实现由提交 `717f548` 引入。
- `packages/worker/src/context-window.ts`：`codexContextWindowConfig` 仅返回
  `model_context_window`。
- `packages/worker/src/runner/codex-thread.ts` 与 `codex-app-server.ts`：将 profile
  config 传到 thread start/resume，未在 app-server 进程启动时提供私有模型目录。
- `packages/worker/src/agent-runtime/codex-client.ts`：启动 app-server 的实际参数。

官方配置说明也将 `model_catalog_json` 描述为启动时读取的模型目录：
[Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)。
以下行为结论以实际安装版本的隔离测试为依据，而非仅根据文档或旧源码注释推断。

## 原生隔离复现

使用 linux-dev 实际受管 Codex 0.163.0，通过 app-server JSON RPC 启动测试 thread。
子进程配置位于 compute scratch，去除了凭据环境变量，端点仅为本机 stub 或本机
关闭的端口；没有请求真实 Provider，没有执行真实模型推理。

| 启动和 thread 配置                                             | 原生 rollout `task_started` 窗口 |
| -------------------------------------------------------------- | -------------------------------- |
| 无私有模型目录，thread config 指定窗口 921600                  | 258400                           |
| 在 thread config 同时指定私有目录和窗口 921600                 | 258400                           |
| 无私有模型目录、无窗口覆盖                                     | 258400                           |
| app-server 启动参数加载私有目录，thread config 指定窗口 921600 | 875520                           |
| app-server 启动参数加载私有目录，无窗口覆盖                    | 875520                           |

复现产物在 linux-dev：
`~/.foundry/compute/default/context-cause-7qaon9zd/`。
各场景子目录保存测试 rollout 和 stderr，`catalog.json` 仅包含目标模型的定义。
测试进程已退出，本机 stub 已关闭。

## 修复边界

仅在 profile 的 `contextWindows` 中钉死 921600 不能解决这次问题，第一条复现
已经覆盖这个条件。应由 Foundry 将其已解析并认可的私有模型定义物化为受管目录，
在 app-server 启动前加载，同时保持原有配置隔离；不宜整体恢复继承用户原生配置。
模型目录身份应进入运行时复用判断，避免继续复用加载旧目录的进程。

历史异常 turn 是否另有 catalog 请求失败，没有请求日志
证明；但无须假设超时，已能由配置隔离和原生对照测试解释并复现此次降窗。

## 实现与验证

`packages/worker/src/agent-runtime/codex-model-catalog.ts` 从当前 CLI 的
`debug models --bundled` 读取内置模型定义。匹配原名或 relay 名最后一段对应的原生
模型，保留指令、工具与推理能力，并为实际模型名设置 `context_window` 和
`max_context_window`。不透明模型名采用原生编码模板并关闭未确认的可选能力。
原生压缩阈值由新窗口推导，不继承模板中可能属于旧窗口的显式阈值。

生成文件位于 Foundry state root 下的
`native-runtime/codex-models/<完整内容的 SHA256>.json`，权限为 0600；窗口或原生
定义变化产生不同文件，并发启动不会覆盖对方正在加载的目录。该目录不包含凭据。
原始用户配置和 `gateway-models.json` 不被读取、复制或改写。

`openCodexThread` 仅对 OpenAI 兼容连接传递解析后的窗口元数据，其值参与既有运行时
key；`CodexAppServerThread.runStreamed` 在获取运行时维护读锁后物化目录，再以
`app-server --listen stdio:// -c model_catalog_json="<受管文件>"` 启动 CLI，随后
执行原有 initialize、thread start/resume、turn start。官方账号不设置受管目录。
即使 handle 被复用，每次 runStreamed 仍重新启动 native owner 并读取当前 CLI 的
内置定义。目录读取失败明确失败，不继续用未知模型的小窗口；读取过程支持取消。

故障时隔离目录的准确路径是 linux-dev 上
`~/.foundry/native-runtime/codex/69e1a2fe5a9e3b2d4c7e3e5e/`。
这是 CODEX_HOME，目录身份由原生来源目录、profile、连接类型、workspace 和适用时
的账号身份哈希生成。它仍负责隔离 config、历史链接与技能；新模型目录通过启动参数
加载，不把它写回这个共享的 config.toml，避免同一 profile 并发使用不同模型时竞争。

新增 `packages/worker/test/codex-model-catalog.test.mjs` 覆盖能力保留、并发窗口、
原生定义更新、元数据失败、取消、在 initialize 前加载与保留同一 thread 的恢复。
`runtime-isolation.test.mjs` 增加兼容端点传入窗口与官方账号不覆盖目录的断言。

原生测试通过环境变量 `TEST_CODEX_CONTEXT_BIN` 显式启用；使用独立 CODEX_HOME、
本机 HTTP stub，通过修改后的实际执行类运行 CLI，不访问真实 Provider。dev-server
安装的 Codex 0.163.0 已验证：同一 thread 首轮 921600 → 875520；恢复并调小为
400000 → 380000；切到不透明私有模型名 700000 → 665000。旧实现第一轮即失败。

这次改动修复模型目录到执行进程的适配缺口；端点 catalog 获取失败时既有的窗口解析
回退策略没有改动，不能据此声称元数据服务故障已获永久解决。生产生效仍需部署 Worker
并确认执行宿主加载新版本，不能将本地测试通过描述为 linux-dev 生产已恢复。

最终检查：针对本次 9 个文件运行 `scripts/check-changed.sh --files …`，并显式设置
`TEST_CODEX_CONTEXT_BIN` 启用原生测试；格式、Worker 构建、12 个相关测试文件和模块
边界审计全部通过。原生目录读取期间也拒绝同一 handle 的并发启动，并验证取消会终止
元数据读取。`git diff --check` 通过。
