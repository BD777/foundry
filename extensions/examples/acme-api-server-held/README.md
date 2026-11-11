# Acme API: server-held extension

## English

This folder is a fictional pure-data example of a server-held connector. It
has no `entry` and no `cli`: the Server validates these declarations, keeps the
token sealed, probes the deployment, and proxies requests through its gateway.

Choose this shape when a private API is publicly reachable, one token is enough
for access, and its routes can be described as data. Device-held connectors
remain the default when the service is only reachable from a device or needs
device-local sign-in.

The form has two steps. The deployment URL comes from the Acme admin page; the
API token is created under Settings > API tokens (or with
`acme tokens create --scope read`); and the account is chosen from the result
of the accounts probe after the first two values validate. Every field's help
explains where its value comes from.

The fictional service exposes:

```text
GET /agent/v1/capabilities
{"version":"1.4.0","token":{"scope":"read"}}

GET /agent/v1/accounts
{"accounts":[{"id":"default","name":"Default account"}]}

GET /agent/v1/
{"routes":[{"method":"GET","path":"/items","access":"read","domain":"items"}]}
```

The route probe builds the gateway's directory. `access.allowBy` reads
`probe:capabilities/scope`: `full` grants read and write, `read` grants read,
and an unknown or missing scope falls back to read. The session receives
`{gatewayBase}` and `{standIn}` values; the real token never enters the
session.

`network.holdings` allows both server and device paths. The server path is
limited to public HTTPS destinations; the device path lets the same instance
reach an address only that device can open.

The connector is hidden until this device can read the fictional
`acme/acme-control-plane` repository through its repository-reading connector
(`access.via: "github"`).

Install it from a checkout of this repository, then add an instance on the
Connectors page:

```sh
foundry-worker extension add ./extensions/examples/acme-api-server-held
```

## 中文

这个目录是一个虚构的服务器保管型纯数据示例：没有 `entry`，也没有 `cli`。
Server 校验收到的声明，封存令牌，探测部署，并通过通用网关代理请求。

如果私有 API 已公开可达、一份令牌就够用，而且路由目录能用纯数据描述，就选这种
写法。若服务只能从设备访问，或需要设备本地登录，仍应使用设备持有型。

表单分两步：部署地址从 Acme 管理页面复制；API 令牌在「设置 > API 令牌」里创建
（或运行 `acme tokens create --scope read`）；账号在地址和令牌校验通过后，从
账号探测的结果中选择。每个字段的 help 都写明了值从哪来。

虚构服务提供：

```text
GET /agent/v1/capabilities
{"version":"1.4.0","token":{"scope":"read"}}

GET /agent/v1/accounts
{"accounts":[{"id":"default","name":"Default account"}]}

GET /agent/v1/
{"routes":[{"method":"GET","path":"/items","access":"read","domain":"items"}]}
```

路由探测生成网关的目录。`access.allowBy` 读取
`probe:capabilities/scope`：`full` 放行读写，`read` 只放行读，未知或缺失的
scope 回退到只读。会话拿到的是 `{gatewayBase}` 和 `{standIn}`，真实令牌不会
进入会话。

`network.holdings` 同时允许服务器和设备两种连接方式。服务器路径仅限公网 HTTPS；
设备路径让同一个实例访问只有那台设备能打开的地址。

只有在设备上能通过读取仓库的连接器（`access.via: "github"`）访问虚构仓库
`acme/acme-control-plane` 时，这个连接器才会显示。

在仓库检出中安装，然后在 Connectors 页面添加实例：

```sh
foundry-worker extension add ./extensions/examples/acme-api-server-held
```
