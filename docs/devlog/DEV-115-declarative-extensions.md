# DEV-115 · 声明式连接器扩展：Limen 只剩一份数据

状态：实现、自验与 dev 部署完成（2026-11-04 UTC+8），待人工验收。前置：[DEV-111](DEV-111-connector-extensions.md)、[DEV-114](DEV-114-extension-sources.md)。

## 问题

本人要求：不把 Foundry 的东西放进别人的仓库，也不另建仓库；尽量不侵入 Limen，只做外层的协议转换；Foundry 的连接器协议要通用、与具体工具无关。原先 Limen 的扩展是一个程序（`connector.ts`），把 `limen` 命令行翻译成扩展协议，只能放在某个仓库里维护。

## 方案

- 扩展多一种形式：**声明式**。manifest 不写 `entry`，每个连接器写一段 `cli`，用数据说明调用工具的哪些命令、从 JSON 回答的哪里读登录、身份、问题、模型服务（`packages/protocol/src/connector-extensions.ts` `ExtensionCli`）。规则与工具无关：参数模板（`{home}`、字段、`{/JSON pointer}`）、成功条件、条件判断、按数组逐项运行。
- Worker 自己按这段数据回答扩展协议的方法（`connectors/extensions/declarative.ts`，扩展宿主遇到无 `entry` 的扩展时直接调用），所以设备持有型运行时、模型接入、页面都不变；`cli` 不离开设备，Server 与 Web 无改动。
- Limen 的扩展成为 Foundry 仓库里的一份数据 [extensions/limen/foundry-extension.json](../../extensions/limen/foundry-extension.json)，只用 `limen status/join/remove --json` 和 `--version`；`source` 指向 Foundry 仓库这个文件夹。
- 会话供给暂时不变（本人选的 (a)）：模型服务仍经会话助手（`foundry.connection.v1`），等 Limen 合入“每次运行可选 Claude Code 配置目录”后改为 `limen run --claude-config-dir`。

## 自验

- 真实对比（本机）：声明式与原程序扩展对同一台设备给出完全相同的状态、模型服务 id、会话命令、参数和身份，所以检查指纹不变；假邀请码返回 Limen 自己的话，不改动任何 profile。
- 测试：`connector-declarative.test.mjs`（假工具：读状态、版本、引导登录（秘密走 stdin、默认值、格式校验、工具的错误原话）、已登录但服务未运行、逐项登出、模型服务与身份、不支持的方法；manifest 校验：有 `cli` 不能有 `entry`、缺 `cli`、模板名、方法 id、条件、pointer、模型接入需 `provides.modelAccess`；模板不经 shell）与原有扩展、来源测试共 17 项通过；prettier、protocol、tsc、audit:contract/modules 通过。
- dev：Worker `0.5.7-dev.250.g30a4f4c8.local.1793771591`（集成树构建，持部署锁），7 台设备更新并上报新版本；sg-chaos、cottoncpp、CanWendeMac-mini、macbook 及 e2e-alice 合成设备把 Limen 换成声明式（0.2.0）。四台真实设备的 `limen_default` 指纹与“验证通过”原样保留（sg-chaos `34beee84…`、cottoncpp `19782b80…`、CanWendeMac-mini `70c16829…`、macbook `3b83a1d7…`）；在 cottoncpp、两台 Mac 上经已安装 Worker 的真实代码读取：声明式、已登录 `default`、列出 `limen_default` 与身份。

## 验收步骤

1. Connectors → Limen：四台设备显示“Signed in as default”，介绍为“From the Limen extension, version 0.2.0. Published in github.com/BD777/foundry/extensions/limen.”（合入后）。
2. 设备页 → Model providers：`Limen · default` 仍为已验证，不需重新验证；新建对话选它，正常回复。
3. 一台没装 Limen 但装了 `limen` CLI 的设备：Add a connector → 从仓库安装 → `https://github.com/BD777/foundry.git`、文件夹 `extensions/limen` → 出现 Limen 标签。

## 限制

- 会话仍依赖本机安装的会话助手（`~/.local/share/limen/host-connection-v1/connection.js`，源码在 Limen 检出里未提交），直到 Limen 的配置目录功能合入。
- 声明式覆盖“有 JSON 输出的命令行、同步登录”；二维码、设备码这类需要持续转达的登录仍用程序扩展（bytedcli、GitHub CLI 内置）。
- Foundry 仓库合入前，`source` 指向的文件夹还不在 `main` 上；设备上这次是用本地文件装的（无来源），合入后可从页面重装以获得“Update”。
