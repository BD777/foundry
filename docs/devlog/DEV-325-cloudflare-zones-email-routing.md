# DEV-325 Cloudflare 网关：Zero Trust 级别下 `/zones` 报错；开放邮件转发（Email Routing）

状态：已部署 dev，待本人验收。

## 问题

1. 在 Zero Trust 级别的工作区里，`GET /zones` 和 `cf zones list` 总是返回 502 `9109 Invalid zone identifier`。逐个按 zone ID 读取（`/zones/<id>`）都正常。2026-11-22 在 blinklet 工作区（`sess_1795346516272224728`）和 foundry 工作区（`sess_1795346638463191865`）各复现一次。
2. 本人要求给 `support@blinklet.app` 配置邮件转发。网关的路由表里没有 Email Routing 的路径，所以全部被拒（path_not_allowed）。实际上本人的 Cloudflare 授权已经包含 `email-routing-address.write`、`email-routing-rule.write` 等权限。

## 原因

`Holdings` 在 zero_trust 级别会把绑定 zone 所属的 Cloudflare 账号 ID 也放进 `Held.Resources`，这样账号级的 Zero Trust 路径才能通过"是否已绑定"的检查。`listZones` 遍历的正是 `Held.Resources`，于是把账号 ID 当成 zone 去请求 `/zones/<account>`，Cloudflare 返回 9109。

## 修复

- `Upstream` 处理 `/zones` 时，改为重新读取绑定，只遍历绑定里的 zone ID。
- `access/cloudflare.json` 增加邮件转发相关的路由：
  - 读取（read 级别）：域名的邮件转发设置、所需 DNS 记录、转发规则列表和单条规则；
  - 修改（dns_edit 级别）：开启邮件转发并写入所需 DNS 记录，新增、修改、删除转发规则；
  - 目标地址（zero_trust 级别，账号级路径，账号必须是已绑定 zone 所属的账号）：列出、读取、添加。目标邮箱的主人点验证链接后，才会真正转发。

  各级别的中英文说明同步更新。

- 测试 `TestCloudflareZeroTrustListsOnlyBoundZonesAndRoutesEmail`：
  - zero_trust 级别下 `/zones` 只列出已绑定的 zone，不会请求 `/zones/<account>`。不改代码时，该测试复现了线上的错误。
  - zero_trust 级别可以开启转发、添加规则、添加目标地址。
  - dns_edit 级别可以添加规则，但添加目标地址被拒（access_level）。
  - read 级别可以读取，但开启转发被拒（access_level）。

  `go test ./internal/connectors/`、`./internal/externalaccounts/`，以及 httpapi 中 Cloudflare、AppStoreConnect、ExternalAccount、ConnectorInstances 相关测试全部通过，`go vet` 无问题。

## 部署与线上验证

- 2026-11-22 11:37Z 部署 Server `a1dfd8908e8e`（`--label cf-zones-email-routing`），由 CanWendeMac-mini 构建。替换的只有本项的文件和文档；回滚副本为 `foundry-server.pre-cf-zones-email-routing`。
- 在 blinklet 工作区（zero_trust 级别），会话 `sess_1795346516272224728` 走完了全部步骤，网关没有拒绝任何一步：
  - `GET /zones?name=blinklet.app` 正常返回；
  - 邮件转发从 unconfigured 变为 enabled/ready，Cloudflare 自动写入 3 条 MX、SPF 和 DKIM 记录，其他 DNS 记录没动；
  - 目标地址是 Cloudflare 账号本人的邮箱，被直接标为 verified，不需要点验证链接；
  - 新建规则：发往 `support@blinklet.app` 的邮件转发到本人邮箱。

- 2026-11-26 合入 main：PR #319（rebase 合入，按事项分提交），提交 `4b1049ad`（与 DEV-323 补丁同一提交）。dev 由合入后的 main `7600d2fc` 重新构建部署（`--label batch-20261127`，2026-11-26 20:02Z）：Server `ebf56c7b9b93`（回滚副本 `foundry-server.pre-batch-20261127`）、Web `a2886d5d717f92e0`（源码未变）、Worker `0.5.7-dev.415.g7600d2fc`。

## 验收步骤（本人）

1. 在一个 Cloudflare 级别为"Read + DNS edit + Zero Trust"的工作区里，让会话运行 `cf zones list`。预期：列出这个工作区绑定的域名，不报 9109。
2. 让会话给某个域名的一个地址配置转发到你的邮箱。预期：你的邮箱收到 Cloudflare 的验证邮件；点击验证后，发到这个地址的邮件会转到你的邮箱。
