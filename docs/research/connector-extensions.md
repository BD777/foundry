# 调研：可插拔的私有连接器

日期：2026-11-03。结论已实施，见 [连接器扩展](../connector-extensions.md) 与 [DEV-111](../devlog/DEV-111-connector-extensions.md)。外部事实附来源；“分类”“覆盖”是本文综合，不是权威清单。

## 问题

Limen（私有 Claude 网关）以“外部模型连接”的独立机制存在（登记、安装面板、Devices 页专区，约 3.3k 行），与设备持有型连接器的生命周期（安装、登录、状态、到期、共享）重复；bytedcli（公司内部 CLI）直接内置在公开仓库。需要：私有连接器移出公开仓库、可插拔；协议通用、高效；兼容已有连接器。

## 现状盘点（2026-11-03，main `1d4bdcf3`）

|      | 飞书                                | Cloudflare                              | bytedcli                                   | AWS CLI                                | 外部连接（Limen）    |
| ---- | ----------------------------------- | --------------------------------------- | ------------------------------------------ | -------------------------------------- | -------------------- |
| 持有 | Server                              | Server                                  | 设备（CLI 自己）                           | 设备（凭据链）                         | 设备（助手进程）     |
| 登录 | Server 发起设备码，可先扫码注册应用 | 授权码 + PKCE，动态客户端               | CLI 的 `--begin/--complete` 设备码，二维码 | console（粘贴回码）/ SSO 设备码 / 终端 | 网关安装程序         |
| 权限 | scope 预设 + 审批 scope + 自填      | 固定只读预设 + 每工作区 zone 与访问级别 | 附加授权组（网页会话）                     | 仅 STS 身份                            | 无                   |
| 表单 | 定制（App ID/secret、品牌、scope）  | 定制（zone、访问级别）                  | 无                                         | 定制（方式、Region、SSO 字段）         | 无（CLI 参数）       |
| 会话 | 替身凭据 + 本机转发 + Server 网关   | 句柄 + 转发（仅 GET）+ MCP 写工具       | 设备登录，否则隔离变量                     | 同左                                   | 每进程助手给环境变量 |

设备持有型约 85% 由数据驱动（Server 无分支）；Server 持有型几乎全是代码（网关、刷新、逐请求检查）。进程外协议表达不了的只有 Server 侧的网关与刷新。

顺带发现：Cloudflare 登录固定只申请只读 scope（`authorization_code.go:137`），`dns_edit` 只有在 Cloudflare 多给权限时才能选；`docs/connectors.md` 提到的几个 capability（`device_connectors`、`connector_browser_sign_in_v1` 等）在代码中不存在。两项不在本次范围，记入 Roadmap。

## 业界：插件协议

