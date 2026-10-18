# 聊天页 React #185 修复

2026-10-16。用户报错页面：`/chats?workspace=ws_56c549f3-a9cf-482e-a699-286c860b190c`。

## 原因

byte-dev 的 `codex_provider_llm_gateway` 同时存在 device 与 server projection。模型控件正确优先选 server，但新加入的模型加载缓存身份使用 `profiles.find(id, deviceId)` 取第一条 device projection。device 行有 runtimeGeneration，server 行没有，得到不同的 key。

自动加载 effect 查询 server key 的 loading/results/error；加载函数却更新 device key。因此每次 render 都再次加载并 setState，触发最大更新深度错误。不是 Worker 再次崩溃。

## 修复

`use-chat-runtime.ts` 将选中 projection 的完整缓存身份直接传给加载函数，loading/results/error/retry 都使用该身份，不在请求时重新猜测 profile。`api/profiles.ts` 的共享请求缓存也包含同一身份，避免升级或换账号后复用旧目录。

## 验证

- 增加 device/server 同 ID、不同 generation/account 的回归：旧代码触发 render loop，修复后一次请求并显示目录。
- generation 改变重新读取共享目录；普通重绘不重复请求，显式 retry 仍发新请求。
- 按变更文件检查：TypeScript、48 个前端测试文件、10 项 UI 审计全部通过，118.4 秒。
- 使用隔离数据库副本，禁用 integrations 与外部 egress；只在副本中给 scratch 用户授予该工作区与对应 profile/device 的访问权限，不改生产权限、不发送模型请求。
- 公网 JS `/assets/index-CdNwfqj-.js` 与本地发布产物逐字节相同，包含 catalogIdentity 修复。仅前端更新，无服务端或 Worker 重启。
- Chromium 完整聊天页实测：副本保留实际 device/server 同 ID 两条 projection，打开该工作区既有 byte-llm-gateway 聊天；加载失败后按键盘 Enter 重试，模型请求累计 2 次（初始 + 显式重试），未循环。错误状态仍保留配置模型，页面可操作。
- 浅色桌面、深色 390×844 页面截图保存在 `.foundry/attachments/react185-validation/`；浏览器 errors 为空，`crashed=false`、`overflow=false`。没有向生产业务会话发消息。
- 追加失败/重试覆盖后，runtime selection 11 项测试全部通过。
