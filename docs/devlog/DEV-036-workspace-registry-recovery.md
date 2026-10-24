# DEV-036 · 诊断测试覆盖真实工作区登记表

## 问题与证据

2026-10-23 用户反馈聊天发送 `hi` 得到设备状态冲突，要求修复并部署。
Server 健康、sg-chaos 在线，但 foundry 工作区带有 `unavailableOnDevice.reason=not_served`。
真实 `~/.foundry/workspaces.json` 只剩 `ws_kept`，路径是已消失的
`/tmp/fdy-10I2AL/diag-ws-zHQA4C/kept`；文件修改时间为北京时间 2026-10-22 21:39:59。

会话 `sess_1792633413864979765` 的工具事件记录了同一时刻执行
`cd packages/worker && node --test test/diagnostics.test.mjs`。
该测试的 `forgetting missing workspaces keeps the ones that exist` 将登记表整体写为
`ws_kept/ws_gone` 再忘记后者，和线上遗留内容一致。之后改用隔离启动器运行测试，
并没有恢复此前损坏的登记表。Server 在 2026-10-23 01:19:27 重连时收到零工作区清单，
将真实工作区标为不再提供服务。发送检查因此返回 409，Web 又将具体原因折叠成泛化冲突。

## 恢复与修复

- 先备份损坏登记表至 `~/.foundry/workspaces.json.incident-20261023`。
- 对照 Server 的未归档工作区和每个目录现存 `.foundry/workspace.json`，恢复
  foundry、RouteGuard、workspace、aqiu、happyclaw 五项的原 ID、路径与名称。
  未恢复已归档 personal-agent，未改业务会话或数据库内容。
- Worker 自动发现恢复后的清单并重新上报；Server 五项均已清除不可用标记。
  无需重启 Worker、execution host 或 Server，没有中断其他设备的活动会话。
- 诊断测试在导入任何 Worker 模块之前建立独立临时 state/tools 目录，结束后清理。
  即使误用直接测试命令或继承真实 state 配置，该文件也不再覆盖真实登记表。
  正常测试仍使用既有 OS 隔离启动器；此修复不替代它，也不宣称其他裸跑测试均安全。
- Web 为“不再提供工作区”和“文件夹消失”分别显示明确恢复指引，继续保留输入，
  不展示任意服务端正文中的设备名、路径或秘密。中英文同时更新。

## 部署和验证

2026-10-23 部署 Web build `390c82e7c4f2c855` 至 `/var/www/foundryapp-dev`，
公网 `version.json` 与浏览器 meta 均确认此版本。原入口备份在
`/tmp/foundry-incident-index-before.html`，旧哈希资源保留。无 Server/Worker 产品代码改动，
两者无需升级；登记修复已由运行中的 Worker 自动加载。
构建前后根分区均约 14 GiB 可用、使用率 87%。

- 诊断测试 5/5、发送错误测试 8/8 通过。
- `scripts/check-changed.sh --files` 覆盖五个源码/测试文件：格式、Web 类型检查、
  49 个相关 Web 测试文件、诊断测试、10 项 UI 审计全部通过。
  回执：`/tmp/foundry-incident-checks.log`。
- Web 生产构建通过；本机真实 Server `/healthz` 为 `ok`。
- 真实浏览器以专用 e2e-alice 账号加载已部署页面；仅拦截合成新聊天发送为 409，
  验证新的恢复文案、草稿保留和可重试状态；浅色桌面、390px 深色页面检查通过，
  无水平溢出。截图在 `.foundry/attachments/20261023/dev036/`。
- Server 只读复核确认 sg-chaos 五个未归档工作区均可用。

## 限制与人工验收

浏览器的 409 是 UI fixture，不是真实模型回包。现有专用测试账号无法访问用户的
sg-chaos 工作区；本轮未冒充已验证用户账号下端到端模型收发，也未更改账号权限。
请刷新 dev 页面，在 foundry 工作区原输入框重试 `hi`：应成功发送并出现 Agent 回复，
不再显示设备状态冲突。人工验收待确认。

## 时间线

| 日期       | 进展                                                                               | 剩余动作           |
| ---------- | ---------------------------------------------------------------------------------- | ------------------ |
| 2026-10-23 | 用户授权修复并部署；完成现场归因、登记恢复、诊断隔离、错误提示、Web 部署与上述自验 | 用户原账号重试收发 |
