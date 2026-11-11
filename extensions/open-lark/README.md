# OpenLark connector extension for Foundry

This bundled extension lets a Foundry session use an OpenLark deployment
through Foundry's server-held connector gateway. The real Agent token stays in
Foundry's sealed server secret store; the session receives only a revocable
stand-in and a loopback gateway URL. It can be a full token, for reads and
writes, or a read-only token.

## Before adding the instance

On the OpenLark host, enable its legacy agent API with a dedicated token:

```sh
export LARK_AGENT_LEGACY=token
export OPEN_LARK_AGENT_TOKEN="$(openssl rand -hex 32)"
```

To let Foundry read without writing, set a different value as
`OPEN_LARK_AGENT_READ_TOKEN` and paste that instead. If both variables are set
on OpenLark, their values must differ. Restart OpenLark after changing the
environment.

A server-held instance must be reachable from the public internet and use
HTTPS, because Foundry sends the token over that connection. Deployments on an
internal network or a development machine with only an IP address are not
supported by this form yet; device-held support for HTTP will come later. Use
the root address, for example `https://open-lark.example.com`. Do not append
`/agent/v1`, a query string or a fragment. Foundry pins DNS and public-address
checks to every probe and gateway request and refuses redirects.

Install the OpenLark Codex plugin/`olk` command on the device separately. This
extension is pure data; Foundry does not run extension code on the server and
does not install OpenLark itself.

## Add it to Foundry

1. Install **OpenLark** from Connectors on the device. It is bundled with the
   Worker and does not need a repository address. From a source checkout:

   ```sh
   foundry-worker extension add extensions/open-lark
   ```

2. Open **Connectors → Private** and choose **OpenLark**.
3. Choose **Foundry server direct** for a public HTTPS deployment, or
   **Via a device** for an internal address. The device validates and forwards
   requests. Both forms may include a path prefix such as
   `https://host/openlark`; do not add `/agent/v1`, a query or a fragment.
4. Enter the Agent token. The recommended value is `OPEN_LARK_AGENT_TOKEN`;
   use `OPEN_LARK_AGENT_READ_TOKEN` to keep Foundry read-only. After validation,
   Foundry reads `token.scope` and shows **Read/write** or **Read-only** on the
   instance. Choose a Lark account or leave it empty for the primary account.
5. Bind the resulting instance to each workspace whose sessions should use it.

The extension asks OpenLark for:

- `GET /agent/v1/capabilities` for the version and the token's `full` or
  `read` scope, when that endpoint exists;
- `GET /agent/v1/accounts` for the account choices;
- `GET /agent/v1/` for the authoritative route catalog.

Foundry forwards a request only when the catalog contains its method and path.
A read-only token enables catalogued `read` routes only. A full token also
enables `write` routes; writes from the Personal Agent require confirmation,
and its permission package must allow write access. Unknown routes are refused
before they reach OpenLark, and every request is audited without its token.

## 中文说明

这是随 Worker 发布的 OpenLark 连接器扩展。真实 Agent 令牌由 Foundry
Server 封存，会话只拿到可撤销的替身令牌和本机回环转发地址。令牌可以是
读写或只读。

先在 OpenLark 所在服务器配置并重启服务：

```sh
export LARK_AGENT_LEGACY=token
export OPEN_LARK_AGENT_TOKEN="$(openssl rand -hex 32)"
```

公网部署选择“Foundry 服务器直连”并填写 HTTPS 地址；内网部署选择
“经设备连接”，由一台能访问内网的在线设备校验和转发。两种方式都可以带
OpenLark 子路径（例如 `https://host/openlark`），但不要追加 `/agent/v1`、
查询串或片段。

若只想让 Foundry 读取，可以改用另一个随机值设置
`OPEN_LARK_AGENT_READ_TOKEN`，并把该值填入 Foundry；如果两个变量都设置，
值必须不同。重启 OpenLark 后再添加实例。Foundry 会读取能力响应中的
`token.scope`，并在实例上显示“读写”或“只读”。

在设备的连接器页面安装 OpenLark；它随 Worker 发布，不需要填写仓库地址。
从源码检出使用时也可以执行：

```sh
foundry-worker extension add extensions/open-lark
```

然后在 **Connectors → Private → OpenLark** 添加实例。推荐把
`OPEN_LARK_AGENT_TOKEN` 作为“Agent 令牌”填入 Foundry；只读场景填写
`OPEN_LARK_AGENT_READ_TOKEN`。校验时 Foundry 会读取能力接口返回的
`token.scope`，并在实例列表显示「读写」或「只读」。账号可以留空使用主账号。
最后到 Workspace 的 Connectors 页绑定该实例。

OpenLark 的 `olk` 命令仍需按 OpenLark/Codex 插件自己的安装说明装在设备上。
Foundry 只按这份声明式描述符探测和转发，不在 Server 上运行扩展代码。只读
令牌只放行路由目录中的 `read` 路由；完整令牌也放行 `write` 路由。Personal
Agent 的写请求还需要权限包允许写并经过确认，所有请求都会逐条审计且不记录
令牌。

## Behind Cloudflare Access / 部署在 Cloudflare Access 后面

If the deployment is protected by Cloudflare Access, this connector needs nothing extra: Foundry's **edge access** is a separate credential matched by address, not a field of any connector. Add a Cloudflare Access service token (Client ID and Secret) under Settings → Edge access for the deployment's host (and, if you like, the `/agent/v1` path prefix), or let Foundry provision one through the Cloudflare connector. Add a policy with the **Service Auth** action that includes the token on `/agent/v1`, and route `/agent/v1` in the tunnel to OpenLark's Agent port (8081). When validation finds the address behind Cloudflare Access without a credential, Foundry says so and offers the same two next steps.

部署受 Cloudflare Access 保护时，本连接器不需要任何额外字段：Foundry 的**边缘访问**是独立于连接器、按地址匹配的凭据。在「设置 → 边缘访问」里为部署的域名（也可限定 `/agent/v1` 路径前缀）添加 Cloudflare Access 服务令牌（Client ID 和 Secret），或让 Foundry 通过 Cloudflare 连接器自动开通。为 `/agent/v1` 加一条 Action 为 **Service Auth** 且包含该令牌的策略，并在 Tunnel 里把 `/agent/v1` 转发到 OpenLark 的 Agent 端口（8081）。校验时若发现地址在 Cloudflare Access 后面又没有凭据，Foundry 会明确提示，并给出同样的两个下一步。
