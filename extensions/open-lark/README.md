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

If the deployment is protected by Cloudflare Access, give Foundry a service token instead of opening a bypass: in Cloudflare Zero Trust create a service token (Access → Service Auth → Service Tokens), add a policy with the **Service Auth** action that includes it on `/agent/v1`, route `/agent/v1` in the tunnel to OpenLark's Agent port (8081), and fill the token's Client ID and Client Secret into the two optional fields. Foundry seals them with the Agent token and sends them only to the deployment.

部署受 Cloudflare Access 保护时，不要开放 Bypass，而是给 Foundry 一个服务令牌：在 Cloudflare Zero Trust 里新建服务令牌（Access → Service Auth → Service Tokens），为 `/agent/v1` 加一条 Action 为 **Service Auth** 且包含该令牌的策略，在 Tunnel 里把 `/agent/v1` 转发到 OpenLark 的 Agent 端口（8081），再把令牌的 Client ID 和 Client Secret 填进两个可选字段。Foundry 会把它们和 Agent 令牌一起封存，只发给这个部署。