| 方案                                                                                                                                                                                                                                                                                                                                                                                         | 形态                                          | 能否直接用                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| MCP（[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)、[lifecycle 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)） | JSON-RPC 2.0 按行，能力协商                   | 否：原语面向模型；授权规范不适用 stdio；2026-07-28 去掉 `initialize`，大版本不兼容。借用其 stdio 规则与 URL elicitation 的安全要求 |
| 凭据助手：[git](https://git-scm.com/docs/git-credential)、[docker](https://github.com/docker/docker-credential-helpers)、[kubectl exec](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)、[AWS credential_process](https://docs.aws.amazon.com/sdkref/latest/guide/feature-process-credentials.html)、[Google executable](https://google.aip.dev/auth/4117)          | 一次性取 token                                | 否：无登录流程、状态、安装、常驻                                                                                                   |
| [1Password Shell Plugins](https://github.com/1Password/shell-plugins/blob/main/sdk/provisioner.go)                                                                                                                                                                                                                                                                                           | 凭据字段 + provision/deprovision + needs-auth | 领域最接近，但是 Go SDK、beta，不是跨语言协议                                                                                      |
| [HashiCorp go-plugin](https://github.com/hashicorp/go-plugin/blob/main/docs/internals.md)（Terraform、Vault）                                                                                                                                                                                                                                                                                | 子进程 gRPC，握手                             | 成熟但对 Node Worker 偏重；握手不提供安全                                                                                          |
| [Airbyte](https://docs.airbyte.com/understanding-airbyte/airbyte-protocol) / Singer                                                                                                                                                                                                                                                                                                          | stdout JSON 消息，JSON Schema 配置            | 面向数据同步                                                                                                                       |
| [LSP](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) / DAP                                                                                                                                                                                                                                                                                     | 常驻子进程，能力协商，进度与取消              | 生命周期的先例                                                                                                                     |
| [MCPB manifest](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)、[Claude Code plugins](https://code.claude.com/docs/en/plugins-reference)                                                                                                                                                                                                                                | 打包与 `user_config`（`sensitive`）           | manifest 与分发的先例                                                                                                              |

结论：自定义协议，传输照搬 MCP stdio（每行 JSON-RPC，stdout 只走协议），生命周期学 LSP（`initialize`、整数大版本、忽略未知字段、常驻、宿主退出则退出），领域借 1Password（字段与 secret 标记、准备/释放）。高效：每个扩展一个常驻进程、按需启动、空闲退出；状态按 TTL 缓存、变化时推送。

## 业界：认证、权限与表单建模

- 认证方式：[Nango `AuthModes`](https://github.com/NangoHQ/nango/blob/master/packages/types/lib/auth/api.ts)（17 种，无设备码）、[Zapier](https://github.com/zapier/zapier-platform/blob/main/packages/schema/docs/build/schema.md)（basic/custom/digest/oauth1/oauth2/session）、[OpenAPI 3.2 securitySchemes](https://spec.openapis.org/oas/v3.2.0.html)（3.2 新增 `deviceAuthorization`）、[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)。
- 表单：[n8n credential `properties`](https://docs.n8n.io/integrations/creating-nodes/build/reference/credentials-files/)、Nango SimplifiedJSONSchema（`secret`、`visible_when`）、[Airbyte spec](https://docs.airbyte.com/platform/connector-development/connector-specification-reference)（`airbyte_secret`、`oneOf`）、MCP elicitation 的受限 JSON Schema。
- 多步流程：[Home Assistant config flow](https://contributors.home-assistant.io/core/integrations/flow-steps/) 的步骤结果（form/external/progress/menu/create/abort）与 reauth 必须同一 `unique_id`。
- 权限：[RFC 9396](https://www.rfc-editor.org/rfc/rfc9396)（授权详情）、[RFC 6749 §5.1](https://www.rfc-editor.org/rfc/rfc6749#section-5.1)（申请与授予分开记录）、增量授权（Google `include_granted_scopes`、Pipedream `additional_scopes`）。
- 账号：[VS Code AuthenticationProvider](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts)（会话 = 账号 + scope 集）、AWS `sso-session` → profile 的父子结构。

综合出的分类（本文综合，覆盖我们的五个连接器与上述平台，不是权威清单）：认证 `oauth2_code` / `oauth2_device` / `client_credentials` / `api_key` / `basic` / `token_exchange` / `jwt` / `mtls` / `cli_delegated` / `custom_flow` / `none`，加上“谁持有”和“会话如何拿到”两个独立维度。

## 落地的取舍

- 设备持有型扩展先行：两个私有需求（bytedcli、Limen）都是设备持有型；它们的认证都是 `cli_delegated`/自定义流程，所以描述符只需声明“登录方式 + 字段”，由扩展处理细节。纯数据的 Server 持有型（Nango 式 OAuth/API key 模板）等真有私有 SaaS 时再做。
- 表单与步骤：受限字段集合（text/secret/url/select + required/default/pattern/showWhen），步骤沿用已有的设备登录挑战（链接、用户码、二维码、粘贴回的码），对应 HA 的 external/progress/form。表达不了的界面才考虑 MCP Apps 式沙箱 iframe，现在不做。
- 会话供给：模型接入沿用已验证的 `foundry.connection.v1` 每进程助手；工具类连接器沿用“设备登录 / 隔离变量”。
