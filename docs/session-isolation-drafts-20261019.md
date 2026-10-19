# Workspace Skill 草稿与固定版本试验：接续实施

依据 [完整设计](session-isolation-design.md)，接续 [第一批隔离基础](session-isolation-implementation-20261019.md)。本记录区分代码、实际验证和发布状态，不把 CI 成功当作已部署。

## 当前实现

- Worker 只发现执行根内的 `.agents/skills`、`.claude/skills`、`.codex/skills`。拒绝越界链接和特殊文件；两遍读取核对内容稳定性；冲突与无效包单独报告。扫描在线程中执行，避免阻塞 daemon 心跳。
- 每个草稿生成不可变快照；明确依赖连同实际字节一起固定，保留相对文件布局。依赖变化也改变试验摘要。绝对跨包路径和无法解析的依赖明确拒绝，不回退到宿主安装。
- 普通会话每回合发现新版本；Issue 从自己的候选读取，澄清从源工作区读取；独立判定不自动加载候选指令。Issue 当前回合刷新返回的快照位于已有只读参考目录。
- `refresh_workspace_skills` 从真实调用会话确定根，不接受模型自报路径。返回可读、可试用的受管副本；不声称当前原生 Skill 工具已热注册。Workspace 开关与 `workspace_draft_skills_v1` 能力协商共同控制加载。
- 正式同名调用保持含义，草稿使用 `draft:name`。正式版与草稿字节一致时共用一个调用项。Foundry 治理名称不能通过大小写变化被试验替换。
- `create_session.skillSelection` 支持 include/exclude、指定草稿摘要与旧库版本。试验禁止 fork、adoption 和导入历史；不加载 baseline 的目标及相同内容别名。受管子会话继承锁定选择，不能重新引入已排除的方法。
- 跨设备明确试验传输精确包，源端与执行端分别校验；不使用目标设备的同名目录代替。原生内部子 Agent 在草稿/试验路径关闭，使用 Foundry 受管会话保持输入可审计。
- Workspace 页面提供刷新、开关、来源/摘要/错误、旧试验过期提示和试用弹窗。试用显式选择账号与 with/without/previous，失败保留输入，重试保持请求身份。发布仍使用原有独立的库发布入口。

## 已记录证据

2026-10-19，隔离测试栈 `isolation-drafts`，合成工作区 `/tmp/foundry-isolation-acceptance`：

| 场景                    | 实际结果                                                |
| ----------------------- | ------------------------------------------------------- |
| with_skill / v1         | `sess_1792369408459284775` → `DRAFT_ACCEPTANCE_V1_7429` |
| without_skill           | `sess_1792369439358534162` → `BASELINE_NONE`            |
| 文件改为 v2，锁定旧摘要 | `sess_1792369499499996174` → `DRAFT_ACCEPTANCE_V1_7429` |
| 从真实页面创建 v2 试验  | `sess_1792370669024082955` → `DRAFT_ACCEPTANCE_V2_8563` |
| 普通新会话自动发现 v2   | `sess_1792370726829943163` → `DRAFT_ACCEPTANCE_V2_8563` |

以上均为真实 Codex CLI 会话，native session id 各不相同，没有直接调用 provider 推理接口。

- 原生目录验收与草稿/依赖/传输回归：10 项通过，无跳过，包含真实 Claude/Codex 目录盘点与依赖包装后的原生调用名。
- macOS 实机：路径、配置、凭据生命周期、草稿和真实沙箱检查 41 通过、0 失败。9 个 Linux 专项及 1 个需当地 Codex CLI 的用例按条件跳过；不是 macOS 真实账号推理验收。
- 第一轮整批检查：Worker 23 个相关测试文件、Server HTTP API 全包、协议/模块/UI 审计通过。两条旧 UI fixture 未提供新增接口的正确响应，已修正；随后 11 个 Web 测试文件及相关复查通过。
- 浏览器发现并修复弹窗下拉菜单遮罩覆盖、任务输入缺少边框、未选执行账号无法创建试验的问题。桌面亮色与 390px 暗色截图在本会话附件目录。

## 生命周期与沙箱补齐

- 原生凭据、配置和历史来源分别建模；每个沙箱/账号的访问令牌副本独立。Claude 默认 Keychain 命名空间保留空值，自定义命名空间按原生规则定位；Keychain 拒绝访问时不换用其他账号。元数据操作只保留所选 provider 环境，使用一次性配置和历史目录，等待原生进程退出后清理。
- 私有输入记录进程及启动身份。空闲时清理已确认退出的受管 owner；不删除活动进程、未知来源或旧版无标记目录。快照保留每个历史内容头，只回收已替代的修复 generation；旧路径仅能转向摘要完全相同的内容。
- Linux 临时目录使用私有 `/tmp`，其下的允许目录单独挂载；修复嵌套 Codex 沙箱报只读文件系统的问题。SDK 工具事件不再在沙箱中创建设备级工作监督器。

