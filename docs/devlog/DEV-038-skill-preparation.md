# DEV-038 Skill 启动准备复用

2026-10-23，用户报告会话显示 `Loading 274 verified Skill packages`，要求保留 bytedcli 二级 Skill 的精确选择能力，参考 Codex / Claude Code 的渐进读取机制优化启动。用户在本会话批准实施；与 Connector 会话协调文件范围和共享构建锁。

## 结论与边界

现有二级索引只控制模型目录大小。启动准备仍读取校验压缩包、解包、构造并验证整个受管目录。新方案把可复用展开内容放在设备缓存中，模型正文读取与原生调用继续沿用现有机制。没有新增远程 Skill 加载 API，也没有限制每轮可用 Skill 数量。

设备共享系统账号，不能用 chmod、mtime 或磁盘上的“已验证”标记替代完整性检查。复用 Server 已有的 revision `source_digest`：通过会话清单下发，Worker 每次从展开缓存读取内容后计算相同摘要。它绑定每个文件的路径、字节长度与内容，UTF-16 排序与 Server 一致；缓存元数据本身不授予信任。旧 Server/旧试验锁定清单没有摘要时保留 ZIP 校验路径。

## 实现

- SQL 查询取已有 revision index 的摘要，不新增数据库 schema；显式选用、默认、bundle、固定版本和试验版本分别取对应 revision。内置包在 Server 启动构建时计算摘要。
- `skill-content-cache.ts` 保存每个 ZIP checksum 对应的展开二进制容器。每次复用仍完整验证内容摘要，省掉 ZIP 读取、ZIP SHA、解压、CRC；损坏、缺失、软链接或越界索引回退到可信 ZIP 重建。原子发布缓存；缺包从固定 revision 获取并校验。没有将本地文件标记当成授权。
- 原有 `materializeSkillSnapshot` 保留：会话目录全量精确检查，修复生成新路径，不覆盖活动会话持有的路径。为维持现有沙箱边界，会话目录保留独立副本，未改为指向公共缓存的符号链接。
- 同一宿主内并发准备相同版本共享下载；只取消最后一个使用者才终止共享下载。跨宿主/后台线程共享磁盘结果；跨进程同时冷缺失仍可能重复下载，原子发布防止半成品可见。
- 选用/默认/bundle/库版本变化与设备连接及后续 Workspace 登记触发后台准备，只准备该设备可运行 Workspace 的解析结果，排除其他设备和已归档/不可用 Workspace。要求新 capability，旧 Worker 不接收新消息。
- 后台 Worker 线程与控制连接分离，限制并发，合并相同集合；新选择替换旧任务，断线取消，超时退出。后台准备失败不阻止保存配置，前台仍可正常重试。它不创建会话或持久计划，也不改变会话允许清单。
- 启动事件报告复用、解包、下载数量与分阶段耗时。并发阶段的毫秒为累计任务用时，不能相加当作总墙钟时间。
- 用户选择菜单仍使用完整元数据；bundle 二级索引不会删掉成员调用身份。新增回归覆盖折叠成员的 `/`、`$` 校验与 Claude 命名空间转换。

## 测量与验证

基线：`skill-preparation-benchmark.test.mjs`，274 个合成 Skill，展开 53,099,298 字节、每包 13 个文件，预先放置 ZIP，故**不包含网络下载**。改造前本机隔离运行：首次目录准备 828 ms、热缓存 646 ms、续聊 779 ms、单版本变更 758 ms。这是 Linux 本机合成测量，不能解释原截图的 2 分 29 秒；已向用户请求对应会话链接。

阶段测试：旧有 runner/草稿及新基准共 24 项通过；新缓存测试覆盖跨进程、无 ZIP/无网络复用、篡改、替换、软链接、恶意路径、错误可信摘要、活动路径保留、共享下载与取消。完整最终检查、独立基准、部署证据在完成后追加。

## 交付与验收状态

- 代码：已实现并完成下述自验；DEV-038 单独提交合入主干，Connector 等其他会话的改动继续留在本地；共享构建使用 `/tmp/foundry-check-changed.lock`。
- Server/Worker：已发布并安装本项，实际执行宿主已于23:56切换并完成恢复核验；具体版本见下方回执。
- 人工验收：待确认。预期新宿主首次准备后再次开聊报告复用、零下载/零解包；单个版本更新只展开变化包；直接点名二级 Skill 仍可用。
- 缓存保留沿用内容寻址版本的保留方式，本次不自动清理旧版本或活动目录。

## 2026-10-23 自验与发布回执

