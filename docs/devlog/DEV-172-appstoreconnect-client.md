# DEV-172 · App Store Connect 会话侧与连接器页（ASC-2）

## 问题

ASC-1 只提供服务端绑定与网关，用户仍无法在 Connectors 页面提交 key、查看账号状态，也无法在 Agent 会话中通过 CLI 使用 App Store Connect。

## 调查与修复

- Connectors 页面新增 App Store Connect 账号卡、绑定、替换 key、撤销与状态展示；私钥只在提交时进入服务端，不回显。
- 新增 Worker 会话侧 `appstoreconnect` 客户端，读取服务端下发的短期凭据并访问网关；工具说明与内置 Skill 同步。
- 错误区分离线、未绑定、密钥无效和权限不足，避免把暂时失败显示成已连接。
- 补齐 HTTP、Web 组件、Worker client 与 Skill 同步测试；沿用 ASC-1 的现有契约并重新检查生成结果。

## 部署与版本证据

ASC-2 于 2026-11-10 14:44Z 后部署到 dev，已纳入本轮追加提交。

## 检查

- 契约生成/检查
- Server App Store Connect 定向测试
- Web TypeScript typecheck 与 App Store Connect 组件测试
- Worker TypeScript build 与 connector client 测试

## 限制

本次为提交窗口验证，不操作真实 App Store Connect 账号；真实资源访问仍需用户提供有效 API key 并完成工作区授权。

## 验收步骤

1. 打开 Connectors → App Store Connect，绑定有效 Issuer、Key ID 与私钥。
2. 页面应只显示 key 已配置，不显示私钥；可替换、撤销并看到明确状态。
3. 在已授权工作区的 Agent 会话中运行 App Store Connect 命令，请求应经 Foundry 网关。
4. 未授权工作区或无效 key 应返回可读拒绝原因，不泄露密钥。