## 新增验证证据

- 当前回合新建草稿 → `refresh_workspace_skills` → 读取固定快照：真实会话 `sess_1792371160731735189` 返回 `CURRENT_TURN_REFRESH_OK_3917`。
- 合成 Issue `iss_107` 的独立澄清会话 `sess_1792371234771124325` 实际读取工作区 README；参考上传、自然语言草案、聊天确认卡和 Details 已检查。修复前的 bubblewrap 与监督器错误已保留日志。
- 真实独立 Codex 判定，模型 `gpt-6.1-sol`，native session `01a151e5-5eff-7221-9b7c-4d34185d17f6`：读取实际候选 `result.txt`，观察 `ISOLATION_ACCEPTANCE_OK\n`，返回 pass 与文件引用；验证前后 SHA-256 相同。该项是独立判定验证，不代替完整 Issue Accept 流程。
- 2026-10-19 后续 macOS 回归：凭据来源、隔离、生命周期、元数据控制读取共 27 通过，0 失败，1 个原生 Codex 条件测试跳过。所有权/运行时租约测试需要 macOS 的 setuid `ps`，按现有测试启动器规则使用合成临时根分组执行。
- Mac 默认 Keychain 实机读取没有找到登录凭据；确认了定位保持一致、无凭据副本、临时配置/历史删除。**没有将 absent 结果当作真实登录成功**。默认/自定义 Keychain 与访问令牌投影由合成测试覆盖。

## 尚待收尾

- 完整 Issue G1–G5 的确认执行 → 验证 → 显式 Accept → 集成成功尚待完成。
- PR 检查及安全发布；本轮 Web 类型检查与生产构建通过，生产 execution host 尚未重启或升级。
- 不承诺静态分析能解析任意动态依赖；不删除未知 owner 或所有历史快照，不将普通 Chat 变成 OS 沙箱。

## 最后检查与继续入口

- Linux 生命周期收尾：`/tmp/foundry-lifecycle-final-check.log`，24 个 Worker 测试文件、构建、格式与模块审计通过。
- 快照入口防护：`/tmp/foundry-snapshot-final-check.log`，2 个测试文件、构建、格式与模块审计通过。
- Claude 到期状态/元数据查询：`/tmp/foundry-status-final-check2.log`，2 个测试文件、构建、格式与模块审计通过；Mac 对应 14 项通过，新增账号状态生命周期用例另行 3 项通过（包含重复回归，不累加为独立总数）。
- 跨语言契约审计通过：254 个类型、113 个 daemon 消息名、25 个浏览器事件、33 个请求映射；模块违规为零。
- 合成测试栈确认没有 queued/running/blocked 会话后已停止 server、worker、Vite 与该栈独立 execution service。随后误用 `scratch-stack.sh down`，删除了该合成栈 DB；本地合成工作区、外部测试日志和截图仍在。没有改动生产服务和无关的宿主 cron。上述 Session/Issue ID 是已观察到的历史证据，不能再通过该栈查询；晚间必须新建合成栈并重跑完整 Issue 验收。
- 继续使用 `/home/windeng/workspace/foundry-session-isolation`，分支 `feat/session-isolation`，PR #135，当前 HEAD `f832e75`；后续改动尚未提交。先重读 `docs/foundry-conversation-release-gate.md`。
- 重新用 `scripts/scratch-stack.sh up isolation-drafts` 创建测试栈（隔离 integrations），再为该栈配对/连接 Worker，重新登录和创建合成 Workspace/Issue。浏览器专用开发代理配置仍在 `/tmp/foundry-draft-vite.mjs`，端口须与新栈一致。
- 已删除栈的 Workspace `ws_8292c24a-e6eb-443a-83d2-9bd4aad75f80`、Issue `iss_107`、设备 `dev_07bef8c4-ec5d-42e4-a37e-2c74149b00be` 不可复用。新建合成任务，重新执行模糊输入、澄清、上传参考、草案，并确认最新引用，再自动化操作“确认标准并开始”、真实 Verify 和显式 Accept。完成后重跑受影响检查、记录证据，再更新 PR。不得把独立判定的 pass 直接当作 Issue 已通过。

- Web 生产构建：`pnpm --filter @foundry/web build` 通过，日志 `/tmp/foundry-drafts-production-build.log`。存在大于 500 kB 的 chunk 提示，构建未失败。