- Worker 定向 54 项通过（6 个文件）：缓存、下载异常/取消、两运行时配置、目录隔离、草稿和版本修复。共享下载的旧回归原先要求两个独立网络请求，现改为验证一个共享请求、取消一方不终止另一方，语义仍是取消隔离。
- Server 定向通过：设备归属、连接/选用变化经真实 WebSocket 触发、默认 Skill、固定 revision 的摘要、历史版本试验、内置包、Go/TS 相同 UTF-16 内容摘要向量。协议契约和模块边界审计通过。
- 真实已安装 Claude Code/Codex 发现探针 `packages/worker/scripts/verify-skill-preparation.mjs` 通过，不发送模型请求、不修改账号/宿主 Skill：Claude 的 24 个折叠成员全部独立可调用；Codex 官方清单隔离、分组目录、不注入正文、显式成员验证通过。此探针不等价于模型实际执行这些方法。
- 独立基准：首次准备 2118 ms，热缓存 334 ms，续聊 380 ms，单版本变化 545 ms。热缓存与续聊均 274 个展开缓存命中、零下载/零解包；单版本变化 273 个复用、1 个解包。首次准备比基线慢，增加持久展开缓存的原子写入，后台预准备将这部分工作提前。基线和新值均为本机单轮合成测量，不包含网络、原生 Agent 启动或模型响应时间。
- 浏览器：独立 e2e-alice 账号在 dev 的已有合成 Workspace 中验证真实 bytedcli（262 个成员）的展开、成员过滤、键盘 Space 单独勾选；随后撤回未保存选择，未保存配置。亮色桌面、暗色390px无横向溢出/页面错误；公网已认证 API 200。截图在 `.foundry/attachments/20261023/dev038-skills/`。
- Server：PID3042938，实际 `/proc/<pid>/exe` SHA256 `b6089091d0095f1fc2db7fcb1f19d3b33250d15cefdbcd6c860e57d4c981ced8` 与候选二进制一致；本机 healthz 为 ok，startedAt `2026-10-23T04:44:35Z`。Web 无代码变更，保留已部署 build `90f983216c5cc75a`。
- Worker：发布并标准更新到 `0.5.7-dev.57.gb316fc8.local.1792730042`，daemon PID3037358。5 个关键安装模块逐字节等于构建，设备后台已生成14份展开缓存。发布来源1288文件摘要在 `~/.foundry/server/releases/dev038-skills/source-manifest.json`，发布前复核无漂移；旧 Server 与 release pointer 已保留。构建/安装后磁盘可用约13GiB。
- 日志与部署回执：`.foundry/attachments/20261023/dev038-skills/{worker-final,server-final,native,build,worker-update}.log` 和 `deployment.json`。原 `check-changed.sh` 自动扩展到无关 Git 初始化测试，已中止；此前 bundle 生命周期测试曾在临时 fixture 生成提交，工作仓库未执行提交。后续改用显式不创建 Git 提交的测试集合。补充 `check-changed.sh` 9 项检查全部通过（39.3秒），日志 `checks-safe.log`；随后追加的 Workspace 延迟登记预准备回归通过，日志 `server-followup.log`。

## 尚需切换实际执行宿主

PID2144701 仍加载 `0.5.7-dev.52.g7e5297f.local.1792605745`。标准更新保留当前会话和两个原有 Workspace 服务：`DEV-006/007 合成验收 Server`、`DEV-006/007 合成验收 Worker`，查询到的 observed state 均为 running。没有停止、暂停或删除它们，也没有创建自动维护计划。

因此后台预准备已运行，**不能宣称真实会话启动已经启用新物化路径**。待宿主真正空闲后自动切换，或由用户批准维护后暂停/恢复这些服务并切换宿主，再确认实际加载版本及真实会话的 `Skills ready` 事件。人工验收和截图对应会话的两分钟等待定位仍待完成。

## 2026-10-23 23:54 已批准宿主维护

用户明确回复“更新吧”。检查时只有本会话为 active claim；当前安装包已经由后续迭代更新到 `0.5.7-dev.57.gb316fc8.local.1792735712`，三个 Skill 核心模块与本项已验证发布逐字节相同，因此使用当前安装包，不降级。

两项原有合成服务已通过原管理器临时 stop（保留定义），控制回执均为 verified：Server `wop_8f792a991cbe84933063b78a4552f149` / revision14；Worker `wop_b0367e95f37ce3f950e90b3b1cd71568` / revision21。实际 observation 均为 stopped。暂停进程会保留 suspended 的 busy 状态，所以使用可恢复的 stop，而非 SIGSTOP。

为让当前会话结束后宿主按标准 idle upgrade 切换，已创建一次性 Foundry 持久唤醒 `work_d8d2951bd21528ae2c1033acd3a73c17`，2026-10-23 23:56:30（UTC+8）核验实际版本并恢复两项服务；设备已确认计划 revision1。即使核验失败也恢复原服务，不能留下维护停机。尚未宣称宿主已切换或服务已恢复；后续核验回执写入 `.foundry/attachments/20261023/dev038-skills/maintenance.json`。

## 2026-10-23 23:59 宿主切换及服务恢复完成

标准 idle upgrade 已在23:56:04将执行宿主切换为 PID3325667，实际 ExecStart、`/proc/<pid>/cmdline` 与 identity.json 均指向当前安装包 `0.5.7-dev.57.gb316fc8.local.1792735712`；旧 PID2144701 已退出。三个 Skill 核心模块与本项原先验证的发布字节一致。

23:56:31 的真实本会话启动事件：`13 selected revisions ready in 69 ms; 13 prepared versions reused, 0 local archives expanded, 0 downloaded`。这证明新物化路径已经实际运行，不仅是新包安装到磁盘。

两项合成服务已恢复：Server revision15 / `wop_4a9e995863cc73a6a32d5c3d31f138f5` verified；Worker revision23 / `wop_fb800538b1d6c1ba6de5898645987f6e` verified。23:58:43 两项 observation 均为 running。Worker 第一次恢复时 Server 仍在启动，出现 fetch failed 退出；等待 Server `/healthz` 返回 ok 后执行新的恢复操作，23:58:09 确认连接到原合成 Server。未改动合成服务定义。

一次性维护唤醒已执行收尾，没有创建重复计划。维护期间不提交 Git，工作目录仍为 main。回执与真实启动数据已保存于 `.foundry/attachments/20261023/dev038-skills/maintenance.json`。此项代码、部署及实际宿主生效已完成自验；人工验收和原截图会话的两分钟等待具体归因仍未声称完成。
