# Codex / Claude 执行配置隔离

2026-10-16。由 linux-dev 的自定义 `gateway-models.json` 将 872K 请求压到 285K 触发；实测 Codex 0.155.0/0.163.0 均受该本地目录上限影响，升级版本不能单独解决。

## 统一边界

| 对象                                                | 处理                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Provider、模型、窗口、权限、压缩设置                | 只使用 Foundry 解析后的 profile/session 配置                                                                |
| 原生全局和项目 settings、模型目录、MCP、hooks、插件 | 不隐式加载；Foundry 管理的技能/工具显式传入                                                                 |
| 原生登录                                            | 仍使用所选 native 登录来源，不迁走 refresh token、不改变账号                                                |
| 会话历史                                            | 作为数据保持原位置；仅链接 sessions/projects 并共用原生索引，保持 native id/resume                          |
| 工作区规则                                          | Codex 原生 AGENTS.md；Claude 显式读工作区 AGENTS.md、CLAUDE.md、.claude/CLAUDE.md，不附带 settings 执行能力 |
| 环境变量                                            | 清除未选中的原生执行控制变量；保留 OS/网络环境和既有明确凭据来源，profile/session 值最后应用                |
| OS/企业管理策略                                     | 不绕过；这不是操作系统沙箱，也不承诺覆盖 provider 的真实能力限制                                            |

独立目录位于 `<state>/native-runtime/<runtime>/<identity>/`，identity 绑定来源、官方账号身份、profile 和工作区。普通聊天和原生元数据读取使用同一配置策略；Issue/验证的既有沙箱目录也不再复制用户 Codex config.toml。自定义任意 shell command 不属于标准 Claude/Codex harness，不声称能隔离其自行读取的配置。

## Codex

- 独立 CODEX_HOME，只生成 SQLite 历史来源与项目配置读取策略；不复制 config.toml、models_cache 或自定义模型目录。项目 .codex/config.toml 被设为不可信配置来源；AGENTS.md 保留。
- 第三方 provider 显式生成选中连接定义。用户选择的 native provider 只导入明确的连接字段（包括认证方式、headers、传输参数），不加载整个本机配置文件；原 native provider id 保留为来源记录。
- 官方账号通过原生 app-server 的 `chatgptAuthTokens` 协议在内存传递 access token。refresh token 留在原来源，由原生 `account/read(refreshToken=true)` 负责续期；刷新时账号发生变化则拒绝，不静默切换。API key 登录亦通过原生认证接口。
- 不把访问令牌放到命令行、日志或模型提示中。官方目录读取也使用隔离配置，避免本地网关目录污染官方模型选项。

## Claude

- 独立 CLAUDE_CONFIG_DIR；原生 CLAUDE_SECURESTORAGE_CONFIG_DIR 指向所选登录的原安全存储。第三方 provider 的安全存储指向新目录，不借用官方登录。
- 仅将 oauthAccount 身份元数据写入新目录，原 settings/MCP/global config 不复制；projects 历史目录链接到原数据位置。
- SDK settingSources=[]、strictMcpConfig=true；只允许 Foundry 配置的 MCP 与技能/插件。工作区文本规则单独供给。
- 沙箱凭据维护改用无 prompt 的 native SDK accountInfo，不再用“回复 OK”触发模型请求。是否续期以原凭据存储实际 expiry 为准，不虚报成功。

## 验证证据

- `scripts/verify-runtime-isolation.mjs` 是可复用的真实原生客户端验证器：只连 localhost 模拟 provider、临时 HOME、合成凭据，不发送外部推理请求。
- Codex 0.163.0：污染全局/项目 config，指定 300K 自定义目录；Foundry 旧配置先复现 285000；随后同一 native thread 在隔离配置下两次 resume 均报告 828400，原文件保持不变。
- Claude 2.1.292 / SDK 0.3.301：污染全局/项目 settings 的 provider/model/window/hooks；隔离后两轮 start/resume 成功，使用选中模型，工作区规则出现、全局污染规则不出现、hook 未执行，未选中项目 agent/MCP 未加载。
- dev-server 真实官方 Codex 登录：隔离后 account/read 仍返回同一登录；额外一轮 gpt-6.1-sol 返回 CONFIG_ISOLATION_OK；原 auth.json 哈希不变。
- macOS：mac-laptop 离线，使用在线 mac-desktop 测试原生 Claude 2.1.294。该机器没有可用的真实官方登录，因此不声称完成真实 Keychain 账号端到端验收；合成 source 凭据测试确认安全存储与配置目录分离、源凭据未改、未继承源 MCP。没有推理请求。
- 自动测试覆盖配置/凭据来源、不同账号目录、历史可恢复、环境污染、实际窗口传递、窗口变化不复用旧配置、旧设置不继承及原有控制/沙箱路径。

参考：[Codex app-server 认证协议](https://developers.openai.com/codex/app-server/)、[配置参考](https://developers.openai.com/codex/config-reference/)、[Claude settings 来源](https://code.claude.com/docs/en/settings)。实现以当前安装的原生 CLI/SDK 实测为准。

## 生效和迁移

活动原生进程继续原配置，不强杀用户任务。新代码必须由实际 execution host 加载，随后新启动/恢复的原生进程才使用隔离配置。更新 Worker 包不等于当前旧 host 已升级；原 linux-dev 在途会话不会凭空变成 828.4K。

保留原账号、config 和历史文件，未修改用户网关模型目录。若运行时仍因 OS 管理策略或 provider 限制而缩小窗口，UI 继续展示真实原生上报，不用配置值伪装成功。

## 最终检查与发布（2026-10-16 20:15）

- 最终 34 个 Worker 测试文件完整重跑：209 pass、0 fail、5 skip（平台/环境条件）。Web TypeScript、3 个相关 Web 测试文件、10 项 UI 审计、模块边界审计及格式检查通过。初轮失败为旧“继承项目 settings/未显式清空 MCP”的测试预期和 provider-key fixture 未设置自己的 CODEX_HOME，均已修正并包含在完整重跑中；未关闭或放宽测试沙箱。
- Worker 发布版本 `0.5.7-dev.30.gca56545.local.1792151774`。staging tarball 内 244 个 dist 文件与验证后的构建逐字节一致；先复制包、再原子切换 release.json。旧 tarball 保留，旧 manifest 备份在本机私有 `~/.foundry/server-backups/config-isolation-1792151774/`。
- 五台在线 Worker（dev-server、linux-dev、linux-dev-2、linux-dev-3、mac-desktop）均注册新版，持续心跳正常；没有重启 Foundry server。
- mac-desktop host 32777、linux-dev-3 host 3550767 已使用新版。linux-dev-2 旧 host 仅剩闲置 Claude 缓存；维护前/后均确认无服务端活动输入、claims、background、ownTurns、计时器及未登记工具进程，才停止旧 host。新 host 347037 使用新版，Worker 347020，NRestarts=0，心跳持续。
- dev-server host 2648384 仍承载本会话等在途执行；linux-dev host 1564333 仍为旧版。两者没有强制替换，不能把已安装新版 Worker 表述成当前 native turn 已隔离。
- mac-laptop 离线，无法安装/验证新版。其原配置和登录未改。
- 设备账号页将“Foundry 使用”澄清为“登录来源”；生成的执行配置路径写入 session 的 Execution configuration 事件。
- 未 commit/push。
