# Session isolation 第一批实施记录

[完整方案](session-isolation-design.md) · [执行内核](execution-kernel.md) · [Skills](skills.md)

状态：分支实施，尚未部署到当前 execution host。本记录只覆盖基础修复；Workspace 草稿、刷新工具、Creator 对照试验和 Web 状态仍按完整方案继续实施，不能把本批视为六阶段全部完成。

## 已落到代码的边界

- `native-runtime-paths.ts` 分开原生 credential/data 来源与 execution config HOME；生成目录按显式 execution owner 区分（没有 AgentSession 对象时也如此），历史仍链接原来源。显式来源和旧执行目录 marker 用于恢复；仅对早期 `.foundry*/native-runtime` 目录保留迁移回退，普通自定义路径不因包含 `native-runtime` 被丢弃。服务安装保存可恢复的原来源。
- `session/preparation/index.ts` 为普通 Claude/Codex turn 与独立判定解析模型窗口、环境、原生 Skill 盘点和无秘密 manifest。判定不加载候选 Skill 指令。配置私密输入用进程内不透明版本标识，manifest/复用键不保存 API key 的哈希。
- Codex 执行配置显式使用 `cli_auth_credentials_store="ephemeral"`，关闭 memories；Claude 关闭 auto memory。独立判定也解析兼容端点窗口，模型目录写入其私有 scratch。诊断 flag 不再允许跳过隔离。
- 沙箱创建空 HOME 后才按实际 profile/runtime 准备官方凭据，只传 access token。自定义原生登录源受支持；兼容端点不再无关地复制另一 runtime/官方账号。续期按原来源并发合并，关闭租约后清除副本，已在途的续期不能重新创建它。
- Claude settings 按内容修订生成不可变、0600 的文件，准备结果及长驻 runtime 持有引用。共享文件直到最后一个 owner 释放才删除；启动清理不再全局删除其他 execution host 的文件。监督启动的子进程退出后才释放其准备引用。
- 配置/Skill 更新不会接管仍有后台工作、timer 或活动 turn 的旧 Claude writer；显式停止沿用既有控制入口。无法安全切换时返回等待或新建试验会话的说明。
- `skill-snapshots.ts` 从已校验 SHA-256/长度的 zip 重建预期清单，复核正文、脚本、索引和插件元数据的实际字节；拒绝额外文件/目录及 symlink。损坏时发布新 generation，保留旧 owner 所持路径。沙箱只挂载本次确切 `pluginDir`，不再开放整个 `skill-sets`。
- 原生验收脚本使用现有公共 preparation / adapter 导出；移除了过时 runner 导出调用，使用临时 HOME、合成包和无 prompt 原生盘点。

## 验证证据

2026-10-19，Linux 本机：

- 最终改动检查：46 个文件的格式、Worker 构建、48 个相关测试文件和模块依赖审计全部通过；随后 Worker 全套回归 801 通过、10 项按条件跳过；最后补充显式 owner 参数传播后，涉及的 17 个测试文件、构建及模块审计再次通过。显式指定真实 Codex CLI 的认证/路径用例 6/6 通过。专项覆盖准备失败/取消、引用持有、配置 HOME/历史定位、后台刷新保护、只复制所选凭据与续期停止竞态、Skill 正文/脚本/marker/plugin/额外目录/symlink 篡改及并发修复。
- Bubblewrap 实测：本次精确 Skill 快照可读且不可写；相邻的其他集合不可读。
- 真实 Codex 0.163.0 的窗口验收 6/6 通过（显式 `TEST_CODEX_CONTEXT_BIN`）：同一 native thread 新建、恢复并切换模型，配置窗口依次为 921600、400000、700000；原生 `task_started.model_context_window` 均为 CLI 保留预算后的 `floor(tokens × 0.95)`。仅连接返回 400 的 localhost stub，没有生产账号或实际模型推理。
- 真实 Codex 0.163.0，临时 HOME、合成 API key、无推理：文件凭据模式会生成 `auth.json`；ephemeral 模式不生成。回归测试使用 `TEST_CODEX_AUTH_BIN` 显式选择设备已有 CLI，原来源不被清理，manifest 不含合成 key。
- 真实 Claude Code 2.1.294 / Codex 0.163.0：`packages/worker/scripts/verify-native-skill-isolation.mjs` 通过。Claude 选一个/零个受管 Skill 时目录准确；Codex 禁用两个项目原生 Skill，只保留五个官方内置 Skill。这里只验证原生盘点，不代表模型实际读取或原生内部子 Agent 隔离已通过。

## 中断后接续核验

2026-10-19，接管原工作树并确认已更新至 `c2e46c6`：

- 重新执行第一批 47 个文件的格式、Worker 构建、48 个相关测试文件和模块审计，全部通过。
- 补齐独立判定在准备完成后、凭据维护或 SDK 加载期间取消的处理：进入统一清理范围，启动前重新检查取消，Claude 查询结束后移除取消监听器。新增已取消判定不得启动查询的回归；涉及 3 个文件的格式、构建、9 个测试文件与模块审计全部通过。
- 使用已安装 Codex 0.163.0 显式启用真实 CLI 测试，路径、ephemeral 认证、模型窗口新建/恢复/切换共 12 项通过，无跳过。
- 在测试隔离器内重新运行原生 Skill 盘点脚本，Claude 选中/空集合与 Codex 项目 Skill 禁用检查通过。
- 以上核验使用临时状态目录和合成凭据；没有重启正在运行的 execution host，也没有验证生产账号推理或 macOS。

## 本批仍不覆盖的内容

- Workspace `.agents/skills` 的正式试用、可信刷新引用、来源冲突、关闭开关、原生安全重建和 Web 展示；当前会话仍只能调用已有选用与官方内置 Skill。
- Creator 的 with/old/without 新上下文试验、跨设备快照传递和原生子 Agent 验证。
- 完整的元数据 operation 生命周期、崩溃秘密文件回收与 Skill generation GC；当前保留旧 generation 以避免清理活动执行输入，可能积累磁盘空间。
- 普通 Chat 同 UID 的恶意修改、TOCTOU 或设备凭据可读性；本批没有把普通 Chat 改为 OS 沙箱。
- macOS 实机、真实账号恢复/窗口推理，以及 Issue G1–G5 全链路和安全部署验收。尚未升级或重启任何现有 execution host。
