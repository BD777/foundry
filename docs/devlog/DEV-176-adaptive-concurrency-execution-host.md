# DEV-176 · 自适应并发、执行宿主清理与下载代理

## 问题

固定并发上限在 2 核机器上既可能压垮内存，也可能让人发起的主回合和等待子会话的父回合无谓排队。执行宿主的过期 claim 会持续累积，退出时还可能丢掉最后一次写入。连接器与工具下载只读取进程环境代理，没有复用 Worker 已经保存的代理。

## 调查

- AC-1 的旧实现已有资源信号、回合采样和纯函数准入，但下限只有 1，且只按核数推导固定硬件上限。
- 设备设置仍是单个 `maxConcurrentTasks`，服务端、Worker 和 Web 没有统一表达 adaptive/forced。
- execution host 的 `claims.json` 每次变化都独立写文件；进程退出时没有可靠的同步落盘屏障。
- AWS、GitHub CLI、Aliyun、npm/uv、扩展与 Skill 仓库下载各自处理网络，保存的 Worker 代理没有覆盖这些路径。

## 修复

- 自适应并发下限改为 `min(16, max(4, cores × 2))`；内存按典型 RSS 与 SwapFree 估算，硬保护统一阻断所有新回合。
- 人发起的 chat/Issue clarification 以及仍有运行子会话的父回合放行；受限回合继续使用自适应槽位。
- `AgentRuntimeSettings` 改为 `adaptive | forced`，旧 `maxConcurrentTasks` 兼容迁移；设备页显示当前上限、运行/排队、信号和每工作区估计。
- execution host 为 claim 增加可选完成时间，清理过期记录，合并写入并在异步写前重读磁盘；新增退出同步 flush 屏障。
- 远端检查隔离全局 Git 配置；连接器与工具下载统一走 Worker 保存的代理，错误只显示脱敏的 direct/代理路由。
- 本 PR 因共享文件和契约生成物的整文件规则，同时包含后续主题所需的契约定义、执行模型设置组件与 usage API 声明；这些不是本主题新增的产品行为。

## 部署与版本证据

该终态已部署到 dev：Server/Web `120fe737567f9e88`，Worker `…1794395454`。提交依据为部署状态快照 `tmp/deployed-20261111`，本 PR 从该快照按主题取文件。

## 检查

- AC-1 交付记录：`admission-policy` 13/13、`runtime-settings-default` 6/6、`concurrent-task-scheduler` 7/7、`slot-wait` 2/2、`devices-feature` 12/12；Worker、Protocol、Web typecheck 通过。
- execution host 交付记录：Worker `tsc` 通过，`execution-core.test.mjs` 12/12，覆盖旧 schema、合并写、跨宿主新增保留和退出 flush。
- 下载代理交付记录：核心改动后 Worker `tsc` 通过，相关 62 通过、1 跳过；覆盖保存代理、环境代理、脱敏、工具与连接器下载。
- 测试基础设施交付记录：39/39 相关测试、`bash -n`、Prettier 和 Mini `remote-check` 通过。
- 本 PR 合并前继续执行本分支的 Go build/vet、Web 与 Worker 定向 typecheck。

## 限制

- 已由旧版本改写成新设置形状、且删除原 `maxConcurrentTasks` 的设备无法反推历史显式上限，只能按 adaptive 处理。
- 双宿主同时写同一个 `claims.json` 仍不是通用的多写者文件协议；本次只保留跨宿主新增并让完成状态优先，缩窄既有覆盖窗口。
- 下载代理测试是单元与进程环境覆盖；真实代理网络质量仍需设备侧验收。

## 验收步骤与预期结果

1. 在 2 核设备打开设备设置：默认应显示 adaptive，下限不低于 4；强制模式可设 1–16。
2. 同时发一个人回合和一个 agent 子会话：子会话应受槽位限制，人回合应立即启动；内存低于硬保护线时两者都显示等待原因。
3. 重启执行宿主：`claims.json` 中已完成或过期的 claim 应被清理，其他宿主的有效 claim 保留，退出前最后一次变更不丢失。
4. 给 Worker 配置 HTTP 代理后下载连接器或工具：请求应走保存的代理，失败信息显示脱敏代理路由。
